import type { PairingSnapshot } from './remoteApi'

interface Dependencies<T> {
  capture: () => PairingSnapshot
  isCurrent: (pairing: PairingSnapshot) => boolean
  request: (pairing: PairingSnapshot, signal: AbortSignal) => Promise<Response>
  onData: (records: T[]) => void
  onFailure: () => void
  timeoutMs?: number
}

/** 單一 in-flight 的讀取器；配對變更、取消或逾時後的晚回結果不能提交。 */
export function createDispatchPuller<T>(deps: Dependencies<T>) {
  let sequence = 0
  let active: AbortController | null = null

  const cancel = () => {
    sequence += 1
    active?.abort()
    active = null
  }

  const pull = async () => {
    if (active) return
    const pairing = deps.capture()
    if (!pairing.token || !deps.isCurrent(pairing)) return
    const ticket = ++sequence
    const controller = new AbortController()
    active = controller
    const owns = () => ticket === sequence && active === controller
      && !controller.signal.aborted && deps.isCurrent(pairing)
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, deps.timeoutMs ?? 10000)
    let onAbort = () => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    })

    try {
      await Promise.race([aborted, (async () => {
        const response = await deps.request(pairing, controller.signal)
        if (!owns()) return
        if (!response.ok) { deps.onFailure(); return }
        const body: unknown = await response.json()
        if (!owns()) return
        if (!body || typeof body !== 'object' || Array.isArray(body)) { deps.onFailure(); return }
        const record = body as Record<string, unknown>
        if (record.ok !== true || !Array.isArray(record.dispatches)) { deps.onFailure(); return }
        deps.onData(record.dispatches as T[])
      })()])
    } catch {
      if (ticket === sequence && active === controller && deps.isCurrent(pairing)
        && (timedOut || !controller.signal.aborted)) deps.onFailure()
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      if (active === controller) active = null
    }
  }

  return { pull, cancel }
}
