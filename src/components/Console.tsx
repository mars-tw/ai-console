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
import {
  ensureStepIds,
  mapStepsById,
  stepIdsForDispatch,
  type StepDispatchMode,
} from '@/lib/dispatchLifecycle'
import { isLive, look, stateOf } from '@/lib/dispatchState'
import { useReadable } from '@/theme'
import LiveTerminal from '@/components/LiveTerminal'
import QuotaStrip from '@/components/QuotaStrip'
import type { DispatchRecord } from '@/types/data'

interface Step {
  /** 穩定身分；不能用 task，因為兩步可能有完全相同的文字 */
  id: string
  tool: string
  task: string
  why?: string
  /** 派工後的狀態 */
  state?: 'idle' | 'sending' | 'sent' | 'failed'
  note?: string
  log?: string
}

interface DispatchCost {
  usd: number
  in: number
  out: number
  /** 總量。有些 CLI（codex）只印總數，拆不出輸入／輸出 */
  total?: number
  model: string
}

/**
 * 用量文字。拆得出輸入／輸出就分開講，只有總數就講總數。
 *
 * 不要在只知道總數時硬填一個 0/0 —— 那看起來像「這一趟沒用到 token」，
 * 而 codex 往往是這裡最貴的一個。寧可少講，不要講錯。
 */
function tokenText(c: DispatchCost): string {
  const n = (v: number) => TOKEN_FORMAT.format(Math.max(0, Math.round(v || 0)))
  if (c.in > 0 || c.out > 0) {
    return t('{input} 輸入 / {output} 輸出 tokens', { input: n(c.in), output: n(c.out) })
  }
  return c.total ? t('{n} tokens', { n: n(c.total) }) : ''
}

/** /api/dispatch/followup 的回應。接力時會多一個 handoff */
interface FollowupReply {
  ok: boolean
  note?: string
  error?: string
  handoff?: { from: string; to: string; why: string }
}

/** 派工／重派的回應。指名的工具限流時會改派，那時候多一個 rerouted */
interface DispatchReply {
  ok: boolean
  note?: string
  error?: string
  id?: string
  tool?: string
  rerouted?: { from: string; to: string; why: string } | null
}

type ConsoleDispatch = DispatchRecord & {
  outcome?: 'ok' | 'no_changes' | 'blocked' | 'error' | 'stopped' | null
  cost?: DispatchCost | null
  issue?: string
  /** 這一筆的工作目錄在不在 git 裡。不在的話「看改了什麼」按了也沒東西 */
  canDiff?: boolean
  /** 撞額度／終端沒人按之後，後端自動把同一份工單換給誰做了（"none" = 沒人能接） */
  handedOffTo?: string
  handoffWhy?: string
  /** 這一筆是從哪一筆接力來的 */
  handoffFrom?: string
}

interface DiffFile {
  path: string
  added: number
  removed: number
  patch: string
}

interface DispatchDiff {
  ok: boolean
  cwd?: string
  isGit: boolean
  files: DiffFile[]
  truncated?: boolean
  error?: string
}

/**
 * 上一輪還在跑的派工 id。刻意放在模組層級 —— 見下面 liveIds 的說明。
 * 模組只載入一次，切分頁不會把它清掉。
 */
const LIVE_IDS = { current: new Set<string>() }

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

function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return ''
  return `$${usd.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`
}

const TOKEN_FORMAT = new Intl.NumberFormat('en-US')

function outcomeLook(d: ConsoleDispatch): { label: string; tone: string } {
  switch (d.outcome) {
    case 'ok':
      return { label: t('已完成'), tone: 'text-emerald-700 dark:text-emerald-300' }
    case 'no_changes':
      return { label: t('跑完了但沒有改到任何檔案'), tone: 'text-amber-700 dark:text-amber-300' }
    // BLOCKED 是照規範停下來，不是失敗 —— 這台機器的規範就是這樣定的。
    // 跟 529、崩潰混在同一個紅色裡的話，使用者會學會忽略紅字，
    // 然後真正的失敗也一起被忽略。
    case 'blocked':
      return { label: t('依規範停下（沒有執行）'), tone: 'text-sky-700 dark:text-sky-300' }
    case 'stopped':
      // 被人停掉的：沒跑完，但也不是它自己壞掉。跟失敗分開，重派鈕照給。
      return { label: t('被停止（沒有跑完）'), tone: 'text-amber-700 dark:text-amber-300' }
    case 'error':
      return { label: t('執行失敗'), tone: 'text-red-700 dark:text-red-300' }
    default:
      return look(stateOf(d))
  }
}

/** 派工時間戳（YYYYMMDD-HHMMSS）→ Date。認不出來就回 null */
function startedDate(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(stamp || '')
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  return new Date(+y, +mo - 1, +d, +h, +mi, +se)
}

function startedAgo(stamp: string): string {
  const d = startedDate(stamp)
  if (!d) return ''
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (s < 60) return t('剛剛')
  if (s < 3600) return t('{n} 分前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小時前', { n: Math.floor(s / 3600) })
  return t('{n} 天前', { n: Math.floor(s / 86400) })
}

function startedAt(stamp: string): string {
  return startedDate(stamp)?.toLocaleString('zh-TW') ?? stamp
}

/**
 * 派工清單上顯示的那一行字。
 *
 * 工單很常以一整段前置說明開頭（專案根目錄、技術棧、規則……），
 * 於是同一批派出去的幾件在清單上被 truncate 成完全一樣的字，
 * 看起來像同一件重複了四次。
 * 這裡把「看起來像設定或標題」的開頭行跳過，找第一句真正的指示。
 * 找不到就退回原本的字 —— 寧可顯示得囉唆，也不要顯示空白。
 */
