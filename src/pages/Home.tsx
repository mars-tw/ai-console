/* eslint-disable react-refresh/only-export-components -- 新手路由與搜尋規則需有聚焦單元測試 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConversationDetail, ConversationSummary, IndexData } from '@/types/data'
import Adventure from '@/components/Adventure'
import AskAI from '@/components/AskAI'
import Console from '@/components/Console'
import ConversationSync from '@/components/ConversationSync'
import Office from '@/components/Office'
import QuickDispatch from '@/components/QuickDispatch'
import SkillCenter from '@/components/SkillCenter'
import { t, useLang } from '@/i18n'
import LangSwitch from '@/components/LangSwitch'

/** python 存的是秒，JS 要毫秒。純函式，跟元件狀態無關，所以放在模組層級 */
const normalize = (d: IndexData): IndexData => {
  d.conversations.forEach((c) => { if (c.mtime < 1e12) c.mtime *= 1000 })
  return d
}

const STATUS_DOT: Record<string, string> = {
  active: 'bg-emerald-500',
  idle: 'bg-mute',
  rate_limited: 'bg-red-500',
  unknown: 'bg-elev2',
}
const STATUS_LABEL: Record<string, string> = { active: '活躍', idle: '閒置', rate_limited: '限流中', unknown: '未知' }
const PROJ_BADGE: Record<string, { label: string; cls: string }> = {
  active: { label: '進行中', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
  blocked: { label: '阻塞', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
  waiting: { label: '等待中', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' },
  done: { label: '完成', cls: 'bg-elev text-mute2' },
}

const WEEK_MS = 7 * 86400 * 1000
const SOURCE_MANAGED_DELETE_TOOLS = new Set(['codex', 'qwen', 'kimi'])

export const BEGINNER_ACTIONS = [
  '找回舊對話',
  '直接問 AI',
  '交給 AI 執行',
  '管理 AI 技能',
] as const

export function originalAiActionLabel(): string {
  return '在原本的 AI 開啟'
}

interface ConversationFilters {
  showTrash: boolean
  showSubagent: boolean
  showDup: boolean
  showOld: boolean
  showDispatch: boolean
  onlyCJK: boolean
  cutoff: number
}

/** 搜尋結果也要說實話：這個函式是「目前過濾條件看不看得到」的單一準則。 */
export function conversationPassesFilters(
  conversation: ConversationSummary,
  filters: ConversationFilters,
  kept = false,
): boolean {
  const inTrash = Boolean(conversation.trashed) && !kept
  if (filters.showTrash !== inTrash) return false
  if (!filters.showSubagent && conversation.subagent) return false
  if (!filters.showDup && conversation.dup) return false
  if (!conversation.inApp && !filters.showOld && conversation.mtime < filters.cutoff) return false
  // 來源桌面側欄明確存在的對話比推測式 dispatch 分類更權威。
  if (!conversation.inApp && !filters.showDispatch && conversation.dispatch) return false
  if (filters.onlyCJK && !HAS_CJK.test(conversation.title)) return false
  return true
}

export function conversationMatchesSearch(conversation: ConversationSummary, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return conversation.title.toLowerCase().includes(q)
    || conversation.path.toLowerCase().includes(q)
    || conversation.projectDir.toLowerCase().includes(q)
}

/** 系統指令和 worker 封包不是新手想找的對話摘要，但原資料仍完整保留。 */
export function beginnerSearchSnippets<T extends { role: string; text: string }>(snippets: T[]): T[] {
  const technical = /^(?:<system|<environment_context|<developer|message type:|task_id:|#\s*agents\.md|you are an agent in a team)/i
  return snippets.filter((snippet) => (
    (snippet.role === 'user' || snippet.role === 'assistant') && !technical.test(snippet.text.trim())
  ))
}

export function shouldShowSearchNoResults(
  titleCount: number,
  contentCount: number,
  hiddenCount: number,
  busy: boolean,
  contentUnavailable = false,
): boolean {
  return !busy && !contentUnavailable
    && titleCount === 0 && contentCount === 0 && hiddenCount === 0
}

function canDeleteFromConsole(c: ConversationSummary): boolean {
  return !SOURCE_MANAGED_DELETE_TOOLS.has(c.tool)
}

const TAIL_ERROR_TEXT: Record<string, string> = {
  invalid_id: '索引裡找不到這個對話',
  not_found: '索引裡找不到這個對話',
  index_missing: '對話索引無法讀取，請重新掃描',
  index_too_large: '對話索引無法讀取，請重新掃描',
  index_invalid: '對話索引無法讀取，請重新掃描',
  source_missing: '對話來源無法安全讀取',
  unsafe_source: '對話來源無法安全讀取',
  source_read_failed: '對話來源無法安全讀取',
  unsupported_format: '這個工具的對話格式目前不支援',
  unparseable_format: '對話尾端沒有可解析的使用者或助理訊息',
  incomplete_tail: '對話尾端尚未寫完或超過安全上限',
}

function tailErrorText(code?: string): string {
  return t(TAIL_ERROR_TEXT[code || ''] || '無法讀取最新訊息')
}

function relTime(msOrIso: number | string): string {
  const ms = typeof msOrIso === 'number' ? msOrIso : new Date(msOrIso).getTime()
  if (!ms || Number.isNaN(ms)) return ''
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 3600) return t('{n} 分鐘前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小時前', { n: Math.floor(s / 3600) })
  return t('{n} 天前', { n: Math.floor(s / 86400) })
}

function fmtSize(bytes: number): string {
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)}MB`
  if (bytes > 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

function folderName(dir: string): string {
  if (!dir) return t('（無目錄）')
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || dir
}

/** 讀某個對話的本機聊天暫存。壞掉就當成空的，不要讓整頁炸掉 */
function readChatCache(id?: string): { role: string; text: string }[] {
  if (!id) return []
  try {
    const saved = localStorage.getItem('ac_chat_' + id)
    return saved ? JSON.parse(saved) : []
  } catch { return [] }
}

/** 標題裡有沒有中文 */
const HAS_CJK = /[\u4e00-\u9fff]/

/**
 * \u628a\u6458\u8981\u88e1\u547d\u4e2d\u7684\u90a3\u4e00\u6bb5\u6a19\u51fa\u4f86\u3002
 *
 * \u6458\u8981\u524d\u5f8c\u5404\u7559 60 \u5b57\u624d\u770b\u5f97\u51fa\u4e0a\u4e0b\u6587\uff0c\u4f46\u4e5f\u56e0\u6b64\u4e00\u773c\u6383\u4e0d\u5230\u95dc\u9375\u5b57\u5728\u54ea \u2014\u2014
 * \u6a19\u51fa\u4f86\u4e4b\u5f8c\u624d\u662f\u300c\u6383\u4e00\u773c\u5c31\u77e5\u9053\u662f\u4e0d\u662f\u9019\u4e00\u4efd\u300d\uff0c\u4e0d\u7136\u9084\u662f\u5f97\u9010\u5b57\u8b80\u3002
 *
 * \u7528\u9663\u5217\u62fc React \u7bc0\u9ede\u800c\u4e0d\u662f innerHTML\uff1a\u67e5\u8a62\u5b57\u4e32\u662f\u4f7f\u7528\u8005\u6253\u7684\uff0c
 * \u7d44 HTML \u5c31\u7b49\u65bc\u958b\u4e00\u500b\u6ce8\u5165\u7684\u53e3\u5b50\uff0c\u800c\u9019\u88e1\u5b8c\u5168\u4e0d\u9700\u8981\u90a3\u500b\u98a8\u96aa\u3002
 */
function markHits(text: string, q: string): ReactNode[] {
  const needle = q.trim()
  if (!needle) return [text]
  const lower = text.toLowerCase()
  const target = needle.toLowerCase()
  const out: ReactNode[] = []
  let i = 0
  let n = 0
  for (;;) {
    const at = lower.indexOf(target, i)
    // \u4e0a\u9650\u53ea\u662f\u9632\u5446\uff1a\u6458\u8981\u672c\u4f86\u5c31\u53ea\u6709\u4e00\u767e\u591a\u5b57\uff0c\u6a19\u8a18\u591a\u5230 20 \u500b\u4ee3\u8868\u51fa\u4e86\u602a\u4e8b
    if (at < 0 || n > 20) { out.push(text.slice(i)); break }
    if (at > i) out.push(text.slice(i, at))
    out.push(
      <mark key={n} className="rounded-sm bg-amber-300 px-0.5 font-medium text-ink dark:bg-amber-400/45">
        {text.slice(at, at + needle.length)}
      </mark>,
    )
    i = at + needle.length
    n += 1
  }
  return out
}

export default function Home() {
  useLang()   // 語言一換就整頁重繪
  const [index, setIndex] = useState<IndexData | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showSubagent, setShowSubagent] = useState(() => localStorage.getItem('ac_showSub') === '1')
  const [showDup, setShowDup] = useState(() => localStorage.getItem('ac_showDup') === '1')
  const [showOld, setShowOld] = useState(() => localStorage.getItem('ac_showOld') === '1')
  const [showDispatch, setShowDispatch] = useState(() => localStorage.getItem('ac_showDisp') === '1')
  /**
   * 只顯示標題有中文的對話。
   *
   * 剩下那批機器迴圈（Codex 的 agent loop）標題長得像
   * row_kind,id,post_type… 或 == tables ==，怎麼列規則都追不完，
   * 但它們有一個共同點：沒有中文。而使用者真正開的對話全部是中文的。
   * 做成開關而不是寫進索引器 —— 那是使用習慣不是資料性質，
   * 寫死的話哪天用英文開一個對話就會憑空消失而且找不到原因。
   */
  const [onlyCJK, setOnlyCJK] = useState(() => localStorage.getItem('ac_onlyCJK') !== '0')
  /** 打開垃圾桶：看被規則收起來的那些 */
  const [showTrash, setShowTrash] = useState(false)
  /**
   * 手動留回來的對話 id。
   * 垃圾桶是規則算出來的，不是逐筆存的狀態 —— 所以「還原」不能去改索引，
   * 只能在這裡記一個豁免名單。規則之後改了，這些照樣留著。
   */
  const [kept, setKept] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem('ac_kept') || '[]') as string[]),
  )
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  /**
   * 選取的對話只存 id，實體從索引推導。
   *
   * 原本存整個物件，於是「重新整理後還原上次選取」得靠一個 effect：
   * 等索引載進來 → 找出那一筆 → setState。那是典型的 derived state，
   * 多一次 render 不說，索引更新後手上那份還會是舊的副本。
   */
  /** 目前聊天串屬於哪一個對話。跟 selectedId 不同步時就重置 */
  const [chatFor, setChatFor] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(
    () => localStorage.getItem('ac_selected'),
  )
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailTailState, setDetailTailState] = useState<'none' | 'latest' | 'fallback'>('none')
  const [detailTailError, setDetailTailError] = useState('')
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const [copied, setCopied] = useState('')
  const [apiOk, setApiOk] = useState(false)
  const [liveTools, setLiveTools] = useState<IndexData['tools'] | null>(null)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [chatModel, setChatModel] = useState('auto')
  const [routeInfo, setRouteInfo] = useState('')
  const [routedModel, setRoutedModel] = useState('')
  const [chatMsgs, setChatMsgs] = useState<{ role: string; text: string }[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  /** 地端推論已經等了幾秒。沒有這個數字，畫面只有一行不會動的「思考中…」 */
  const [chatSecs, setChatSecs] = useState(0)
  /** 這一次請求的中止把手。放 ref 是因為送出與取消是兩次不同的 render */
  const chatAbort = useRef<AbortController | null>(null)
  /** 每次送出／換對話都遞增；舊回應即使晚到，也不能寫進新對話。 */
  const chatRequestSeq = useRef(0)
  const selectedIdRef = useRef<string | null>(selectedId)
  selectedIdRef.current = selectedId
  /** 訊息捲動容器，與「使用者是不是往上捲離開底部了」 */
  const msgBoxRef = useRef<HTMLDivElement>(null)
  const [awayFromEnd, setAwayFromEnd] = useState(false)
  /**
   * 對話內容的搜尋結果。
   *
   * 側欄原本的搜尋只比對標題、路徑與專案目錄 —— 但人真正記得的往往是
   * 「我那時候在哪一段對話裡討論過 CP950」，不是那段對話當初被工具
   * 自動命名成什麼。標題是工具取的，常常跟內容沒關係。
   *
   * 這是後端掃出來的（/api/search，實測 646 份 12 MB 掃一次 ~55 ms），
   * 跟標題比對分開顯示：標題找不到的時候，內容命中一定要看得見，
   * 否則使用者會直接下結論「沒有這段對話」然後放棄。
   */
  const [contentHits, setContentHits] = useState<{ id: string; snippets: { role: string; text: string }[] }[]>([])
  const [contentBusy, setContentBusy] = useState(false)
  const [contentTruncated, setContentTruncated] = useState(false)
  const [contentSearchUnavailable, setContentSearchUnavailable] = useState(false)
  const [contentSearchPartial, setContentSearchPartial] = useState(false)
  const [contentQuery, setContentQuery] = useState('')
  const [searchRevealAll, setSearchRevealAll] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  /** id → 對話。內容搜尋只回 id 與摘要，標題與工具名要從索引補回來 */
  const contentById = useMemo(
    () => new Map((index?.conversations ?? []).map((c) => [c.id, c])),
    [index],
  )
  const [viewMode, setViewMode] = useState<'list' | 'ask' | 'console' | 'office' | 'rpg' | 'skills'>('list')
  const [syncOpen, setSyncOpen] = useState(false)
  /**
   * 側欄開合。
   *
   * 在「📋 對話」以外的分頁預設收起來 —— 那三個分頁跟對話清單沒有關係，
   * 但側欄照樣佔走 320px（1440 寬的視窗有 22%）。
   * 記在 localStorage：使用者在主控台把它拉回來過一次，
   * 下次就不該再幫他收起來，那會變成跟他作對。
   */
  const [sidebarPref, setSidebarPref] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('ac_sidebar') || '{}') } catch { return {} }
  })
  const sidebarOpen = sidebarPref[viewMode]
    ?? (viewMode === 'list' && (typeof window === 'undefined' || window.innerWidth >= 640))
  const setSidebarOpen = (v: boolean) => {
    setSidebarPref((s) => {
      const next = { ...s, [viewMode]: v }
      try { localStorage.setItem('ac_sidebar', JSON.stringify(next)) } catch { /* 存不了不影響使用 */ }
      return next
    })
  }
  // 只顯示最近幾天有活動的資料夾。142 個資料夾裡今天只用過 25 個，
  // 全部列出來等於什麼都找不到。0 = 不限。
  const [activeDays, setActiveDays] = useState(() => Number(localStorage.getItem('ac_activeDays') ?? 7))
  const [deleted, setDeleted] = useState<Set<string>>(new Set())
  useEffect(() => { localStorage.setItem('ac_activeDays', String(activeDays)) }, [activeDays])

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 4000) }

  /** 換對話要當下中止地端請求，並讓任何已經在回程上的舊結果失效。 */
  const selectConversation = (id: string | null) => {
    if (id === selectedIdRef.current) return
    selectedIdRef.current = id
    chatRequestSeq.current += 1
    chatAbort.current?.abort()
    chatAbort.current = null
    setChatBusy(false)
    setChatSecs(0)
    setRouteInfo('')
    setSelectedId(id)
    setSyncOpen(false)
  }

  useEffect(() => { localStorage.setItem('ac_showSub', showSubagent ? '1' : '0') }, [showSubagent])
  useEffect(() => { localStorage.setItem('ac_showDup', showDup ? '1' : '0') }, [showDup])
  useEffect(() => { localStorage.setItem('ac_showOld', showOld ? '1' : '0') }, [showOld])
  useEffect(() => { localStorage.setItem('ac_showDisp', showDispatch ? '1' : '0') }, [showDispatch])
  useEffect(() => { localStorage.setItem('ac_kept', JSON.stringify([...kept])) }, [kept])
  useEffect(() => { localStorage.setItem('ac_onlyCJK', onlyCJK ? '1' : '0') }, [onlyCJK])

  /**
   * 控制 API 還活著嗎。
   *
   * 原本這件事只在掛載時做一次。後端之後掛掉（被關掉、當掉、或它本來就是
   * 另一個行程起的）畫面完全不知道 —— 「↻ 重新掃描」「▶ 派工」全部還亮著，
   * 按下去才一個一個失敗，而「控制 API 離線（檢視模式）」那行提示
   * 從來不會出現。提示的機制早就寫好了，只是永遠不會被觸發。
   *
   * 這是實際發生過的情境：桌面版的後端是它自己起的 python 子行程，
   * 那個行程一結束，畫面看起來還是好的。
   *
   * 20 秒一次。/api/health 只回一個時間戳，成本可以忽略；
   * 而按鈕亮著卻按不動的每一秒，都是在騙使用者。
   */
  const checkApi = useCallback(() => {
    fetch('/api/health').then((r) => {
      if (!r.ok) { setApiOk(false); return }
      setApiOk(true)
      fetch('/api/status').then((r2) => r2.ok ? r2.json() : null)
        .then((d) => d?.tools && setLiveTools(d.tools)).catch(() => {})
      fetch('/api/models').then((r3) => r3.ok ? r3.json() : null)
        .then((d) => {
          if (d?.models?.length) setModels(d.models)
        }).catch(() => {})
    }).catch(() => setApiOk(false))
  }, [])

  useEffect(() => {
    checkApi()
    const timer = setInterval(checkApi, 20000)
    return () => clearInterval(timer)
  }, [checkApi])

  /**
   * 全域快捷鍵。
   *
   * 這是一個會整天開著、裡面有上千份對話的工具，但真正做事的三個分頁
   * 一個快捷鍵都沒有（只有冒險分頁有）。每次要找東西都得先把手移到滑鼠、
   * 點到搜尋框 —— 一天幾十次。
   *
   * 刻意只做四件事，不做一整套組合鍵：記不住的快捷鍵等於不存在。
   *   /        跳到搜尋
   *   Esc      清掉搜尋（在搜尋框裡）
   *   Ctrl+1~6 切分頁
   *   Ctrl+B   收合／展開側欄
   *
   * 在輸入框裡時完全不攔截，除了 Ctrl 組合 —— 打字打到一半被搶走焦點
   * 是最讓人火大的一種「貼心」。
   */
  /**
   * 快捷鍵要動到的東西放 ref，每次 render 更新。
   *
   * 第一版把 sidebarOpen 放進相依、直接用閉包裡的值 —— 實測 Ctrl+B 在
   * 辦公室分頁沒作用：sidebarOpen 從 list 切到 console 時 true→false 觸發一次
   * 重掛，之後 console→office 兩邊都是 false，effect 不會再重掛，
   * 於是閉包裡的 viewMode 停在 'console'。在辦公室按 Ctrl+B，
   * 改到的是主控台的偏好，畫面上什麼都不會發生。
   *
   * 這是典型的「為了少掛一次監聽，換來一個只在特定切換順序下才出現的 bug」。
   * 監聽只掛一次，動作永遠讀最新的 —— 兩邊都要。
   */
  const keyActions = useRef({ sidebarOpen, setSidebarOpen, setViewMode })
  keyActions.current = { sidebarOpen, setSidebarOpen, setViewMode }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = keyActions.current
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
        || el.tagName === 'SELECT' || el.isContentEditable)
      if (e.ctrlKey || e.metaKey) {
        if (e.key >= '1' && e.key <= '6') {
          e.preventDefault()
          a.setViewMode((['list', 'ask', 'console', 'office', 'rpg', 'skills'] as const)[Number(e.key) - 1])
          return
        }
        if (e.key.toLowerCase() === 'b') { e.preventDefault(); a.setSidebarOpen(!a.sidebarOpen) }
        return
      }
      if (typing) return
      if (e.key === '/') {
        e.preventDefault()
        // 已經在畫面上就直接聚焦，不要繞一圈
        if (searchRef.current) { searchRef.current.focus(); return }
        a.setSidebarOpen(true)
        // 側欄剛展開時輸入框還沒進 DOM，等下一輪事件迴圈。
        // 這裡刻意用 setTimeout 而不是 requestAnimationFrame ——
        // rAF 在分頁不可見時不會觸發，焦點會安靜地沒有移動過去，
        // 而「安靜地沒發生」是最難查的一種壞法。
        setTimeout(() => searchRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * 邊打邊搜對話內容。
   *
   * 250ms 的延遲不是為了省伺服器（一次只要 ~55 ms），是為了不要在使用者
   * 還在打字的時候一直換答案 —— 結果清單在眼前跳動比慢一點更難用。
   * 每次重打都中止上一次：不然打字快的時候，先發的請求可能後到，
   * 把舊查詢的結果蓋在新查詢上面。
   */
  useEffect(() => {
    const q = search.trim()
    setContentHits([])
    setContentTruncated(false)
    setContentSearchUnavailable(false)
    setContentSearchPartial(false)
    setContentQuery(q)
    if (q.length < 2) { setContentBusy(false); return }
    if (!apiOk) {
      setContentBusy(false)
      setContentSearchUnavailable(true)
      return
    }
    const ac = new AbortController()
    setContentBusy(true)
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ac.signal })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((d) => {
          if (!d?.ok) throw new Error(d?.error || 'content search unavailable')
          if (ac.signal.aborted) return
          setContentHits(d.hits || [])
          setContentTruncated(Boolean(d.truncated))
          setContentSearchPartial(Boolean(d.partial))
          setContentSearchUnavailable(false)
        })
        .catch(() => {
          if (!ac.signal.aborted) {
            setContentHits([])
            setContentTruncated(false)
            setContentSearchPartial(false)
            setContentSearchUnavailable(true)
          }
        })
        .finally(() => { if (!ac.signal.aborted) setContentBusy(false) })
    }, 250)
    return () => { clearTimeout(timer); ac.abort() }
  }, [search, apiOk])

  // useCallback + 空相依：底下每 60 秒的輪詢把這個函式收進 setInterval 的閉包，
  // 每次 render 重新產生一份的話，計時器會一直握著第一次那份。
  // 它現在只用到 setIndex（本來就穩定）跟模組層級的 normalize，所以空相依是對的。
  const reloadIndex = useCallback(() => {
    fetch('/data/index.json', { cache: 'no-cache' })
      .then((r) => {
        if (r.status === 304) return null
        if (!r.ok) return null
        return r.json()
      })
      .then((d) => {
        if (d) setIndex(normalize(d))
      })
      .catch(() => {})
  }, [])

  // 每 60 秒輪詢索引與即時狀態（自動化每 15 分鐘會刷新磁碟上的資料）
  useEffect(() => {
    const timer = setInterval(() => {
      reloadIndex()
      if (apiOk) {
        fetch('/api/status').then((r) => r.ok ? r.json() : null)
          .then((d) => d?.tools && setLiveTools(d.tools)).catch(() => {})
      }
    }, 60000)
    return () => clearInterval(timer)
  }, [apiOk, reloadIndex])

  const selected = useMemo(
    () => (selectedId ? index?.conversations.find((c) => c.id === selectedId) ?? null : null),
    [index, selectedId],
  )

  /** 刪除一個對話：伺服器把來源檔搬到回收區，可以救回來 */
  const removeConv = async (c: ConversationSummary) => {
    // 這三家另有 DB/catalog/archive 作為權威側欄狀態；只搬本文會在重掃後
    // 復活。按鈕本身也會隱藏，這層是避免舊畫面或未來呼叫誤走確認流程。
    if (!canDeleteFromConsole(c)) {
      showToast(t('請在 {tool} 來源應用中刪除這個對話', { tool: c.toolLabel }))
      return
    }
    if (!confirm(t('把「{title}」移到回收區？檔案會搬到 ~/.ai-console/trash，可以救回來。',
      { title: c.title.slice(0, 40) }))) return
    try {
      const r = await fetch('/api/conv/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.id }),
      })
      const d = await r.json()
      if (d.ok) {
        setDeleted((s2) => new Set(s2).add(c.id))
        if (selected?.id === c.id) selectConversation(null)
        showToast(t('已移到回收區'))
      } else showToast(t('刪除失敗：{err}', { err: d.error || '' }))
    } catch { showToast(t('控制 API 無回應')) }
  }

  const launch = async (c: ConversationSummary) => {
    setBusy(c.id)
    try {
      const r = await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id }) })
      const d = await r.json()
      if (d.ok) showToast(t('已開啟終端：{cmd}', { cmd: d.cmd }))
      else {
        if (c.resume) {
          copy(c.resume, 'resume')
          showToast(t('此工具無法直接啟動，已改為複製接續指令'))
        } else {
          showToast(t('無法啟動：{err}', { err: d.error || '' }))
        }
      }
    } catch { showToast(t('控制 API 無回應')) }
    setBusy('')
  }

  /**
   * 換對話時重置聊天串，並還原本機暫存。
   *
   * 用 React 官方的「render 期間調整 state」寫法，不用 effect：
   * effect 版本要等畫面先用舊訊息渲染一次、再被覆蓋掉，中間那一幀
   * 會看到上一個對話的內容閃過去。訊息本身還是 state（使用者會繼續往下打），
   * 所以不能純推導。
   */
  if (chatFor !== (selected?.id ?? null)) {
    setChatFor(selected?.id ?? null)
    setChatMsgs(readChatCache(selected?.id))
    setDetail(null)          // 上一個對話的內容不要殘留到新的那一欄
    setDetailLoading(!!selected?.hasMessages)
    setDetailTailState('none')
    setDetailTailError('')
  }

  const seedChat = () => {
    if (!detail?.messages?.length) return
    const seeded = detail.messages.slice(-8).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: m.text.slice(0, 1200),
    }))
    setChatMsgs(seeded)
    showToast(t('已載入近期 {n} 則訊息作為上下文', { n: seeded.length }))
  }

  const inferTask = (): string => {
    if (!selected) return 'general'
    if (selected.msgCount > 60) return 'long'
    const hay = `${selected.title} ${selected.projectDir}`
    return /code|程式|代码|python|api|bug|wp|wordpress|網站|函数|爬蟲|爬虫|deploy|腳本|脚本/i.test(hay) ? 'coding' : 'general'
  }

  /**
   * 打開一份對話就停在最新的一則。
   *
   * 打開對話最常見的目的是「看最近聊到哪」，但捲動容器一律從 scrollTop 0 開始，
   * 於是每次都要手動往下捲幾萬像素才看得到重點 —— 一份長對話捲到底要好幾秒。
   */
  const scrollMsgsToEnd = (behavior: ScrollBehavior = 'auto') => {
    const box = msgBoxRef.current
    if (!box) return
    box.scrollTo({ top: box.scrollHeight, behavior })
    setAwayFromEnd(false)
  }

  const onMsgScroll = () => {
    const box = msgBoxRef.current
    if (!box) return
    // 40px 的容差：捲到底時瀏覽器的小數誤差會讓等式差個零點幾，
    // 抓死等於的話按鈕會在底部一直閃。
    setAwayFromEnd(box.scrollHeight - box.scrollTop - box.clientHeight > 40)
  }

  // 訊息載入完成才捲得動 —— 內容還沒進 DOM 的時候 scrollHeight 是 0。
  useEffect(() => {
    if (!detail || detailLoading) return
    // 讓瀏覽器先把訊息排版完再捲，不然捲到的是排版前的舊高度
    const id = requestAnimationFrame(() => scrollMsgsToEnd())
    return () => cancelAnimationFrame(id)
  }, [detail, detailLoading])

  const sendChat = async () => {
    const text = chatInput.trim()
    if (!text || chatBusy || !chatModel) return
    const conversationId = selected?.id ?? null
    const requestId = chatRequestSeq.current + 1
    chatRequestSeq.current = requestId
    const isCurrent = () => (
      chatRequestSeq.current === requestId && selectedIdRef.current === conversationId
    )
    const ac = new AbortController()
    chatAbort.current = ac
    const history = chatMsgs.length ? chatMsgs : (detail?.messages?.slice(-8).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text.slice(0, 1200),
    })) || [])
    const next = [...history, { role: 'user', text }]
    setChatMsgs(next)
    setChatInput('')
    setChatBusy(true)
    setChatSecs(0)
    try {
      // 自動路由也是這一次請求的一部分；換對話時要能一起中止。
      let useModel = chatModel
      if (chatModel === 'auto') {
        const rr = await fetch('/api/route?task=' + inferTask(), { signal: ac.signal })
        const rd = await rr.json()
        if (!isCurrent()) return
        if (rd.ok && rd.model) {
          useModel = rd.model
          setRoutedModel(rd.model)
          setRouteInfo(t('自動選擇：{model} — {reason}', { model: rd.model, reason: rd.reason }))
        } else {
          setRouteInfo(rd.reason || t('自動路由失敗'))
          return
        }
      }
      if (!isCurrent()) return

      const r = await fetch('/api/chat', {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: useModel,
          messages: [
            { role: 'system', content: t('你正在接續一段來自其他 AI 工具的對話。以下是對話的近期內容，請直接延續脈絡，用繁體中文回答。') },
            ...next.map((m) => ({ role: m.role, content: m.text })),
          ],
        }),
      })
      const d = await r.json()
      if (!isCurrent()) return
      const reply = d.ok ? (d.content || d.reasoning || t('（空回應）')) : `⚠️ ${d.error || t('呼叫失敗')}`
      const finalMsgs = [...next, { role: 'assistant', text: reply }]
      setChatMsgs(finalMsgs)
      if (conversationId) localStorage.setItem('ac_chat_' + conversationId, JSON.stringify(finalMsgs.slice(-30)))
    } catch (e) {
      // 換對話造成的 abort 屬於舊對話，不能把「已取消」塞進新對話。
      if (!isCurrent()) return
      // 自己按「不等了」不是錯誤，不能報成「控制 API 無回應」——
      // 那會讓人以為是後端掛了，然後去重開伺服器找一個不存在的問題。
      if ((e as Error)?.name === 'AbortError') {
        setChatMsgs([...next, { role: 'assistant', text: t('（已取消，沒有等這一次的回覆）') }])
      } else {
        setChatMsgs([...next, { role: 'assistant', text: t('⚠️ 控制 API 無回應') }])
      }
    } finally {
      if (isCurrent()) {
        if (chatAbort.current === ac) chatAbort.current = null
        setChatBusy(false)
      }
    }
  }

  /**
   * 地端推論的等待計時。
   *
   * 地端跑一次常常 20~60 秒，而畫面上只有一行不會動的「思考中…」。
   * 沒有秒數的話使用者會以為當機而重新整理 —— 那一次的推論就白跑了，
   * 而且它還會在背景把 GPU 佔著跑完。
   */
  useEffect(() => {
    if (!chatBusy) return
    const id = setInterval(() => setChatSecs((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [chatBusy])

  // 依賴 selectedId 的 cleanup 是最後一道保險：即使未來有別的入口直接改 id，
  // 舊請求仍會被中止並失效；元件卸載也走同一條路。
  useEffect(() => () => {
    chatRequestSeq.current += 1
    chatAbort.current?.abort()
    chatAbort.current = null
  }, [selectedId])


  useEffect(() => {
    fetch('/data/index.json', { cache: 'no-cache' })
      .then((r) => {
        if (r.status === 304) return null
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d) => {
        if (d) setIndex(normalize(d))
      })
      .catch((e) => setError(String(e)))
  }, [])

  /**
   * 相依只看 id 與「有沒有訊息」，不看整個 selected 物件。
   *
   * selected 是從 index 推導出來的（`.find()`），而索引每 60 秒重載一次。
   * 只要 setIndex 收到新物件，selected 就換一個身分 —— 即使那份對話
   * 一個字都沒變。原本相依整個物件，於是：
   *   每 60 秒把正在讀的那份對話（74 KB）加尾端（43 KB）重抓一次，
   *   setDetail 又觸發「自動捲到最新」——**捲上去讀舊訊息的人
   *   每 60 秒被拉回底部一次。**
   * 那個現象沒有任何錯誤訊息，只會讓人覺得「這程式怪怪的」。
   */
  const selectedHasMessages = selected?.hasMessages ?? false
  useEffect(() => {
    if (!selected) return
    localStorage.setItem('ac_selected', selected.id)
    if (!selected.hasMessages) return
    const controller = new AbortController()
    setDetailLoading(true)

    const load = async () => {
      try {
        const response = await fetch(`/data/conv/${selected.id}.json`, {
          signal: controller.signal,
          cache: 'no-cache',
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const exported = await response.json() as ConversationDetail
        if (!exported.truncated) {
          if (!controller.signal.aborted) setDetail(exported)
          return
        }

        // 索引匯出檔為了控制大小只留「前 120 則」。直接捲到底仍然不是最新，
        // 所以長對話改由本機 API 依 canonical index 即時讀來源尾端。
        try {
          const tailResponse = await fetch(
            `/api/conv/tail?id=${encodeURIComponent(selected.id)}`,
            { signal: controller.signal, cache: 'no-store' },
          )
          const latest = await tailResponse.json()
          if (!tailResponse.ok || !latest?.ok || !Array.isArray(latest.messages)) {
            throw Object.assign(new Error('tail read failed'), { code: String(latest?.code || '') })
          }
          if (!controller.signal.aborted) {
            setDetail({
              ...exported,
              messages: latest.messages,
              truncated: Boolean(latest.truncated),
            })
            setDetailTailState('latest')
            setDetailTailError('')
          }
        } catch (tailFailure) {
          if ((tailFailure as Error)?.name === 'AbortError' || controller.signal.aborted) return
          // 不認得的新工具格式不能讓整份對話消失；保留原匯出與原工具接續退路。
          setDetail(exported)
          setDetailTailState('fallback')
          const code = (tailFailure as Error & { code?: string })?.code
          setDetailTailError(code ? tailErrorText(code) : t('控制 API 無回應'))
        }
      } catch (loadFailure) {
        if ((loadFailure as Error)?.name !== 'AbortError' && !controller.signal.aborted) {
          setDetail(null)
        }
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false)
      }
    }
    void load()
    return () => controller.abort()
    // selected 只在 id 或 hasMessages 變的時候才需要重載；見上面的說明。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedHasMessages])

  /**
   * 「一週未使用」的基準時刻。
   *
   * 用索引自己的產生時間，不用 Date.now()：render 期間呼叫不純函式會讓
   * 結果隨著任何一次重繪跳動（React 也會擋）。而且對齊索引的快照時刻本來就比較對 ——
   * 判斷冷熱的資料是那一刻掃出來的，不是使用者盯著畫面的當下。
   */
  const indexNow = index?.generated_at ? new Date(index.generated_at).getTime() : 0

  // 依「原始專案資料夾」分組（保留各工具原本的目錄結構）
  const groups = useMemo(() => {
    if (!index) return [] as { dir: string; line: string; convs: ConversationSummary[] }[]
    const q = search.trim().toLowerCase()
    const cutoff = indexNow - WEEK_MS
    const filters: ConversationFilters = {
      showTrash, showSubagent, showDup, showOld, showDispatch, onlyCJK, cutoff,
    }
    const filtered = index.conversations.filter((c) => {
      if (deleted.has(c.id)) return false
      // 搜尋不再暗中繞過過濾器。若命中被收起的對話，畫面會明說
      // 數量並給一鍵顯示；否則同時顯示「搜得到」和「找不到」會讓新手無所適從。
      if (!searchRevealAll && !conversationPassesFilters(c, filters, kept.has(c.id))) return false
      return conversationMatchesSearch(c, q)
    })
    const map = new Map<string, ConversationSummary[]>()
    for (const c of filtered) {
      const key = c.projectDir || t('（無目錄）')
      const arr = map.get(key) || []
      arr.push(c)
      map.set(key, arr)
    }
    // 資料夾層級的活躍度過濾：整個資料夾最近都沒動過就不列出來。
    // 搜尋時不套用 —— 你明確在找東西的時候不該被時間擋住。
    //
    // 基準時間用索引的產生時間而不是 Date.now()：一來 render 期間不該呼叫
    // 不純函式，二來資料本來就只新到上次掃描為止，用掃描時間才對得上。
    const scanned = new Date(index.generated_at).getTime() || 0
    const dirCutoff = activeDays > 0 && !q && scanned ? scanned - activeDays * 86400000 : 0
    return [...map.entries()]
      .filter(([, convs]) => !dirCutoff || convs.some((c) => c.inApp || c.mtime >= dirCutoff))
      .map(([dir, convs]) => {
        // 該資料夾的主要工作線 = 成員中最常見的分類
        const counts = new Map<string, number>()
        convs.forEach((c) => counts.set(c.project, (counts.get(c.project) || 0) + 1))
        const line = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'other'
        return { dir, line, convs }
      })
      .sort((a, b) => (b.convs[0]?.mtime ?? 0) - (a.convs[0]?.mtime ?? 0))
  }, [index, indexNow, search, searchRevealAll, showSubagent, showDup, showOld, showDispatch,
      showTrash, onlyCJK, kept, activeDays, deleted])

  const searchFilters = useMemo<ConversationFilters>(() => ({
    showTrash,
    showSubagent,
    showDup,
    showOld,
    showDispatch,
    onlyCJK,
    cutoff: indexNow - WEEK_MS,
  }), [showTrash, showSubagent, showDup, showOld, showDispatch, onlyCJK, indexNow])

  /** 標題命中先列，而且完全相等／從標題開頭的結果排前面。 */
  const titleSearchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return [] as ConversationSummary[]
    return groups.flatMap((group) => group.convs).sort((a, b) => {
      const titleA = a.title.toLowerCase()
      const titleB = b.title.toLowerCase()
      const score = (title: string) => title === q ? 0 : title.startsWith(q) ? 1 : title.includes(q) ? 2 : 3
      return score(titleA) - score(titleB) || b.mtime - a.mtime
    })
  }, [groups, search])

  const titleSearchIds = useMemo(() => new Set(titleSearchResults.map((c) => c.id)), [titleSearchResults])

  /** 內容命中只列現在看得到的對話，並去掉已在標題區出現的重複項。 */
  const currentContentHits = useMemo(
    () => contentQuery === search.trim() ? contentHits : [],
    [contentQuery, search, contentHits],
  )

  const visibleContentHits = useMemo(() => currentContentHits.flatMap((hit) => {
    const conversation = contentById.get(hit.id)
    if (!conversation || deleted.has(hit.id) || titleSearchIds.has(hit.id)) return []
    if (!searchRevealAll && !conversationPassesFilters(conversation, searchFilters, kept.has(hit.id))) return []
    const snippets = beginnerSearchSnippets(hit.snippets)
    return snippets.length ? [{ ...hit, snippets }] : []
  }), [currentContentHits, contentById, deleted, titleSearchIds, searchRevealAll, searchFilters, kept])

  /** 不說「找不到」：有命中只是被目前篩選收起時，告訴使用者真實數量。 */
  const hiddenSearchCount = useMemo(() => {
    if (!search.trim() || searchRevealAll || !index) return 0
    const matched = new Set<string>()
    for (const conversation of index.conversations) {
      if (!deleted.has(conversation.id) && conversationMatchesSearch(conversation, search)) matched.add(conversation.id)
    }
    for (const hit of currentContentHits) if (!deleted.has(hit.id)) matched.add(hit.id)
    let hidden = 0
    for (const id of matched) {
      const conversation = contentById.get(id)
      if (conversation && !conversationPassesFilters(conversation, searchFilters, kept.has(id))) hidden += 1
    }
    return hidden
  }, [search, searchRevealAll, index, deleted, currentContentHits, contentById, searchFilters, kept])

  const oldCount = useMemo(() => {
    if (!index) return 0
    const cutoff = indexNow - WEEK_MS
    return index.conversations.filter(
      (c) => !c.inApp && c.mtime < cutoff && !c.subagent && !c.dup,
    ).length
  }, [index, indexNow])

  const hubProjects = useMemo(() => {
    const m = new Map<string, { status: string; needs_handoff: boolean; next_step: string }>()
    index?.projects.forEach((p) => m.set(p.project_id, { status: p.status, needs_handoff: p.needs_handoff, next_step: p.next_step }))
    return m
  }, [index])

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(key)
    setTimeout(() => setCopied(''), 1500)
  }

  /**
   * 分頁列。抽出來是因為「沒有索引」的畫面也要有它。
   *
   * 原本這裡是 `if (error) return <一行紅字>` 直接把整頁換掉，
   * 連導覽列一起擋死 —— 第一次打開（還沒跑過 indexer）的人只看到一行紅字，
   * 主控台、辦公室、冒險三個分頁全部進不去，看起來就是整個程式壞了。
   * 但那三個分頁根本不需要索引。
   */
  // overflow-x-auto 是保險：視窗再窄一點時分頁列會變成可橫捲，
  // 而不是把最後一個分頁擠到看不見的地方。
  // 子項全部 flex-none，不然它們會被壓扁成一團看不懂的字。
  const tabs = (
    <div className="flex flex-none items-center gap-1 overflow-x-auto border-b border-line px-3 py-1.5">
      {([
        ['list', t('📋 對話')], ['ask', t('💬 問 AI')], ['console', t('🎙️ 派工主控台')],
        ['office', t('🎮 辦公室')], ['rpg', t('⚔️ 冒險')],
        ['skills', t('🧩 AI 技能')],
      ] as const).map(([m, label]) => (
        <button
          key={m}
          className={`flex-none rounded-md px-3 py-1 text-xs ${viewMode === m ? 'bg-ink text-invink' : 'text-mute2 hover:bg-elev'}`}
          onClick={() => setViewMode(m)}
        >
          {label}
        </button>
      ))}
      <LangSwitch />
    </div>
  )

  if (!index) return (
    <div className="flex h-screen flex-col bg-panel text-ink">
      <main className="flex min-w-0 flex-1 flex-col">
        {tabs}
        {viewMode === 'ask' ? (
          <AskAI />
        ) : viewMode === 'console' ? (
          <Console />
        ) : viewMode === 'office' ? (
          <Office tools={liveTools ?? {}} projects={[]} conversations={[]} onDispatch={launch} busyId={busy} />
        ) : viewMode === 'rpg' ? (
          <Adventure tools={liveTools ?? {}} />
        ) : viewMode === 'skills' ? (
          <SkillCenter />
        ) : (
          error ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <p role="alert" className="mx-auto mt-5 max-w-4xl px-6 text-sm text-red-600">
                {t('對話清單尚未建立：{err}', { err: error })}
              </p>
              <ConversationSync
                index={null}
                apiOk={apiOk}
                onComplete={(next) => { setIndex(normalize(next)); setError('') }}
              />
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center p-8">
              <p role="status" aria-live="polite" className="text-sm text-mute2">{t('正在載入對話清單…')}</p>
            </div>
          )
        )}
      </main>
    </div>
  )

  return (
    <div className="flex h-screen flex-col bg-panel text-ink">
      <div className="relative flex min-h-0 flex-1">
        {/* ── 側欄 ───────────────────────────
            在「📋 對話」以外的分頁預設收起來。
            那三個分頁跟對話清單沒有關係，但側欄照樣佔走 320px ——
            1440 寬的視窗有 22% 給了一個當下用不到的清單，
            像素辦公室的畫布因此只有 1105 寬（收起來是 1425）。
            不是直接拿掉，是收起來：從主控台按「▶ 派工」接續某個資料夾
            仍然是真實用法，留一顆細長的把手可以隨時拉回來。

            寬度也跟著視窗走：固定 320px 在 700px 寬的視窗會吃掉 46%，
            主區只剩 380px —— 連四個分頁鈕都排不下（實測溢出 387>380）。 */}
        {sidebarOpen && (
        <aside className="absolute inset-y-0 left-0 z-20 flex w-[min(20rem,calc(100vw-2rem))] flex-none flex-col border-r border-line bg-panel shadow-xl sm:relative sm:z-auto sm:w-64 sm:shadow-none lg:w-80">
          <div className="border-b border-line p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h1 className="text-lg font-medium">{t('AI 控制台')}</h1>
              <span className="min-w-0 flex-1 truncate text-right text-xs text-mute3">
                {t('{time}更新', { time: relTime(index.generated_at) })}
              </span>
              <button
                className="flex-none rounded px-1.5 py-1 text-xs leading-none text-mute3 hover:bg-elev hover:text-ink3"
                style={{ minWidth: 24, minHeight: 24 }}
                onClick={() => setSidebarOpen(false)}
                title={t('收起對話清單')}
                aria-label={t('收起對話清單')}
              >
                ‹
              </button>
            </div>
            <div className="mb-2 flex items-center gap-2">
              <button
                className="rounded-md border border-line px-3 py-1 text-xs hover:bg-elev disabled:opacity-40"
                disabled={!apiOk}
                onClick={() => { setViewMode('list'); setSyncOpen(true) }}
                title={apiOk ? t('匯入或同步四個 AI 的對話') : t('控制 API 沒有回應。桌面版重開一次即可；開發模式請確認 npm run dev 還在跑')}
              >
                {t('↻ 匯入／同步對話')}
              </button>
              {!apiOk && <span role="status" className="text-xs text-amber-600">{t('控制 API 離線（檢視模式）')}</span>}
            </div>
            <input
              ref={searchRef}
              className="w-full rounded-md border border-line bg-transparent px-3 py-1.5 text-sm outline-none focus:border-line3"
              placeholder={t('搜尋標題與內容…（按 / 跳到這裡）')}
              aria-label={t('搜尋舊對話')}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSearchRevealAll(false) }}
              onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); setSearchRevealAll(false); e.currentTarget.blur() } }}
            />
            <details className="mt-2 rounded-md border border-line px-2 py-1.5">
              <summary className="cursor-pointer text-xs text-mute2">{t('進階篩選與整理')}</summary>
            {(index.stats.trashed ?? 0) > 0 && (
              <button
                className={`mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs ${
                  showTrash
                    ? 'bg-ink text-invink'
                    : 'text-mute2 hover:bg-elev'
                }`}
                onClick={() => setShowTrash((v) => !v)}
                title={t('這些對話只是收起來，檔案完全沒有動。點「留著」可以單筆放回主清單')}
              >
                🗑️ {showTrash ? t('回到主清單') : t('垃圾桶（{n} 份）', { n: index.stats.trashed ?? 0 })}
              </button>
            )}
            {showTrash && (
              <div className="mt-1 rounded bg-elev px-2 py-1 text-[10px] leading-relaxed text-mute2">
                {t('收起來的原因：不是目前在用的工具、太久沒動過，或在原本的工具裡已經封存。檔案都還在，沒有刪除。')}
              </div>
            )}
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-mute2">
              <input type="checkbox" checked={showSubagent} onChange={(e) => setShowSubagent(e.target.checked)} />
              {t('顯示子代理對話（{n} 份）', { n: index.stats.subagent })}
            </label>
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-mute2">
              <input type="checkbox" checked={showDup} onChange={(e) => setShowDup(e.target.checked)} />
              {t('顯示重複副本（{dup} 份，去重後 {uniq} 份正本）', { dup: index.stats.duplicates ?? 0, uniq: index.stats.unique ?? index.stats.total })}
            </label>
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-mute2">
              <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />
              {t('顯示一週未使用的舊對話（已收納 {n} 份）', { n: oldCount })}
            </label>
            <label
              className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-mute2"
              title={t('機器跑的 agent 迴圈標題都是英文的指令輸出，怎麼列規則都追不完；你自己開的對話都有中文')}
            >
              <input type="checkbox" checked={onlyCJK} onChange={(e) => setOnlyCJK(e.target.checked)} />
              {t('只顯示有中文的對話')}
            </label>
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-mute2">
              <input type="checkbox" checked={showDispatch} onChange={(e) => setShowDispatch(e.target.checked)} />
              {t('顯示 AI 派工對話（已隱藏 {n} 份 worker 紀錄）', { n: index.stats.dispatch ?? 0 })}
            </label>
            <label className="mt-1 flex items-center gap-1.5 text-xs text-mute2">
              {t('只看最近')}
              <select
                className="rounded border border-line2 bg-panel px-1 py-0.5 text-xs text-ink2 [&>option]:bg-panel [&>option]:text-ink2"
                value={activeDays}
                onChange={(e) => setActiveDays(Number(e.target.value))}
              >
                {[1, 3, 7, 30, 0].map((d) => (
                  <option key={d} value={d}>{d === 0 ? t('全部') : t('{n} 天', { n: d })}</option>
                ))}
              </select>
              {t('有動過的資料夾')}
            </label>
            </details>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {search.trim() && titleSearchResults.length > 0 && (
              <section aria-labelledby="title-search-heading" className="border-b border-line2">
                <h2 id="title-search-heading" className="px-3 py-1.5 text-[11px] font-medium text-ink3">
                  {t('對話清單找到 {n} 份（標題符合的排前面）', { n: titleSearchResults.length })}
                </h2>
                {titleSearchResults.map((conversation) => (
                  <button
                    key={conversation.id}
                    className={`flex w-full items-center gap-2 border-t border-line2 px-3 py-2 text-left text-xs hover:bg-elev ${selectedId === conversation.id ? 'bg-elev' : ''}`}
                    onClick={() => selectConversation(conversation.id)}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{markHits(conversation.title, search)}</span>
                    <span className="flex-none text-[10px] text-mute3">{conversation.toolLabel}</span>
                  </button>
                ))}
              </section>
            )}

            {search.trim().length >= 2 && (contentBusy || visibleContentHits.length > 0) && (
              <section aria-labelledby="content-search-heading" className="border-b border-line2 bg-elev/40">
                <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-mute2">
                  <h2 id="content-search-heading">🔎 {t('對話內容裡找到')}</h2>
                  <span className="font-medium text-ink3">
                    {contentBusy ? t('搜尋中…') : t('{n} 份', { n: visibleContentHits.length })}
                  </span>
                  {contentTruncated && !contentBusy && (
                    <span className="text-mute3">{t('（只列前 {n} 份）', { n: currentContentHits.length })}</span>
                  )}
                </div>
                {visibleContentHits.map((hit) => {
                  const conversation = contentById.get(hit.id)
                  return (
                    <button
                      key={hit.id}
                      className={`flex w-full flex-col gap-0.5 border-t border-line2 px-3 py-2 text-left hover:bg-elev ${selectedId === hit.id ? 'bg-elev' : ''}`}
                      onClick={() => selectConversation(hit.id)}
                    >
                      <span className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate font-medium">{conversation?.title || hit.id}</span>
                        {conversation && <span className="flex-none text-[10px] text-mute3">{conversation.toolLabel}</span>}
                      </span>
                      {hit.snippets.map((snippet, i) => (
                        <span key={i} className="line-clamp-2 text-[11px] leading-snug text-mute2">
                          <span className="text-mute3">{snippet.role === 'user' ? t('你：') : t('AI：')}</span>
                          {markHits(snippet.text, search)}
                        </span>
                      ))}
                    </button>
                  )
                })}
              </section>
            )}

            {search.trim().length >= 2 && contentSearchUnavailable && (
              <div role="status" aria-live="polite" className="border-b border-line2 bg-amber-50 px-3 py-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                {t('對話內容搜尋暫時無法使用；目前只顯示標題找到的結果。')}
              </div>
            )}

            {search.trim().length >= 2 && contentSearchPartial && (
              <div role="status" aria-live="polite" className="border-b border-line2 bg-amber-50 px-3 py-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                {t('部分對話內容無法搜尋；目前結果可能不完整。')}
              </div>
            )}

            {search.trim() && hiddenSearchCount > 0 && (
              <div role="status" aria-live="polite" className="border-b border-line2 bg-amber-50 px-3 py-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <p>{t('另外找到 {n} 份，但被目前的進階篩選收起來。', { n: hiddenSearchCount })}</p>
                <button
                  className="mt-2 rounded-md border border-amber-400 px-2.5 py-1 font-medium hover:bg-amber-100 dark:hover:bg-amber-900"
                  onClick={() => setSearchRevealAll(true)}
                >
                  {t('顯示這 {n} 份結果', { n: hiddenSearchCount })}
                </button>
              </div>
            )}

            {search.trim() && shouldShowSearchNoResults(
              titleSearchResults.length,
              visibleContentHits.length,
              hiddenSearchCount,
              contentBusy,
              contentSearchUnavailable || contentSearchPartial,
            ) && (
              <div role="status" aria-live="polite" className="px-3 py-6 text-center text-xs text-mute3">
                {search.trim().length >= 2
                  ? t('標題和對話內容都沒有找到「{query}」。', { query: search.trim() })
                  : t('標題沒有找到「{query}」；輸入至少 2 個字才會再搜對話內容。', { query: search.trim() })}
              </div>
            )}

            {!search.trim() && groups.length === 0 && (
              <div role="status" aria-live="polite" className="px-3 py-6 text-center text-xs text-mute3">
                <div>{t('目前的進階篩選沒有符合的對話')}</div>
                <button
                  className="mt-3 rounded border border-line2 px-3 py-1 hover:bg-elev"
                  onClick={() => {
                    setActiveDays(0); setShowOld(true); setShowSubagent(true)
                    setShowDup(true); setShowDispatch(true); setOnlyCJK(false); setShowTrash(false)
                  }}
                >
                  {t('重設所有進階篩選')}
                </button>
              </div>
            )}
            {!search.trim() && groups.map(({ dir, line, convs }) => {
              const hub = hubProjects.get(line)
              // 專案分組預設收合：一台機器上動輒上百個專案，全展開要滾很久。
              // 但搜尋時要強制展開 —— 不然搜完只看到一列「▸ 📁 資料夾 (3)」，
              // 命中的對話全被關在收合的資料夾裡，看起來就是「搜尋壞了／找不到」。
              const open = search.trim() ? true : (openGroups[dir] ?? false)
              // 搜尋代表使用者已經明確縮小範圍，命中的項目全部自動顯示。
              // 40 筆上限只保留在一般瀏覽，避免「搜尋有 63 筆、畫面卻只列 40 筆」。
              const shown = search.trim() ? convs : (showAll[dir] ? convs : convs.slice(0, 40))
              const badge = hub ? PROJ_BADGE[hub.status] : null
              return (
                <div key={dir} className="border-b border-line">
                  {/* 外層是 div，不是 button。
                      原本折疊鈕是 <button>，裡面又塞一個 <span role="button">（▶ 派工）——
                      HTML 不准按鈕巢狀，而且那個 span 沒有 tabIndex 也沒有鍵盤處理，
                      用鍵盤操作的人永遠 Tab 不到「派工」。
                      改成兩顆並排的原生 <button>，Tab 與 Enter/Space 就自動正確。 */}
                  {/* 內距放在按鈕上，不是外層的 div。
                      放在 div 上的話那一列看起來有 36px 高，但真正可以按的區域
                      只有文字本身的 20px —— 上下各 8px 是死的。
                      WCAG 2.2 的目標尺寸下限是 24×24，用觸控板或手抖的人會一直按空。 */}
                  <div className="flex w-full items-center gap-2 px-3 hover:bg-elev">
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden py-2 text-left"
                      onClick={() => setOpenGroups((s) => ({ ...s, [dir]: !open }))}
                      aria-expanded={open}
                      title={dir}
                    >
                      <span className="text-xs text-mute3">{open ? '▾' : '▸'}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">📁 {folderName(dir)}</span>
                      {line !== 'other' && (
                        <span
                          className="min-w-0 max-w-24 flex-none truncate rounded-full bg-elev px-2 py-0.5 text-xs text-mute2"
                          title={index.projectTitles[line] || line}
                        >
                          {index.projectTitles[line] || line}
                        </span>
                      )}
                      {badge && <span className={`flex-none rounded-full px-2 py-0.5 text-xs ${badge.cls}`}>{badge.label}</span>}
                      {hub?.needs_handoff && <span className="flex-none rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">{t('待接力')}</span>}
                      <span className="flex-none text-xs text-mute3">{convs.length}</span>
                    </button>
                    {apiOk && convs.some((c) => c.resume) && (
                      <button
                        className="flex-none rounded border border-line px-1.5 py-1 text-xs hover:bg-elev"
                        title={t('派工：接續此資料夾最新的對話')}
                        onClick={() => {
                          const target = convs.find((c) => c.resume)
                          if (target) launch(target)
                        }}
                      >
                        {busy && convs.some((c) => c.id === busy) ? '…' : t('▶ 派工')}
                      </button>
                    )}
                  </div>
                  {open && hub?.next_step && (
                    <div className="mx-3 mb-2 rounded-md bg-elev px-2 py-1.5 text-xs text-mute2">
                      {t('下一步：')}{hub.next_step}
                    </div>
                  )}
                  {open && shown.map((c) => (
                    // 外層用 div 不用 button：裡面還要放一個刪除按鈕，
                    // 按鈕不能巢狀在按鈕裡
                    <div
                      key={c.id}
                      className={`group flex w-full items-start gap-1 px-3 py-1.5 pl-7 hover:bg-elev ${selected?.id === c.id ? 'bg-elev' : ''}`}
                    >
                      <button
                        onClick={() => selectConversation(c.id)}
                        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                      >
                        <span className="truncate text-sm">
                          {c.pinned && <span className="mr-1" title={t('來源應用已釘選')}>📌</span>}
                          {c.title}
                          {c.metadataConflict && (
                            <span
                              className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                              title={t('來源應用的多份 metadata 不一致，請回來源應用確認')}
                            >
                              {t('metadata 衝突')}
                            </span>
                          )}
                          {c.dup && <span className="ml-1 rounded bg-elev px-1 text-xs text-mute3">{t('副本')}→{c.dupOfTool}</span>}
                          {!!c.dupCount && <span className="ml-1 rounded bg-elev px-1 text-xs text-mute3">+{t('{n} 副本', { n: c.dupCount })}</span>}
                        </span>
                        <span className="flex items-center gap-2 text-xs text-mute3">
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${(liveTools ?? index.tools)[c.tool]?.rate_limited ? 'bg-red-500' : 'bg-emerald-500'}`} />
                          {c.toolLabel} · {relTime(c.mtime)} · {fmtSize(c.size)}
                          {c.msgCount > 0 && ` · ${t('{n} 則', { n: c.msgCount })}`}
                        </span>
                      </button>
                      {showTrash && (
                        <button
                          className="flex-none rounded px-1 text-[10px] text-emerald-600 hover:text-emerald-500"
                          title={t('放回主清單。規則之後改了也還是會留著')}
                          onClick={(e) => { e.stopPropagation(); setKept((k) => new Set(k).add(c.id)) }}
                        >
                          {t('留著')}
                        </button>
                      )}
                      {apiOk && canDeleteFromConsole(c) && (
                        <button
                          className="flex-none rounded px-1 text-xs text-mute3 opacity-0 hover:text-red-500 focus-visible:text-red-500 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                          title={t('移到回收區')}
                          onClick={(e) => { e.stopPropagation(); void removeConv(c) }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  {open && !search.trim() && convs.length > 40 && !showAll[dir] && (
                    <button className="w-full px-3 py-1.5 text-left text-xs text-mute3 hover:text-ink3" onClick={() => setShowAll((s) => ({ ...s, [dir]: true }))}>
                      {t('顯示全部 {n} 筆…', { n: convs.length })}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </aside>
        )}

        {/* 收起來時留一條可以拉回去的把手。
            完全沒有把手的話，切到主控台再切回來會找不到清單去哪了。 */}
        {!sidebarOpen && (
          <button
            className="flex w-7 flex-none items-center justify-center border-r border-line text-mute3 hover:bg-elev hover:text-ink3"
            onClick={() => setSidebarOpen(true)}
            title={t('展開對話清單')}
            aria-label={t('展開對話清單')}
          >
            ›
          </button>
        )}

        {/* ── 主內容 ─────────────────────────── */}
        {/* relative 是給「⬇ 最新」浮動鈕定位用的。放在捲動容器裡面的話
            它會跟著內容一起捲走，等於沒有浮動。 */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {tabs}
          {viewMode === 'ask' ? (
            <AskAI />
          ) : viewMode === 'console' ? (
            <Console />
          ) : viewMode === 'office' ? (
            <Office
              tools={liveTools ?? index.tools}
              projects={index.projects}
              conversations={index.conversations}
              onDispatch={launch}
              busyId={busy}
            />
          ) : viewMode === 'rpg' ? (
            <Adventure tools={liveTools ?? index.tools} />
          ) : viewMode === 'skills' ? (
            <SkillCenter />
          ) : syncOpen ? (
            <ConversationSync
              index={index}
              apiOk={apiOk}
              onComplete={(next) => { setIndex(normalize(next)); setError('') }}
              onClose={() => setSyncOpen(false)}
            />
          ) : !selected ? (
            <section aria-labelledby="beginner-home-title" className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
              <div className="mx-auto max-w-3xl">
                <p className="text-sm text-mute2">{t('AI 控制台')}</p>
                <h1 id="beginner-home-title" className="mt-1 text-2xl font-semibold text-ink">
                  {t('你現在想做什麼？')}
                </h1>
                <p className="mt-2 text-sm leading-6 text-mute2">
                  {t('不需要先懂模型、指令或資料夾，選一件事就能開始。')}
                </p>

                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  <button
                    className="min-h-28 rounded-xl border border-line bg-panel p-4 text-left shadow-sm hover:border-line3 hover:bg-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    onClick={() => {
                      setSidebarOpen(true)
                      setSyncOpen(false)
                      setTimeout(() => searchRef.current?.focus(), 0)
                    }}
                  >
                    <span className="block text-lg font-medium text-ink">🔎 {t(BEGINNER_ACTIONS[0])}</span>
                    <span className="mt-2 block text-sm leading-5 text-mute2">{t('輸入記得的一句話；若還沒出現，再按左側「匯入／同步對話」。')}</span>
                  </button>
                  <button
                    className="min-h-28 rounded-xl border border-line bg-panel p-4 text-left shadow-sm hover:border-line3 hover:bg-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    onClick={() => setViewMode('ask')}
                  >
                    <span className="block text-lg font-medium text-ink">💬 {t(BEGINNER_ACTIONS[1])}</span>
                    <span className="mt-2 block text-sm leading-5 text-mute2">{t('直接問一個問題；AI 只會回答，不會執行工作。')}</span>
                  </button>
                  <button
                    className="min-h-28 rounded-xl border border-line bg-panel p-4 text-left shadow-sm hover:border-line3 hover:bg-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    onClick={() => setViewMode('console')}
                  >
                    <span className="block text-lg font-medium text-ink">⚡ {t(BEGINNER_ACTIONS[2])}</span>
                    <span className="mt-2 block text-sm leading-5 text-mute2">{t('把想完成的結果寫清楚，再確認交給 AI 動手。')}</span>
                  </button>
                  <button
                    className="min-h-28 rounded-xl border border-line bg-panel p-4 text-left shadow-sm hover:border-line3 hover:bg-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    onClick={() => setViewMode('skills')}
                  >
                    <span className="block text-lg font-medium text-ink">🧩 {t(BEGINNER_ACTIONS[3])}</span>
                    <span className="mt-2 block text-sm leading-5 text-mute2">{t('匯入、檢查並管理每個 AI 可用的技能。')}</span>
                  </button>
                </div>

                <details className="mt-6 rounded-lg border border-line px-4 py-3 text-sm text-mute2">
                  <summary className="cursor-pointer font-medium text-ink3">{t('進階資料與數量')}</summary>
                  <p className="mt-3">
                    {t('目前有 {n} 份正本對話、{tools} 個 AI 來源、{groups} 個專案資料夾。', {
                      n: index.stats.unique ?? index.stats.total,
                      tools: Object.keys(index.tools).length,
                      groups: groups.length,
                    })}
                  </p>
                  <p className="mt-1 text-xs text-mute3">{t('篩選、子代理與重複副本都放在左側的「進階篩選與整理」。')}</p>
                </details>
              </div>
            </section>
          ) : (
            <>
              <header className="flex-none border-b border-line px-5 py-3">
                <div className="mb-1 flex items-center gap-3">
                  <h2 className="min-w-0 flex-1 truncate text-base font-medium">{selected.title}</h2>
                  <span className="flex-none rounded-full bg-elev px-2 py-0.5 text-xs text-mute2">{selected.toolLabel}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-mute3">
                  <span>{relTime(selected.mtime)}</span>
                  {selected.resume && (
                    <button
                      className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-invink hover:bg-ink2 disabled:opacity-40"
                      disabled={!apiOk || busy === selected.id}
                      onClick={() => launch(selected)}
                    >
                      {busy === selected.id ? t('開啟中…') : t(originalAiActionLabel())}
                    </button>
                  )}
                  {!apiOk && selected.resume && <span className="text-amber-600">{t('控制 API 離線，重開控制台後即可開啟。')}</span>}
                </div>
                <details className="mt-2 text-xs text-mute3">
                  <summary className="cursor-pointer hover:text-ink3">{t('進階資訊')}</summary>
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-elev p-2">
                    <span className="max-w-full break-all" title={selected.path}>{selected.path}</span>
                    {selected.resume && (
                      <button className="rounded border border-line px-2 py-1 hover:bg-panel" onClick={() => copy(selected.resume, 'resume')}>
                        {copied === 'resume' ? t('已複製 ✓') : t('複製原 AI 開啟指令')}
                      </button>
                    )}
                    <button className="rounded border border-line px-2 py-1 hover:bg-panel" onClick={() => copy(selected.path, 'path')}>
                      {copied === 'path' ? t('已複製 ✓') : t('複製檔案路徑')}
                    </button>
                  </div>
                </details>
              </header>

              <div
                ref={msgBoxRef}
                className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4"
                onScroll={onMsgScroll}
              >
                {!selected.hasMessages ? (
                  <section aria-labelledby="large-conversation-title" className="mx-auto max-w-xl rounded-xl border border-line bg-elev p-5">
                    <h3 id="large-conversation-title" className="font-medium text-ink">{t('這份對話請回原本的 AI 查看')}</h3>
                    <p className="mt-2 text-sm leading-6 text-mute2">
                      {t('對話檔較大（{size}），控制台沒有複製訊息內容。請按上方「在原本的 AI 開啟」，對話就會回到原處。', { size: fmtSize(selected.size) })}
                    </p>
                  </section>
                ) : detailLoading ? (
                  <p role="status" aria-live="polite" className="text-mute3">{t('載入訊息中…')}</p>
                ) : detail ? (
                  <div className="mx-auto flex max-w-3xl flex-col gap-3">
                    {detail.messages.map((m, i) => (
                      <div key={i} className={`rounded-lg px-4 py-3 text-sm leading-6 ${m.role === 'user' ? 'ml-12 bg-elev' : 'mr-12 border border-line'}`}>
                        <div className="mb-1 text-xs text-mute3">{m.role === 'user' ? '你' : selected.toolLabel}{m.ts ? ` · ${new Date(m.ts).toLocaleString('zh-TW')}` : ''}</div>
                        <div className="whitespace-pre-wrap break-words">{m.text}</div>
                      </div>
                    ))}
                    {detailTailState === 'latest' ? (
                      <p role="status" className="text-center text-xs text-mute3">
                        {t('已顯示真正最新的 {n} 則訊息；更早內容仍可回原工具查看。', { n: detail.messages.length })}
                      </p>
                    ) : detailTailState === 'fallback' ? (
                      <p role="alert" className="text-center text-xs text-amber-600 dark:text-amber-400">
                        {selected.resume
                          ? t('最新訊息載入失敗：{err}。目前顯示索引匯出的前段；仍可用「在原本的 AI 開啟」回原處查看。', { err: detailTailError })
                          : t('最新訊息載入失敗：{err}。目前顯示索引匯出的前段；可從「進階資訊」複製檔案路徑。', { err: detailTailError })}
                      </p>
                    ) : detail.truncated ? (
                      <p className="text-center text-xs text-mute3">
                        {t('（訊息過多，目前顯示索引匯出的前段）')}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-mute3">找不到匯出的訊息檔。</p>
                )}

              </div>

              {/* 只在使用者往上捲離開底部時才出現。永遠掛著的話，
                  它會一直蓋住最後一則訊息的右下角。 */}
              {awayFromEnd && (
                <button
                  className="absolute bottom-24 right-6 z-10 rounded-full border border-line2 bg-white px-3 py-1.5 text-xs shadow-lg hover:bg-elev"
                  onClick={() => scrollMsgsToEnd('smooth')}
                >
                  {t('⬇ 最新')}
                </button>
              )}

              {/* 續聊區釘在捲動容器外面。放在裡面的話，對話一長就得
                  捲到最底才碰得到輸入框 —— 而「想接續聊」正是打開一份
                  對話最常見的目的，不該是最難到達的動作。 */}
              <div className="flex-none border-t border-line bg-app">
                {/* ── 地端續聊 ── */}
                {apiOk && (
                  <div className="mx-auto w-full max-w-3xl px-5 pb-4 pt-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-sm font-medium">💬 用地端模型接續</span>
                      <select
                        className="rounded-md border border-line2 bg-panel px-2 py-1 text-xs text-ink2 [&>option]:bg-panel [&>option]:text-ink2"
                        value={chatModel}
                        onChange={(e) => setChatModel(e.target.value)}
                      >
                        <option value="auto">🤖 自動（依狀態路由）</option>
                        {models.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                      {chatMsgs.length === 0 && detail?.messages?.length ? (
                        <button className="rounded-md border border-line px-2 py-1 text-xs hover:bg-elev" onClick={seedChat}>
                          載入近期訊息當上下文
                        </button>
                      ) : chatMsgs.length > 0 && (
                        <span className="text-xs text-mute3">上下文 {chatMsgs.length} 則</span>
                      )}
                      {chatMsgs.length > 0 && (
                        <button className="rounded px-2 py-1 text-xs text-mute3 hover:text-ink3" onClick={() => { setChatMsgs([]); if (selected) localStorage.removeItem('ac_chat_' + selected.id) }}>
                          清空
                        </button>
                      )}
                    </div>
                    {routeInfo && <div role="status" aria-live="polite" className="mb-2 text-xs text-amber-600 dark:text-amber-400">{routeInfo}</div>}
                    {chatMsgs.length > 0 && (
                      <div
                        role="log"
                        aria-live="polite"
                        aria-relevant="additions text"
                        aria-busy={chatBusy}
                        aria-label={t('地端續聊訊息')}
                        className="mb-2 flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md bg-elev p-3"
                      >
                        {chatMsgs.map((m, i) => (
                          <div key={i} className={`rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'ml-10 bg-white' : 'mr-10 border border-line bg-white'}`}>
                            <div className="mb-0.5 text-xs text-mute3">{m.role === 'user' ? '你' : (chatModel === 'auto' ? (routedModel || '自動') : chatModel)}</div>
                            <div className="whitespace-pre-wrap break-words">{m.text}</div>
                          </div>
                        ))}
                        {chatBusy && (
                          <div className="flex items-center gap-2 text-xs text-mute3">
                            {/* role=log 會在這一列加入時宣告一次；每秒變動的視覺計時
                                對讀屏器隱藏，避免整段推論期間每秒重複播報。 */}
                            <span className="sr-only">{t('地端模型開始處理這次訊息')}</span>
                            <span aria-hidden="true">{t('地端模型思考中… {n} 秒', { n: chatSecs })}</span>
                            {/* 15 秒之前不出現：正常的短回覆本來就會在那之內回來，
                                太早給取消鈕反而像在暗示「它大概壞了」。 */}
                            {chatSecs >= 15 && (
                              <button
                                className="rounded border border-line2 px-1.5 py-0.5 hover:bg-elev"
                                onClick={() => chatAbort.current?.abort()}
                              >
                                {t('不等了')}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <textarea
                        className="min-h-10 flex-1 rounded-md border border-line bg-transparent px-3 py-2 text-sm outline-none focus:border-line3"
                        placeholder={chatMsgs.length ? '繼續這段對話…' : '直接輸入會自動帶入近期訊息當上下文'}
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }}
                      />
                      <button
                        className="self-end rounded-md bg-ink px-4 py-2 text-sm text-invink hover:bg-ink2 disabled:opacity-40"
                        disabled={chatBusy || !chatModel}
                        onClick={sendChat}
                      >
                        {chatBusy ? '…' : '送出'}
                      </button>
                    </div>
                    {/* 問問題與交工作是兩個不同意圖。QuickDispatch 有自己的工作草稿，
                        不會把上面還沒送出的問題當成可執行工單。 */}
                    <QuickDispatch
                      conv={selected ? { title: selected.title, projectDir: selected.projectDir } : null}
                      recent={(detail?.messages || []).slice(-6).map((m) => ({
                        role: m.role === 'assistant' ? 'assistant' : 'user',
                        text: m.text,
                      }))}
                      onToast={showToast}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {/* ── 底部額度狀態列 ─────────────────────── */}
      {toast && (
        <div role="status" aria-live="polite" aria-atomic="true" className="fixed bottom-10 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-ink px-4 py-2 text-sm text-invink shadow-lg">
          {toast}
        </div>
      )}
      <footer className="flex flex-none items-center gap-4 overflow-x-auto border-t border-line px-4 py-1.5 text-xs">
        {Object.entries(liveTools ?? index.tools).map(([key, tool]) => (
          <span key={key} className="flex flex-none items-center gap-1.5" title={tool.evidence || tool.role}>
            <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[tool.status] || STATUS_DOT.unknown}`} />
            <span className="text-ink3">{tool.label}</span>
            <span className="text-mute3">{t(STATUS_LABEL[tool.status] || tool.status)}</span>
          </span>
        ))}
        {/* 這行是純說明，窄視窗第一個該讓位的就是它。
            原本是 flex-none，900px 寬時右邊被切掉 88px，而父層是
            overflow-x-auto —— 要橫捲一條狀態列才看得到，等於看不到。
            改成可縮可截斷，並在真的太窄時整行藏起來。 */}
        <span className="ml-auto hidden min-w-0 truncate text-mute3 sm:inline"
              title={t('ai-hub 每 15 分鐘自動掃描')}>
          {liveTools ? t('即時狀態 · ') : ''}{t('ai-hub 每 15 分鐘自動掃描')}
        </span>
      </footer>
    </div>
  )
}
