// 共用 AI 工具就緒度判讀（純函式，無 DOM／無網路）。
// 契約重點：ready 只代表「允許嘗試送出」，不等於已登入、也不等於還有額度；
// 任何缺漏、型別不符、重複 id 或過期 auto 一律 fail closed，且永不退回本地模型。

export interface ReadinessTool {
  id: string
  label: string
  mode?: string
  ready?: unknown
  limited?: unknown
  state?: unknown
  readiness?: unknown
  authStatus?: unknown
  reason?: string
}

export interface ReadinessSnapshot {
  ok: boolean
  tools: ReadinessTool[]
  auto: string | null
  ready: boolean
  reason: string
}

const KNOWN_MODES = new Set(['headless', 'terminal', 'local'])
// 可嘗試送出的狀態；prepare_on_send 只是 readiness 欄位別名，不是合法 state
const ATTEMPT_STATES = new Set(['ready', 'needs_start', 'login_unverified'])
const SETUP_STATES = new Set(['missing_tool', 'needs_model'])
const BLOCKED_STATES = new Set(['limited', 'error', 'offline', 'disabled', 'unavailable', 'blocked'])

const PARSE_FAIL_REASON = '工具狀態讀不到（回覆格式不正確）'
const NO_AUTO_REASON = '目前沒有可自動派工的工具'

type Kind = 'limited' | 'unknown' | 'setup' | 'blocked' | 'attemptable'
interface Verdict {
  kind: Kind
  state: string
  mode: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 單一判讀閘門，標籤／色調／派工共用，避免各處重複實作條件。 */
function classify(tool: ReadinessTool | null | undefined): Verdict {
  const state = str(tool?.state)
  const mode = str(tool?.mode)
  if (!tool || typeof tool !== 'object') return { kind: 'unknown', state, mode }
  if (tool.limited === true) return { kind: 'limited', state, mode }
  // 旗標必須是真布林（字串 'true' 不算），模式也必須是已知模式
  if (typeof tool.ready !== 'boolean' || tool.limited !== false || !KNOWN_MODES.has(mode)) {
    return { kind: 'unknown', state, mode }
  }
  if (tool.ready === true) {
    return { kind: ATTEMPT_STATES.has(state) ? 'attemptable' : 'unknown', state, mode }
  }
  if (SETUP_STATES.has(state)) return { kind: 'setup', state, mode }
  if (BLOCKED_STATES.has(state) || ATTEMPT_STATES.has(state)) return { kind: 'blocked', state, mode }
  return { kind: 'unknown', state, mode }
}

/**
 * 是否允許送出（前端擋門，後端仍會即時複查）。
 * requested='auto' 時只採用伺服器給的 auto（不猜、不 fallback）；auto 不得選終端機模式。
 */
export function canDispatch(
  requested: string,
  tools: readonly ReadinessTool[],
  auto: string | null | undefined,
): boolean {
  if (typeof requested !== 'string' || !requested.trim() || !Array.isArray(tools)) return false
  const wantAuto = requested.trim() === 'auto'
  const id = wantAuto ? str(auto).trim() : requested.trim()
  if (!id || id === 'auto') return false
  const rows = tools.filter((row) => !!row && typeof row === 'object' && str(row.id).trim() === id)
  if (rows.length !== 1) return false // 找不到、或 id 重複無法辨識 → fail closed
  const verdict = classify(rows[0])
  if (verdict.kind !== 'attemptable') return false
  if (wantAuto && verdict.mode === 'terminal') return false
  return true
}

/** 解析後端 readiness 快照；形狀不合就整份作廢，不做物件渲染或型別強制轉換。 */
export function parseDispatchReadiness(raw: unknown): ReadinessSnapshot {
  const fail = (reason = PARSE_FAIL_REASON): ReadinessSnapshot => ({
    ok: false,
    tools: [],
    auto: null,
    ready: false,
    reason,
  })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail()
  const body = raw as Record<string, unknown>
  if (body.ok !== true || !Array.isArray(body.tools)) return fail()

  const tools: ReadinessTool[] = []
  const seen = new Set<string>()
  for (const item of body.tools) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail()
    const row = item as Record<string, unknown>
    const id = str(row.id).trim()
    const label = str(row.label).trim()
    if (!id || !label || seen.has(id)) return fail()
    seen.add(id)
    // 只保留可公開顯示的字串／布林欄位；缺漏者留空 → 之後判為「狀態未確認」
    const norm: ReadinessTool = { id, label }
    if (typeof row.mode === 'string') norm.mode = row.mode
    if (typeof row.ready === 'boolean') norm.ready = row.ready
    if (typeof row.limited === 'boolean') norm.limited = row.limited
    if (typeof row.state === 'string') norm.state = row.state
    if (typeof row.readiness === 'string') norm.readiness = row.readiness
    if (typeof row.authStatus === 'string') norm.authStatus = row.authStatus
    if (typeof row.reason === 'string') norm.reason = row.reason
    tools.push(norm)
  }

  // 頂層 ready 若有給就必須是布林 true；false 或型別不符即視為矛盾，一律不升級 auto（列仍可見）
  const topReadyBlocks = body.ready !== undefined && body.ready !== true
  const rawAuto = str(body.auto).trim()
  const auto = !topReadyBlocks && rawAuto && canDispatch('auto', tools, rawAuto) ? rawAuto : null
  const reason = typeof body.reason === 'string' ? body.reason : auto ? '' : NO_AUTO_REASON
  return { ok: true, tools, auto, ready: auto !== null, reason }
}

/** 未翻譯的中文狀態字樣；絕不對未驗證登入的 CLI 宣稱「已就緒」。 */
export function toolReadinessLabel(tool: ReadinessTool): string {
  const v = classify(tool)
  if (v.kind === 'limited') return '額度用完'
  if (v.kind === 'unknown') return '狀態未確認'
  if (v.kind === 'setup') return '尚未設定'
  if (v.kind === 'blocked') return '目前無法使用'
  if (v.state === 'needs_start') return '送出時準備'
  if (v.state === 'login_unverified') return '已找到工具，登入待確認'
  if (v.mode === 'local' && v.state === 'ready') return '已就緒'
  return '可嘗試執行'
}

/** 色調：只有本地且真正就緒才給綠燈，其餘可嘗試者為中性灰。 */
export function toolReadinessTone(tool: ReadinessTool): 'ready' | 'neutral' | 'blocked' | 'unknown' {
  const v = classify(tool)
  if (v.kind === 'limited' || v.kind === 'setup' || v.kind === 'blocked') return 'blocked'
  if (v.kind === 'unknown') return 'unknown'
  return v.mode === 'local' && v.state === 'ready' ? 'ready' : 'neutral'
}