function taskLabel(d: ConsoleDispatch): string {
  const raw = (d.task || '').trim()
  if (!raw) return t('（沒有工單內容）')
  // 內部測試用的標記不該出現在使用者的清單裡
  if (raw === '__DRYRUN__') return t('（連線測試）')
  const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  const skip = (ln: string) =>
    ln.length < 4                       // 太短，不成一句
    || /^[#>*\-`|]/.test(ln)            // markdown 結構行
    || /^[^：:]{1,14}[：:]\s*\S/.test(ln)  // 「專案根目錄：C:\…」這種設定行
    || /^\*\*/.test(ln)
  const first = lines.find((ln) => !skip(ln))
  return first || lines[0] || raw
}

function patchLineTone(line: string): string {
  if (line.startsWith('@@')) return 'text-mute2'
  if (line.startsWith('+')) return 'text-emerald-700 dark:text-emerald-300'
  if (line.startsWith('-')) return 'text-red-700 dark:text-red-300'
  return 'text-ink3'
}

function PatchLines({ patch }: { patch: string }) {
  return (
    <pre className="mt-1 max-h-96 overflow-auto rounded border border-line2 bg-app p-2 font-mono text-[11px] leading-5">
      {patch.split('\n').map((line, i) => (
        <span key={`${i}-${line}`} className={`block min-w-max ${patchLineTone(line)}`}>
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}

/** 斷線時的保守 fallback；連上後以 /api/dispatch/tools 的真實可用清單為準。 */
const TOOLS = ['auto', 'claude', 'codex', 'qwen', 'grok', 'kimi', 'cursor', 'local'] as const

/** 已結束派工每次露出的筆數。按「再顯示」一次多露這麼多筆，按到底為止 */
const DONE_PAGE = 8

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
  // 工具名稱用的是照深底挑的顏色，亮色主題下要壓過才讀得清楚
  // （辦公室早就這樣做了，這裡一直漏掉：codex 在白底只有 3.20:1）
  const tone = useReadable()
  const [input, setInput] = useState('')
  const [toolOptions, setToolOptions] = useState<string[]>([...TOOLS])
  // 限流中的工具。跟 QuickDispatch 用同一個來源（/api/dispatch/tools 回應裡的
  // limited 旗標）—— 計畫裡的選單若不跟對話頁一樣把它們灰掉，
  // 使用者選了限流的工具、按下派工才吃 503，白等一次派工往返。
  const [limitedTools, setLimitedTools] = useState<Set<string>>(new Set())
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/dispatch/tools', { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!Array.isArray(data?.tools)) return
        setToolOptions(['auto', ...data.tools.map((item: { id?: unknown }) => String(item.id || ''))
          .filter((id: string) => id && id !== 'auto')])
        setLimitedTools(new Set(data.tools
          .filter((item: { limited?: unknown }) => item.limited === true)
          .map((item: { id?: unknown }) => String(item.id || ''))
          .filter((id: string) => id)))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])
  // 計畫存在 localStorage：切分頁時這個元件會 unmount，
  // 但 runAll 的迴圈還在背景把後續工單派出去。使用者回來看到空白，
  // 會以為沒派成功而重新拆解再派一次 —— 派出去的是會改檔案的 agent，
  // 重複派工代價不小。
  const [steps, setSteps] = useState<Step[]>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('ac_console_steps') || '[]')
      if (!Array.isArray(raw)) return []
      const restored = raw
        .filter((item): item is Partial<Step> => !!item && typeof item === 'object')
        .filter((item) => typeof item.tool === 'string' && typeof item.task === 'string')
        .map((item) => ({
          ...item,
          tool: item.tool as string,
          task: item.task as string,
          state: item.state ?? 'idle',
        }))
      return ensureStepIds(restored)
    } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem('ac_console_steps', JSON.stringify(steps)) } catch { /* 存不了不影響使用 */ }
  }, [steps])
  const [planning, setPlanning] = useState(false)
  const [note, setNoteValue] = useState('')
  const [noteError, setNoteError] = useState(false)
  /** 訊息嚴重度由呼叫點明確指定，不從文字裡有沒有 ⚠ 猜測。 */
  const setNote = (message: string, error = false) => {
    setNoteValue(message)
    setNoteError(error)
  }
  const [autoRun, setAutoRun] = useState(false)
  const [dispatches, setDispatches] = useState<ConsoleDispatch[]>([])
  const [showDone, setShowDone] = useState(false)
  /**
   * 已結束清單目前露出幾筆。
   *
   * 之前整份清單（進行中＋已結束）硬切 .slice(0, 12) —— 6 件進行中時
   * 已結束只剩 6 個名額，但按鈕上寫的是「看已結束（24）」。數字承諾 24
   * 卻只交付 6，落在窗口外那幾筆的「看改了什麼」「重派」永遠點不到，
   * 使用者會以為那件根本沒跑。
   * 現在：進行中的一律全列（本來就少）；已結束的分頁露出，按到底拿得到全部。
   */
  const [doneShown, setDoneShown] = useState(DONE_PAGE)
  /** 正在對哪一件補話，以及打到一半的內容 */
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replyBusy, setReplyBusy] = useState(false)
  /** 一件跑完才派下一件。預設開著 —— 多個 agent 同時改同一批檔案會互相蓋掉 */
  const [serial, setSerial] = useState(() => localStorage.getItem('ac_serial') !== '0')
  /**
   * 這批工單在哪個目錄裡做事。空的＝家目錄（原本的行為）。
   *
   * 沒有這一欄的話，無頭派工一律從家目錄啟動，agent 得自己 cd 過去；
   * 而且派工紀錄的 cwd 永遠是家目錄，「📝 看改了什麼」就永遠回
   * 「這個工作目錄不是 git 專案」—— 一個看得到但永遠沒東西的功能。
   */
  const [workDir, setWorkDir] = useState(() => localStorage.getItem('ac_workdir') || '')
  useEffect(() => { localStorage.setItem('ac_workdir', workDir) }, [workDir])
  const [batch, setBatch] = useState<{ total: number; done: number; running: boolean; current: string } | null>(null)
  const [jobs, setJobs] = useState<SchedJob[]>([])
  const [showSched, setShowSched] = useState(false)
  const [draft, setDraft] = useState<SchedJob | null>(null)
  /**
   * 最近下過的指令。
   *
   * 存 localStorage 的理由跟上面的 steps 一模一樣：切分頁這個元件會 unmount。
   * 原本只放在元件狀態裡 —— 去看一眼對話再切回來，剛剛打過的那幾句就沒了，
   * 而那正是最可能要再用一次的東西。
   */
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('ac_console_history') || '[]')
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 8) : []
    } catch { return [] }
  })
  useEffect(() => {
    try { localStorage.setItem('ac_console_history', JSON.stringify(history)) } catch { /* 存不了不影響使用 */ }
  }, [history])
  // 展開中的派工與它的產出。派出去卻看不到結果，等於白派。
  useEffect(() => { localStorage.setItem('ac_serial', serial ? '1' : '0') }, [serial])
  const [openLog, setOpenLog] = useState<string | null>(null)
  const [logText, setLogText] = useState<Record<string, string>>({})
  const boxRef = useRef<HTMLTextAreaElement>(null)

  const [justDone, setJustDone] = useState<ConsoleDispatch[]>([])
  /** log 是否跟著捲到底。使用者往上捲就停下來，捲回底部再繼續跟 */
  const followLog = useRef(true)
  const [diffFor, setDiffFor] = useState<string | null>(null)
  const [diffData, setDiffData] = useState<Record<string, DispatchDiff>>({})
  const [diffLoading, setDiffLoading] = useState<Record<string, boolean>>({})
  const [openPatch, setOpenPatch] = useState<string | null>(null)
  /** 正在重派哪一件。空字串＝沒有 */
  const [retryBusy, setRetryBusy] = useState('')
  const [cancelBusy, setCancelBusy] = useState('')
  /**
   * 互動終端：哪一件正開著、各工具的執行檔路徑、這個環境支不支援。
   *
   * 只有桌面版有（node-pty 在 Electron 主行程裡）。瀏覽器開發模式拿不到
   * window.acPty —— 那時候按鈕就不要出現，給一個按了沒反應的鈕更糟。
   */
  const [ptyFor, setPtyFor] = useState<string | null>(null)
  const [bins, setBins] = useState<Record<string, string>>({})
  const [ptyOk, setPtyOk] = useState(false)
  useEffect(() => {
    const api = (window as unknown as { acPty?: { available: () => Promise<boolean> } }).acPty
    if (!api) return
    void api.available().then(setPtyOk).catch(() => setPtyOk(false))
    fetch('/api/bins').then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.paths && d.bins) setBins(d.bins) })
      .catch(() => {})
  }, [])
  // 拆解是地端模型，最長要等 120 秒。按鈕只寫「拆解中…」的話，
  // 等超過十幾秒就會開始懷疑是不是當掉了 —— 秒數會跳，就知道它還活著。
  const [planSec, setPlanSec] = useState(0)
  /** 拆解是可以中止的。地端模型慢的時候不該把人綁在原地 */
  const planAbort = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!planning) return
    const timer = setInterval(() => setPlanSec((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [planning])

  // 進行中的排前面，結束的收進摺疊區。之前是一份只增不減的歷史全部攤在
  // 「執行中的派工」標題底下，看久了就完全不知道現在到底有沒有東西在跑。
  const live = dispatches.filter(isLive)
  const done = dispatches.filter((d) => !isLive(d))
  const sessionUsd = dispatches.reduce((sum, d) => sum + (d.cost?.usd || 0), 0)

  // 派工狀態每 8 秒刷新一次，讓「執行中 → 完成」自己會動
  useEffect(() => {
    const pull = () => {
      fetch('/api/dispatches').then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d?.dispatches) return
          setDispatches(d.dispatches)
          // 「進行中 → 結束」那個瞬間要講一聲。
          // 之前這裡什麼都不做，而已結束的預設是收起來的 —— 一件工跑完就
          // 直接從畫面上消失，使用者只看到東西不見了，不知道是跑完還是壞掉。
          const nowLive: Set<string> = new Set(d.dispatches.filter(isLive).map((x: ConsoleDispatch) => x.id))
          const finished = d.dispatches.filter(
            (x: ConsoleDispatch) => LIVE_IDS.current.has(x.id) && !nowLive.has(x.id),
          )
          LIVE_IDS.current = nowLive
          // 第一次輪詢時 liveIds 是空的，所以剛開啟主控台不會冒出一堆舊通知
          if (finished.length) {
            setJustDone((q) => [...finished, ...q].slice(0, 4))
          }
        })
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
    setPlanSec(0)
    setNote('')
    setSteps([])
    const ac = new AbortController()
    planAbort.current = ac
    try {
      const r = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction }),
        signal: ac.signal,
      })
      // 一定要看 r.ok。原本直接 .json() 然後照用，後端回 500 時
      // steps 變空陣列、note 是空字串 —— 按鈕轉一下就沒反應，
      // 使用者只會覺得程式壞了
      if (!r.ok) {
        setNote(t('拆解失敗（HTTP {code}）', { code: r.status }), true)
        setPlanning(false)
        return
      }
      const d = await r.json()
      const got: Step[] = ensureStepIds(
        (d.steps || []).map((s: Omit<Step, 'id'> & { id?: string }) => ({ ...s, state: 'idle' as const })),
      )
      setSteps(got)
      setHistory((h) => [instruction, ...h.filter((x) => x !== instruction)].slice(0, 8))
      // d.ok === false 代表拆解沒成功，後端退而求其次把整句話當成一件工。
      // 那一件的內容是使用者原封不動的句子，沒有經過拆解器判斷該給誰、
      // 該切成幾步 —— 這種時候「省略確認」不該生效，不然一句
      // 「把舊的清一清」就會照字面直接派給某個會改檔案的 agent。
      // 原本這裡只看 got.length，失敗照樣自動派出去，而且畫面上沒有任何警告。
      if (!d.ok) {
        setNote(`⚠️ ${d.note || t('拆解失敗')}${autoRun ? t('（已暫停自動派工，請先確認下面這件再送）') : ''}`, true)
      } else {
        setNote(d.note || (got.length ? '' : t('沒有拆解出任何工作，換個說法試試')))
        if (autoRun && got.length) void runAll(got)
      }
    } catch (e) {
      // 使用者自己按「不等了」不是錯誤，不要當成 API 掛掉來報
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setNote(t('控制 API 無回應'), true)
      }
    }
    planAbort.current = null
    setPlanning(false)
  }

  /**
   * 不等地端拆解了，整件當成一件工單。
   *
   * 這跟「逾時自動退回」看起來一樣，差別在這是使用者主動選的：
   * 產生的那一件維持 idle，還是要按下派工才會送出去。
   * 沒有這個出口的話，地端模型慢的時候人只能乾等好幾分鐘或重新整理頁面。
   */
  const givePlanUp = () => {
    planAbort.current?.abort()
    const task = input.trim()
    if (task) {
      setSteps(ensureStepIds([{
        tool: 'auto', task, why: t('你選擇不等拆解，整件派工'), state: 'idle' as const,
      }]))
      setNote(t('已停止拆解。下面這一件還沒送出，確認過再按派工。'))
    }
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
  const runAll = async (list: Step[], mode: StepDispatchMode = 'pending') => {
    // 只動這一批真的要派的，不要動整份清單。
    //
    // 原本三個 setSteps 都是 s.map(全部) —— 於是按「只重派失敗的」或
    // 「只派這件」時，畫面上已經成功的工單會一起變回「派工中…」再變「已派出」，
    // 看起來像被重複派了一次。派出去的是會改檔案的 agent，
    // 讓人以為重複派工的代價不小。
    const inBatch = new Set(stepIdsForDispatch(list, mode))
    const selected = list.filter((step) => inBatch.has(step.id))
    if (!selected.length) return
    if (!window.confirm(t('這會真的交給 AI 執行工作，可能讀寫專案檔案。確定要開始嗎？'))) return
    const only = (fn: (x: Step) => Step) =>
      setSteps((s) => mapStepsById(s, inBatch, fn))

    only((x) => ({ ...x, state: 'sending' }))
    try {
      const d = await fetch('/api/dispatch/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steps: selected.map((x) => ({ tool: x.tool, task: x.task })),
          serial,
          cwd: workDir.trim(),
        }),
      }).then((r) => r.json())
      only((x) => ({ ...x, state: d.ok ? 'sent' : 'failed', note: d.note || d.error || '' }))
      setNote(d.ok ? (d.note || '') : `⚠️ ${d.error}`, !d.ok)
    } catch {
      only((x) => ({ ...x, state: 'failed', note: t('控制 API 無回應') }))
      setNote(t('⚠️ 控制 API 無回應'), true)
    }
  }

  /** 讀某次派工的產出 */
  /**
   * 對一件派工補一句話。
   *
   * 補一句是用各家的續談旗標再派一次，所以**一定是原本那個 AI 執行**。
   * 它沒有續談模式（kimi）或額度用完時，後端會改成「接力」：
   * 把原始工單＋它做到哪裡＋這次的補充，組成新工單交給另一個沒限流的 AI。
   * 那時候回傳裡會有 handoff，要明講換人了 —— 使用者以為是原本那個在做，
   * 結果換了一個，是很難查的誤會。
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
      }).then((x) => x.json()) as FollowupReply
      setNote(
        r.ok
          ? (r.handoff
            ? t('🤝 {why} —— 已把工單與進度交給 {to} 接手', { why: r.handoff.why, to: r.handoff.to })
            : (r.note || t('已送出')))
          : `⚠️ ${r.error || t('送出失敗')}`,
        !r.ok,
      )
      if (r.ok) {
        setReplyText('')
        setReplyTo(null)
        // 立刻拉一次，不要等下一個輪詢週期 —— 送出後畫面沒反應會以為沒送出去
        fetch('/api/dispatches').then((x) => (x.ok ? x.json() : null))
          .then((x) => x?.dispatches && setDispatches(x.dispatches)).catch(() => {})
      }
    } catch {
      setNote(t('⚠️ 控制 API 無回應'), true)
    }
    setReplyBusy(false)
  }

  const saveJob = async (j: SchedJob) => {
    const r = await fetch('/api/schedule/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j),
    }).then((x) => x.json()).catch(() => ({ ok: false, error: t('控制 API 無回應') }))
    setNote(r.ok ? t('已存好，到時間就會自己跑') : `⚠️ ${r.error}`, !r.ok)
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
    setNote(r.ok ? (r.note || t('已派出')) : `⚠️ ${r.error}`, !r.ok)
    pullSched()
  }

  const pullSched = () => {
    fetch('/api/schedules').then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.jobs && setJobs(d.jobs)).catch(() => {})
  }

  const fetchLog = async (id: string) => {
    try {
      const r = await fetch(`/api/dispatch/log?id=${encodeURIComponent(id)}`)
      const d = await r.json()
      setLogText((m) => ({ ...m, [id]: d.ok ? (d.text || t('還沒有輸出')) : (d.error || '') }))
    } catch {
      setLogText((m) => ({ ...m, [id]: t('控制 API 無回應') }))
    }
  }

  const loadLog = async (id: string) => {
    if (openLog === id) { setOpenLog(null); return }
    followLog.current = true      // 每次重新展開都先回到跟著跑的狀態
    setOpenLog(id)
    await fetchLog(id)
  }

  /**
   * 把一筆派工原封不動再派一次。
   *
   * 撞上 API 529 這種伺服器端的暫時性問題時，唯一該做的事就是重跑一次 ——
   * 但原本得把整份工單重打，而工單常常是幾十行。
   * 重派會產生一筆新紀錄而不是覆蓋舊的：「這件重試過幾次、每次結果是什麼」
   * 本身就是要看得到的資訊。
   */
  const retry = async (id: string) => {
    if (retryBusy) return
    setRetryBusy(id)
    try {
      const r = await fetch('/api/dispatch/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then((x) => x.json()) as DispatchReply
      setNote(
        r.ok
          ? (r.rerouted
            ? t('🔀 {why}，已改派給 {to}', { why: r.rerouted.why, to: r.rerouted.to })
            : (r.note || t('已重派')))
          : `⚠️ ${r.error || t('重派失敗')}`,
        !r.ok,
      )
      if (r.ok) {
        fetch('/api/dispatches').then((x) => (x.ok ? x.json() : null))
          .then((x) => x?.dispatches && setDispatches(x.dispatches)).catch(() => {})
      }
    } catch {
      setNote(t('⚠️ 控制 API 無回應'), true)
    }
    setRetryBusy('')
  }

  /**
   * 取消一件還沒被按下去的終端派工。
   *
   * 為什麼需要：終端派工開一個視窗、把指令帶進去、然後等人按。在那之前
   * 它一直被算成「進行中」。實際發生過的事 —— 派給 kimi 的工單擺了半小時
   * 沒人按，同一件事改派給會自己跑的 gemini；於是同一份工單有兩個持有者，
   * 誰先按下那個視窗，就有兩個 AI 在同一批檔案上做同一件事。
   * 而畫面上完全沒有辦法把前一件收掉。
   *
   * 後端除了標記登錄，還會把工單檔換成「不要做任何事」——
   * 那個視窗還開著，光標記登錄擋不住有人順手按下去。
   */
  const cancelDispatch = async (id: string) => {
    if (cancelBusy) return
    setCancelBusy(id)
    try {
      const r = await fetch('/api/dispatch/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then((x) => x.json()) as { ok?: boolean; error?: string; note?: string }
      setNote(r.ok ? (r.note ? `⚠️ ${r.note}` : t('已取消。那個終端就算被按下去也不會做事了'))
        : `⚠️ ${r.error || t('取消失敗')}`, !r.ok || !!r.note)
      if (r.ok) {
        fetch('/api/dispatches').then((x) => (x.ok ? x.json() : null))
          .then((x) => x?.dispatches && setDispatches(x.dispatches)).catch(() => {})
      }
    } catch {
      setNote(t('⚠️ 控制 API 無回應'), true)
    }
    setCancelBusy('')
  }

  // 停掉執行中的無頭派工。這比取消危險：agent 可能正在改檔案，砍在一半會留下
  // 改到一半的檔。所以先確認；但停了之後後端會老實標成「已停止」，
  // 不會像用工作管理員殺掉那樣顯示成「已完成」。
  const stopDispatch = async (d: ConsoleDispatch) => {
    if (cancelBusy) return
    if (!window.confirm(t('停掉正在跑的 {tool}？它可能正在改檔案，中途砍掉會留下改到一半的檔。'
      + '停了之後這件會標成「已停止」，可以重派。', { tool: d.tool }))) return
    setCancelBusy(d.id)
    try {
      const r = await fetch('/api/dispatch/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: d.id }),
      }).then((x) => x.json()) as { ok?: boolean; error?: string; note?: string }
      setNote(r.ok ? (r.note ? `⚠️ ${r.note}` : t('已停止這件，記成「已停止」')) : `⚠️ ${r.error || t('停止失敗')}`,
        !r.ok || !!r.note)
      if (r.ok) {
        fetch('/api/dispatches').then((x) => (x.ok ? x.json() : null))
          .then((x) => x?.dispatches && setDispatches(x.dispatches)).catch(() => {})
      }
    } catch {
      setNote(t('⚠️ 控制 API 無回應'), true)
    }
    setCancelBusy('')
  }

  const toggleDiff = async (id: string) => {
    if (diffFor === id) {
      setDiffFor(null)
      setOpenPatch(null)
      return
    }
    setDiffFor(id)
    setOpenPatch(null)
    if (Object.prototype.hasOwnProperty.call(diffData, id) || diffLoading[id]) return

    setDiffLoading((m) => ({ ...m, [id]: true }))
    try {
      const r = await fetch(`/api/dispatch/diff?id=${encodeURIComponent(id)}`)
      const body = await r.json().catch(() => ({})) as Partial<DispatchDiff>
      if (!r.ok || !body.ok) {
        throw new Error(body.error || t('讀取改動失敗（HTTP {code}）', { code: r.status }))
      }
      setDiffData((m) => ({
        ...m,
        [id]: {
          ok: true,
          cwd: typeof body.cwd === 'string' ? body.cwd : '',
          isGit: body.isGit === true,
          files: Array.isArray(body.files) ? body.files : [],
          truncated: body.truncated === true,
        },
      }))
    } catch (e) {
      setDiffData((m) => ({
        ...m,
        [id]: {
          ok: false,
          isGit: false,
          files: [],
          error: e instanceof Error && e.message ? e.message : t('控制 API 無回應'),
        },
      }))
    } finally {
      setDiffLoading((m) => ({ ...m, [id]: false }))
    }
  }

  // 展開中的 log 如果那件還在跑，就每 3 秒續抓。
  // 之前只在展開的那一刻抓一次 —— 打開一件正在跑的工作，畫面就永遠停在
  // 打開的那一秒，看起來跟當掉沒兩樣。
  useEffect(() => {
    if (!openLog) return
    const d = dispatches.find((x) => x.id === openLog)
    if (!d || !isLive(d)) return
    const timer = setInterval(() => { void fetchLog(openLog) }, 3000)
    return () => clearInterval(timer)
  }, [openLog, dispatches])

  const editStep = (id: string, patch: Partial<Step>) =>
    setSteps((s) => mapStepsById(s, new Set([id]), (step) => ({ ...step, ...patch })))

  const pending = stepIdsForDispatch(steps).length > 0
  const running = steps.some((s) => s.state === 'sending')
  const failed = steps.some((s) => s.state === 'failed')

  /** 只重派 failed 步驟；尚未送的 idle 與已成功步驟都保持原狀 */
  const retryFailed = () => {
    void runAll(steps, 'failed')
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
        {/* 工作目錄。空的就照舊從家目錄跑，所以不填也不會壞掉。
            填了才有意義的是：agent 不用自己 cd，而且「📝 看改了什麼」
            才問得到 git 差異 —— 家目錄不是 git 專案，那裡永遠沒東西可看。 */}
        <label className="mb-2 flex items-center gap-2 text-[11px] text-mute2">
          <span className="flex-none">{t('工作目錄')}</span>
          <input
            className="min-w-0 flex-1 rounded border border-line2 bg-transparent px-2 py-1 font-mono text-[11px] outline-none focus:border-line4"
            placeholder={t('留空＝家目錄。填專案路徑才看得到這批派工改了什麼')}
            value={workDir}
            onChange={(e) => setWorkDir(e.target.value)}
            spellCheck={false}
          />
        </label>
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
            aria-busy={planning}
            onClick={makePlan}
          >
            {planning ? t('拆解中… {n} 秒', { n: planSec }) : t('分析並排程')}
          </button>
          {planning && (
            <span
              className="sr-only"
              role="progressbar"
              aria-label={t('任務拆解進度')}
              aria-valuetext={t('拆解中… {n} 秒', { n: planSec })}
            >
              {t('拆解中… {n} 秒', { n: planSec })}
            </span>
          )}
          {/* 超過 25 秒才出現。地端模型正常幾秒就回，太早出現只會讓人以為壞了 */}
          <button
            className={`rounded border border-line2 px-2 py-1 text-[11px] text-mute hover:bg-elev ${
              planning && planSec >= 25 ? '' : 'hidden'
            }`}
            onClick={givePlanUp}
            title={t('地端模型太慢的話可以不等。整件會變成一張工單，還是要你按下派工才送出')}
          >
            {t('不等了，整件當一件')}
          </button>
          <span className="text-[11px] text-mute3">Ctrl + Enter</span>
          {note && (
            <span
              className="text-[11px] text-amber-700 dark:text-amber-400/90"
              role={noteError ? 'alert' : 'status'}
              aria-live={noteError ? 'assertive' : 'polite'}
            >
              {note}
            </span>
          )}
        </div>
        {history.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {history.map((h) => (
              <button
                key={h}
                className="max-w-64 truncate rounded bg-elev px-2 py-1 text-[11px] text-mute hover:text-ink2"
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
                className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-60 dark:disabled:opacity-40"
                disabled={!pending || running}
                onClick={() => runAll(steps)}
              >
                {running ? t('派工中…') : t('▶ 全部派出')}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {steps.map((s) => (
              <div key={s.id} className="rounded border border-line p-2">
                <div className="mb-1 flex items-center gap-2">
                  <select
                    className="rounded border border-line2 bg-panel px-1.5 py-0.5 text-[11px] text-ink2 [&>option]:bg-panel [&>option]:text-ink2"
                    style={{ color: TOOL_COLOR[s.tool] ? tone(TOOL_COLOR[s.tool]) : undefined }}
                    value={s.tool}
                    disabled={s.state !== 'idle'}
                    onChange={(e) => editStep(s.id, { tool: e.target.value })}
                  >
                    {[...new Set([...toolOptions, s.tool])].map((tl) => (
                      <option key={tl} value={tl} disabled={limitedTools.has(tl)}>
                        {tl}{limitedTools.has(tl) ? t('（額度用完）') : ''}
                      </option>
                    ))}
                  </select>
                  {s.why && <span className="truncate text-[11px] text-mute3">{s.why}</span>}
                  <span
                    className="ml-auto text-[11px]"
                    role={s.state === 'failed' ? 'alert' : 'status'}
                    aria-live={s.state === 'failed' ? 'assertive' : 'polite'}
                  >
                    {s.state === 'sent' && <span className="text-emerald-700 dark:text-emerald-400">{t('已派出')}</span>}
                    {s.state === 'sending' && <span className="text-amber-700 dark:text-amber-400">{t('派工中…')}</span>}
                    {s.state === 'failed' && <span className="text-red-700 dark:text-red-400">{s.note || t('失敗')}</span>}
                  </span>
                  {s.state === 'idle' && (
                    <button
                      className="text-[11px] text-sky-700 hover:text-sky-500 dark:text-sky-400"
                      title={t('只派這一件，其他留著。想先確認一件跑得對再放行其餘的時候用')}
                      onClick={() => void runAll([s])}
                    >
                      {t('▶ 只派這件')}
                    </button>
                  )}
                  {s.state === 'idle' && (
                    <button
                      className="text-[11px] text-mute3 hover:text-red-400"
                      onClick={() => setSteps((x) => x.filter((step) => step.id !== s.id))}
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
                  onChange={(e) => editStep(s.id, { task: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {batch?.running && (
        <div
          className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] dark:border-amber-700/60 dark:bg-amber-950/40"
          role="progressbar"
          aria-label={t('派工佇列進度')}
          aria-valuemin={0}
          aria-valuemax={batch.total}
          aria-valuenow={Math.min(batch.done, batch.total)}
          aria-valuetext={t('派工佇列：第 {a} / {b} 件', { a: batch.done + 1, b: batch.total })}
        >
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 flex-none animate-pulse rounded-full bg-amber-400" />
            <span className="text-amber-700 dark:text-amber-200">
              {t('派工佇列：第 {a} / {b} 件', { a: batch.done + 1, b: batch.total })}
            </span>
            <span className="min-w-0 flex-1 truncate text-mute2">{batch.current}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded bg-elev" aria-hidden="true">
            <div className="h-full bg-amber-400" style={{ width: `${Math.round((batch.done / Math.max(1, batch.total)) * 100)}%` }} />
          </div>
        </div>
      )}

      {/* ── 定時工作 ── */}
      <div className="rounded border border-line bg-panel p-3">
        <div className="mb-2 flex items-center gap-2">
          <button
            className="rounded px-1 py-1 text-xs font-medium tracking-widest text-mute hover:bg-elev"
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
                {[...new Set([...toolOptions, draft.tool])].map((tl) => <option key={tl} value={tl}>{tl}</option>)}
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

      {/* 派之前就看得到誰還有額度、今天燒了多少——不是撞牆之後才看到紅字 */}
      <QuotaStrip compact />

      {/* ── 執行追蹤 ── */}
      <div className="rounded border border-line bg-panel p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-medium tracking-widest text-mute">{t('🛰️ 派工')}</span>
          {live.length > 0 && (
            <span
              className="rounded bg-amber-100 dark:bg-amber-400/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-300"
            >
              {t('{n} 件進行中', { n: live.length })}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {sessionUsd > 0 && (
              <span className="text-[10px] text-mute2">
                {t('清單內累計 {amount}', { amount: formatUsd(sessionUsd) })}
              </span>
            )}
            {done.length > 0 && (
              <button
                className="rounded px-1 py-1.5 text-[10px] text-mute2 hover:bg-elev hover:text-ink3"
                onClick={() => { setShowDone((v) => !v); setDoneShown(DONE_PAGE) }}
              >
                {showDone ? t('收起已結束（{n}）', { n: done.length }) : t('看已結束（{n}）', { n: done.length })}
              </button>
            )}
          </div>
        </div>
        {/* 剛跑完的視覺記錄不自己消失；無障礙 live announcement 由 App 單一負責。 */}
        {justDone.map((d) => {
          const notice = d.outcome === 'error'
            ? 'error'
            : d.outcome === 'no_changes'
              ? 'no_changes'
              : d.outcome === 'ok' || stateOf(d) !== 'failed' ? 'ok' : 'error'
          const status = outcomeLook(d)
          return (
            <div
              key={d.id}
              className={`mb-1 flex items-center gap-2 rounded border px-2 py-1 text-[11px] ${
                notice === 'error'
                  ? 'border-red-300 bg-red-50 dark:border-red-800/60 dark:bg-red-950/40'
                  : notice === 'no_changes'
                    ? 'border-amber-300 bg-amber-50 dark:border-amber-800/60 dark:bg-amber-950/40'
                    : 'border-emerald-300 bg-emerald-50 dark:border-emerald-800/60 dark:bg-emerald-950/40'
              }`}
            >
              <span className="flex-none">{notice === 'ok' ? '✅' : '⚠️'}</span>
              <span className="w-14 flex-none font-medium" style={{ color: TOOL_COLOR[d.tool] ? tone(TOOL_COLOR[d.tool]) : undefined }}>
                {d.tool}
              </span>
              <span className="min-w-0 flex-1 truncate text-mute" title={d.task}>{d.task}</span>
              {notice === 'error' && (
                <span className="max-w-48 truncate text-red-700 dark:text-red-300">
                  {d.issue?.trim() || t('沒有提供錯誤原因')}
                </span>
              )}
              <span className={`flex-none ${status.tone}`}>
                {status.label}
              </span>
              <button
                className="flex-none rounded border border-line2 px-1.5 text-mute hover:bg-elev"
                onClick={() => {
                  setShowDone(true)
                  if (openLog !== d.id) void loadLog(d.id)
                  setJustDone((q) => q.filter((x) => x.id !== d.id))
                }}
              >
                {t('看結果')}
              </button>
              <button
                className="flex-none text-mute3 hover:text-ink3"
                title={t('知道了')}
                onClick={() => setJustDone((q) => q.filter((x) => x.id !== d.id))}
              >
                ✕
              </button>
            </div>
          )
        })}
        {dispatches.length === 0 && (
          <div className="text-xs text-mute3">{t('目前沒有派工')}</div>
        )}
        {dispatches.length > 0 && live.length === 0 && !showDone && (
          <div className="text-xs text-mute3">{t('沒有進行中的派工')}</div>
        )}
        <div className="flex flex-col gap-1">
          {(showDone ? [...live, ...done.slice(0, doneShown)] : live).map((d) => {
            const status = outcomeLook(d)
            const diff = diffData[d.id]
            const diffOpen = diffFor === d.id
            return (
              <div key={d.id}>
              <button
                onClick={() => loadLog(d.id)}
                className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[11px] hover:bg-elev"
                title={t('點一下看這次派工的產出')}
              >
                <span className="w-3 flex-none text-mute3">{openLog === d.id ? '▾' : '▸'}</span>
                <span className="w-14 flex-none font-medium" style={{ color: TOOL_COLOR[d.tool] ? tone(TOOL_COLOR[d.tool]) : undefined }}>
                  {d.tool}
                </span>
                <span className="min-w-0 flex-1 truncate text-mute" title={d.task}>{taskLabel(d)}</span>
                {/* 何時派的。沒有這個的話，同一批派出去的幾件在畫面上長得一模一樣
                    —— 工單開頭往往是同一段前置說明，truncate 之後完全分不出誰是誰。
                    時間是最便宜也最有效的區別。 */}
                <span className="flex-none text-[10px] text-mute3" title={startedAt(d.started)}>
                  {startedAgo(d.started)}
                </span>
                {d.cost && (
                  <span className="flex-none text-[10px] text-mute2" title={d.cost.model}>
                    {formatUsd(d.cost.usd) && `${formatUsd(d.cost.usd)} · `}
                    {tokenText(d.cost)}
                  </span>
                )}
                <span className={`flex-none ${status.tone}`}>
                  {status.label}
                </span>
              </button>
              {(d.outcome === 'error' || d.outcome === 'blocked') && !isLive(d) && (
                <div className={`ml-6 mt-0.5 text-[10px] ${d.outcome === 'blocked'
                  ? 'text-sky-700 dark:text-sky-300' : 'text-red-700 dark:text-red-300'}`}>
                  {d.issue?.trim() || (d.outcome === 'blocked'
                    ? t('沒有說明是哪一條規範擋下的')
                    : t('沒有提供錯誤原因'))}
                </div>
              )}
              {stateOf(d) === 'running' && (
                <div className="ml-6 flex items-center gap-2 text-[10px] text-mute3">
                  <span className="inline-block h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-amber-400" />
                  <span className="min-w-0 flex-1 truncate font-mono">{d.tail || t('（還沒有輸出）')}</span>
                  <span className="flex-none">{elapsed(d.started)}</span>
                  {d.mode !== 'terminal' && !!d.pid && (
                    <button
                      className="flex-none text-[10px] text-mute2 hover:text-red-500"
                      title={t('停掉這個正在跑的行程（會先確認）。停了會老實標成「已停止」，不會假裝完成')}
                      disabled={cancelBusy === d.id}
                      onClick={() => void stopDispatch(d)}
                    >
                      {cancelBusy === d.id ? '…' : t('⏹ 停止')}
                    </button>
                  )}
                </div>
              )}
              {!!d.pending?.length && (
                <div className="ml-6 text-[10px] text-sky-700 dark:text-sky-400/80">
                  {t('已排隊 {n} 句，這一輪結束後送出', { n: d.pending.length })}
                </div>
              )}
              {/* 只在「重跑一次有意義」的結果上給重派鈕。
                  已完成的不給 —— 那會變成一顆很容易誤按、而且會真的
                  再花一次錢的按鈕。 */}
              {/* 後端已經自動換人的，講清楚換給誰、為什麼 —— 不然使用者看到一筆
                  紅色的失敗，會自己再派一次，跟自動接力的那一筆撞在一起。 */}
              {d.handedOffTo && (
                <div className={`ml-6 mt-0.5 text-[10px] ${d.handedOffTo === 'none'
                  ? 'text-amber-700 dark:text-amber-300' : 'text-sky-700 dark:text-sky-300'}`}
                  title={d.handoffWhy || ''}>
                  {d.handedOffTo === 'none'
                    ? t('↪ 沒有工具能接手（都限流或沒安裝），等額度恢復')
                    : d.handedOffTo === '…'
                      ? t('↪ 正在自動換人…')
                      : t('↪ 已自動接力給 {id}', { id: d.handedOffTo })}
                </div>
              )}
              {d.handoffFrom && (
                <div className="ml-6 mt-0.5 text-[10px] text-mute3">
                  {t('↩ 從 {id} 接力而來', { id: d.handoffFrom })}
                </div>
              )}
              {!isLive(d) && !d.handedOffTo && (d.outcome === 'error' || d.outcome === 'no_changes') && (
                <button
                  className="ml-6 rounded px-1 py-1.5 text-[10px] text-mute2 hover:bg-elev hover:text-ink3 disabled:opacity-50"
                  disabled={!!retryBusy}
                  title={t('用同一份工單、同一個工具再派一次')}
                  onClick={() => void retry(d.id)}
                >
                  {retryBusy === d.id ? t('重派中…') : t('↻ 重派')}
                </button>
              )}
              {/* 只有工作目錄在 git 裡才給這顆按鈕。
                  否則按十次有九次得到「這裡不是 git 專案」，
                  使用者會學會不按它 —— 然後真的有改動的那一次也不會去看。 */}
              {!isLive(d) && d.canDiff && (
                <button
                  className="ml-6 rounded px-1 py-1.5 text-[10px] text-mute2 hover:bg-elev hover:text-ink3"
                  aria-expanded={diffOpen}
                  onClick={() => void toggleDiff(d.id)}
                >
                  {diffOpen ? t('收起改動') : t('📝 看改了什麼')}
                </button>
              )}
              <button
                className={`${isLive(d) ? 'ml-6' : 'ml-2'} rounded px-1 py-1.5 text-[10px] text-mute2 hover:bg-elev hover:text-ink3`}
                title={t('工作跑歪了可以在這裡補一句。還在跑的話會排隊，結束後自動送出。'
                  + '原本那個 AI 沒有續談模式或額度用完時，會自動把工單與進度交給別的 AI 接手')}
                onClick={() => { setReplyTo(replyTo === d.id ? null : d.id); setReplyText('') }}
              >
                {replyTo === d.id ? t('取消') : t('💬 補一句')}
              </button>
              {/* 只有「等你執行」才給取消。執行中的要停下來得殺行程，
                  而中途砍掉一個正在改檔案的 agent 比讓它跑完更危險。 */}
              {stateOf(d) === 'waiting' && (
                <button
                  className="ml-2 text-[10px] text-mute2 hover:text-red-500"
                  title={t('這件還沒有人按下去。取消之後那個終端就算被按下去也不會做事 ——'
                    + '同一件事已經改派給別人的時候用這個，才不會兩個 AI 動同一批檔案')}
                  disabled={cancelBusy === d.id}
                  onClick={() => void cancelDispatch(d.id)}
                >
                  {cancelBusy === d.id ? '…' : t('✕ 取消這件')}
                </button>
              )}
              {ptyOk && bins[d.tool] && (
                <button
                  className="ml-2 text-[10px] text-sky-700 hover:text-sky-500 dark:text-sky-400"
                  title={t('在同一個工作目錄另外開一條可以打字的 {tool}，用來接手往下做。'
                    + '注意：這不會接到已經在跑的那個行程 —— 無頭派工的 stdin 是關掉的，'
                    + '任何人都插不進去。要對進行中的工作補話請用「💬 補一句」。',
                    { tool: d.tool })}
                  onClick={() => setPtyFor(ptyFor === d.id ? null : d.id)}
                >
                  {ptyFor === d.id ? t('收起終端') : t('🖥️ 另開終端')}
                </button>
              )}
              {ptyFor === d.id && (
                <div className="mx-4 my-1 h-72">
                  <LiveTerminal
                    id={`disp-${d.id}`}
                    tool={d.tool}
                    bin={bins[d.tool]}
                    cwd={d.cwd}
                    onClose={() => setPtyFor(null)}
                  />
                </div>
              )}
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
              {diffOpen && (
                <div className="mx-4 my-1 rounded border border-line2 bg-panel p-2 text-[11px] text-ink2">
                  {diffLoading[d.id] && <div className="text-mute2">{t('讀取改動中…')}</div>}
                  {!diffLoading[d.id] && diff && !diff.ok && (
                    <div className="text-mute2">
                      {t('讀取改動失敗：{error}', { error: diff.error || t('未知錯誤') })}
                    </div>
                  )}
                  {!diffLoading[d.id] && diff?.ok && !diff.isGit && (
                    <div className="text-mute2">
                      {t('這個工作目錄不是 git 專案，看不到改動')}
                    </div>
                  )}
                  {!diffLoading[d.id] && diff?.ok && diff.isGit && diff.files.length === 0 && (
                    <div className="text-mute2">{t('這次沒有可顯示的檔案改動')}</div>
                  )}
                  {!diffLoading[d.id] && diff?.ok && diff.isGit && diff.files.length > 0 && (
                    <div className="flex flex-col gap-1">
                      {diff.files.map((file) => {
                        const patchKey = `${d.id}\u0000${file.path}`
                        const expanded = openPatch === patchKey
                        return (
                          <div key={file.path}>
                            <button
                              className="flex w-full items-center gap-2 rounded border border-line2 bg-panel px-2 py-1 text-left hover:bg-elev"
                              aria-expanded={expanded}
                              title={expanded
                                ? t('收起 {path} 的 patch', { path: file.path })
                                : t('展開 {path} 的 patch', { path: file.path })}
                              onClick={() => setOpenPatch(expanded ? null : patchKey)}
                            >
                              <span className="w-3 flex-none text-mute3">{expanded ? '▾' : '▸'}</span>
                              <span className="min-w-0 flex-1 truncate font-mono text-ink3">{file.path}</span>
                              <span className="flex-none text-emerald-700 dark:text-emerald-300">+{file.added}</span>
                              <span className="flex-none text-mute3">/</span>
                              <span className="flex-none text-red-700 dark:text-red-300">−{file.removed}</span>
                            </button>
                            {expanded && <PatchLines patch={file.patch} />}
                          </div>
                        )
                      })}
                      {diff.truncated && (
                        <div className="text-mute2">{t('改動內容太長，只顯示一部分')}</div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {openLog === d.id && (
                <pre
                  // 還在跑的就自動捲到底，跟 tail -f 一樣。
                  // 使用者往上捲會停下來（不然想看前面一段會一直被拉走），
                  // 捲回底部就恢復跟隨。
                  ref={(el) => {
                    if (el && isLive(d) && followLog.current) el.scrollTop = el.scrollHeight
                  }}
                  onScroll={(e) => {
                    const el = e.currentTarget
                    followLog.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
                  }}
                  className="mx-4 my-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-app p-2 font-mono text-[11px] leading-5 text-ink3"
                >
                  {logText[d.id] ?? t('讀取中…')}
                  {isLive(d) && (
                    <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-amber-400 align-middle" />
                  )}
                </pre>
              )}
              </div>
            )
          })}
        </div>
        {showDone && done.length > doneShown && (
          <button
            className="mt-1 self-start rounded px-1 py-1.5 text-[10px] text-mute2 hover:bg-elev hover:text-ink3"
            onClick={() => setDoneShown((n) => n + DONE_PAGE)}
          >
            {t('再顯示 {m} 筆（還有 {n} 筆）', {
              m: Math.min(DONE_PAGE, done.length - doneShown),
              n: done.length - doneShown,
            })}
          </button>
        )}
      </div>
    </div>
  )
}
