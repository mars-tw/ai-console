export const DEVSPACE_TARGETS = ['codex'] as const
export type DevSpaceTarget = typeof DEVSPACE_TARGETS[number]
export const DEVSPACE_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 SOL' },
  { id: 'gpt-6-astra', label: 'GPT-6 ASTRA' },
] as const
export type DevSpaceModel = typeof DEVSPACE_MODELS[number]['id']
export const DEFAULT_DEVSPACE_MODEL: DevSpaceModel = 'gpt-5.6-sol'
const MODEL_PREFERENCE = 'ai-console.devspace-model'
export type DevSpaceTaskState = 'running' | 'completed' | 'failed' | 'stopped'

export interface DevSpaceDraft {
  workspace: string | null
  model: DevSpaceModel
  instructions: string
}

export type DevSpaceConversationSource =
  | 'new-work'
  | 'continuation'
  | 'legacy-retry'
  | 'legacy-followup'
  | 'office'
  | 'mobile'
  | 'schedule'

export interface DevSpaceConversationContextMessage {
  role: string
  text: string
  label?: string
}

export interface DevSpaceConversationPreparation {
  task: string
  workspace?: string | null
  title?: string
  source?: DevSpaceConversationSource
  originalTool?: string
  context?: readonly DevSpaceConversationContextMessage[]
}

export type DevSpaceTranslate = (
  text: string,
  variables?: Record<string, string | number>,
) => string

export type DevSpaceWorkbenchReason =
  | 'loading'
  | 'unreadable'
  | 'uninstalled'
  | 'missing-configuration'
  | 'invalid-project'
  | 'empty-instructions'
  | 'mcp-stopped'
  | 'mcp-running'

export interface DevSpaceWorkbenchState {
  reason: DevSpaceWorkbenchReason
  canCopy: boolean
  canStartMcp: boolean
  executionReady: boolean
}

export type DevSpaceCopyOpenResult =
  | { ok: true }
  | { ok: false; stage: 'copy' | 'open'; error: unknown }

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
  models: { id: DevSpaceModel; label: string }[]
  defaultModel: DevSpaceModel
}

export interface DevSpaceTask {
  id: string
  status: DevSpaceTaskState
  target?: string
  provider?: string
  model?: string
  response?: string
  stale?: boolean
  error?: { code: string; message: string; retryable?: boolean }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function isDevSpaceTarget(value: unknown): value is DevSpaceTarget {
  return DEVSPACE_TARGETS.some(target => target === value)
}

export function isDevSpaceModel(value: unknown): value is DevSpaceModel {
  return DEVSPACE_MODELS.some(model => model.id === value)
}

export function devSpaceModelLabel(model?: string): string {
  return DEVSPACE_MODELS.find(item => item.id === model)?.label || model || '模型尚未記錄'
}

export function readDevSpaceModel(store?: Pick<Storage, 'getItem'>): DevSpaceModel {
  try {
    // Accessing the storage object itself can throw in restricted contexts.
    const storage = store ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    const value = storage?.getItem(MODEL_PREFERENCE)
    return isDevSpaceModel(value) ? value : DEFAULT_DEVSPACE_MODEL
  } catch { return DEFAULT_DEVSPACE_MODEL }
}

export function saveDevSpaceModel(model: DevSpaceModel): void {
  try { localStorage.setItem(MODEL_PREFERENCE, model) } catch { /* Keep the current selection even if storage is unavailable. */ }
}

/** Conversation instructions and workspace stay in memory; only the existing model preference is durable. */
export function createDevSpaceDraft(model: DevSpaceModel = readDevSpaceModel()): DevSpaceDraft {
  return { workspace: null, model, instructions: '' }
}

export function updateDevSpaceDraft(draft: DevSpaceDraft, patch: Partial<DevSpaceDraft>): DevSpaceDraft {
  return {
    workspace: patch.workspace === undefined ? draft.workspace : patch.workspace,
    model: patch.model === undefined ? draft.model : patch.model,
    instructions: patch.instructions === undefined ? draft.instructions : patch.instructions,
  }
}

/** "Clear draft" is intentionally narrow: keep the chosen project and model. */
export function clearDevSpaceInstructions(draft: DevSpaceDraft): DevSpaceDraft {
  return updateDevSpaceDraft(draft, { instructions: '' })
}

const DEVSPACE_CONTEXT_MESSAGES = 6
const DEVSPACE_CONTEXT_CHARS = 300

/** Only the smallest recent context needed for the new ChatGPT conversation is carried forward. */
export function boundedDevSpaceConversationContext(
  messages: readonly DevSpaceConversationContextMessage[] | undefined,
): DevSpaceConversationContextMessage[] {
  if (!Array.isArray(messages)) return []
  return messages
    .filter(message => message && typeof message.text === 'string' && !!message.text.trim())
    .slice(-DEVSPACE_CONTEXT_MESSAGES)
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: message.text.replace(/\s+/g, ' ').trim().slice(0, DEVSPACE_CONTEXT_CHARS),
      ...(typeof message.label === 'string' && message.label.trim()
        ? { label: message.label.trim().slice(0, 80) }
        : {}),
    }))
}

