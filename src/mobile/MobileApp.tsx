/* eslint-disable react-refresh/only-export-components -- 派工資格判讀要能在沒有 DOM 的情況下聚焦測試 */
// 手機遙控主畫面（PWA 前端）
// 提供使用者在行動裝置瀏覽器上，透過 Tailscale 網路遙控操作 AI 派工。
// 具備 401 自動轉配對、8 秒狀態輪詢、安全邊界留白與符合行動觸控標準的按鈕尺寸。
//
// 手機上只有 /api/dispatch/tools 這一個狀態來源：這裡不做（也不該做）接入 AI、
// 金鑰或帳號登入。缺工具時唯一誠實的出口是「回電腦上設定好再回來重新檢查」。

import { useEffect, useState, useCallback, useRef } from 'react'
import { t } from '@/i18n'
import QuotaStrip from '@/components/QuotaStrip'
import {
  canDispatch,
  parseDispatchReadiness,
  toolReadinessLabel,
  type ReadinessSnapshot,
  type ReadinessTool,
} from '@/lib/aiReadiness'
import { isLive, look, stateOf } from '@/lib/dispatchState'
import type { DispatchRecord } from '@/types/data'
import {
  capturePairing,
  clearRemoteToken,
  createSnapshotFetch,
  getRemoteToken,
  installRemoteFetch,
  isPairingIntact,
  isStalePairingError,
  setRemoteToken,
  tokenFromHash,
  validateRemoteToken,
  type PairingSnapshot,
} from './remoteApi'

export type ConsoleDispatch = DispatchRecord & {
  outcome?: 'ok' | 'no_changes' | 'blocked' | 'error' | 'stopped' | null
  handedOffTo?: string
  handoffFrom?: string
}

/**
 * 工具列的形狀跟共用判讀同一份（後端多給欄位不會壞）。
 * ready／state 是可選的：舊版少給的那幾欄不會被當成「可以派」，而是「狀態未確認」。
 */
export interface DispatchTool extends ReadinessTool {
  mode?: 'headless' | 'terminal' | 'local'
  ready?: boolean
  limited?: boolean
  state?: string
}

export interface MobileAppProps {
  initialToken?: string
  initialPaired?: boolean
  initialDispatches?: ConsoleDispatch[]
  initialTools?: DispatchTool[]
  /** 伺服器明講的自動派工對象；沒有就是 null，前端不猜也不退回本地模型 */
  initialAuto?: string | null
}

/** 計算派工發起距今時間 */
function startedAgo(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(stamp || '')
  if (!m) return ''
  const [, y, mo, d, h, mi, se] = m
  const t0 = new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime()
  const s = Math.max(0, Math.round((Date.now() - t0) / 1000))
  if (s < 60) return t('剛剛')
  if (s < 3600) return t('{n} 分前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小時前', { n: Math.floor(s / 3600) })
  return t('{n} 天前', { n: Math.floor(s / 86400) })
}

/** 依 outcome 回傳對應之語意說明 */
function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'ok':
      return t('已完成')
    case 'no_changes':
      return t('跑完了但沒有改到任何檔案')
    case 'blocked':
      return t('依規範停下（沒有執行）')
    case 'stopped':
      return t('被停止（沒有跑完）')
    case 'error':
      return t('執行失敗')
    default:
      return outcome
  }
}

/** 依 outcome 回傳語意色調樣式 */
function outcomeTone(outcome: string): string {
  switch (outcome) {
    case 'ok':
      return 'text-emerald-700 dark:text-emerald-300'
    case 'no_changes':
    case 'stopped':
      return 'text-amber-700 dark:text-amber-300'
    case 'blocked':
      return 'text-sky-700 dark:text-sky-300'
    case 'error':
      return 'text-red-700 dark:text-red-300'
    default:
      return 'text-mute2'
  }
}

/** 問到後端之前一律是「一件都不能派」。讀不到就是讀不到，不留舊快照也不猜。 */
export const EMPTY_READINESS: ReadinessSnapshot = { ok: false, tools: [], auto: null, ready: false, reason: '' }

/** 初始 props 也走同一道判讀：缺 ready／state 的舊資料只會停用，不會被補成「可派工」。 */
export function readinessFromProps(
  tools?: readonly DispatchTool[],
  auto?: string | null,
): ReadinessSnapshot {
  if (!Array.isArray(tools) || tools.length === 0) return EMPTY_READINESS
  return parseDispatchReadiness({ ok: true, tools, auto: typeof auto === 'string' ? auto : '' })
}

/** 這個工具只回答、不會動檔案。查不到模式就只認 id —— 不替任何工具宣稱它會寫檔。 */
export function isAnswerOnlyTool(id: string, tools: readonly ReadinessTool[]): boolean {
  const row = Array.isArray(tools) ? tools.find((x) => x && x.id === id) : undefined
  if (row && typeof row.mode === 'string') return row.mode === 'local'
  return id === 'local'
}

/**
 * 本機問答紀錄（tool==='local' 或 mode==='sync'）。
 * 它只回答、沒有檔案工具，也沒有可續談的後端工作 —— 後端現在會用 409 擋掉補話，
 * 免得一句「再幫我改一下」被升級成雲端／檔案操作。
 */
export function isLocalAnswerRecord(d: { tool?: string; mode?: string } | null | undefined): boolean {
  if (!d || typeof d !== 'object') return false
  return d.tool === 'local' || d.mode === 'sync'
}

/** 本機問答為什麼不能補話。講清楚出口在哪，不要只給一顆按不動的鈕。 */
export const LOCAL_FOLLOWUP_NOTE = () =>
  t('本機問答請回原對話接續（這筆只回答、沒有可續談的工作）')

/** 配對變更時保留文字；請先確認工作狀態，不能假定沒有送出。 */
export const STALE_PAIRING_NOTE = () =>
  t('配對已變更，已保留你的文字；請先確認這件工作的狀態。')

