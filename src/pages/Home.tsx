import { useEffect, useMemo, useState } from 'react'
import type { ConversationDetail, ConversationSummary, IndexData } from '@/types/data'
import Adventure from '@/components/Adventure'
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

export default function Home() {
  useLang()   // 語言一換就整頁重繪
  const [index, setIndex] = useState<IndexData | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showSubagent, setShowSubagent] = useState(() => localStorage.getItem('ac_showSub') === '1')
  const [showDup, setShowDup] = useState(() => localStorage.getItem('ac_showDup') === '1')
  const [showOld, setShowOld] = useState(() => localStorage.getItem('ac_showOld') === '1')
  const [showDispatch, setShowDispatch] = useState(() => localStorage.getItem('ac_showDisp') === '1')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<ConversationSummary | null>(null)
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
  const [viewMode, setViewMode] = useState<'list' | 'office' | 'rpg'>('list')

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(''), 4000) }

  useEffect(() => { localStorage.setItem('ac_showSub', showSubagent ? '1' : '0') }, [showSubagent])
  useEffect(() => { localStorage.setItem('ac_showDup', showDup ? '1' : '0') }, [showDup])
  useEffect(() => { localStorage.setItem('ac_showOld', showOld ? '1' : '0') }, [showOld])
  useEffect(() => { localStorage.setItem('ac_showDisp', showDispatch ? '1' : '0') }, [showDispatch])

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

  const reloadIndex = () => {
    fetch('/data/index.json?t=' + Date.now()).then((r) => r.json()).then((d) => setIndex(normalize(d))).catch(() => {})
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

  // 還原上次選取的對話
  useEffect(() => {
    if (index && !selected) {
      const lastId = localStorage.getItem('ac_selected')
      if (lastId) {
        const c = index.conversations.find((x) => x.id === lastId)
        if (c) setSelected(c)
      }
    }
  }, [index])

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

  // 選新對話時重置聊天串，並嘗試還原本機暫存
  useEffect(() => {
    if (!selected) { setChatMsgs([]); return }
    try {
      const saved = localStorage.getItem('ac_chat_' + selected.id)
      setChatMsgs(saved ? JSON.parse(saved) : [])
    } catch { setChatMsgs([]) }
  }, [selected])

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

  const normalize = (d: IndexData): IndexData => {
    d.conversations.forEach((c) => { if (c.mtime < 1e12) c.mtime *= 1000 })  // python 秒 → JS 毫秒
    return d
  }

  useEffect(() => {
    fetch('/data/index.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d) => setIndex(normalize(d)))
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    if (!selected) return
    localStorage.setItem('ac_selected', selected.id)
    setDetail(null)
    if (!selected.hasMessages) return
    setDetailLoading(true)
    fetch(`/data/conv/${selected.id}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setDetail(d); setDetailLoading(false) })
      .catch(() => setDetailLoading(false))
  }, [selected])

  // 依「原始專案資料夾」分組（保留各工具原本的目錄結構）
  const groups = useMemo(() => {
    if (!index) return [] as { dir: string; line: string; convs: ConversationSummary[] }[]
    const q = search.trim().toLowerCase()
    const cutoff = Date.now() - WEEK_MS
    const filtered = index.conversations.filter((c) => {
      if (!showSubagent && c.subagent) return false
      if (!showDup && c.dup) return false
      if (!showOld && c.mtime < cutoff) return false
      if (!showDispatch && c.dispatch) return false
      if (!q) return true
      return c.title.toLowerCase().includes(q) || c.path.toLowerCase().includes(q) || c.projectDir.toLowerCase().includes(q)
    })
    const map = new Map<string, ConversationSummary[]>()
    for (const c of filtered) {
      const key = c.projectDir || t('（無目錄）')
      const arr = map.get(key) || []
      arr.push(c)
      map.set(key, arr)
    }
    return [...map.entries()]
      .map(([dir, convs]) => {
        // 該資料夾的主要工作線 = 成員中最常見的分類
        const counts = new Map<string, number>()
        convs.forEach((c) => counts.set(c.project, (counts.get(c.project) || 0) + 1))
        const line = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'other'
        return { dir, line, convs }
      })
      .sort((a, b) => (b.convs[0]?.mtime ?? 0) - (a.convs[0]?.mtime ?? 0))
  }, [index, search, showSubagent, showDup, showOld, showDispatch])

  const oldCount = useMemo(() => {
    if (!index) return 0
    const cutoff = Date.now() - WEEK_MS
    return index.conversations.filter((c) => c.mtime < cutoff && !c.subagent && !c.dup).length
  }, [index])

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
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
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
                    <button
                      key={c.id}
                      onClick={() => setSelected(c)}
                      className={`flex w-full flex-col gap-0.5 px-3 py-1.5 pl-7 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900 ${selected?.id === c.id ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`}
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
          {viewMode === 'office' ? (
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