/**
 * Convert any coding entry point into text for ChatGPT Conversation. This does not resume or
 * submit a CLI job; it only prepares bounded project/context instructions for the user to paste.
 */
export function buildDevSpaceConversationInstructions(input: DevSpaceConversationPreparation): string {
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  const parts: string[] = [task]
  const source: string[] = []
  if (input.title?.trim()) source.push(`對話／工作：${input.title.trim().slice(0, 240)}`)
  if (input.originalTool?.trim()) source.push(`原紀錄工具：${input.originalTool.trim().slice(0, 80)}`)
  if (source.length) parts.push(`【來源摘要】\n${source.join('\n')}`)

  const context = boundedDevSpaceConversationContext(input.context)
  if (context.length) {
    const lines = context.map(message => {
      const who = message.label || (message.role === 'assistant' ? 'AI' : '使用者')
      return `${who}：${message.text}`
    })
    parts.push(`【近期必要背景】\n${lines.join('\n')}`)
  }

  parts.push('【執行路徑】\n這份內容只用來建立新的 ChatGPT「對話」或貼入目前的 ChatGPT 對話接續。請使用已加入的 DevSpace MCP 操作專案；不要恢復、重派或接力任何舊 CLI 工單，也不要使用 auto-handoff。')
  return parts.filter(Boolean).join('\n\n')
}

export function prepareDevSpaceConversationDraft(
  draft: DevSpaceDraft,
  input: DevSpaceConversationPreparation,
): DevSpaceDraft {
  const workspace = input.workspace === undefined ? draft.workspace : input.workspace
  return updateDevSpaceDraft(draft, {
    workspace,
    instructions: buildDevSpaceConversationInstructions(input),
  })
}

/** The exact text copied by desktop/mobile preparation UIs. It still requires a manual paste/send. */
export function buildDevSpaceConversationPrompt(
  draft: DevSpaceDraft,
  translate: DevSpaceTranslate = (text, variables) => Object.entries(variables || {})
    .reduce((result, [name, value]) => result.split(`{${name}}`).join(String(value)), text),
): string {
  const cwd = draft.workspace?.trim() || ''
  return `${translate('請在 ChatGPT「對話」模式完成以下工作，使用已連接的 DevSpace MCP；不要切到「工作」模式，也不要呼叫 agents run／continue。')}\n\n${translate('專案資料夾')}：${cwd}\n${translate('偏好模型（送出前請在 ChatGPT 選單確認）：{model}', { model: devSpaceModelLabel(draft.model) })}\n\n${draft.instructions.trim()}\n\n${translate('先呼叫 open_workspace 開啟指定專案，再使用 MCP 讀改檔案與執行必要指令。成果直接寫入本機專案，最後回覆成果路徑、驗證結果及未完成事項，供原派工者接手。')}`
}

/** A cancelled desktop picker must not erase a manually entered or previously chosen path. */
export function resolveDevSpaceDirectory(current: string | null, selected: string | null | undefined): string | null {
  return typeof selected === 'string' && !!selected.trim() ? selected : current
}

