import { useEffect, useMemo, useState } from 'react'
import PixelOffice from '@/components/PixelOffice'
import { SKINS } from '@/pixel/sprites'
import { t, useLang } from '@/i18n'
import { useReadable } from '@/theme'
import { isLive, look, stateOf } from '@/lib/dispatchState'
import type { ConversationSummary, DispatchRecord, HubProject, ToolStatus } from '@/types/data'

// ── 角色人設（名稱與配色統一由 SKINS 提供，這裡只放對話用的人格）──
const PERSONAS: Record<string, string> = {
  kimi: '你是 KIMI，AI 辦公室的總控調度，一隻沉穩可靠的藍龍，手上永遠有咖啡。{LANG_HINT_SHORT}',
  claude: '你是 CLAUDE，辦公室的執行 Worker，一隻務實的橘龍。認真、執行力強。{LANG_HINT}',
  codex: '你是 CODEX，治理派工官，一隻戴眼鏡的綠龍，拿著 clipboard。講規矩、重流程。{LANG_HINT}',
  grok: '你是 GROK，生成主力，一隻穿皮外套的天藍龍，活力十足，說話有點衝但可靠。{LANG_HINT}',
  qwen: '你是 QWEN，地端兜底的紫龍大姊姊，冷靜淡定，雲端全掛時你最可靠。{LANG_HINT}',
  cursor: '你是 CURSOR，輔助編輯，一隻掛著耳機的琥珀龍，隨性自在。{LANG_HINT}',
  gemini: '你是 AGY，一隻傻傻的小黃龍，大眼睛流口水。說話簡短可愛，語尾偶爾帶「嗷」。{LANG_HINT}',
}
const CHARS = Object.fromEntries(
  Object.entries(SKINS).map(([k, s]) => [k, { name: s.name, color: s.color, persona: PERSONAS[k] ?? '' }]),
) as Record<string, { name: string; color: string; persona: string }>

/**
 * 人設裡的語言指示跟著介面語言走 —— 介面切英文卻回中文，
 * 對非中文使用者等於沒開源。
 */
function persona(key: string): string {
  return (CHARS[key]?.persona ?? '')
    .replace('{LANG_HINT_SHORT}', t('用繁體中文、簡潔地回答。'))
    .replace('{LANG_HINT}', t('用繁體中文回答。'))
}

/** 龍頭像：直接取 sprite sheet 的第 0 格（正面站姿），放大到只看得到臉 */
function DragonFace({ agent, size = 32 }: { agent: string; size?: number }) {
  const zoom = 2.4                       // 放大倍率，讓圓框內主要是頭部
  return (
    <div
      className="flex-none overflow-hidden rounded-full border border-white/40 bg-elev/80"
      style={{
        width: size, height: size,
        backgroundImage: `url(/office/sprites/${agent}.png)`,
        backgroundSize: `${size * 4 * zoom}px ${size * 3 * zoom}px`,
        // 第 0 格的頭大約在格內 (12..36, 2..22)/48，把那塊移到圓框中央
        backgroundPosition: `${-size * zoom * 0.25 + size * 0.5}px ${-size * zoom * 0.04}px`,
        imageRendering: 'pixelated',
      }}
    />
  )
}

interface ChatMsg { role: string; text: string }

interface Props {
  tools: Record<string, ToolStatus>
  projects: HubProject[]
  conversations: ConversationSummary[]
  onDispatch: (c: ConversationSummary) => void
  busyId: string
}

/**
 * /api/map 與 /api/audit 的回應形狀。
 *
 * 只宣告畫面真的會讀的欄位 —— 後端多回什麼不影響，但少回或改名時
 * 編譯會當場抱怨。原本這兩個都是 any，欄位改名不會有任何警告，
 * 要等使用者看到欄位變成「—」才會發現。
 */
