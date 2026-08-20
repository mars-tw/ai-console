// 對話主控台：一個輸入框指揮全部 AI
//
// 流程刻意做成三段，而不是一句話直接開跑：
//   輸入 → 拆解成計畫（誰做什麼）→ 你確認 → 派工執行 → 追蹤
//
// 中間那個確認不是多餘的。派出去的是會實際改檔案、跑指令的 agent，
// 而拆解是模型做的、會出錯。看一眼再按，比事後收拾便宜太多。
// 真的嫌煩的話有「省略確認」開關，但預設是關的。

import { useEffect, useRef, useState } from 'react'
import { t, useLang } from '@/i18n'
import { isLive, look, stateOf } from '@/lib/dispatchState'
import type { DispatchRecord } from '@/types/data'

interface Step {
  tool: string
  task: string
  why?: string
  /** 派工後的狀態 */
  state?: 'idle' | 'sending' | 'sent' | 'failed'
  note?: string
  log?: string
}

const TOOL_COLOR: Record<string, string> = {
  claude: '#D97757', codex: '#10A37F', qwen: '#615CED',
  grok: '#1D9BF0', local: '#71717a', kimi: '#2563EB',
}

/** 從派工的時間戳（YYYYMMDD-HHMMSS）算已經跑多久 */
function elapsed(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(stamp || '')
  if (!m) return ''
  const [, y, mo, d, h, mi, se] = m
  const t0 = new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime()
  const s = Math.max(0, Math.round((Date.now() - t0) / 1000))
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
  return `${Math.floor(s / 3600)} 小時 ${Math.floor((s % 3600) / 60)} 分`
}

/**
 * 可以派工的執行者。
 * 之前這份清單寫死在下拉選單裡，而且漏了 gemini（ANTIGRAVITY）——
 * 後端明明支援，拆解器也會派給它，選單卻選不到，顯示會變空白。
 */
const TOOLS = ['auto', 'claude', 'codex', 'gemini', 'qwen', 'grok', 'kimi', 'cursor', 'local'] as const

interface SchedJob {
  id: string
  name: string
  task: string
  tool: string
  kind: 'interval' | 'daily' | 'weekly'
  enabled: boolean
  everyMinutes: number
  hour: number
  minute: number
  weekday: number
  nextRun: number
  lastRun: number
  lastResult: string
  runs: number
  desc?: string
}

const NEW_JOB: SchedJob = {
  id: '', name: '', task: '', tool: 'auto', kind: 'daily', enabled: true,
  everyMinutes: 60, hour: 9, minute: 0, weekday: 0,
  nextRun: 0, lastRun: 0, lastResult: '', runs: 0,
}

const WEEKDAYS = ['週一', '週二', '週三', '週四', '週五', '週六', '週日']