/** Opening ChatGPT is strictly sequenced after a successful clipboard write. */
export async function copyThenOpenDevSpace(
  copy: () => Promise<void>,
  open: () => Promise<void>,
): Promise<DevSpaceCopyOpenResult> {
  try { await copy() } catch (error) { return { ok: false, stage: 'copy', error } }
  try { await open() } catch (error) { return { ok: false, stage: 'open', error } }
  return { ok: true }
}

export function devSpaceDispatchBody(cwd: string, prompt: string, model: unknown, id?: string) {
  if (!isDevSpaceModel(model)) throw new Error('請選擇 GPT-5.6 SOL 或 GPT-6 ASTRA。')
  return id ? { cwd, id, prompt: prompt.trim(), model } : { cwd, target: 'codex', prompt: prompt.trim(), model }
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
  if (!Array.isArray(data.models) || !isDevSpaceModel(data.defaultModel)) {
    throw new Error('背景服務尚未支援模型選擇，請重新啟動新版控制台。')
  }
  const models = data.models.flatMap(value => {
    const model = record(value)
    return isDevSpaceModel(model.id) ? [{ id: model.id, label: devSpaceModelLabel(model.id) }] : []
  })
  if (!models.some(model => model.id === data.defaultModel)) throw new Error('DevSpace 回傳的狀態格式無法辨識，請重新整理。')
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
    models,
    defaultModel: data.defaultModel,
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
    ...(typeof task.provider === 'string' ? { provider: task.provider } : {}),
    ...(typeof task.model === 'string' ? { model: task.model } : {}),
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

/**
 * One explicit reason drives the headline, while flags keep preparation separate from execution.
 * A stopped MCP never blocks drafting or copying; it only means the pasted request cannot run yet.
 */
export function devSpaceWorkbenchState(
  status: DevSpaceStatus | null,
  statusError: string,
  cwd: string,
  instructions: string,
): DevSpaceWorkbenchState {
  const readable = !statusError && status !== null
  const installed = !!status && !statusError && status.installed
  const configured = !!status && installed && status.configured
  const projectValid = !!status && configured && withinDevSpaceRoots(cwd, status.allowedRoots)
  const hasInstructions = !!instructions.trim()
  const running = !!status && readable && status.service.running
  const canCopy = projectValid && hasInstructions
  const canStartMcp = configured && !running

  let reason: DevSpaceWorkbenchReason
  if (statusError) reason = 'unreadable'
  else if (!status) reason = 'loading'
  else if (!status.installed) reason = 'uninstalled'
  else if (!status.configured) reason = 'missing-configuration'
  else if (!projectValid) reason = 'invalid-project'
  else if (!hasInstructions) reason = 'empty-instructions'
  else reason = running ? 'mcp-running' : 'mcp-stopped'

  return { reason, canCopy, canStartMcp, executionReady: canCopy && running }
}

export function devSpaceRunProblem(status: DevSpaceStatus | null, cwd: string, target: string, prompt: string, model: string = DEFAULT_DEVSPACE_MODEL): string {
  if (!status) return '請先讀取 DevSpace 狀態。'
  if (!status.installed) return '請先安裝 DevSpace，再重新整理。'
  if (!status.configured) return '請先完成 DevSpace 設定，再重新整理。'
  if (!withinDevSpaceRoots(cwd, status.allowedRoots)) return '請選擇允許的工作目錄，或其中的子目錄。'
  if (target !== 'codex' || !status.targets.some(item => item.name === target)) return '請先在 DevSpace 啟用 Codex。'
  if (!isDevSpaceModel(model) || !status.models.some(item => item.id === model)) return '請選擇 GPT-5.6 SOL 或 GPT-6 ASTRA。'
  if (!prompt.trim()) return '請寫下要執行的工作。'
  if (prompt.length > 24000) return '請輸入 1 到 24,000 字的任務內容。'
  return ''
}

export const devSpaceTaskLabel = (state: DevSpaceTaskState): string => ({
  running: '執行中', completed: '已完成', failed: '執行失敗', stopped: '已停止',
}[state])

export async function devSpaceRequest(path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (path === 'run' || path === 'continue') {
    throw new Error('AI 控制台不再建立或接續 DevSpace 背景工作；請使用 ChatGPT「對話」＋ DevSpace MCP。')
  }
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