/** 對還在跑的 CLI 補話是「排隊」：這一輪跑完才會送出，屆時後端會自己再檢查一次。 */
export const FOLLOWUP_QUEUE_NOTE = () =>
  t('這一輪跑完後才會送出；到時候後端會再檢查一次能不能執行。')

/**
 * 補一句的資格：無頭 CLI 都給。
 *
 * 還在跑的那一筆也要給 —— 後端支援把補話排進「已接受」的工作裡，
 * 手機這邊讀不讀得到 AI 就緒度，都不該擋住使用者把話排進去（就緒度只擋「等於重跑一次」的情況）。
 * 本機問答（tool==='local' 或 mode==='sync'）仍然不給：那是一次性地端回答，後端會用 409 擋下。
 */
export function canFollowupRecord(d: { mode?: string; tool?: string } | null | undefined): boolean {
  if (!d || typeof d !== 'object') return false
  return d.mode !== 'terminal' && !isLocalAnswerRecord(d)
}

/** 只讓正規化過的公開字串進畫面：非字串（物件、數字、null）一律當成「沒有這一欄」。 */
export function publicText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 本機問答真正可讀的回答內容；只認字串，物件一律不算「AI 回答過了」。 */
export function localAnswerText(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  const body = data as Record<string, unknown>
  return publicText(body.reply) || publicText(body.answer) || publicText(body.text)
}

/** 擋下來的工具要留住後端給的具體原因；限流卻沒給原因時明講「額度狀態無法確認」。 */
function toolReasonText(tool: ReadinessTool): string {
  const reason = publicText(tool.reason)
  if (reason) return t(reason)
  return tool.limited === true ? t('額度狀態無法確認') : ''
}

/** 下拉選項文字：工具名（狀態：具體原因）。label／reason 走 t()，不直接算繪物件。 */
export function toolOptionText(tool: ReadinessTool, tools: readonly ReadinessTool[]): string {
  const id = publicText(tool.id)
  const label = t(publicText(tool.label)) || id
  const head = isAnswerOnlyTool(id, tools) ? `${label}【${t('只回答，不改檔')}】` : label
  const status = t(toolReadinessLabel(tool))
  // 可以派的工具不用再解釋原因；不能派的一定要看得到為什麼
  const reason = canDispatch(id, tools, null) ? '' : toolReasonText(tool)
  return `${head}（${reason ? `${status}：${reason}` : status}）`
}

/** 送出前的即時複查：非 2xx（含 401）、格式不對、擲例外，一律回空快照。 */
export async function fetchReadiness(doFetch: typeof fetch): Promise<ReadinessSnapshot> {
  try {
    const res = await doFetch('/api/dispatch/tools')
    if (!res.ok) return EMPTY_READINESS
    return parseDispatchReadiness(await res.json())
  } catch {
    return EMPTY_READINESS
  }
}

export interface DispatchDeps {
  fetch: typeof fetch
  /** 執行前的確認；不給就等於使用者已同意（測試用） */
  confirm?: (message: string) => boolean
  /** 還是同一個掛載、同一份配對嗎？false 就不會送出 POST */
  isCurrent?: () => boolean
}

export interface DispatchAttempt {
  /** 有沒有真的打出 POST /api/dispatch */
  posted: boolean
  ok: boolean
  /** 實際送出的工具 id（auto 已在複查後釘死） */
  tool: string
  message: string
  answerOnly: boolean
  snapshot: ReadinessSnapshot
  /** 因為卸載或配對改變而中止 */
  stale: boolean
}

/**
 * 送出一件派工。順序是刻意的：
 * 先重問一次工具狀態 → 把 auto 釘成這份新快照裡的那一個 → 確認 → 才 POST。
 *
 * 釘死 auto 的理由：使用者可能選的是「只回答，不改檔」的地端工具，
 * 若把 'auto' 原樣丟給後端，送出的瞬間伺服器換人，就會變成一個會改檔的 CLI 在跑。
 */
export async function attemptDispatch(
  requested: string,
  task: string,
  deps: DispatchDeps,
): Promise<DispatchAttempt> {
  const text = (task || '').trim()
  const base = { posted: false, ok: false, tool: '', answerOnly: false, stale: false }
  if (!text) return { ...base, message: '', snapshot: EMPTY_READINESS }

  const snapshot = await fetchReadiness(deps.fetch)
  if (deps.isCurrent && !deps.isCurrent()) {
    return { ...base, message: '', snapshot, stale: true }
  }
  const tool = requested === 'auto' ? (snapshot.auto || '') : (requested || '').trim()
  if (!canDispatch(tool, snapshot.tools, snapshot.auto)) {
    return { ...base, message: t('這些 AI 現在不是確認可以執行的狀態，沒有送出任何工作。'), snapshot }
  }

  const answerOnly = isAnswerOnlyTool(tool, snapshot.tools)
  if (deps.confirm && !deps.confirm(answerOnly
    ? t('這件只交給本機模型：只回答，不改檔。確定要送出嗎？')
    : t('這會真的交給 AI 執行工作，可能讀寫專案檔案。確定要送出嗎？'))) {
    return { ...base, tool, answerOnly, message: '', snapshot }
  }
  // 確認框可能停在畫面上很久：按下去的當下要再確認還是同一個掛載、同一份配對
  if (deps.isCurrent && !deps.isCurrent()) {
    return { ...base, tool, answerOnly, message: '', snapshot, stale: true }
  }

  try {
    const res = await deps.fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, task: text }),
    })
    const raw = await res.json().catch(() => null) as unknown
    const data = (raw && typeof raw === 'object' && !Array.isArray(raw))
      ? raw as Record<string, unknown>
      : {}
    // 晚回的回應不能拿去改新配對的畫面狀態
    if (deps.isCurrent && !deps.isCurrent()) {
      return { posted: true, ok: false, tool, answerOnly, snapshot, stale: true, message: '' }
    }
    const ok = res.ok && data.ok === true
    const note = publicText(data.note)
    const fail = { posted: true, ok: false, tool, answerOnly, snapshot, stale: false }
    if (!ok) return { ...fail, message: publicText(data.error) || t('派工失敗') }

    if (answerOnly) {
      // 本機問答的價值就是那段回答；沒拿到可讀內容就不能宣稱「AI 已經回答了」
      const reply = localAnswerText(data)
      if (!reply) {
        const unverified = t('已接受，但沒有拿到可以顯示的回答內容（不代表 AI 已經回答完）。請回電腦上的對話確認，你打的字會留著。')
        return { ...fail, message: note ? `${unverified}\n${note}` : unverified }
      }
      return {
        posted: true,
        ok: true,
        tool,
        answerOnly,
        snapshot,
        stale: false,
        message: `${t('本機模型已回答，沒有改任何檔案')}：\n${reply}`,
      }
    }
    // CLI 是「已接受」不是「已完成」：完成與否看下面的派工清單
    return { posted: true, ok: true, tool, answerOnly, snapshot, stale: false, message: note || t('派工成功') }
  } catch (error) {
    // 傳輸層在送出前擋下來（token 被換掉／清掉／配對換代）：這是中止，不是失敗的派工。
    // 不能宣稱送出過，草稿也要留著。
    if (isStalePairingError(error)) {
      return { ...base, tool, answerOnly, message: '', snapshot, stale: true }
    }
    return { posted: true, ok: false, tool, answerOnly, snapshot, stale: false, message: t('派工失敗') }
  }
}

