export interface HubProject {
  project_id: string
  title: string
  status: string
  updated_at: string
  updated_by: string
  next_step: string
  needs_handoff: boolean
}

export interface ToolStatus {
  label: string
  status: string
  last_active: string
  rate_limited: boolean
  role: string
  evidence?: string
  /** 額度恢復時間（由 /api/status 從派工 log 解析，顯示成 MM/DD HH:MM）*/
  reset_at?: string
}

export interface ConversationSummary {
  id: string
  tool: string
  toolLabel: string
  sessionId: string
  title: string
  project: string
  projectDir: string
  path: string
  size: number
  mtime: number
  lastTs: string
  msgCount: number
  subagent: boolean
  dispatch?: boolean
  resume: string
  hasMessages: boolean
  dup?: boolean
  dupOf?: string
  dupOfTool?: string
  dupCount?: number
}

export interface IndexData {
  generated_at: string
  projects: HubProject[]
  tools: Record<string, ToolStatus>
  projectTitles: Record<string, string>
  conversations: ConversationSummary[]
  stats: { total: number; subagent: number; duplicates?: number; dispatch?: number; unique?: number; elapsed_sec: number }
}

/** /api/dispatches 回傳的派工紀錄 */
export interface DispatchRecord {
  id: string
  tool: string
  task: string
  started: string
  log: string
  mode: 'headless' | 'sync' | 'terminal'
  pid?: number | null
  alive?: boolean
  result?: string
  reply?: string
}

export interface Message {
  role: string
  text: string
  ts: string
}

export interface ConversationDetail {
  id: string
  tool: string
  title: string
  messages: Message[]
  truncated: boolean
}
