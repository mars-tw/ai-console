import type { DispatchRecord, HubProject, ToolStatus } from '@/types/data'

export interface WorkSource { state: 'ready' | 'partial' | 'missing' | 'unreadable'; rowCount?: number | null; selectedCount?: number | null; modifiedAt?: string }
export interface WorkState {
  schemaVersion: 1; checkedAt: string; validForMs: number; coverage: string; taskDataAvailable: boolean
  sources: { registry: WorkSource; projects: WorkSource; runtimeSessions: WorkSource }
  tools: Record<string, ToolStatus>; projects: HubProject[] | null
  dispatches: DispatchRecord[] | null; runtimeSessions: DispatchRecord[]
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const states = new Set(['running', 'waiting', 'failed', 'stopped', 'unknown'])
const phases = new Set(['running', 'idle', 'ended', 'not_observed', 'unverified'])
const outcomes = new Set(['unknown', 'failed', 'stopped', 'blocked'])
export function validateWorkState(raw: unknown): WorkState | null {
  if (!object(raw) || raw.ok !== true || raw.schemaVersion !== 1 || typeof raw.checkedAt !== 'string' || !Number.isFinite(Date.parse(raw.checkedAt))
    || typeof raw.validForMs !== 'number' || raw.validForMs <= 0 || raw.validForMs > 15000 || typeof raw.coverage !== 'string'
    || typeof raw.taskDataAvailable !== 'boolean' || !object(raw.sources) || !object(raw.tools)
    || !Array.isArray(raw.runtimeSessions) || (raw.dispatches !== null && !Array.isArray(raw.dispatches)) || (raw.projects !== null && !Array.isArray(raw.projects))) return null
  for (const key of ['registry', 'projects', 'runtimeSessions']) {
    const source = raw.sources[key]
    if (!object(source) || !['ready', 'partial', 'missing', 'unreadable'].includes(String(source.state))) return null
  }
  for (const tool of Object.values(raw.tools)) if (!object(tool) || ['label', 'status', 'last_active', 'role'].some((key) => typeof tool[key] !== 'string') || typeof tool.rate_limited !== 'boolean') return null
  if (Array.isArray(raw.projects) && raw.projects.some((row: unknown) => !object(row) || ['project_id', 'title', 'status', 'updated_at', 'updated_by', 'next_step'].some((key) => typeof row[key] !== 'string') || typeof row.needs_handoff !== 'boolean')) return null
  for (const row of [...(Array.isArray(raw.dispatches) ? raw.dispatches : []), ...raw.runtimeSessions]) {
    if (!object(row) || typeof row.id !== 'string' || !row.id.trim() || typeof row.tool !== 'string' || typeof row.task !== 'string'
      || !states.has(String(row.state)) || !phases.has(String(row.runtimePhase)) || !outcomes.has(String(row.taskOutcome))
      || typeof row.providerOutcome !== 'string' || typeof row.cancelOrderPending !== 'boolean' || !object(row.evidence)
      || typeof row.evidence.process !== 'string' || typeof row.evidence.reason !== 'string' || typeof row.evidence.terminalReason !== 'string'
      || (row.evidence.terminal !== null && typeof row.evidence.terminal !== 'string')
      || (row.state === 'failed' && row.taskOutcome !== 'failed') || (row.state === 'stopped' && row.taskOutcome !== 'stopped')
      || (row.state === 'running' && (row.runtimePhase !== 'running' || row.evidence.process !== 'verified' || row.cancelOrderPending))) return null
  }
  return raw as unknown as WorkState
}
export function isWorkStateFresh(snapshot: WorkState | null, now = Date.now()): boolean {
  const age = snapshot ? now - Date.parse(snapshot.checkedAt) : Infinity
  return !!snapshot && age >= -5000 && age < snapshot.validForMs
}
export async function readWorkStateOnce(outer: AbortSignal, doFetch: typeof fetch = fetch, timeoutMs = 12000): Promise<WorkState> {
  const request = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => { request.abort(); reject(new DOMException('Aborted', 'AbortError')) }
    if (outer.aborted) { onAbort(); return }
    outer.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => { request.abort(); reject(new Error('work-state timeout')) }, timeoutMs)
  })
  try {
    return await Promise.race([interrupted, (async () => {
      request.signal.throwIfAborted()
      const response = await doFetch('/api/work-state', { signal: request.signal, cache: 'no-store' })
      request.signal.throwIfAborted()
      if (!response.ok) throw new Error(`work-state HTTP ${response.status}`)
      const raw: unknown = await response.json()
      request.signal.throwIfAborted()
      const snapshot = validateWorkState(raw)
      if (!snapshot || !isWorkStateFresh(snapshot)) throw new Error('work-state invalid or expired')
      return snapshot
    })()])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outer.removeEventListener('abort', onAbort)
    request.abort()
  }
}
export type ObservationState = 'off' | 'observing' | 'hidden' | 'offscreen' | 'limit' | 'unmounted'
interface Options { read?: (signal: AbortSignal) => Promise<WorkState>; onData: (snapshot: WorkState) => void; onReadState: (state: 'loading' | 'ready' | 'error') => void; onObservation: (state: ObservationState) => void }
/** One request at a time; explicit 5-second observations expire after 2 minutes. */
export function createWorkStateObserver(options: Options) {
  let visible = false, disposed = false, observing = false
  let active: AbortController | null = null
  let next: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined
  const stop = (reason: ObservationState = 'off') => {
    observing = false
    if (next !== undefined) clearTimeout(next)
    if (deadline !== undefined) clearTimeout(deadline)
    next = deadline = undefined
    const request = active; active = null; request?.abort()
    if (request && !disposed) options.onReadState('error')
    options.onObservation(reason)
  }
  const refresh = async () => {
    if (!visible || disposed || active) return
    const request = new AbortController(); active = request; options.onReadState('loading')
    try {
      const data = await (options.read ?? readWorkStateOnce)(request.signal)
      if (request.signal.aborted || active !== request || disposed || !visible) return
      options.onData(data); options.onReadState('ready')
    } catch { if (!request.signal.aborted && active === request && !disposed) options.onReadState('error') }
    finally {
      if (active === request) { active = null; if (observing && visible && !disposed) next = setTimeout(() => { void refresh() }, 5000) }
    }
  }
  return { refresh, stop,
    start: () => { if (!visible || disposed) return; stop(); observing = true; options.onObservation('observing'); deadline = setTimeout(() => stop('limit'), 120000); void refresh() },
    setVisible: (value: boolean, reason: 'hidden' | 'offscreen' = 'offscreen') => { visible = value; if (!value) stop(reason) },
    dispose: () => { disposed = true; visible = false; stop('unmounted') },
  }
}