interface ToolMapEntry {
  account?: { account?: string; plan?: string; until?: string }
  browser?: string
  skills?: string[]
  settings?: string[]
}
type ToolMap = Record<string, ToolMapEntry | undefined> & {
  /** 跨工具共享的治理技能（.agents） */
  _governance?: { skills: string[] }
}

interface AuditReport {
  generated_at: string
  summary: {
    sites_ok: number
    sites_partial: number
    sites_empty: number
    articles: number
    expected_articles: number
    words: number
  }
  dispatch_logs: { errors: string[] }[]
}

export default function Office({ tools, projects, conversations, onDispatch, busyId }: Props) {
  useLang()
  const tone = useReadable()   // 語言一換就重繪
  const [chatWith, setChatWith] = useState<string | null>(null)
  // 對話存起來。原本只是元件 state —— 關掉對話框或切到別的分頁就全沒了，
  // 而使用者常常在這裡打一長串指示。切分頁回來看到空白，會以為送丟了。
  const [agentMsgs, setAgentMsgs] = useState<Record<string, ChatMsg[]>>(() => {
    try { return JSON.parse(localStorage.getItem('ac_office_chat') || '{}') } catch { return {} }
  })
  useEffect(() => {
    try { localStorage.setItem('ac_office_chat', JSON.stringify(agentMsgs)) } catch { /* 存不了不影響使用 */ }
  }, [agentMsgs])
  const [agentInput, setAgentInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  // 地端模型一句話可能要等一分鐘。只寫「思考中…」看起來跟當掉一樣，
  // 秒數會跳才知道它還活著。
  const [chatSec, setChatSec] = useState(0)
  useEffect(() => {
    if (!chatBusy) return
    const timer = setInterval(() => setChatSec((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [chatBusy])
  const [routed, setRouted] = useState('')
  // 中控
  const [cmdTool, setCmdTool] = useState('auto')
  const [cmdInput, setCmdInput] = useState('')
  const [cmdBusy, setCmdBusy] = useState(false)
  const [cmdLog, setCmdLog] = useState<string[]>([])
  const [toolMap, setToolMap] = useState<ToolMap | null>(null)
  const [showMap, setShowMap] = useState(false)
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([])
  const [audit, setAudit] = useState<AuditReport | null>(null)
  const [auditBusy, setAuditBusy] = useState(false)

  // 只有還沒結束的才算「現在正在發生」。整份歷史攤在這裡的話，
  // 辦公室永遠看起來很忙，實際上可能一件都沒在跑。
  const liveDispatches = dispatches.filter(isLive)

  const refreshDispatches = () => {
    fetch('/api/dispatches').then((r) => r.ok ? r.json() : null)
      .then((d) => d?.ok && setDispatches(d.dispatches)).catch(() => {})
  }
  const runAudit = () => {
    setAuditBusy(true)
    fetch('/api/audit').then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d?.summary) setAudit(d) })
      .catch(() => {})
      .finally(() => setAuditBusy(false))
  }

  useEffect(() => {
    fetch('/api/map').then((r) => r.ok ? r.json() : null)
      .then((d) => d?.ok && setToolMap(d.map)).catch(() => {})
    refreshDispatches()
    const timer = setInterval(refreshDispatches, 15000)
    return () => clearInterval(timer)
  }, [])

  const queue = useMemo(() => projects.filter((p) => p.status !== 'done'), [projects])
  const findConvFor = (pid: string) =>
    conversations.find((c) => c.project === pid && c.resume && !c.subagent && !c.dup)

  // ── 角色對話 ──
  const sendAgentChat = async () => {
    const text = agentInput.trim()
    if (!text || !chatWith || chatBusy) return
    const sys = persona(chatWith)
    const history = agentMsgs[chatWith] || []
    const next = [...history, { role: 'user', text }]
    setAgentMsgs((m) => ({ ...m, [chatWith]: next }))
    setAgentInput('')
    setChatBusy(true)
    setChatSec(0)
    try {
      let model = routed
      if (!model) {
        const rr = await fetch('/api/route?task=general')
        const rd = await rr.json()
        model = rd.ok ? rd.model : ''
        if (model) setRouted(model)
      }
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: sys }, ...next.map((m) => ({ role: m.role, content: m.text }))],
        }),
      })
      const d = await r.json()
      const reply = d.ok ? (d.content || d.reasoning || t('（空回應）')) : `⚠️ ${d.error || t('失敗')}`
      setAgentMsgs((m) => ({ ...m, [chatWith]: [...next, { role: 'assistant', text: reply }] }))
    } catch {
      setAgentMsgs((m) => ({ ...m, [chatWith]: [...next, { role: 'assistant', text: t('⚠️ API 無回應') }] }))
    }
    setChatBusy(false)
  }

  /**
   * 把打好的那句話真的交給這隻龍代表的工具去做。
   *
   * 為什麼要有這個：對話框本來就寫著「或叫他去工作」，但在這之前
   * 框裡唯一的動作是「送出」——那只是叫地端模型扮演這隻龍回話。
   * 使用者對 GROK 說「幫我把 X 做完」，得到「好的，我這就去做」，
   * 然後什麼都沒發生。介面承諾了一件它做不到的事，這是最糟的一種壞。
   *
   * 派出去走的是跟主控台完全一樣的 /api/dispatch，所以同樣會掛規範與技能、
   * 同樣寫 log、同樣進派工登錄 —— 不另外做一套。
   */
  const dispatchToAgent = async () => {
    const text = agentInput.trim()
    if (!text || !chatWith || chatBusy) return
    const name = CHARS[chatWith].name
    setAgentMsgs((m) => ({
      ...m, [chatWith]: [...(m[chatWith] || []), { role: 'user', text }],
    }))
    setAgentInput('')
    setChatBusy(true)
    setChatSec(0)
    try {
      const d = await fetch('/api/dispatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: chatWith, task: text }),
      }).then((r) => r.json())
      const note = d.ok
        ? `⚡ ${d.note || t('已派給 {name}', { name })}`
        : `⚠️ ${d.error || t('派工失敗')}`
      setAgentMsgs((m) => ({
        ...m, [chatWith]: [...(m[chatWith] || []), { role: 'assistant', text: note }],
      }))
    } catch {
      setAgentMsgs((m) => ({
        ...m, [chatWith]: [...(m[chatWith] || []), { role: 'assistant', text: t('⚠️ 控制 API 無回應') }],
      }))
    }
    setChatBusy(false)
  }

  // ── 中控派工 ──
  const sendCommand = async () => {
    const text = cmdInput.trim()
    if (!text || cmdBusy) return
    setCmdBusy(true)
    setCmdLog((l) => [...l, `> [${cmdTool === 'auto' ? t('自動') : cmdTool}] ${text}`])
    setCmdInput('')
    try {
      const r = await fetch('/api/dispatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: cmdTool, task: text }),
      })
      const d = await r.json()
      if (d.ok) {
        if (d.reply) setCmdLog((l) => [...l, `[${d.model || d.tool}] ${d.reply.slice(0, 500)}`])
        else setCmdLog((l) => [...l, `✅ ${d.note || t('已派出')}（log: ${d.log}）`])
      } else {
        setCmdLog((l) => [...l, `⚠️ ${d.error || t('失敗')}`])
      }
      refreshDispatches()
    } catch {
      setCmdLog((l) => [...l, t('⚠️ API 無回應')])
    }
    setCmdBusy(false)
  }

  const legend: [string, string, string][] = [
    ['#34d399', t('工作中'), t('坐在位子上瘋狂打電腦，偶爾找同事辯論')],
    ['#fbbf24', t('偷懶中'), t('上廁所、看書、泡咖啡、種花、走來走去')],
    ['#818cf8', t('休息中'), t('額度用畢躺沙發，對話框寫明恢復時間')],
    ['#f59e0b', t('派工中'), t('站到白板前執行任務（tool calling）')],
    ['#71717a', t('沒紀錄'), t('找不到這個工具的使用紀錄，先擺在門邊；半透明不是壞掉')],
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-app">
      {/* ── 像素辦公室 ── */}
      <PixelOffice tools={tools} dispatches={dispatches} onPick={setChatWith} />

      {/* 狀態圖例 */}
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-app px-4 py-2 text-xs text-mute">
        {legend.map(([col, label, hint]) => (
          <span key={label} className="flex items-center gap-1.5" title={hint}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: tone(col) }} />
            {label}
          </span>
        ))}
        <span className="ml-auto text-mute3">{t('點角色開對話')}</span>
      </div>

      {/* ── 中控 + 任務排程 ── */}
      <div className="flex flex-none flex-wrap gap-3 border-t border-line bg-panel px-4 py-3">
        {/* 中控對話框 */}
        <div className="min-w-72 flex-1 rounded border border-line2 bg-elev p-3">
          <div className="mb-2 text-xs font-medium tracking-widest text-mute">{t('🎛️ 中控指揮台')}</div>
          <div className="mb-2 max-h-36 overflow-y-auto rounded bg-app p-2 font-mono text-xs leading-5 text-ink3">
            {cmdLog.length === 0 && <span className="text-mute3">{t('下指令給全體或指定夥伴，例如「整理今天的工作進度」…')}</span>}
            {cmdLog.map((l, i) => <div key={i} className="whitespace-pre-wrap break-all">{l}</div>)}
            {cmdBusy && <div className="text-mute2">{t('派工中…')}</div>}
          </div>
          <div className="flex gap-2">
            <select
              className="rounded border border-line3 bg-panel px-2 py-1.5 text-xs text-ink2"
              value={cmdTool}
              onChange={(e) => setCmdTool(e.target.value)}
            >
              <option value="auto">{t('🤖 自動路由')}</option>
              <option value="claude">{t('Claude（無頭）')}</option>
              <option value="codex">{t('Codex（無頭）')}</option>
              <option value="qwen">{t('Qwen（無頭）')}</option>
              <option value="grok">{t('Grok（終端預填）')}</option>
              <option value="local">{t('地端（LM Studio）')}</option>
            </select>
            <input
              className="min-w-0 flex-1 rounded border border-line3 bg-panel px-3 py-1.5 text-sm text-ink outline-none focus:border-line4"
              placeholder={t('輸入指令，Enter 派出…')}
              value={cmdInput}
              onChange={(e) => setCmdInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sendCommand() }}
            />
            <button
              className="rounded bg-amber-500 px-4 py-1.5 text-sm font-medium text-invink hover:bg-amber-400 disabled:opacity-60 dark:disabled:opacity-40"
              disabled={cmdBusy}
              onClick={sendCommand}
            >
              {t('派出')}
            </button>
          </div>
          {/* 派工追蹤：只列還沒結束的。結束的留在主控台分頁看，
              這裡是「現在辦公室裡在發生什麼」，不是歷史紀錄 */}
          {liveDispatches.length > 0 && (
            <div className="mt-2 flex max-h-32 flex-col gap-1 overflow-y-auto">
              {liveDispatches.map((d) => {
                const lk = look(stateOf(d))
                return (
                  <div key={d.id} className="flex items-center gap-2 rounded bg-app px-2 py-1 text-xs" title={d.result || ''}>
                    <span className={`inline-block h-2 w-2 flex-none rounded-full ${lk.dot}`} />
                    <span className="flex-none font-medium text-ink3">{d.tool}</span>
                    <span className="min-w-0 flex-1 truncate text-mute2">{d.task}</span>
                    <span className={`flex-none ${lk.tone}`}>{lk.label}</span>
                  </div>
                )
              })}
            </div>
          )}
          {dispatches.length > 0 && liveDispatches.length === 0 && (
            <div className="mt-2 text-[11px] text-mute3">
              {t('目前沒有進行中的派工（最近 {n} 件都結束了）', { n: dispatches.length })}
            </div>
          )}
          {/* 稽核列 */}
          <div className="mt-2 flex items-center gap-2 border-t border-line2 pt-2 text-xs">
            <button
              className="rounded border border-line3 px-2 py-1 text-ink3 hover:bg-elev2 disabled:opacity-60 dark:disabled:opacity-40"
              disabled={auditBusy}
              onClick={runAudit}
            >
              {auditBusy ? t('稽核中…') : t('🔍 執行稽核')}
            </button>
            {audit && (
              <span className="text-mute">
                {t('站點')} ✅{audit.summary.sites_ok} / ⚠️{audit.summary.sites_partial} / ❌{audit.summary.sites_empty}
                ・{t('文章')} {audit.summary.articles}/{audit.summary.expected_articles}
                ・{t('{n} 字', { n: audit.summary.words.toLocaleString() })}
                ・{t('派工 log {n} 份有錯', { n: audit.dispatch_logs.filter((l) => l.errors.length > 0).length })}
                <span className="text-mute3">（{audit.generated_at.slice(5, 16)}）</span>
              </span>
            )}
          </div>
        </div>
        <div className="min-w-72 flex-1 rounded border border-line2 bg-elev p-3">
          <div className="mb-2 text-xs font-medium tracking-widest text-mute">{t('📋 任務排程區')}</div>
          {queue.length === 0 && <div className="text-xs text-mute2">{t('目前沒有進行中的工作 🎉')}</div>}
          <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto">
            {queue.map((p) => {
              const conv = findConvFor(p.project_id)
              return (
                <div key={p.project_id} className="flex items-center gap-2 rounded border border-line2 bg-panel px-2.5 py-1.5 text-xs">
                  <span className="font-medium text-ink">{p.title}</span>
                  {p.needs_handoff && <span className="rounded bg-amber-100 dark:bg-amber-400/20 px-1 py-0.5 text-amber-700 dark:text-amber-300">{t('待接力')}</span>}
                  <span className="min-w-0 flex-1 truncate text-mute" title={p.next_step}>{p.next_step || t('（無下一步）')}</span>
                  {conv && (
                    <button
                      className="flex-none rounded border border-line3 px-2 py-0.5 text-ink2 hover:bg-elev2 disabled:opacity-60 dark:disabled:opacity-40"
                      disabled={busyId === conv.id}
                      onClick={() => onDispatch(conv)}
                    >
                      {busyId === conv.id ? '…' : t('▶ 繼續工作')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── 對接總覽（帳號/瀏覽器/技能/全域設定） ── */}
      <div className="flex-none border-t border-line bg-panel px-4 py-3">
        <button className="mb-2 flex items-center gap-2 text-xs font-medium tracking-widest text-mute hover:text-ink2" onClick={() => setShowMap((v) => !v)}>
          {showMap ? '▾' : '▸'} {t('🗺️ 對接總覽（哪個工具用哪個帳號、哪個瀏覽器、哪些技能）')}
        </button>
        {showMap && toolMap && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-mute2">
                  <th className="pb-1 pr-3">工具</th>
                  <th className="pb-1 pr-3">帳號</th>
                  <th className="pb-1 pr-3">方案</th>
                  <th className="pb-1 pr-3">瀏覽器</th>
                  <th className="pb-1 pr-3">技能</th>
                  <th className="pb-1">全域設定</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(CHARS).map(([key, ch]) => {
                  const m = toolMap[key]
                  if (!m) return null
                  return (
                    <tr key={key} className="border-t border-line text-ink3">
                      <td className="py-1.5 pr-3 font-medium" style={{ color: tone(ch.color) }}>{ch.name}</td>
                      <td className="py-1.5 pr-3">{m.account?.account || '—'}</td>
                      <td className="py-1.5 pr-3">{[m.account?.plan, m.account?.until ? `至 ${m.account.until}` : ''].filter(Boolean).join(' ') || '—'}</td>
                      <td className="py-1.5 pr-3">{m.browser || '—'}</td>
                      <td className="py-1.5 pr-3" title={(m.skills || []).join('、')}>{m.skills?.length ?? 0} 個</td>
                      <td className="py-1.5 text-mute2">{(m.settings || []).join('、') || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {toolMap._governance && (
              <div className="mt-2 text-xs text-mute2">
                全域治理技能（.agents，跨工具共享）：{toolMap._governance.skills.join('、') || '無'}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 角色對話框（浮動） ── */}
      {chatWith && (
        <div className="fixed bottom-4 right-4 z-50 flex h-96 w-80 flex-col rounded-lg border border-line2 bg-panel shadow-2xl">
          <div className="flex flex-none items-center gap-2 rounded-t-lg px-3 py-2" style={{ background: CHARS[chatWith].color }}>
            <DragonFace agent={chatWith} size={32} />
            <span className="text-sm font-bold text-white">{CHARS[chatWith].name}</span>
            <span className="text-xs text-white/70">{tools[chatWith]?.status === 'rate_limited' ? '額度用畢，地端代答' : '地端模型驅動'}</span>
            <button className="ml-auto text-white/70 hover:text-white" onClick={() => setChatWith(null)}>✕</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {(agentMsgs[chatWith] || []).length === 0 && (
              <p className="text-xs text-mute2">
                {t('「說說看」是跟 {name} 聊天，由地端模型代答，不會動到任何檔案。',
                   { name: CHARS[chatWith].name })}
                <br />
                {t('要他真的去做，打完之後按「⚡ 交給他做」—— 那會派給真正的 {tool}。',
                   { tool: chatWith })}
              </p>
            )}
            <div className="flex flex-col gap-2">
              {(agentMsgs[chatWith] || []).map((m, i) => (
                <div key={i} className={`rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'ml-8 bg-elev2 text-ink' : 'mr-8 bg-elev text-ink2 border border-line2'}`}>
                  {m.text}
                </div>
              ))}
              {chatBusy && (
                <div className="text-xs text-mute2">
                  {t('{name} 思考中… {n} 秒', { name: CHARS[chatWith].name, n: chatSec })}
                  {chatSec > 20 && (
                    <span className="ml-1 text-mute3">{t('（地端模型比較慢，還在跑）')}</span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-none gap-2 border-t border-line2 p-2">
            <input
              className="min-w-0 flex-1 rounded border border-line3 bg-app px-2 py-1.5 text-sm text-ink outline-none"
              placeholder="說點什麼…"
              value={agentInput}
              onChange={(e) => setAgentInput(e.target.value)}
              // Enter 走聊天、Ctrl+Enter 才派工。
              // 反過來的話手一快就會派出一個會改檔案的 agent。
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (e.ctrlKey || e.metaKey) void dispatchToAgent()
                else void sendAgentChat()
              }}
            />
            <button
              className="flex-none rounded border border-line3 px-2 text-xs text-mute hover:bg-elev disabled:opacity-40"
              disabled={chatBusy || !agentInput.trim()}
              title={t('只是聊天，由地端模型代答，不會動到任何檔案')}
              onClick={sendAgentChat}
            >
              {t('說說看')}
            </button>
            <button
              className="flex-none rounded bg-ink px-2 text-xs text-invink hover:bg-white disabled:opacity-60 dark:disabled:opacity-40"
              disabled={chatBusy || !agentInput.trim()}
              title={t('真的派給 {tool} 執行，會掛上規範與技能，跟主控台派工同一條路徑', { tool: chatWith })}
              onClick={dispatchToAgent}
            >
              {t('⚡ 交給他做')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
