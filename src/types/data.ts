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
  /** 來源工具自己標記的封存（目前只有 Codex 有這個旗標） */
  archived?: boolean
  /**
   * 控制台的垃圾桶：主畫面預設不顯示，但檔案完全沒動，隨時看得回來。
   * 規則在 tools/indexer.py 的 trash_reason()：
   *   archived        來源工具裡封存掉的
   *   not-active-tool 不是目前在用的那幾個 CLI
   *   stale           太久沒有動過
   */
  trashed?: boolean
  trashReason?: 'archived' | 'not-active-tool' | 'stale' | ''
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
  stats: {
    total: number; subagent: number; duplicates?: number; dispatch?: number
    unique?: number; elapsed_sec: number
    /** 來源工具裡已封存的份數 */
    archived?: number
    /** 被垃圾桶規則收起來的份數 */
    trashed?: number
  }
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
  /**
   * 伺服器導出的真正狀態。
   *   running 執行中 / waiting 終端還沒被跑起來 / done 完成
   *   failed  跑起來但 log 裡有失敗訊息 / silent 跑完卻沒有任何輸出
   * 原本只有 alive 一個布林值，畫面只分得出「執行中」跟「不是執行中」，
   * 於是跑完的、失敗的、還沒按下去的全部長一樣。
   */
  state?: 'running' | 'waiting' | 'done' | 'failed' | 'silent'
  result?: string
  reply?: string
  /** 執行中的最後一行輸出。看得到它在變，才知道還活著 */
  tail?: string
  logSize?: number
  /** 這是哪一件的接續 */
  followupOf?: string
  /** 排隊中、等這一輪結束才送出的補充 */
  pending?: string[]
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