export type ControlAction = 'stop' | 'cancel' | 'retry' | 'followup'

export interface ControlDeps extends DispatchDeps {
  /** 補一句要送出的內容（只有 followup 會用到） */
  text?: string
  /** 這筆還在跑嗎：跑著的 CLI 補話是排進後端已接受的工作，不需要重新複查就緒度 */
  live?: boolean
}

export interface ControlAttempt {
  posted: boolean
  ok: boolean
  /** 因為卸載、配對換代或 token 被換掉而中止 */
  stale: boolean
  message: string
  /** 有重新複查才會有；stop／cancel 一律是 null */
  snapshot: ReadinessSnapshot | null
}

const CONTROL_ENDPOINT: Record<ControlAction, string> = {
  stop: '/api/dispatch/stop',
  cancel: '/api/dispatch/cancel',
  retry: '/api/dispatch/retry',
  followup: '/api/dispatch/followup',
}

const CONTROL_FAIL: Record<ControlAction, () => string> = {
  stop: () => t('停止失敗'),
  cancel: () => t('取消失敗'),
  retry: () => t('重派失敗'),
  followup: () => t('送出失敗'),
}

/**
 * 停止／取消／重派／補一句共用的一條路。四個入口都得走同一份配對綁定，
 * 免得其中一個忘了檢查就變成「用新配對送舊意圖」。
 *
 * 就緒度只擋「等於重新執行」的動作（重派、對已結束的工作補話）；
 * 停止與取消不受 AI 就緒度影響 —— 讀不到工具狀態不代表不能喊停。
 */
export async function attemptControl(
  action: ControlAction,
  d: ConsoleDispatch,
  deps: ControlDeps,
): Promise<ControlAttempt> {
  const alive = () => !deps.isCurrent || deps.isCurrent()
  const base: ControlAttempt = { posted: false, ok: false, stale: false, message: '', snapshot: null }

  // 0. 起手就得是同一份配對（token + 代次）
  if (!alive()) return { ...base, stale: true }

  const text = (deps.text || '').trim()
  if (action === 'followup') {
    if (!text) return base
    if (isLocalAnswerRecord(d)) return { ...base, message: LOCAL_FOLLOWUP_NOTE() }
  }

  // 1. 需要確認的動作：原生 confirm 會同步卡住畫面，按下去的當下要再驗一次快照
  if (action === 'stop' && deps.confirm && !deps.confirm(t('確定要停止這件派工嗎？'))) {
    return base
  }
  if (!alive()) return { ...base, stale: true }

  // 2. 就緒度複查：只有重派與「對已結束工作補話」需要
  let snapshot: ReadinessSnapshot | null = null
  if (action === 'retry' || (action === 'followup' && deps.live !== true)) {
    snapshot = await fetchReadiness(deps.fetch)
    if (!alive()) return { ...base, snapshot, stale: true }
    if (!canDispatch(d.tool, snapshot.tools, snapshot.auto)) {
      return {
        ...base,
        snapshot,
        message: action === 'retry'
          ? t('{tool} 現在不是確認可以執行的狀態，沒有重派。', { tool: d.tool })
          : t('{tool} 現在不是確認可以執行的狀態，沒有送出這句話。', { tool: d.tool }),
      }
    }
  }

  // 3. POST 之前的最後一道閘（傳輸層還會再擋一次，且帶當初那把 token 的明確授權）
  if (!alive()) return { ...base, snapshot, stale: true }

  try {
    const res = await deps.fetch(CONTROL_ENDPOINT[action], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'followup' ? { id: d.id, text } : { id: d.id }),
    })
    const raw = await res.json().catch(() => null) as unknown
    const data = (raw && typeof raw === 'object' && !Array.isArray(raw))
      ? raw as Record<string, unknown>
      : {}
    // 晚回的回應不能拿去改新配對的畫面狀態
    if (!alive()) return { posted: true, ok: false, stale: true, message: '', snapshot }
    if (!(res.ok && data.ok === true)) {
      return { posted: true, ok: false, stale: false, snapshot, message: publicText(data.error) || CONTROL_FAIL[action]() }
    }
    return { posted: true, ok: true, stale: false, snapshot, message: publicText(data.note) }
  } catch (error) {
    if (isStalePairingError(error)) return { ...base, snapshot, stale: true }
    return { posted: true, ok: false, stale: false, snapshot, message: CONTROL_FAIL[action]() }
  }
}