/** 下一次什麼時候跑。看得到時間才知道設定有沒有生效 */
function whenNext(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const mins = Math.round((d.getTime() - Date.now()) / 60000)
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (mins < 1) return '即將執行'
  if (mins < 60) return `${mins} 分鐘後（${clock}）`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} 小時後（${clock}）`
  return `${Math.round(mins / 1440)} 天後（${clock}）`
}

export default function Console() {
  useLang()
  const [input, setInput] = useState('')
  // 計畫存在 localStorage：切分頁時這個元件會 unmount，
  // 但 runAll 的迴圈還在背景把後續工單派出去。使用者回來看到空白，
  // 會以為沒派成功而重新拆解再派一次 —— 派出去的是會改檔案的 agent，
  // 重複派工代價不小。
  const [steps, setSteps] = useState<Step[]>(() => {
    try { return JSON.parse(localStorage.getItem('ac_console_steps') || '[]') } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem('ac_console_steps', JSON.stringify(steps)) } catch { /* 存不了不影響使用 */ }
  }, [steps])
  const [planning, setPlanning] = useState(false)
  const [note, setNote] = useState('')
  const [autoRun, setAutoRun] = useState(false)
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([])
  const [showDone, setShowDone] = useState(false)
  /** 正在對哪一件補話，以及打到一半的內容 */
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replyBusy, setReplyBusy] = useState(false)
  /** 一件跑完才派下一件。預設開著 —— 多個 agent 同時改同一批檔案會互相蓋掉 */
  const [serial, setSerial] = useState(() => localStorage.getItem('ac_serial') !== '0')
  const [batch, setBatch] = useState<{ total: number; done: number; running: boolean; current: string } | null>(null)
  const [jobs, setJobs] = useState<SchedJob[]>([])
  const [showSched, setShowSched] = useState(false)
  const [draft, setDraft] = useState<SchedJob | null>(null)
  const [history, setHistory] = useState<string[]>([])
  // 展開中的派工與它的產出。派出去卻看不到結果，等於白派。
  useEffect(() => { localStorage.setItem('ac_serial', serial ? '1' : '0') }, [serial])
  const [openLog, setOpenLog] = useState<string | null>(null)
  const [logText, setLogText] = useState<Record<string, string>>({})
  const boxRef = useRef<HTMLTextAreaElement>(null)

  // 進行中的排前面，結束的收進摺疊區。之前是一份只增不減的歷史全部攤在
  // 「執行中的派工」標題底下，看久了就完全不知道現在到底有沒有東西在跑。
  const live = dispatches.filter(isLive)
  const done = dispatches.filter((d) => !isLive(d))

  // 派工狀態每 8 秒刷新一次，讓「執行中 → 完成」自己會動
  useEffect(() => {
    const pull = () => {
      fetch('/api/dispatches').then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.dispatches && setDispatches(d.dispatches))
        .catch(() => {})
      fetch('/api/dispatch/batch').then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setBatch(d)).catch(() => {})
      fetch('/api/schedules').then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.jobs && setJobs(d.jobs))
        .catch(() => {})
    }
    pull()
    const timer = setInterval(pull, 8000)
    return () => clearInterval(timer)
  }, [])

  const makePlan = async () => {
    const instruction = input.trim()
    if (!instruction || planning) return
    setPlanning(true)
    setNote('')
    setSteps([])
    try {
      const r = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction }),
      })
      // 一定要看 r.ok。原本直接 .json() 然後照用，後端回 500 時
      // steps 變空陣列、note 是空字串 —— 按鈕轉一下就沒反應，
      // 使用者只會覺得程式壞了
      if (!r.ok) {
        setNote(t('拆解失敗（HTTP {code}）', { code: r.status }))
        setPlanning(false)
        return
      }
      const d = await r.json()
      const got: Step[] = (d.steps || []).map((s: Step) => ({ ...s, state: 'idle' as const }))
      setSteps(got)
      setNote(d.note || (got.length ? '' : t('沒有拆解出任何工作，換個說法試試')))
      setHistory((h) => [instruction, ...h.filter((x) => x !== instruction)].slice(0, 8))
      if (autoRun && got.length) void runAll(got)
    } catch {
      setNote(t('控制 API 無回應'))
    }
    setPlanning(false)
  }

  /**
   * 把整批交給伺服器排隊，不要在前端跑迴圈。
   *
   * 原本這裡是 for + await fetch('/api/dispatch')，註解還寫著
   * 「序列而非並行 —— 同時開四個 agent 搶同一批檔案是災難」。
   * 但那個 await 只等到 HTTP 回應，而伺服器是 Popen 之後立刻回傳 ——
   * 迴圈一秒內就把四件全派出去了，正好造成它自己警告的那件事。
   * 而且迴圈跑在元件裡，切到別的分頁就 unmount，佇列直接消失。
   *
   * 現在整批丟給伺服器，它會等前一件的行程真的結束才派下一件，
   * 跟前端在不在完全無關。
   */
  const runAll = async (list: Step[]) => {
    setSteps((s) => s.map((x) => ({ ...x, state: 'sending' })))
    try {
      const d = await fetch('/api/dispatch/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: list.map((x) => ({ tool: x.tool, task: x.task })), serial }),
      }).then((r) => r.json())
      setSteps((s) => s.map((x) => ({ ...x, state: d.ok ? 'sent' : 'failed', note: d.note || d.error || '' })))
      setNote(d.ok ? (d.note || '') : `⚠️ ${d.error}`)
    } catch {
      setSteps((s) => s.map((x) => ({ ...x, state: 'failed', note: t('控制 API 無回應') })))
    }
  }

  /** 讀某次派工的產出 */
  /**
   * 對一件派工補一句話。
   *
   * 無頭執行是一次性的，沒辦法對跑到一半的行程插話 —— 但四個工具都支援
   * 續談上一輪，所以這裡是「用續談旗標再派一次」。還在跑的話伺服器會先排隊，
   * 等它結束再送，不然兩個行程會搶同一段對話。
   */
  const sendFollowup = async (id: string) => {
    const text = replyText.trim()
    if (!text) return
    setReplyBusy(true)
    try {
      const r = await fetch('/api/dispatch/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text }),
      }).then((x) => x.json())
      setNote(r.ok ? (r.note || t('已送出')) : `⚠️ ${r.error || t('送出失敗')}`)
      if (r.ok) {
        setReplyText('')
        setReplyTo(null)
        // 立刻拉一次，不要等下一個輪詢週期 —— 送出後畫面沒反應會以為沒送出去
        fetch('/api/dispatches').then((x) => (x.ok ? x.json() : null))
          .then((x) => x?.dispatches && setDispatches(x.dispatches)).catch(() => {})
      }
    } catch {
      setNote(t('⚠️ 控制 API 無回應'))
    }
    setReplyBusy(false)
  }

  const saveJob = async (j: SchedJob) => {
    const r = await fetch('/api/schedule/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j),
    }).then((x) => x.json()).catch(() => ({ ok: false, error: t('控制 API 無回應') }))
    setNote(r.ok ? t('已存好，到時間就會自己跑') : `⚠️ ${r.error}`)
    if (r.ok) setDraft(null)
    pullSched()
  }

  const deleteJob = async (id: string) => {
    if (!confirm(t('刪掉這個定時工作？已經派出去的不受影響。'))) return
    await fetch('/api/schedule/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    }).catch(() => {})
    pullSched()
  }

  /** 立刻跑一次。設定完馬上驗證得到，不用等到明天早上 */
  const runJobNow = async (id: string) => {
    const r = await fetch('/api/schedule/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    }).then((x) => x.json()).catch(() => ({ ok: false, error: t('控制 API 無回應') }))
    setNote(r.ok ? (r.note || t('已派出')) : `⚠️ ${r.error}`)
    pullSched()
  }

  const pullSched = () => {
    fetch('/api/schedules').then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.jobs && setJobs(d.jobs)).catch(() => {})
  }

  const loadLog = async (id: string) => {
    if (openLog === id) { setOpenLog(null); return }
    setOpenLog(id)
    try {
      const r = await fetch(`/api/dispatch/log?id=${encodeURIComponent(id)}`)
      const d = await r.json()
      setLogText((m) => ({ ...m, [id]: d.ok ? (d.text || t('還沒有輸出')) : (d.error || '') }))
    } catch {
      setLogText((m) => ({ ...m, [id]: t('控制 API 無回應') }))
    }
  }

  const editStep = (i: number, patch: Partial<Step>) =>
    setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  const pending = steps.some((s) => s.state === 'idle')
  const running = steps.some((s) => s.state === 'sending')
  const failed = steps.some((s) => s.state === 'failed')

  /** 把失敗的步驟退回可編輯狀態，只重派那幾件（已成功的不會重複派） */
  const retryFailed = () => {
    const next = steps.map((s) => (s.state === 'failed' ? { ...s, state: 'idle' as const, note: '' } : s))
    setSteps(next)
    void runAll(next.filter((s) => s.state === 'idle'))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-app p-3 text-ink2">
      {/* ── 輸入 ── */}
      <div className="rounded border border-line bg-panel p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium tracking-widest text-mute">{t('🎙️ 主控台')}</span>
          <span className="text-[11px] text-mute3">{t('說一句話，自動決定誰做、怎麼做')}</span>
          <label className="ml-auto flex items-center gap-1 text-[11px] text-mute2">
            <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
            {t('省略確認，拆完直接派')}
          </label>
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-mute2"
            title={t('一件跑完才派下一件。關掉會同時派出 —— 多個 AI 改同一批檔案會互相蓋掉')}
          >
            <input type="checkbox" checked={serial} onChange={(e) => setSerial(e.target.checked)} />
            {t('一件一件跑')}
          </label>
        </div>
        <textarea
          ref={boxRef}
          className="min-h-16 w-full resize-y rounded border border-line2 bg-transparent px-3 py-2 text-sm outline-none focus:border-line4"
          placeholder={t('例如：把 tools 底下的腳本都加上使用說明，然後跑一次測試')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void makePlan() }
          }}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            className="rounded bg-ink px-3 py-1 text-xs font-medium text-invink disabled:opacity-60 dark:disabled:opacity-40"
            disabled={!input.trim() || planning}
            onClick={makePlan}
          >
            {planning ? t('拆解中…') : t('分析並排程')}
          </button>
          <span className="text-[11px] text-mute3">Ctrl + Enter</span>
          {note && <span className="text-[11px] text-amber-700 dark:text-amber-400/90">{note}</span>}
        </div>
        {history.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {history.map((h) => (
              <button
                key={h}
                className="max-w-64 truncate rounded bg-elev px-2 py-0.5 text-[11px] text-mute hover:text-ink2"
                onClick={() => setInput(h)}
              >
                {h}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── 計畫 ── */}
      {steps.length > 0 && (
        <div className="rounded border border-line bg-panel p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium tracking-widest text-mute">
              {t('📋 派工計畫（{n} 件）', { n: steps.length })}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {failed && !running && (
                <button
                  className="rounded border border-amber-300 dark:border-amber-600 px-2 py-1 text-xs text-amber-700 dark:text-amber-300"
                  onClick={retryFailed}
                >
                  {t('↻ 只重派失敗的')}
                </button>
              )}
              <button
                className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-60 dark:disabled:opacity-40"
                disabled={!pending || running}
                onClick={() => runAll(steps)}
              >
                {running ? t('派工中…') : t('▶ 全部派出')}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {steps.map((s, i) => (
              <div key={i} className="rounded border border-line p-2">
                <div className="mb-1 flex items-center gap-2">
                  <select
                    className="rounded border border-line2 bg-transparent px-1.5 py-0.5 text-[11px]"
                    style={{ color: TOOL_COLOR[s.tool] ?? undefined }}
                    value={s.tool}
                    disabled={s.state !== 'idle'}
                    onChange={(e) => editStep(i, { tool: e.target.value })}
                  >
                    {TOOLS.map((tl) => (
                      <option key={tl} value={tl}>{tl}</option>
                    ))}
                  </select>
                  {s.why && <span className="truncate text-[11px] text-mute3">{s.why}</span>}
                  <span className="ml-auto text-[11px]">
                    {s.state === 'sent' && <span className="text-emerald-700 dark:text-emerald-400">{t('已派出')}</span>}
                    {s.state === 'sending' && <span className="text-amber-700 dark:text-amber-400">{t('派工中…')}</span>}
                    {s.state === 'failed' && <span className="text-red-700 dark:text-red-400">{s.note || t('失敗')}</span>}
                  </span>
                  {s.state === 'idle' && (
                    <button
                      className="text-[11px] text-mute3 hover:text-red-400"
                      onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}
                    >
                      {t('移除')}
                    </button>
                  )}
                </div>
                <textarea
                  className="w-full resize-y rounded bg-app px-2 py-1 text-xs leading-5 text-ink3 outline-none disabled:opacity-60"
                  rows={Math.min(6, Math.ceil(s.task.length / 60) + 1)}
                  value={s.task}
                  disabled={s.state !== 'idle'}
                  onChange={(e) => editStep(i, { task: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {batch?.running && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] dark:border-amber-700/60 dark:bg-amber-950/40">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 flex-none animate-pulse rounded-full bg-amber-400" />
            <span className="text-amber-700 dark:text-amber-200">
              {t('派工佇列：第 {a} / {b} 件', { a: batch.done + 1, b: batch.total })}
            </span>
            <span className="min-w-0 flex-1 truncate text-mute2">{batch.current}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded bg-elev">
            <div className="h-full bg-amber-400" style={{ width: `${Math.round((batch.done / Math.max(1, batch.total)) * 100)}%` }} />
          </div>
        </div>
      )}

      {/* ── 定時工作 ── */}
      <div className="rounded border border-line bg-panel p-3">
        <div className="mb-2 flex items-center gap-2">
          <button
            className="text-xs font-medium tracking-widest text-mute"
            onClick={() => setShowSched((v) => !v)}
          >
            {showSched ? '▾' : '▸'} {t('⏰ 定時工作')}
          </button>
          {jobs.filter((j) => j.enabled).length > 0 && (
            <span className="rounded bg-emerald-100 px-1.5 text-[10px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
              {t('{n} 件啟用中', { n: jobs.filter((j) => j.enabled).length })}
            </span>
          )}
          {showSched && (
            <button
              className="ml-auto rounded border border-line2 px-2 py-0.5 text-[11px] text-mute hover:bg-elev"
              onClick={() => setDraft({ ...NEW_JOB })}
            >
              {t('＋ 新增')}
            </button>
          )}
        </div>

        {showSched && jobs.length === 0 && !draft && (
          <div className="text-[11px] text-mute3">
            {t('還沒有定時工作。設定一次之後它會自己跑，不用你在場。')}
          </div>
        )}

        {showSched && jobs.map((j) => (
          <div key={j.id} className="flex items-center gap-2 border-t border-line py-1.5 text-[11px] first:border-t-0">
            <input
              type="checkbox"
              checked={j.enabled}
              title={t('暫停 / 啟用')}
              onChange={(e) => void saveJob({ ...j, enabled: e.target.checked })}
            />
            <span className="w-28 flex-none truncate font-medium text-ink3">{j.name}</span>
            <span className="w-20 flex-none text-mute2">{j.desc}</span>
            <span className="w-16 flex-none text-mute3">{j.tool}</span>
            <span className="min-w-0 flex-1 truncate text-mute3" title={j.task}>{j.task}</span>
            <span className="flex-none text-mute2">
              {j.enabled ? whenNext(j.nextRun) : t('已暫停')}
            </span>
            <button className="flex-none text-mute2 hover:text-ink3" title={t('立刻跑一次')} onClick={() => void runJobNow(j.id)}>▶</button>
            <button className="flex-none text-mute2 hover:text-ink3" title={t('編輯')} onClick={() => setDraft(j)}>✎</button>
            <button className="flex-none text-mute3 hover:text-red-500" title={t('刪除')} onClick={() => void deleteJob(j.id)}>✕</button>
          </div>
        ))}

        {showSched && draft && (
          <div className="mt-2 rounded border border-line2 bg-app p-2">
            <input
              className="mb-1 w-full rounded border border-line2 bg-panel px-2 py-1 text-[11px] outline-none focus:border-line3"
              placeholder={t('名稱（例如：每天早上整理進度）')}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <textarea
              className="mb-1 w-full resize-none rounded border border-line2 bg-panel px-2 py-1 text-[11px] outline-none focus:border-line3"
              rows={2}
              placeholder={t('要做的事。可以直接指名，例如「用 codex 檢查最近的改動」')}
              value={draft.task}
              onChange={(e) => setDraft({ ...draft, task: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <select
                className="rounded border border-line2 bg-panel px-1 py-0.5"
                value={draft.tool}
                onChange={(e) => setDraft({ ...draft, tool: e.target.value })}
              >
                {TOOLS.map((tl) => <option key={tl} value={tl}>{tl}</option>)}
              </select>
              <select
                className="rounded border border-line2 bg-panel px-1 py-0.5"
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as SchedJob['kind'] })}
              >
                <option value="interval">{t('每隔一段時間')}</option>
                <option value="daily">{t('每天')}</option>
                <option value="weekly">{t('每週')}</option>
              </select>
              {draft.kind === 'interval' ? (
                <>
                  <input
                    type="number" min={1} max={1440}
                    className="w-16 rounded border border-line2 bg-panel px-1 py-0.5"
                    value={draft.everyMinutes}
                    onChange={(e) => setDraft({ ...draft, everyMinutes: +e.target.value || 60 })}
                  />
                  <span className="text-mute2">{t('分鐘')}</span>
                </>
              ) : (
                <>
                  {draft.kind === 'weekly' && (
                    <select
                      className="rounded border border-line2 bg-panel px-1 py-0.5"
                      value={draft.weekday}
                      onChange={(e) => setDraft({ ...draft, weekday: +e.target.value })}
                    >
                      {WEEKDAYS.map((w, i) => <option key={w} value={i}>{t(w)}</option>)}
                    </select>
                  )}
                  <input
                    type="number" min={0} max={23}
                    className="w-12 rounded border border-line2 bg-panel px-1 py-0.5"
                    value={draft.hour}
                    onChange={(e) => setDraft({ ...draft, hour: Math.min(23, Math.max(0, +e.target.value || 0)) })}
                  />
                  <span className="text-mute2">:</span>
                  <input
                    type="number" min={0} max={59}
                    className="w-12 rounded border border-line2 bg-panel px-1 py-0.5"
                    value={draft.minute}
                    onChange={(e) => setDraft({ ...draft, minute: Math.min(59, Math.max(0, +e.target.value || 0)) })}
                  />
                </>
              )}
              <button
                className="ml-auto rounded bg-ink px-2 py-0.5 text-invink disabled:opacity-50"
                disabled={!draft.task.trim()}
                onClick={() => void saveJob(draft)}
              >
                {t('存起來')}
              </button>
              <button className="rounded border border-line2 px-2 py-0.5 text-mute" onClick={() => setDraft(null)}>
                {t('取消')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── 執行追蹤 ── */}
      <div className="rounded border border-line bg-panel p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium tracking-widest text-mute">{t('🛰️ 派工')}</span>
          {live.length > 0 && (
            <span className="rounded bg-amber-100 dark:bg-amber-400/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">
              {t('{n} 件進行中', { n: live.length })}
            </span>
          )}
          {done.length > 0 && (
            <button
              className="ml-auto text-[10px] text-mute2 hover:text-ink3"
              onClick={() => setShowDone((v) => !v)}
            >
              {showDone ? t('收起已結束（{n}）', { n: done.length }) : t('看已結束（{n}）', { n: done.length })}
            </button>
          )}
        </div>
        {dispatches.length === 0 && (
          <div className="text-xs text-mute3">{t('目前沒有派工')}</div>
        )}
        {dispatches.length > 0 && live.length === 0 && !showDone && (
          <div className="text-xs text-mute3">{t('沒有進行中的派工')}</div>
        )}
        <div className="flex flex-col gap-1">
          {(showDone ? [...live, ...done] : live).slice(0, 12).map((d) => (
            <div key={d.id}>
              <button
                onClick={() => loadLog(d.id)}
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-elev"
                title={t('點一下看這次派工的產出')}
              >
                <span className="w-3 flex-none text-mute3">{openLog === d.id ? '▾' : '▸'}</span>
                <span className="w-14 flex-none font-medium" style={{ color: TOOL_COLOR[d.tool] ?? undefined }}>
                  {d.tool}
                </span>
                <span className="min-w-0 flex-1 truncate text-mute" title={d.task}>{d.task}</span>
                <span className={`flex-none ${look(stateOf(d)).tone}`}>
                  {look(stateOf(d)).label}
                </span>
              </button>
              {stateOf(d) === 'running' && (
                <div className="ml-6 flex items-center gap-2 text-[10px] text-mute3">
                  <span className="inline-block h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-amber-400" />
                  <span className="min-w-0 flex-1 truncate font-mono">{d.tail || t('（還沒有輸出）')}</span>
                  <span className="flex-none">{elapsed(d.started)}</span>
                </div>
              )}
              {!!d.pending?.length && (
                <div className="ml-6 text-[10px] text-sky-700 dark:text-sky-400/80">
                  {t('已排隊 {n} 句，這一輪結束後送出', { n: d.pending.length })}
                </div>
              )}
              <button
                className="ml-6 text-[10px] text-mute2 hover:text-ink3"
                title={t('工作跑歪了可以在這裡補一句。還在跑的話會排隊，結束後自動送出')}
                onClick={() => { setReplyTo(replyTo === d.id ? null : d.id); setReplyText('') }}
              >
                {replyTo === d.id ? t('取消') : t('💬 補一句')}
              </button>
              {replyTo === d.id && (
                <div className="ml-6 mt-1 flex gap-1">
                  <input
                    autoFocus
                    className="min-w-0 flex-1 rounded border border-line2 bg-app px-2 py-1 text-[11px] outline-none focus:border-line4"
                    placeholder={t('例如：路徑錯了，改用 tools/ 底下那份')}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void sendFollowup(d.id) }}
                  />
                  <button
                    className="flex-none rounded bg-ink px-2 py-1 text-[11px] text-invink hover:bg-white disabled:opacity-60 dark:disabled:opacity-40"
                    disabled={replyBusy || !replyText.trim()}
                    onClick={() => void sendFollowup(d.id)}
                  >
                    {replyBusy ? t('送出中…') : t('送出')}
                  </button>
                </div>
              )}
              {openLog === d.id && (
                <pre className="mx-4 my-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-app p-2 font-mono text-[11px] leading-5 text-ink3">
                  {logText[d.id] ?? t('讀取中…')}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
