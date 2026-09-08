// 繼續工作對話框共用的純函式（無 DOM／無網路）。
import type { ReadinessTool } from '@/lib/aiReadiness'
import { canDispatch } from '@/lib/aiReadiness'
import type { Msg } from '@/lib/workOrder'

/** 這份對話能不能走「繼續工作」流程（handler 與對話框都要守）。 */
export function canOpenContinueWork(conv: {
  readOnly?: boolean
  sourceKind?: string
} | null | undefined): boolean {
  if (!conv) return false
  if (conv.readOnly) return false
  if (conv.sourceKind === 'discovered') return false
  return true
}

export function continueWorkBlockedReason(conv: {
  readOnly?: boolean
  sourceKind?: string
} | null | undefined): string | null {
  if (!conv) return '找不到對話'
  if (conv.readOnly || conv.sourceKind === 'discovered') {
    return '匯入的對話僅供閱讀，請在原本的 AI 操作。'
  }
  return null
}

export type TerminalResumeKind = 'session_resume' | 'project_only' | 'unsupported'

/** 原工具終端機接續行為（依目前伺服器 launch 路由，不臆測 AGY）。 */
export function terminalResumeKind(tool: string): TerminalResumeKind {
  const id = tool.trim().toLowerCase()
  if (id === 'claude' || id === 'codex' || id === 'kimi') return 'session_resume'
  if (id === 'grok' || id === 'qwen' || id === 'cursor') return 'project_only'
  return 'unsupported'
}

export function terminalResumeExplanation(tool: string): string {
  const kind = terminalResumeKind(tool)
  if (kind === 'session_resume') {
    return '目前伺服器會帶入命名工作階段的接續指令（resume／-r）。開啟後仍可能看到英文選單，需要你在終端機裡確認。'
  }
  if (kind === 'project_only') {
    return '目前伺服器只會在原專案目錄開啟這個工具，不保證回到舊工作階段。開啟後仍可能看到英文選單，需要你在終端機裡確認。'
  }
  return '這個工具目前沒有受支援的接續方式；請改用上方中文工作區派工，或回來源應用操作。'
}

/** 終端機常見英文選單與安全決策（雙語標籤供對照）。 */
export function terminalMenuSafetyTips(): string[] {
  return [
    '外部終端機的選單可能仍是英文；方向鍵與 Enter 是常見操作，但各工具可能不同。',
    'Login／Sign in（登入）：只登入你自己的官方帳號。',
    'Select model（選模型）：選你打算使用的模型；不確定就先取消。',
    'Trust folder／Allow once／Always allow（信任資料夾／允許一次／永遠允許）：只信任你認得的專案；看懂動作後才按 Allow once；不要隨便 Always allow 或關閉沙箱。',
    'Payment／Upgrade（付款／升級）：除非你打算付費，不要選付費或升級方案。',
  ]
}

export function isHeadlessRow(row: ReadinessTool | null | undefined): boolean {
  return !!row && row.mode === 'headless'
}

/** 新手對話框：只保留真正無頭的工具列。 */
export function filterHeadlessDispatchTools(tools: readonly ReadinessTool[]): ReadinessTool[] {
  return tools.filter((row) => isHeadlessRow(row))
}

/**
 * 初始工具：優先 initialTool，不可用時不悄悄換人（留給 UI 顯示原因）。
 * 沒指定時才走 auto，再不行取第一個可用無頭工具。
 */
export function pickInitialHeadlessTool(
  initialTool: string | undefined,
  tools: readonly ReadinessTool[],
  auto: string | null | undefined,
): string {
  const headless = filterHeadlessDispatchTools(tools)
  const prefer = (initialTool || '').trim()
  if (prefer && prefer !== 'auto') return prefer
  if (canDispatch('auto', headless, auto)) return 'auto'
  const first = headless.find((row) => canDispatch(row.id, headless, auto))
  return first?.id || prefer || 'auto'
}

/** 確認視窗要顯示的實際收件人名稱。 */
export function resolveDispatchRecipientLabel(
  tool: string,
  tools: readonly ReadinessTool[],
  auto: string | null | undefined,
): string {
  if (tool === 'auto') {
    const id = auto || ''
    return tools.find((row) => row.id === id)?.label || id || '自動'
  }
  return tools.find((row) => row.id === tool)?.label || tool
}

const CTX_MSGS = 6
const CTX_CHARS = 300

/** 對話背景：最多 6 則、每則 300 字，與工單組裝一致。 */
export function normalizeContextMessages(
  messages: readonly { role?: string; text?: string }[] | null | undefined,
): Msg[] {
  if (!messages?.length) return []
  const out: Msg[] = []
  for (const raw of messages.slice(-CTX_MSGS)) {
    if (!raw || typeof raw !== 'object') continue
    const text = typeof raw.text === 'string' ? raw.text : ''
    out.push({
      role: raw.role === 'assistant' ? 'assistant' : 'user',
      text: text.slice(0, CTX_CHARS),
    })
  }
  return out
}

/** 晚到的上下文／launch 結果不能蓋掉已關閉或已換掉的對話。 */
export function ownsContinuationContext(input: {
  requestSeq: number
  requestId: number
  conversationId: string
  activeId: string | null
  open: boolean
}): boolean {
  return input.open
    && input.requestSeq === input.requestId
    && input.activeId === input.conversationId
}