export default function MobileApp({
  initialToken,
  initialPaired,
  initialDispatches,
  initialTools,
  initialAuto = null,
}: MobileAppProps) {
  // 保存的 token 與 QR 都先驗證，避免無效憑證觸發多路未授權請求。
  const [paired, setPaired] = useState(initialPaired === true)
  const startupToken = useRef<string | null>(null)
  const pairingAttempt = useRef(0)

  // 配對頁面之 token 輸入與連線中狀態
  const [tokenInput, setTokenInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [pairError, setPairError] = useState('')

  // 連線健康與輪詢狀態
  const [connected, setConnected] = useState(initialPaired === true)

  // 快速派工表單狀態。工具就緒度唯一來源是 /api/dispatch/tools。
  const [readiness, setReadiness] = useState<ReadinessSnapshot>(
    () => readinessFromProps(initialTools, initialAuto),
  )
  const [readinessLoading, setReadinessLoading] = useState<boolean>(false)
  const [selectedTool, setSelectedTool] = useState<string>('auto')
  const [taskDraft, setTaskDraft] = useState<string>('')
  const [dispatching, setDispatching] = useState<boolean>(false)
  const [dispatchNotice, setDispatchNotice] = useState<{ message: string; ok: boolean } | null>(null)
  /** 同步的送出鎖：setState 是非同步的，擋不住連點兩下變成兩次真的派工 */
  const dispatchLock = useRef(false)
  const mountedRef = useRef(true)
  /** 卸載或配對改變後，先前發出的複查結果一律作廢，不會拿舊情境去 POST */
  const isCurrent = (epoch: number) => mountedRef.current && epoch === pairingAttempt.current
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ── 工單綁定：每一件會改到後端狀態的操作，開頭就把 token 與代次一起釘住 ──
  /** 工單起手式；沒有 token（沒配對或被清掉）時 intentAlive 會直接是 false */
  const beginIntent = (): PairingSnapshot => capturePairing(pairingAttempt.current)
  /** 每個非同步邊界都要重問：同一個掛載、同一代配對、而且還是同一把 token */
  const intentAlive = (intent: PairingSnapshot): boolean =>
    isCurrent(intent.epoch) && isPairingIntact(intent, pairingAttempt.current)
  /** 這件工單專屬的傳輸：明確帶當初那把 token，不會重讀較新的 token 來授權舊意圖 */
  const intentFetch = (intent: PairingSnapshot): typeof fetch =>
    createSnapshotFetch(intent, { fetch, isCurrent: () => intentAlive(intent) })

  // 派工清單與展開之日誌紀錄
  const [dispatches, setDispatches] = useState<ConsoleDispatch[]>(initialDispatches ?? [])
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null)
  const [logTextMap, setLogTextMap] = useState<Record<string, string>>({})
  const [logLoadingMap, setLogLoadingMap] = useState<Record<string, boolean>>({})

  // 補一句（Followup）展開列與輸入內容
  const [replyingId, setReplyingId] = useState<string | null>(null)
  const [replyText, setReplyTextState] = useState<string>('')
  const [replySending, setReplySending] = useState<boolean>(false)
  /** 送出期間使用者可能又打了新的字：用 ref 記住當下值，成功時才知道該不該清空 */
  const replyTextRef = useRef('')
  const setReplyText = useCallback((value: string) => {
    replyTextRef.current = value
    setReplyTextState(value)
  }, [])

  // 抓取派工清單與更新連線狀態
  const pullDispatches = useCallback(async () => {
    try {
      const res = await fetch('/api/dispatches')
      if (res.status === 401) return
      if (!res.ok) {
        setConnected(false)
        return
      }
      const data = await res.json()
      if (data && Array.isArray(data.dispatches)) {
        setDispatches(data.dispatches)
        setConnected(true)
      }
    } catch {
      setConnected(false)
    }
  }, [])

  // 重新檢查工具狀態。讀不到就換成空快照 —— 留著舊的等於對使用者宣稱那些工具還能用。
  const pullTools = useCallback(async () => {
    const epoch = pairingAttempt.current
    setReadinessLoading(true)
    const snapshot = await fetchReadiness(fetch)
    if (!mountedRef.current || epoch !== pairingAttempt.current) return
    setReadiness(snapshot)
    setReadinessLoading(false)
  }, [])

  // 初始化安裝 fetch 攔截器、解析 hash、註冊 PWA 與排程輪詢
  useEffect(() => {
    installRemoteFetch()
    let cancelled = false
    if (startupToken.current === null) {
      startupToken.current = tokenFromHash() ?? initialToken ?? getRemoteToken()
    }
    const validateCandidate = (candidate: string) => {
      const attempt = ++pairingAttempt.current
      validateRemoteToken(candidate).then(() => {
        if (cancelled || attempt !== pairingAttempt.current) return
        setRemoteToken(candidate)
        setPaired(true)
        setPairError('')
      }).catch((error: unknown) => {
        if (!cancelled && attempt === pairingAttempt.current) {
          setPaired(false)
          setPairError(error instanceof Error && error.message
            ? error.message : t('連線失敗，請檢查 Token 或主機狀態'))
        }
      })
    }
    const candidate = startupToken.current.trim()
    if (candidate && initialPaired !== true) validateCandidate(candidate)

    // 已開啟的手機頁再點新的配對連結只會改 hash，不會重新掛載元件。
    const handlePairingLink = () => {
      const nextToken = tokenFromHash()?.trim()
      if (!nextToken) return
      startupToken.current = nextToken
      setPaired(false)
      setConnected(false)
      setPairError('')
      // 換了一份配對就換了一台主機：舊的工具狀態與 auto 一律作廢
      setReadiness(EMPTY_READINESS)
      validateCandidate(nextToken)
    }

    // 註冊 Service Worker，支援離線快取
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/m/sw.js').catch(() => {
        // 註冊失敗不拋錯，不影響使用者操作核心派工功能
      })
    }

    // 動態在 head 補上 PWA 所需之 manifest 與 theme-color
    if (typeof document !== 'undefined' && document.head) {
      if (!document.head.querySelector('link[rel="manifest"]')) {
        const link = document.createElement('link')
        link.rel = 'manifest'
        link.href = '/m/manifest.webmanifest'
        document.head.appendChild(link)
      }
      if (!document.head.querySelector('meta[name="theme-color"]')) {
        const meta = document.createElement('meta')
        meta.name = 'theme-color'
        meta.content = '#18181b'
        document.head.appendChild(meta)
      }
    }

    // 監聽 401 未授權自訂事件
    const handleUnauthorized = () => {
      // 授權沒了：進行中的複查作廢，工具狀態與 auto 一起清掉
      pairingAttempt.current += 1
      clearRemoteToken()
      setPaired(false)
      setConnected(false)
      setReadiness(EMPTY_READINESS)
      setPairError(t('配對已失效，請重新掃 QR 或輸入新的 Token'))
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('ac_remote_unauthorized', handleUnauthorized)
      window.addEventListener('hashchange', handlePairingLink)
    }

    return () => {
      cancelled = true
      if (typeof window !== 'undefined') {
        window.removeEventListener('ac_remote_unauthorized', handleUnauthorized)
        window.removeEventListener('hashchange', handlePairingLink)
      }
    }
  }, [initialPaired, initialToken])

  // 當處於已配對狀態時，每 8 秒輪詢一次派工與連線狀態
  useEffect(() => {
    if (!paired) return

    void pullDispatches()
    void pullTools()

    const timer = setInterval(() => {
      void pullDispatches()
    }, 8000)

    return () => clearInterval(timer)
  }, [paired, pullDispatches, pullTools])

  // 配對連線處理
  const handleConnect = async () => {
    const candidate = tokenInput.trim()
    if (!candidate || connecting) return
    const attempt = ++pairingAttempt.current
    setConnecting(true)
    setPairError('')

    try {
      await validateRemoteToken(candidate)
      if (attempt !== pairingAttempt.current) return
      setRemoteToken(candidate)
      setPaired(true)
      setTokenInput('')
    } catch (error) {
      if (attempt === pairingAttempt.current) {
        setPairError(error instanceof Error && error.message
          ? error.message : t('連線失敗，請檢查 Token 或主機狀態'))
      }
    } finally {
      setConnecting(false)
    }
  }

  // 解除配對並清除 Token
  const handleUnpair = () => {
    if (window.confirm(t('確定要解除配對並清除 Token 嗎？'))) {
      pairingAttempt.current += 1
      clearRemoteToken()
      setPaired(false)
      setConnected(false)
      setPairError('')
      setReadiness(EMPTY_READINESS)
      setExpandedLogId(null)
      setLogTextMap({})
    }
  }

  // 快速派工送出。按鈕會灰掉，但擋門一定要在這裡也做一次 —— 灰掉的按鈕擋不住程式呼叫。
  const handleDispatch = async () => {
    const submitted = taskDraft
    if (!submitted.trim() || dispatching || dispatchLock.current) return
    if (!canDispatch(selectedTool, readiness.tools, readiness.auto)) {
      setDispatchNotice({ message: t('這些 AI 現在不是確認可以執行的狀態，沒有送出任何工作。'), ok: false })
      return
    }
    // 這一件從頭到尾綁死同一份配對（token + 代次）；沒有 token 就地失敗，不會送出
    const intent = beginIntent()
    if (!intentAlive(intent)) {
      setDispatchNotice({ message: STALE_PAIRING_NOTE(), ok: false })
      return
    }
    dispatchLock.current = true
    setDispatching(true)
    setDispatchNotice(null)

    try {
      const result = await attemptDispatch(selectedTool, submitted, {
        fetch: intentFetch(intent),
        confirm: (message) => (typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(message)
          : true),
        isCurrent: () => intentAlive(intent),
      })
      if (!mountedRef.current) return
      if (result.stale) {
        // 沒送出：草稿留著，也不要拿舊工單的結果去動新配對的狀態
        if (isCurrent(intent.epoch)) setDispatchNotice({ message: STALE_PAIRING_NOTE(), ok: false })
        return
      }
      if (!intentAlive(intent)) return
      setReadiness(result.snapshot)
      if (result.message) setDispatchNotice({ message: publicText(result.message), ok: result.ok })
      // 送出去了就重讀清單：即使這支手機沒拿到可讀回答，那筆紀錄仍該看得到
      if (result.posted) void pullDispatches()
      if (result.ok) {
        // 只清掉「送出的就是現在框裡這一份」的情況；等待期間新打的字不能被吃掉
        setTaskDraft((current) => (current === submitted ? '' : current))
      }
    } finally {
      dispatchLock.current = false
      if (mountedRef.current) setDispatching(false)
    }
  }

  /**
   * 停止／取消／重派／補一句共用的一條路：綁定同一份配對快照，
   * 用這件工單專屬的傳輸送出，晚回的回應一律不准動到新配對的畫面狀態。
   */
  const runControl = async (
    action: ControlAction,
    d: ConsoleDispatch,
    extra?: { text?: string; live?: boolean },
  ): Promise<ControlAttempt | null> => {
    const intent = beginIntent()
    if (!intentAlive(intent)) {
      setDispatchNotice({ message: STALE_PAIRING_NOTE(), ok: false })
      return null
    }
    const result = await attemptControl(action, d, {
      fetch: intentFetch(intent),
      confirm: (message) => (typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(message)
        : true),
      isCurrent: () => intentAlive(intent),
      ...extra,
    })
    if (!mountedRef.current) return result
    if (result.stale) {
      if (isCurrent(intent.epoch)) setDispatchNotice({ message: STALE_PAIRING_NOTE(), ok: false })
      return result
    }
    if (!intentAlive(intent)) return result
    if (result.snapshot) setReadiness(result.snapshot)
    if (result.message) setDispatchNotice({ message: publicText(result.message), ok: result.ok })
    if (result.ok) void pullDispatches()
    return result
  }

  // 停止正在執行的派工（不看 AI 就緒度：讀不到工具狀態不代表不能喊停）
  const handleStop = async (d: ConsoleDispatch) => {
    await runControl('stop', d)
  }

  // 取消尚未被啟動的等待派工（同樣不看就緒度，只看配對）
  const handleCancel = async (d: ConsoleDispatch) => {
    await runControl('cancel', d)
  }

  // 重新派發工作。重派的是「這一筆原本那個工具」，所以複查對象也是它。
  const handleRetry = async (d: ConsoleDispatch) => {
    if (dispatchLock.current) return
    dispatchLock.current = true
    try {
      await runControl('retry', d)
    } finally {
      dispatchLock.current = false
    }
  }

  /**
   * 送出補一句（Followup）。
   *
   * 本機問答不能走這裡：那是一次性的地端回答，沒有可續談的後端工作，
   * 後端會用 409 擋下 —— 這是刻意的，免得一句補話把「只回答」升級成雲端／檔案操作。
   * 被擋下時使用者打的字原封不動留著。
   */
  const handleSendFollowup = async (d: ConsoleDispatch) => {
    const submitted = replyText
    const text = submitted.trim()
    if (!text || replySending || dispatchLock.current) return
    if (isLocalAnswerRecord(d)) {
      setDispatchNotice({ message: LOCAL_FOLLOWUP_NOTE(), ok: false })
      return
    }
    const live = isLive(d)
    dispatchLock.current = true
    setReplySending(true)
    try {
      // 還在跑的是排進後端已接受的那份工作（佇列後端管），就緒度讀不到也不擋；
      // 已結束的等於再派一次，那才要先複查。
      const result = await runControl('followup', d, { text, live })
      if (result?.ok && mountedRef.current) {
        // 只清掉「送出的就是框裡那一句」；等待期間新打的字要留著
        if (replyTextRef.current === submitted) {
          setReplyText('')
          setReplyingId(null)
        }
        if (live && !result.message) {
          setDispatchNotice({ message: FOLLOWUP_QUEUE_NOTE(), ok: true })
        }
      }
    } finally {
      dispatchLock.current = false
      if (mountedRef.current) setReplySending(false)
    }
  }

  // 每次展開重新讀取；保持展開時與清單同步輪詢，關閉即取消讀取。
  const toggleLog = (id: string) => {
    if (expandedLogId === id) {
      setExpandedLogId(null)
      return
    }
    setExpandedLogId(id)
    setLogLoadingMap((prev) => ({ ...prev, [id]: true }))
  }

  useEffect(() => {
    if (!paired || !expandedLogId) return
    const id = expandedLogId
    const controller = new AbortController()
    let inFlight = false
    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const res = await fetch(`/api/dispatch/log?id=${encodeURIComponent(id)}`, { signal: controller.signal })
        const data = await res.json()
        if (controller.signal.aborted) return
        if (res.ok && data?.ok && typeof data.text === 'string') {
          // 僅保留最後 3000 字元以節省手機端渲染記憶體
          const trimmed = data.text.length > 3000 ? data.text.slice(-3000) : data.text
          setLogTextMap((prev) => ({ ...prev, [id]: trimmed }))
        } else {
          setLogTextMap((prev) => ({
            ...prev,
            [id]: publicText(data?.error) || t('日誌讀取失敗，稍後會自動重試'),
          }))
        }
      } catch {
        if (!controller.signal.aborted) {
          setLogTextMap((prev) => ({ ...prev, [id]: t('日誌讀取失敗，稍後會自動重試') }))
        }
      } finally {
        inFlight = false
        if (!controller.signal.aborted) setLogLoadingMap((prev) => ({ ...prev, [id]: false }))
      }
    }
    void load()
    const timer = setInterval(() => void load(), 8000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [expandedLogId, paired])

  /** 明確可以執行工作的工具；一個都沒有就不給送出，也不假裝有 */
  const hasExecutor = readiness.ok
    && readiness.tools.some((row) => canDispatch(row.id, readiness.tools, readiness.auto))
  const canSend = canDispatch(selectedTool, readiness.tools, readiness.auto)

  // ─────────────────────────────────────────────────────────────
  // 配對畫面（當未帶 Token 或 Token 錯誤 401 時顯示）
  // ─────────────────────────────────────────────────────────────
  if (!paired) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center bg-app px-4 text-ink font-sans"
        style={{
          paddingTop: 'env(safe-area-inset-top, 0px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          paddingLeft: 'env(safe-area-inset-left, 0px)',
          paddingRight: 'env(safe-area-inset-right, 0px)',
        }}
      >
        <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6 shadow-sm">
          <h2 className="mb-2 text-base font-bold text-ink">
            📱 {t('AI 控制台 遙控')}
          </h2>
          <p className="mb-5 text-xs leading-relaxed text-mute">
            {t('用桌面版的「📱 手機遙控」掃 QR 會自動配對')}
          </p>

          <div className="space-y-3">
            <label htmlFor="remote-token-input" className="sr-only">
              {t('請輸入存取權限 Token')}
            </label>
            <input
              id="remote-token-input"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={t('請輸入存取權限 Token')}
              className="min-h-[44px] w-full rounded-lg border border-line bg-app px-3.5 text-sm text-ink outline-none placeholder:text-mute3 focus-visible:border-line3"
            />

            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting || !tokenInput.trim()}
              className="min-h-[44px] w-full rounded-lg bg-ink px-4 py-2 text-sm font-medium text-invink hover:bg-ink2 disabled:opacity-40"
            >
              {connecting ? t('連線中…') : t('連線')}
            </button>

            {pairError && (
              <div role="alert" className="text-xs text-red-700 dark:text-red-300">
                {pairError}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────
  // 遙控主畫面（手機直式、單欄、留安全邊距）
  // ─────────────────────────────────────────────────────────────
  return (
    <div
      className="flex min-h-screen flex-col bg-app text-ink font-sans"
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col space-y-4 p-4">
        {/* 1. 頂部列：標題、連線狀態指示與解除配對按鈕 */}
        <header className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-ink">
              {t('AI 控制台 遙控')}
            </h1>
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                connected ? 'bg-emerald-500' : 'bg-red-500'
              }`}
              title={connected ? t('連線正常') : t('連不上主機')}
              aria-label={connected ? t('連線正常') : t('連不上主機')}
            />
          </div>

          <div className="flex items-center gap-2">
            {!connected && (
              <span className="text-xs font-medium text-red-700 dark:text-red-300">
                {t('連不上主機')}
              </span>
            )}
            <button
              type="button"
              onClick={handleUnpair}
              className="min-h-[44px] rounded px-2.5 text-xs text-mute3 hover:text-ink2"
            >
              {t('解除配對')}
            </button>
          </div>
        </header>

        {/* 2. 額度狀態列：掛載既有 QuotaStrip 元件（精簡版 compact） */}
        <section aria-label={t('額度與今日用量')}>
          <QuotaStrip compact />
        </section>

        {/* 3. 快速派工面板 */}
        <section className="rounded-xl border border-line bg-panel p-3.5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-mute">
              ⚡ {t('交給 AI 執行')}
            </h2>
            <button
              type="button"
              onClick={() => void pullTools()}
              disabled={readinessLoading}
              className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs text-mute hover:text-ink2 disabled:opacity-40"
            >
              {readinessLoading ? t('檢查中…') : t('重新檢查')}
            </button>
          </div>

          {/* 沒有確認可執行的 AI：手機上設定不了，唯一誠實的出口是回電腦處理 */}
          {!hasExecutor && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <span>
                {readinessLoading
                  ? t('正在確認哪些 AI 可以執行工作…')
                  : t('目前沒有確認可以執行工作的 AI，不會送出任何工作。請先在電腦上完成 AI 設定，再回這裡按「重新檢查」。你打好的內容會留著。')}
              </span>
              {!readinessLoading && readiness.reason && (
                <span className="ml-1 text-mute2">{readiness.reason}</span>
              )}
            </div>
          )}

          {/* 工具下拉選單：全部列出來（看得到才知道為什麼不能選），不能派的一律停用 */}
          <div>
            <label htmlFor="mobile-dispatch-tool" className="sr-only">
              {t('派給哪個工具')}
            </label>
            <select
              id="mobile-dispatch-tool"
              value={selectedTool}
              onChange={(e) => setSelectedTool(e.target.value)}
              className="min-h-[44px] w-full rounded-lg border border-line bg-app px-3 text-xs text-ink2 outline-none focus-visible:border-line3"
            >
              <option value="auto" disabled={!readiness.auto}>
                {readiness.auto
                  ? t('自動選擇（目前是 {id}）', { id: readiness.auto })
                  : t('自動選擇（目前沒有可自動派工的工具）')}
              </option>
              {readiness.tools.map((x) => (
                <option
                  key={x.id}
                  value={x.id}
                  disabled={!canDispatch(x.id, readiness.tools, readiness.auto)}
                >
                  {toolOptionText(x, readiness.tools)}
                </option>
              ))}
            </select>
          </div>

          {/* 任務內容文字區域 */}
          <div>
            <textarea
              value={taskDraft}
              onChange={(e) => setTaskDraft(e.target.value)}
              placeholder={t('要 AI 完成什麼？')}
              rows={3}
              className="w-full rounded-lg border border-line bg-app p-3 text-sm text-ink outline-none placeholder:text-mute3 focus-visible:border-line3"
            />
          </div>

          {/* 送出按鈕：可派工資格由共用判讀決定，handleDispatch 裡還會再擋一次 */}
          <button
            type="button"
            onClick={handleDispatch}
            disabled={dispatching || !taskDraft.trim() || !canSend}
            title={canSend
              ? undefined
              : t('還沒有確認可以執行工作的 AI；請先在電腦上完成設定，再按「重新檢查」')}
            className="min-h-[44px] w-full rounded-lg bg-ink px-4 py-2 text-sm font-medium text-invink hover:bg-ink2 disabled:opacity-40"
          >
            {dispatching ? t('派工中…') : t('派出去')}
          </button>

          {/* 派工結果提示 */}
          {dispatchNotice && (
            <div
              role="status"
              aria-live="polite"
              className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${
                dispatchNotice.ok
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-red-700 dark:text-red-300'
              }`}
            >
              {publicText(dispatchNotice.message)}
            </div>
          )}
        </section>

        {/* 4. 派工清單（每 8 秒定時刷新） */}
        <section className="flex-1 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-mute">
              📋 {t('派工清單')}
            </h2>
            <span className="text-xs text-mute3">
              {dispatches.length}
            </span>
          </div>

          {dispatches.length === 0 ? (
            <div className="rounded-xl border border-line bg-panel p-6 text-center text-xs text-mute3">
              {t('目前沒有任何派工紀錄')}
            </div>
          ) : (
            <div className="space-y-3">
              {dispatches.map((d) => {
                const s = stateOf(d)
                const st = look(s)
                const live = isLive(d)
                const isRunning = live && s === 'running'
                const isWaiting = s === 'waiting'
                const isHeadless = d.mode !== 'terminal'
                const localAnswer = isLocalAnswerRecord(d)
                const canRetry =
                  d.outcome === 'error' ||
                  d.outcome === 'no_changes' ||
                  d.outcome === 'stopped' ||
                  s === 'stopped' ||
                  s === 'failed'
                // 還在跑的 CLI 也給補一句（後端會排隊，這一輪跑完再檢查）；
                // 本機問答沒有可續談的後端工作，補話會被 409 擋下 —— 不要給那顆按鈕
                const canFollowup = canFollowupRecord(d)
                const queuedFollowup = canFollowup && live
                const isLogOpen = expandedLogId === d.id

                return (
                  <div
                    key={d.id}
                    className="flex flex-col rounded-xl border border-line bg-panel p-3.5 space-y-2 text-ink2"
                  >
                    {/* 頂部資訊列：工具、距今時間、狀態與結果 */}
                    <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-line/60 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-elev px-2 py-0.5 text-xs font-semibold text-ink">
                          {d.tool}
                        </span>
                        <span className="text-[11px] text-mute3">
                          {startedAgo(d.started)}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* 狀態指示 */}
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${st.tone}`}>
                          <span className={`inline-block h-2 w-2 rounded-full ${st.dot}`} />
                          <span>{st.label}</span>
                        </span>

                        {/* outcome 額外標示 */}
                        {d.outcome && (
                          <span className={`text-[11px] font-medium ${outcomeTone(d.outcome)}`}>
                            {outcomeLabel(d.outcome)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 工單內容摘要（前 80 字） */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleLog(d.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          void toggleLog(d.id)
                        }
                      }}
                      className="cursor-pointer text-xs leading-relaxed text-ink hover:text-mute"
                    >
                      {(d.task || '').slice(0, 80)}
                      {(d.task || '').length > 80 ? '…' : ''}
                    </div>

                    {/* 本機問答：講清楚它只回答、沒改檔，也講清楚要接續請回原對話 */}
                    {localAnswer && (
                      <div className="rounded bg-elev px-2 py-1 text-[11px] leading-relaxed text-mute2">
                        {t('本機問答：只回答，沒有改任何檔案')}
                        <span className="ml-1">{LOCAL_FOLLOWUP_NOTE()}</span>
                      </div>
                    )}

                    {/* 即時 tail 行輸出 */}
                    {d.tail && (
                      <div className="truncate rounded bg-app px-2 py-1 font-mono text-[11px] text-mute2">
                        {d.tail}
                      </div>
                    )}

                    {/* 接力徽章 */}
                    {(d.handedOffTo || d.handoffFrom) && (
                      <div className="flex flex-wrap gap-1.5 text-[10px]">
                        {d.handedOffTo && (
                          <span className="rounded bg-elev px-1.5 py-0.5 text-mute2">
                            {t('↪ 已自動接力給 {to}', { to: d.handedOffTo })}
                          </span>
                        )}
                        {d.handoffFrom && (
                          <span className="rounded bg-elev px-1.5 py-0.5 text-mute2">
                            {t('↩ 從 {from} 接力而來', { from: d.handoffFrom })}
                          </span>
                        )}
                      </div>
                    )}

                    {/* 動作按鈕群組：每個按鈕皆確保 min-h-[44px] */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {/* 執行中且非終端模式：提供停止功能 */}
                      {isRunning && isHeadless && (
                        <button
                          type="button"
                          onClick={() => handleStop(d)}
                          className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs font-medium text-ink2 hover:bg-elev2"
                        >
                          {t('⏹ 停止')}
                        </button>
                      )}

                      {/* waiting 狀態：提供取消功能 */}
                      {isWaiting && (
                        <button
                          type="button"
                          onClick={() => handleCancel(d)}
                          className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs font-medium text-ink2 hover:bg-elev2"
                        >
                          {t('✕ 取消')}
                        </button>
                      )}

                      {/* 失敗、已停止或無改動：提供重派功能 */}
                      {canRetry && (
                        <button
                          type="button"
                          onClick={() => handleRetry(d)}
                          className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs font-medium text-ink2 hover:bg-elev2"
                        >
                          {t('↻ 重派')}
                        </button>
                      )}

                      {/* 無頭工作都能補一句；還在跑的講清楚是「這一輪完成後才送出」 */}
                      {canFollowup && (
                        <button
                          type="button"
                          onClick={() => {
                            if (replyingId === d.id) {
                              setReplyingId(null)
                            } else {
                              setReplyingId(d.id)
                              setReplyText('')
                            }
                          }}
                          title={queuedFollowup ? FOLLOWUP_QUEUE_NOTE() : undefined}
                          className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs font-medium text-ink2 hover:bg-elev2"
                        >
                          {queuedFollowup ? t('💬 補一句（這輪完成後送出）') : t('💬 補一句')}
                        </button>
                      )}

                      {/* 查看日誌開關 */}
                      <button
                        type="button"
                        onClick={() => toggleLog(d.id)}
                        className="min-h-[44px] ml-auto rounded-lg border border-line bg-elev px-3 text-xs text-mute hover:bg-elev2 hover:text-ink2"
                      >
                        {isLogOpen ? t('收合日誌') : t('查看日誌')}
                      </button>
                    </div>

                    {/* 展開之「補一句」輸入區 */}
                    {replyingId === d.id && (
                      <div className="mt-2 space-y-2 rounded-lg border border-line2 bg-app p-2.5">
                        <textarea
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder={t('補話內容…')}
                          rows={2}
                          className="w-full rounded border border-line bg-panel p-2 text-xs text-ink outline-none placeholder:text-mute3"
                        />
                        {/* 排隊送出的說明：這一輪跑完才送，屆時後端會自己再檢查一次 */}
                        {queuedFollowup && (
                          <p className="text-[11px] leading-relaxed text-mute2">
                            {FOLLOWUP_QUEUE_NOTE()}
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleSendFollowup(d)}
                          disabled={replySending || !replyText.trim() || isLocalAnswerRecord(d)}
                          className="min-h-[44px] w-full rounded bg-ink px-3 py-1.5 text-xs font-medium text-invink hover:bg-ink2 disabled:opacity-40"
                        >
                          {replySending ? t('送出中…') : (queuedFollowup ? t('排隊送出') : t('送出'))}
                        </button>
                      </div>
                    )}

                    {/* 展開之日誌顯示區塊（最後 3000 字元、等寬字、可捲動） */}
                    {isLogOpen && (
                      <div className="mt-2">
                        <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-app p-2.5 font-mono text-[11px] text-ink3">
                          {logLoadingMap[d.id]
                            ? t('日誌載入中…')
                            : logTextMap[d.id] || t('（還沒有輸出）')}
                        </pre>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
