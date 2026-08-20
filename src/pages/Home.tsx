import { useEffect, useMemo, useState } from 'react'
import type { ConversationDetail, ConversationSummary, IndexData } from '@/types/data'
import Adventure from '@/components/Adventure'
import Console from '@/components/Console'
import Office from '@/components/Office'
import { t, useLang } from '@/i18n'
import LangSwitch from '@/components/LangSwitch'

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

export default function Home() {
  useLang()   // 語言一換就整頁重繪
  const [index, setIndex] = useState<IndexData | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showSubagent, setShowSubagent] = useState(() => localStorage.getItem('ac_showSub') === '1')
  const [showDup, setShowDup] = useState(() => localStorage.getItem('ac_showDup') === '1')
  const [showOld, setShowOld] = useState(() => localStorage.getItem('ac_showOld') === '1')
  const [showDispatch, setShowDispatch] = useState(() => localStorage.getItem('ac_showDisp') === '1')
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
  const [viewMode, setViewMode] = useState<'list' | 'console' | 'office' | 'rpg'>('list')
  // 只顯示最近幾天有活動的資料夾。142 個資料夾裡今天只用過 25 個，
  // 全部列出來等於什麼都找不到。0 = 不限。
  const [activeDays, setActiveDays] = useState(() => Number(localStorage.getItem('ac_activeDays') ?? 7))
  const [deleted, setDeleted] = useState<Set<string>>(new Set())
  useEffect(() => { localStorage.setItem('ac_activeDays', String(activeDays)) }, [activeDays])

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 4000) }

  useEffect(() => { localStorage.setItem('ac_showSub', showSubagent ? '1' : '0') }, [showSubagent])
  useEffect(() => { localStorage.setItem('ac_showDup', showDup ? '1' : '0') }, [showDup])
  useEffect(() => { localStorage.setItem('ac_showOld', showOld ? '1' : '0') }, [showOld])
  useEffect(() => { localStorage.setItem('ac_showDisp', showDispatch ? '1' : '0') }, [showDispatch])
  useEffect(() => { localStorage.setItem('ac_kept', JSON.stringify([...kept])) }, [kept])

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

  const normalize = (d: IndexData): IndexData => {
    d.conversations.forEach((c) => { if (c.mtime < 1e12) c.mtime *= 1000 })  // python 秒 → JS 毫秒
    return d
  }

  const reloadIndex = () => {
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
  }

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
  }, [apiOk])

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
        if (selected?.id === c.id) setSelectedId(null)
        showToast(t('已移到回收區'))
      } else showToast(t('刪除失敗：{err}', { err: d.error || '' }))
    } catch { showToast(t('控制 API 無回應')) }
  }

  const refresh = async () => {
    setBusy('refresh')
    try {
      const r = await fetch('/api/refresh', { method: 'POST' })
      const d = await r.json()
      if (d.ok) { reloadIndex(); showToast('已重新掃描全部工具') } else showToast('掃描失敗：' + (d.error || d.out || ''))
    } catch { showToast('控制 API 無回應') }
    setBusy('')
  }

  const launch = async (c: ConversationSummary) => {
    setBusy(c.id)
    try {
      const r = await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: c.id }) })
      const d = await r.json()
      if (d.ok) showToast(t('已開啟終端：{cmd}', { cmd: d.cmd }))
      else {
        if (c.resume) { copy(c.resume, 'resume'); showToast('此工具無法直接啟動，已改為複製接續指令') }
        else showToast('無法啟動：' + (d.error || ''))
      }
    } catch { showToast('控制 API 無回應') }
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

  const sendChat = async () => {
    const text = chatInput.trim()
    if (!text || chatBusy || !chatModel) return
    // 自動路由：依任務類型 + 系統狀態選模型
    let useModel = chatModel
    if (chatModel === 'auto') {
      try {
        const rr = await fetch('/api/route?task=' + inferTask())
        const rd = await rr.json()
        if (rd.ok && rd.model) {
          useModel = rd.model
          setRoutedModel(rd.model)
          setRouteInfo(t('自動選擇：{model} — {reason}', { model: rd.model, reason: rd.reason }))
        } else {
          setRouteInfo(rd.reason || t('自動路由失敗'))
          setChatBusy(false)
          return
        }
      } catch { setRouteInfo(t('路由 API 無回應')); return }
    }
    const history = chatMsgs.length ? chatMsgs : (detail?.messages?.slice(-8).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text.slice(0, 1200),
    })) || [])
    const next = [...history, { role: 'user', text }]
    setChatMsgs(next)
    setChatInput('')
    setChatBusy(true)
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
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
      const reply = d.ok ? (d.content || d.reasoning || t('（空回應）')) : `⚠️ ${d.error || t('呼叫失敗')}`
      const finalMsgs = [...next, { role: 'assistant', text: reply }]
      setChatMsgs(finalMsgs)
      if (selected) localStorage.setItem('ac_chat_' + selected.id, JSON.stringify(finalMsgs.slice(-30)))
    } catch {
      setChatMsgs([...next, { role: 'assistant', text: t('⚠️ 控制 API 無回應') }])
    }
    setChatBusy(false)
  }


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
    fetch(`/data/conv/${selected.id}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setDetail(d); setDetailLoading(false) })
      .catch(() => setDetailLoading(false))
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
  }, [index, indexNow, search, showSubagent, showDup, showOld, showDispatch, showTrash, kept, activeDays, deleted])

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

  if (error) return <div className="p-8 text-red-600">{t('索引載入失敗：{err}（請先執行 tools/indexer.py）', { err: error })}</div>
  if (!index) return <div className="p-8 text-zinc-500">{t('正在掃描全部 AI 對話…')}</div>

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
              {!apiOk && <span className="text-xs text-amber-600">{t('控制 API 離線（檢視模式）')}</span>}
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
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={showDispatch} onChange={(e) => setShowDispatch(e.target.checked)} />
              {t('顯示 AI 派工對話（已隱藏 {n} 份 worker 紀錄）', { n: index.stats.dispatch ?? 0 })}
            </label>
            <label className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
              {t('只看最近')}
              <select
                className="rounded border border-zinc-200 bg-transparent px-1 py-0.5 text-xs dark:border-zinc-700"
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
              <div className="px-3 py-6 text-center text-xs text-zinc-400">
                <div>{search.trim() ? t('找不到符合的對話') : t('目前的過濾條件下沒有東西')}</div>
                <div className="mt-1 text-zinc-500">
                  {t('索引裡共有 {n} 份對話', { n: index.conversations.length })}
                </div>
                <button
                  className="mt-3 rounded border border-zinc-300 px-3 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  onClick={() => {
                    setActiveDays(0); setShowOld(true); setShowSubagent(true)
                    setShowDup(true); setShowDispatch(true); setSearch('')
                  }}
                >
                  {t('重設所有過濾條件')}
                </button>
              </div>
            )}
            {groups.map(({ dir, line, convs }) => {
              const hub = hubProjects.get(line)
              // 專案分組預設收合：一台機器上動輒上百個專案，全展開要滾很久
              const open = openGroups[dir] ?? false
              const shown = showAll[dir] ? convs : convs.slice(0, 40)
              const badge = hub ? PROJ_BADGE[hub.status] : null
              return (
                <div key={dir} className="border-b border-zinc-100 dark:border-zinc-900">
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    onClick={() => setOpenGroups((s) => ({ ...s, [dir]: !open }))}
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
                    {apiOk && convs.some((c) => c.resume) && (
                      <span
                        role="button"
                        className="flex-none rounded border border-zinc-200 px-1.5 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        title={t('派工：接續此資料夾最新的對話')}
                        onClick={(e) => {
                          e.stopPropagation()
                          const target = convs.find((c) => c.resume)
                          if (target) launch(target)
                        }}
                      >
                        {busy && convs.some((c) => c.id === busy) ? '…' : t('▶ 派工')}
                      </span>
                    )}
                  </button>
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
                        onClick={() => setSelectedId(c.id)}
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
                          className="flex-none rounded px-1 text-xs text-zinc-300 opacity-0 hover:text-red-500 group-hover:opacity-100 dark:text-zinc-600"
                          title={t('移到回收區')}
                          onClick={(e) => { e.stopPropagation(); void removeConv(c) }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  {open && convs.length > 40 && !showAll[dir] && (
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
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-none items-center gap-1 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
            <button
              className={`rounded-md px-3 py-1 text-xs ${viewMode === 'list' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
              onClick={() => setViewMode('list')}
            >
              {t('📋 對話')}
            </button>
            <button
              className={`rounded-md px-3 py-1 text-xs ${viewMode === 'console' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
              onClick={() => setViewMode('console')}
            >
              {t('🎙️ 主控台')}
            </button>
            <button
              className={`rounded-md px-3 py-1 text-xs ${viewMode === 'office' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
              onClick={() => setViewMode('office')}
            >
              {t('🎮 辦公室')}
            </button>
            <button
              className={`rounded-md px-3 py-1 text-xs ${viewMode === 'rpg' ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
              onClick={() => setViewMode('rpg')}
            >
              {t('⚔️ 冒險')}
            </button>
            <LangSwitch />
          </div>
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

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {!selected.hasMessages ? (
                  <p className="text-zinc-400">此對話檔較大（{fmtSize(selected.size)}），未匯出訊息內容；可用接續指令回原工具查看。</p>
                ) : detailLoading ? (
                  <p className="text-zinc-400">載入訊息中…</p>
                ) : detail ? (
                  <div className="mx-auto flex max-w-3xl flex-col gap-3">
                    {detail.messages.map((m, i) => (
                      <div key={i} className={`rounded-lg px-4 py-3 text-sm leading-6 ${m.role === 'user' ? 'ml-12 bg-zinc-100 dark:bg-zinc-800' : 'mr-12 border border-zinc-200 dark:border-zinc-800'}`}>
                        <div className="mb-1 text-xs text-zinc-400">{m.role === 'user' ? '你' : selected.toolLabel}{m.ts ? ` · ${new Date(m.ts).toLocaleString('zh-TW')}` : ''}</div>
                        <div className="whitespace-pre-wrap break-words">{m.text}</div>
                      </div>
                    ))}
                    {detail.truncated && <p className="text-center text-xs text-zinc-400">（訊息過多，僅顯示前段；完整內容請回原工具）</p>}
                  </div>
                ) : (
                  <p className="text-zinc-400">找不到匯出的訊息檔。</p>
                )}

                {/* ── 地端續聊 ── */}
                {apiOk && (
                  <div className="mx-auto mt-6 max-w-3xl border-t border-zinc-200 pt-4 dark:border-zinc-800">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-sm font-medium">💬 用地端模型接續</span>
                      <select
                        className="rounded-md border border-zinc-200 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
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
                    {routeInfo && <div className="mb-2 text-xs text-amber-600 dark:text-amber-400">{routeInfo}</div>}
                    {chatMsgs.length > 0 && (
                      <div className="mb-2 flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md bg-zinc-50 p-3 dark:bg-zinc-900">
                        {chatMsgs.map((m, i) => (
                          <div key={i} className={`rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'ml-10 bg-white dark:bg-zinc-800' : 'mr-10 border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-950'}`}>
                            <div className="mb-0.5 text-xs text-zinc-400">{m.role === 'user' ? '你' : (chatModel === 'auto' ? (routedModel || '自動') : chatModel)}</div>
                            <div className="whitespace-pre-wrap break-words">{m.text}</div>
                          </div>
                        ))}
                        {chatBusy && <div className="text-xs text-zinc-400">地端模型思考中…</div>}
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
        <div className="fixed bottom-10 left-1/2 z-10 -translate-x-1/2 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900">
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
