export const DEVSPACE_TARGETS = ['codex', 'claude', 'local'] as const
export type DevSpaceTarget = typeof DEVSPACE_TARGETS[number]
export type DevSpaceTaskState = 'running' | 'completed' | 'failed' | 'stopped'

export interface DevSpaceStatus {
  installed: boolean
  version: string | null
  configured: boolean
  configPath: string
  allowedRoots: string[]
  endpoint: string | null
  service: { running: boolean; managed: boolean; pid?: number }
  daemon: { running: boolean; state: string; activeTurns: number }
  targets: { name: DevSpaceTarget; kind: 'provider'; model?: string }[]
}

export interface DevSpaceTask {
  id: string
  status: DevSpaceTaskState
  target?: string
  provider?: DevSpaceTarget
  response?: string
  stale?: boolean
  error?: { code: string; message: string; retryable?: boolean }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function isDevSpaceTarget(value: unknown): value is DevSpaceTarget {
  return DEVSPACE_TARGETS.some(target => target === value)
}

/** Unknown or incomplete status must never become a positive readiness signal. */
export function parseDevSpaceStatus(value: unknown): DevSpaceStatus {
  const data = record(value)
  const service = record(data.service)
  const daemon = record(data.daemon)
  if (typeof data.installed !== 'boolean' || typeof data.configured !== 'boolean'
    || typeof service.running !== 'boolean' || typeof service.managed !== 'boolean'
    || typeof daemon.running !== 'boolean' || !Array.isArray(data.allowedRoots) || !Array.isArray(data.targets)) {
    throw new Error('DevSpace 回傳的狀態格式無法辨識，請重新整理。')
  }
  return {
    installed: data.installed,
    version: typeof data.version === 'string' ? data.version : null,
    configured: data.configured,
    configPath: typeof data.configPath === 'string' ? data.configPath : '',
    allowedRoots: data.allowedRoots.filter((root): root is string => typeof root === 'string' && !!root.trim()),
    endpoint: typeof data.endpoint === 'string' ? data.endpoint : null,
    service: { running: service.running, managed: service.managed, ...(typeof service.pid === 'number' ? { pid: service.pid } : {}) },
    daemon: { running: daemon.running, state: typeof daemon.state === 'string' ? daemon.state : 'unavailable', activeTurns: typeof daemon.activeTurns === 'number' ? daemon.activeTurns : 0 },
    targets: data.targets.flatMap(value => {
      const item = record(value)
      return isDevSpaceTarget(item.name) && item.kind === 'provider'
        ? [{ name: item.name, kind: 'provider' as const, ...(typeof item.model === 'string' ? { model: item.model } : {}) }]
        : []
    }),
  }
}

export function parseDevSpaceTask(value: unknown): DevSpaceTask {
  const task = record(value)
  if (typeof task.id !== 'string' || !task.id || !['running', 'completed', 'failed', 'stopped'].includes(String(task.status))) {
    throw new Error('DevSpace 回傳的任務格式無法辨識，請重新整理。')
  }
  const failure = record(task.error)
  return {
    id: task.id,
    status: task.status as DevSpaceTaskState,
    stale: task.stale === true,
    ...(typeof task.target === 'string' ? { target: task.target } : {}),
    ...(isDevSpaceTarget(task.provider) ? { provider: task.provider } : {}),
    ...(typeof task.response === 'string' ? { response: task.response } : {}),
    ...(typeof failure.message === 'string' ? { error: { code: typeof failure.code === 'string' ? failure.code : '', message: failure.message, retryable: failure.retryable === true } } : {}),
  }
}

export function parseDevSpaceTasks(value: unknown): DevSpaceTask[] {
  if (!Array.isArray(value)) throw new Error('DevSpace 回傳的任務格式無法辨識，請重新整理。')
  return value.map(parseDevSpaceTask)
}

/** Convenience only. The server resolves symlinks and enforces the actual allowed roots. */
export function withinDevSpaceRoots(cwd: string, roots: string[]): boolean {
  if (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(cwd.trim())) return false
  const normalize = (path: string) => {
    const trimmed = path.trim()
    const windows = /^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith('\\\\')
    const result = trimmed === '/' ? '/' : trimmed.replace(/\\/g, '/').replace(/\/+$/, '')
    return windows ? result.toLowerCase() : result
  }
  const candidate = normalize(cwd)
  if (!candidate || candidate.split('/').some(part => part === '..' || part === '.')) return false
  return roots.some(root => {
    const allowed = normalize(root)
    return !!allowed && (candidate === allowed || candidate.startsWith(allowed === '/' ? '/' : `${allowed}/`))
  })
}

export function devSpaceRunProblem(status: DevSpaceStatus | null, cwd: string, target: string, prompt: string): string {
  if (!status) return '請先讀取 DevSpace 狀態。'
  if (!status.installed) return '請先安裝 DevSpace，再重新整理。'
  if (!status.configured) return '請先完成 DevSpace 設定，再重新整理。'
  if (!withinDevSpaceRoots(cwd, status.allowedRoots)) return '請選擇允許的工作目錄，或其中的子目錄。'
  if (!status.targets.some(item => item.name === target)) return '請選擇已在 DevSpace 啟用的執行者。'
  if (!prompt.trim()) return '請寫下要執行的工作。'
  if (prompt.length > 24000) return '請輸入 1 到 24,000 字的任務內容。'
  return ''
}

export const devSpaceTaskLabel = (state: DevSpaceTaskState): string => ({
  running: '執行中', completed: '已完成', failed: '執行失敗', stopped: '已停止',
}[state])

export async function devSpaceRequest(path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/devspace/${path}`, body === undefined
    ? { cache: 'no-store', signal }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  let data: Record<string, unknown>
  try { data = record(await response.json()) } catch {
    throw new Error('DevSpace 控制 API 沒有回傳有效資料，請確認背景服務正在執行。')
  }
  if (!response.ok || data.ok !== true) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
  return data
}

/** Start the next read only after the previous one settles; cleanup rejects late results. */
export function pollDevSpace<T>(read: (signal: AbortSignal) => Promise<T>, receive: (result: T) => void, fail: (error: unknown) => void, delay = 4000): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    try {
      const value = await read(controller.signal)
      if (!controller.signal.aborted) receive(value)
    } catch (error) {
      if (!controller.signal.aborted) fail(error)
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(() => { void tick() }, delay)
    }
  }
  void tick()
  return () => { controller.abort(); clearTimeout(timer) }
}
