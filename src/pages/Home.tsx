import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationDetail, ConversationSummary, IndexData } from '@/types/data'
import Adventure from '@/components/Adventure'
import Console from '@/components/Console'
import Office from '@/components/Office'
import { t, useLang } from '@/i18n'
import LangSwitch from '@/components/LangSwitch'

/** python 存的是秒，JS 要毫秒。純函式，跟元件狀態無關，所以放在模組層級 */
const normalize = (d: IndexData): IndexData => {
  d.conversations.forEach((c) => { if (c.mtime < 1e12) c.mtime *= 1000 })
  return d
}

const STATUS_DOT: Record<string, string> = {
  active: 'bg-emerald-500',
  idle: 'bg-zinc-400',
  rate_limited: 'bg-red-500',
  unknown: 'bg-zinc-300',
}
const STATUS_LABEL: Record<string, string> = { active: '活躍', idle: '閒置', rate_limited: '限流中', unknown: '未知' }
const PROJ_BADGE: Record<string, { label: string; cls: string }> = {
  active: { label: '進行中', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
  blocked: { label: '阻塞', cls: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
  waiting: { label: '等待中', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' },
  done: { label: '完成', cls: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400' },
}

const WEEK_MS = 7 * 86400 * 1000

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
  const [viewMode, setViewMode] = useState<'list' | 'console' | 'office' | 'rpg'>('list')
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
  }

  useEffect(() => { localStorage.setItem('ac_showSub', showSubagent ? '1' : '0') }, [showSubagent])
  useEffect(() => { localStorage.setItem('ac_showDup', showDup ? '1' : '0') }, [showDup])
  useEffect(() => { localStorage.setItem('ac_showOld', showOld ? '1' : '0') }, [showOld])
  useEffect(() => { localStorage.setItem('ac_showDisp', showDispatch ? '1' : '0') }, [showDispatch])
  useEffect(() => { localStorage.setItem('ac_kept', JSON.stringify([...kept])) }, [kept])
  useEffect(() => { localStorage.setItem('ac_onlyCJK', onlyCJK ? '1' : '0') }, [onlyCJK])

  useEffect(() => {
    fetch('/api/health').then((r) => {
      if (!r.ok) return
      setApiOk(true)
      fetch('/api/status').then((r2) => r2.ok ? r2.json() : null)
        .then((d) => d?.tools && setLiveTools(d.tools)).catch(() => {})
      fetch('/api/models').then((r3) => r3.ok ? r3.json() : null)
        .then((d) => {
          if (d?.models?.length) setModels(d.models)
        }).catch(() => {})
    }).catch(() => setApiOk(false))
  }, [])

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

  const refresh = async () => {
    setBusy('refresh')
    try {
      const r = await fetch('/api/refresh', { method: 'POST' })
      const d = await r.json()
      if (d.ok) {
        reloadIndex()
        showToast(t('已重新掃描全部工具'))
      } else {
        showToast(t('掃描失敗：{err}', { err: d.error || d.out || '' }))
      }
    } catch { showToast(t('控制 API 無回應')) }
    setBusy('')
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
  }, [selected])

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
    const filtered = index.conversations.filter((c) => {
      if (deleted.has(c.id)) return false
      // 有搜尋字串時豁免所有隱藏過濾器。
      // 原本只有資料夾層級豁免，對話層級的「一週未使用」照樣擋 ——
      // 結果搜兩週前的對話永遠是空的，但東西明明還在。
      // 垃圾桶是獨立的一個視圖，不是額外的過濾器 ——
      // 打開時「只」看垃圾桶裡的，關著時完全不出現。
      // 混在一起的話，看垃圾桶還要自己分辨哪些是垃圾桶裡的，等於沒有分。
      const inTrash = !!c.trashed && !kept.has(c.id)
      if (showTrash !== inTrash) return false
      if (!q) {
        if (!showSubagent && c.subagent) return false
        if (!showDup && c.dup) return false
        if (!showOld && c.mtime < cutoff) return false
        if (!showDispatch && c.dispatch) return false
        if (onlyCJK && !HAS_CJK.test(c.title)) return false
        return true
      }
      return c.title.toLowerCase().includes(q) || c.path.toLowerCase().includes(q) || c.projectDir.toLowerCase().includes(q)
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
      .filter(([, convs]) => !dirCutoff || convs.some((c) => c.mtime >= dirCutoff))
      .map(([dir, convs]) => {
        // 該資料夾的主要工作線 = 成員中最常見的分類
        const counts = new Map<string, number>()
        convs.forEach((c) => counts.set(c.project, (counts.get(c.project) || 0) + 1))
        const line = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'other'
        return { dir, line, convs }
      })
      .sort((a, b) => (b.convs[0]?.mtime ?? 0) - (a.convs[0]?.mtime ?? 0))
  }, [index, indexNow, search, showSubagent, showDup, showOld, showDispatch, showTrash,
      onlyCJK, kept, activeDays, deleted])

  const oldCount = useMemo(() => {
    if (!index) return 0
    const cutoff = indexNow - WEEK_MS
    return index.conversations.filter((c) => c.mtime < cutoff && !c.subagent && !c.dup).length
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
  const tabs = (
    <div className="flex flex-none items-center gap-1 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
      {([
        ['list', t('📋 對話')], ['console', t('🎙️ 主控台')],
        ['office', t('🎮 辦公室')], ['rpg', t('⚔️ 冒險')],
      ] as const).map(([m, label]) => (
        <button
          key={m}
          className={`rounded-md px-3 py-1 text-xs ${viewMode === m ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
          onClick={() => setViewMode(m)}
        >
          {label}
        </button>
      ))}
      <LangSwitch />
    </div>
  )

  if (!index) return (
    <div className="flex h-screen flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <main className="flex min-w-0 flex-1 flex-col">
        {tabs}
        {viewMode === 'console' ? (
          <Console />
        ) : viewMode === 'office' ? (
          <Office tools={liveTools ?? {}} projects={[]} conversations={[]} onDispatch={launch} busyId={busy} />
        ) : viewMode === 'rpg' ? (
          <Adventure tools={liveTools ?? {}} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="max-w-md text-center">
              {error ? (
                <>
                  <p role="alert" className="mb-2 text-sm text-red-600">{t('索引載入失敗：{err}', { err: error })}</p>
                  <p className="mb-4 text-xs text-zinc-500">{t('第一次使用要先掃描一次，才會有對話清單。其他三個分頁不需要索引，現在就能用。')}</p>
                  <button
                    className="rounded-md border border-zinc-300 px-4 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    disabled={busy === 'refresh'}
                    onClick={refresh}
                  >
                    {busy === 'refresh' ? t('掃描中…') : t('掃描建立索引')}
                  </button>
                </>
              ) : (
                <p role="status" aria-live="polite" className="text-sm text-zinc-500">{t('正在掃描全部 AI 對話…')}</p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )

  return (
    <div className="flex h-screen flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="flex min-h-0 flex-1">
        {/* ── 側欄 ─────────────────────────── */}
        <aside className="flex w-80 flex-none flex-col border-r border-zinc-200 dark:border-zinc-800">
          <div className="border-b border-zinc-200 p-3 dark:border-zinc-800">
            <div className="mb-2 flex items-baseline justify-between">
              <h1 className="text-lg font-medium">{t('AI 控制台')}</h1>
              <span className="text-xs text-zinc-400">{t('{time}更新', { time: relTime(index.generated_at) })}</span>
            </div>
            <div className="mb-2 flex items-center gap-2">
              <button
                className="rounded-md border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
                disabled={!apiOk || busy === 'refresh'}
                onClick={refresh}
                title={apiOk ? t('重新掃描全部工具的對話') : t('控制 API 未啟動（npm run dev 會同時啟動）')}
              >
                {busy === 'refresh' ? t('掃描中…') : t('↻ 重新掃描')}
              </button>
              {!apiOk && <span role="status" className="text-xs text-amber-600">{t('控制 API 離線（檢視模式）')}</span>}
            </div>
            <input
              className="w-full rounded-md border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700"
              placeholder={t('搜尋全部對話…')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {(index.stats.trashed ?? 0) > 0 && (
              <button
                className={`mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs ${
                  showTrash
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
                onClick={() => setShowTrash((v) => !v)}
                title={t('這些對話只是收起來，檔案完全沒有動。點「留著」可以單筆放回主清單')}
              >
                🗑️ {showTrash ? t('回到主清單') : t('垃圾桶（{n} 份）', { n: index.stats.trashed ?? 0 })}
              </button>
            )}
            {showTrash && (
              <div className="mt-1 rounded bg-zinc-100 px-2 py-1 text-[10px] leading-relaxed text-zinc-500 dark:bg-zinc-900">
                {t('收起來的原因：不是目前在用的工具、太久沒動過，或在原本的工具裡已經封存。檔案都還在，沒有刪除。')}
              </div>
            )}
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={showSubagent} onChange={(e) => setShowSubagent(e.target.checked)} />
              {t('顯示子代理對話（{n} 份）', { n: index.stats.subagent })}
            </label>
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={showDup} onChange={(e) => setShowDup(e.target.checked)} />
              {t('顯示重複副本（{dup} 份，去重後 {uniq} 份正本）', { dup: index.stats.duplicates ?? 0, uniq: index.stats.unique ?? index.stats.total })}
            </label>
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />
              {t('顯示一週未使用的舊對話（已收納 {n} 份）', { n: oldCount })}
            </label>
            <label
              className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-zinc-500"
              title={t('機器跑的 agent 迴圈標題都是英文的指令輸出，怎麼列規則都追不完；你自己開的對話都有中文')}
            >
              <input type="checkbox" checked={onlyCJK} onChange={(e) => setOnlyCJK(e.target.checked)} />
              {t('只顯示有中文的對話')}
            </label>
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={showDispatch} onChange={(e) => setShowDispatch(e.target.checked)} />
              {t('顯示 AI 派工對話（已隱藏 {n} 份 worker 紀錄）', { n: index.stats.dispatch ?? 0 })}
            </label>
            <label className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
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
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {groups.length === 0 && (
              // 過濾條件太緊時整個側欄會是空的，沒有提示的話看起來就像程式壞了
              <div role="status" aria-live="polite" className="px-3 py-6 text-center text-xs text-zinc-400">
                <div>{search.trim() ? t('找不到符合的對話') : t('目前的過濾條件下沒有東西')}</div>
                <div className="mt-1 text-zinc-500">
                  {t('索引裡共有 {n} 份對話', { n: index.conversations.length })}
                </div>
                {/* 「只顯示有中文的對話」是預設開啟的，而它正是最容易把清單清空的那一個。
                    不點名的話，對話多為英文的人只會看到「沒有東西」+ 索引有幾百份，
                    兩句互相矛盾，然後去懷疑掃描器 —— 實際上只是一個過濾器開著。 */}
                {onlyCJK && !search.trim() && (
                  <div className="mt-2">
                    <div className="text-amber-600 dark:text-amber-400">
                      {t('已套用「只顯示有中文的對話」過濾')}
                    </div>
                    <button
                      className="mt-1 rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      onClick={() => setOnlyCJK(false)}
                    >
                      {t('關掉這個過濾')}
                    </button>
                  </div>
                )}
                <button
                  className="mt-3 rounded border border-zinc-300 px-3 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  onClick={() => {
                    setActiveDays(0); setShowOld(true); setShowSubagent(true)
                    setShowDup(true); setShowDispatch(true); setSearch('')
                    // onlyCJK 與 showTrash 也要重設。漏掉它們的話：
                    // 機器上主要是英文對話的人，或正好切在垃圾桶視圖的人，
                    // 按了「重設所有過濾條件」還是 0 筆，畫面繼續叫他重設 —— 死循環。
                    setOnlyCJK(false); setShowTrash(false)
                  }}
                >
                  {t('重設所有過濾條件')}
                </button>
              </div>
            )}
            {groups.map(({ dir, line, convs }) => {
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
                <div key={dir} className="border-b border-zinc-100 dark:border-zinc-900">
                  {/* 外層是 div，不是 button。
                      原本折疊鈕是 <button>，裡面又塞一個 <span role="button">（▶ 派工）——
                      HTML 不准按鈕巢狀，而且那個 span 沒有 tabIndex 也沒有鍵盤處理，
                      用鍵盤操作的人永遠 Tab 不到「派工」。
                      改成兩顆並排的原生 <button>，Tab 與 Enter/Space 就自動正確。 */}
                  <div className="flex w-full items-center gap-2 px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => setOpenGroups((s) => ({ ...s, [dir]: !open }))}
                      aria-expanded={open}
                      title={dir}
                    >
                      <span className="text-xs text-zinc-400">{open ? '▾' : '▸'}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">📁 {folderName(dir)}</span>
                      {line !== 'other' && (
                        <span className="flex-none rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          {index.projectTitles[line] || line}
                        </span>
                      )}
                      {badge && <span className={`flex-none rounded-full px-2 py-0.5 text-xs ${badge.cls}`}>{badge.label}</span>}
                      {hub?.needs_handoff && <span className="flex-none rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">{t('待接力')}</span>}
                      <span className="flex-none text-xs text-zinc-400">{convs.length}</span>
                    </button>
                    {apiOk && convs.some((c) => c.resume) && (
                      <button
                        className="flex-none rounded border border-zinc-200 px-1.5 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
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
                    <div className="mx-3 mb-2 rounded-md bg-zinc-50 px-2 py-1.5 text-xs text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                      {t('下一步：')}{hub.next_step}
                    </div>
                  )}
                  {open && shown.map((c) => (
                    // 外層用 div 不用 button：裡面還要放一個刪除按鈕，
                    // 按鈕不能巢狀在按鈕裡
                    <div
                      key={c.id}
                      className={`group flex w-full items-start gap-1 px-3 py-1.5 pl-7 hover:bg-zinc-50 dark:hover:bg-zinc-900 ${selected?.id === c.id ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`}
                    >
                      <button
                        onClick={() => selectConversation(c.id)}
                        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                      >
                        <span className="truncate text-sm">
                          {c.title}
                          {c.dup && <span className="ml-1 rounded bg-zinc-100 px-1 text-xs text-zinc-400 dark:bg-zinc-800">{t('副本')}→{c.dupOfTool}</span>}
                          {!!c.dupCount && <span className="ml-1 rounded bg-zinc-100 px-1 text-xs text-zinc-400 dark:bg-zinc-800">+{t('{n} 副本', { n: c.dupCount })}</span>}
                        </span>
                        <span className="flex items-center gap-2 text-xs text-zinc-400">
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
                      {apiOk && (
                        <button
                          className="flex-none rounded px-1 text-xs text-zinc-300 opacity-0 hover:text-red-500 focus-visible:text-red-500 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 dark:text-zinc-600"
                          title={t('移到回收區')}
                          onClick={(e) => { e.stopPropagation(); void removeConv(c) }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  {open && !search.trim() && convs.length > 40 && !showAll[dir] && (
                    <button className="w-full px-3 py-1.5 text-left text-xs text-zinc-400 hover:text-zinc-600" onClick={() => setShowAll((s) => ({ ...s, [dir]: true }))}>
                      {t('顯示全部 {n} 筆…', { n: convs.length })}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </aside>

        {/* ── 主內容 ─────────────────────────── */}
        {/* relative 是給「⬇ 最新」浮動鈕定位用的。放在捲動容器裡面的話
            它會跟著內容一起捲走，等於沒有浮動。 */}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {tabs}
          {viewMode === 'console' ? (
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
          ) : !selected ? (
            <div className="flex flex-1 items-center justify-center text-zinc-400">
              <div className="text-center">
                <p className="mb-2 text-lg">{t('從左側選一個對話')}</p>
                <p className="text-sm">{t('共 {n} 份正本對話 · {tools} 個工具 · {groups} 個專案資料夾', { n: index.stats.unique ?? index.stats.total, tools: Object.keys(index.tools).length, groups: groups.length })}</p>
              </div>
            </div>
          ) : (
            <>
              <header className="flex-none border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
                <div className="mb-1 flex items-center gap-3">
                  <h2 className="min-w-0 flex-1 truncate text-base font-medium">{selected.title}</h2>
                  <span className="flex-none rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{selected.toolLabel}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
                  <span>{relTime(selected.mtime)}</span>
                  <span className="max-w-[40%] truncate" title={selected.path}>{selected.path}</span>
                  {apiOk && selected.resume && (
                    <button
                      className="rounded bg-zinc-900 px-2 py-0.5 text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                      disabled={busy === selected.id}
                      onClick={() => launch(selected)}
                    >
                      {busy === selected.id ? t('啟動中…') : t('▶ 接續此對話')}
                    </button>
                  )}
                  {selected.resume && (
                    <button className="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900" onClick={() => copy(selected.resume, 'resume')}>
                      {copied === 'resume' ? t('已複製 ✓') : t('複製接續指令：{cmd}', { cmd: selected.resume })}
                    </button>
                  )}
                  <button className="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900" onClick={() => copy(selected.path, 'path')}>
                    {copied === 'path' ? '已複製 ✓' : '複製檔案路徑'}
                  </button>
                </div>
              </header>

              <div
                ref={msgBoxRef}
                className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4"
                onScroll={onMsgScroll}
              >
                {!selected.hasMessages ? (
                  <p className="text-zinc-400">此對話檔較大（{fmtSize(selected.size)}），未匯出訊息內容；可用接續指令回原工具查看。</p>
                ) : detailLoading ? (
                  <p role="status" aria-live="polite" className="text-zinc-400">{t('載入訊息中…')}</p>
                ) : detail ? (
                  <div className="mx-auto flex max-w-3xl flex-col gap-3">
                    {detail.messages.map((m, i) => (
                      <div key={i} className={`rounded-lg px-4 py-3 text-sm leading-6 ${m.role === 'user' ? 'ml-12 bg-zinc-100 dark:bg-zinc-800' : 'mr-12 border border-zinc-200 dark:border-zinc-800'}`}>
                        <div className="mb-1 text-xs text-zinc-400">{m.role === 'user' ? '你' : selected.toolLabel}{m.ts ? ` · ${new Date(m.ts).toLocaleString('zh-TW')}` : ''}</div>
                        <div className="whitespace-pre-wrap break-words">{m.text}</div>
                      </div>
                    ))}
                    {detailTailState === 'latest' ? (
                      <p role="status" className="text-center text-xs text-zinc-400">
                        {t('已顯示真正最新的 {n} 則訊息；更早內容仍可回原工具查看。', { n: detail.messages.length })}
                      </p>
                    ) : detailTailState === 'fallback' ? (
                      <p role="alert" className="text-center text-xs text-amber-600 dark:text-amber-400">
                        {selected.resume
                          ? t('最新訊息載入失敗：{err}。目前顯示索引匯出的前段；仍可用「接續此對話」回原工具查看。', { err: detailTailError })
                          : t('最新訊息載入失敗：{err}。目前顯示索引匯出的前段；可複製上方檔案路徑回原工具查看。', { err: detailTailError })}
                      </p>
                    ) : detail.truncated ? (
                      <p className="text-center text-xs text-zinc-400">
                        {t('（訊息過多，目前顯示索引匯出的前段）')}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-zinc-400">找不到匯出的訊息檔。</p>
                )}

              </div>

              {/* 只在使用者往上捲離開底部時才出現。永遠掛著的話，
                  它會一直蓋住最後一則訊息的右下角。 */}
              {awayFromEnd && (
                <button
                  className="absolute bottom-24 right-6 z-10 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs shadow-lg hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
                  onClick={() => scrollMsgsToEnd('smooth')}
                >
                  {t('⬇ 最新')}
                </button>
              )}

              {/* 續聊區釘在捲動容器外面。放在裡面的話，對話一長就得
                  捲到最底才碰得到輸入框 —— 而「想接續聊」正是打開一份
                  對話最常見的目的，不該是最難到達的動作。 */}
              <div className="flex-none border-t border-zinc-200 bg-app dark:border-zinc-800">
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
                        <button className="rounded-md border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900" onClick={seedChat}>
                          載入近期訊息當上下文
                        </button>
                      ) : chatMsgs.length > 0 && (
                        <span className="text-xs text-zinc-400">上下文 {chatMsgs.length} 則</span>
                      )}
                      {chatMsgs.length > 0 && (
                        <button className="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-600" onClick={() => { setChatMsgs([]); if (selected) localStorage.removeItem('ac_chat_' + selected.id) }}>
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
                        className="mb-2 flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md bg-zinc-50 p-3 dark:bg-zinc-900"
                      >
                        {chatMsgs.map((m, i) => (
                          <div key={i} className={`rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'ml-10 bg-white dark:bg-zinc-800' : 'mr-10 border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-950'}`}>
                            <div className="mb-0.5 text-xs text-zinc-400">{m.role === 'user' ? '你' : (chatModel === 'auto' ? (routedModel || '自動') : chatModel)}</div>
                            <div className="whitespace-pre-wrap break-words">{m.text}</div>
                          </div>
                        ))}
                        {chatBusy && (
                          <div className="flex items-center gap-2 text-xs text-zinc-400">
                            {/* role=log 會在這一列加入時宣告一次；每秒變動的視覺計時
                                對讀屏器隱藏，避免整段推論期間每秒重複播報。 */}
                            <span className="sr-only">{t('地端模型開始處理這次訊息')}</span>
                            <span aria-hidden="true">{t('地端模型思考中… {n} 秒', { n: chatSecs })}</span>
                            {/* 15 秒之前不出現：正常的短回覆本來就會在那之內回來，
                                太早給取消鈕反而像在暗示「它大概壞了」。 */}
                            {chatSecs >= 15 && (
                              <button
                                className="rounded border border-zinc-300 px-1.5 py-0.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
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
                        className="min-h-10 flex-1 rounded-md border border-zinc-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700"
                        placeholder={chatMsgs.length ? '繼續這段對話…' : '直接輸入會自動帶入近期訊息當上下文'}
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }}
                      />
                      <button
                        className="self-end rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                        disabled={chatBusy || !chatModel}
                        onClick={sendChat}
                      >
                        {chatBusy ? '…' : '送出'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {/* ── 底部額度狀態列 ─────────────────────── */}
      {toast && (
        <div role="status" aria-live="polite" aria-atomic="true" className="fixed bottom-10 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
          {toast}
        </div>
      )}
      <footer className="flex flex-none items-center gap-4 overflow-x-auto border-t border-zinc-200 px-4 py-1.5 text-xs dark:border-zinc-800">
        {Object.entries(liveTools ?? index.tools).map(([key, tool]) => (
          <span key={key} className="flex flex-none items-center gap-1.5" title={tool.evidence || tool.role}>
            <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[tool.status] || STATUS_DOT.unknown}`} />
            <span className="text-zinc-600 dark:text-zinc-300">{tool.label}</span>
            <span className="text-zinc-400">{t(STATUS_LABEL[tool.status] || tool.status)}</span>
          </span>
        ))}
        <span className="ml-auto flex-none text-zinc-400">{liveTools ? t('即時狀態 · ') : ''}{t('ai-hub 每 15 分鐘自動掃描')}</span>
      </footer>
    </div>
  )
}
