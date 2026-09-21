/* eslint-disable react-refresh/only-export-components -- transport helpers have focused node tests */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import QuotaStrip from '@/components/QuotaStrip'
import {
  canDispatch,
  parseDispatchReadiness,
  toolReadinessLabel,
  type ReadinessSnapshot,
  type ReadinessTool,
} from '@/lib/aiReadiness'
import {
  buildDevSpaceConversationPrompt,
  copyThenOpenDevSpace,
  createDevSpaceDraft,
  DEVSPACE_MODELS,
  prepareDevSpaceConversationDraft,
  readDevSpaceModel,
  saveDevSpaceModel,
  type DevSpaceConversationPreparation,
  type DevSpaceModel,
} from '@/lib/devspace'
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
  issue?: string
  handedOffTo?: string
  handoffFrom?: string
}

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
  initialAuto?: string | null
}

function startedAgo(stamp: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(stamp || '')
  if (!match) return ''
  const [, y, mo, d, h, mi, se] = match
  const then = new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime()
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return t('剛剛')
  if (seconds < 3600) return t('{n} 分前', { n: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('{n} 小時前', { n: Math.floor(seconds / 3600) })
  return t('{n} 天前', { n: Math.floor(seconds / 86400) })
}

function outcomeLabel(outcome: string): string {
  return ({
    ok: t('已完成'),
    no_changes: t('跑完了但沒有改到任何檔案'),
    blocked: t('依規範停下（沒有執行）'),
    stopped: t('被停止（沒有跑完）'),
    error: t('執行失敗'),
  } as Record<string, string>)[outcome] || outcome
}

function outcomeTone(outcome: string): string {
  if (outcome === 'ok') return 'text-emerald-700 dark:text-emerald-300'
  if (outcome === 'error') return 'text-red-700 dark:text-red-300'
  if (outcome === 'blocked') return 'text-sky-700 dark:text-sky-300'
  return 'text-amber-700 dark:text-amber-300'
}

export const EMPTY_READINESS: ReadinessSnapshot = { ok: false, tools: [], auto: null, ready: false, reason: '' }

export function readinessFromProps(tools?: readonly DispatchTool[], auto?: string | null): ReadinessSnapshot {
  if (!Array.isArray(tools) || !tools.length) return EMPTY_READINESS
  return parseDispatchReadiness({ ok: true, tools, auto: typeof auto === 'string' ? auto : '' })
}

export function isAnswerOnlyTool(id: string, tools: readonly ReadinessTool[]): boolean {
  const row = Array.isArray(tools) ? tools.find(item => item?.id === id) : undefined
  if (row && typeof row.mode === 'string') return row.mode === 'local'
  return id === 'local'
}

export function isLocalAnswerRecord(record: { tool?: string; mode?: string } | null | undefined): boolean {
  return !!record && (record.tool === 'local' || record.mode === 'sync')
}

export const LOCAL_FOLLOWUP_NOTE = () =>
  t('本機問答請回原對話接續（這筆只回答、沒有可續談的工作）')

export const STALE_PAIRING_NOTE = () =>
  t('配對已變更，已保留你的文字；請重新確認目前連線。')

export const FOLLOWUP_QUEUE_NOTE = () =>
  t('舊版排隊補話已停用；請改在 ChatGPT「對話」使用 DevSpace MCP 接續。')

export function canFollowupRecord(record: { mode?: string; tool?: string } | null | undefined): boolean {
  return !!record && record.mode !== 'terminal' && !isLocalAnswerRecord(record)
}

export function publicText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function localAnswerText(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  const body = data as Record<string, unknown>
  return publicText(body.reply) || publicText(body.answer) || publicText(body.text)
}

function toolReasonText(tool: ReadinessTool): string {
  const reason = publicText(tool.reason)
  if (reason) return t(reason)
  return tool.limited === true ? t('額度狀態無法確認') : ''
}

export function toolOptionText(tool: ReadinessTool, tools: readonly ReadinessTool[]): string {
  const id = publicText(tool.id)
  const label = t(publicText(tool.label)) || id
  const head = isAnswerOnlyTool(id, tools) ? `${label}【${t('只回答，不改檔')}】` : label
  const status = t(toolReadinessLabel(tool))
  const reason = canDispatch(id, tools, null) ? '' : toolReasonText(tool)
  return `${head}（${reason ? `${status}：${reason}` : status}）`
}

export async function fetchReadiness(doFetch: typeof fetch): Promise<ReadinessSnapshot> {
  try {
    const response = await doFetch('/api/dispatch/tools')
    if (!response.ok) return EMPTY_READINESS
    return parseDispatchReadiness(await response.json())
  } catch { return EMPTY_READINESS }
}

export interface DispatchDeps {
  fetch: typeof fetch
  confirm?: (message: string) => boolean
  isCurrent?: () => boolean
}

export interface DispatchAttempt {
  posted: boolean
  ok: boolean
  tool: string
  message: string
  answerOnly: boolean
  snapshot: ReadinessSnapshot
  stale: boolean
}

/** Legacy helper now fails closed without reading readiness or posting a job. */
export async function attemptDispatch(
  _requested: string,
  task: string,
  deps: DispatchDeps,
): Promise<DispatchAttempt> {
  const stale = !!deps.isCurrent && !deps.isCurrent()
  return {
    posted: false,
    ok: false,
    tool: '',
    answerOnly: false,
    snapshot: EMPTY_READINESS,
    stale,
    message: task.trim() && !stale
      ? t('手機端不再建立 CLI 工單；請準備 ChatGPT「對話」＋ DevSpace MCP 指示。')
      : '',
  }
}

export type ControlAction = 'stop' | 'cancel' | 'retry' | 'followup'
export interface ControlDeps extends DispatchDeps { text?: string; live?: boolean }
export interface ControlAttempt {
  posted: boolean
  ok: boolean
  stale: boolean
  message: string
  snapshot: ReadinessSnapshot | null
}

/** Only stopping/cancelling an already-existing legacy job may mutate server state. */
export async function attemptControl(
  action: ControlAction,
  record: ConsoleDispatch,
  deps: ControlDeps,
): Promise<ControlAttempt> {
  const base: ControlAttempt = { posted: false, ok: false, stale: false, message: '', snapshot: null }
  const alive = () => !deps.isCurrent || deps.isCurrent()
  if (!alive()) return { ...base, stale: true }
  if (action === 'retry' || action === 'followup') {
    return {
      ...base,
      message: t('這個動作已改用 ChatGPT「對話」＋ DevSpace MCP；沒有送出舊派工請求。'),
    }
  }
  if (action === 'stop' && deps.confirm && !deps.confirm(t('確定要停止這件舊派工嗎？'))) return base
  if (!alive()) return { ...base, stale: true }
  try {
    const response = await deps.fetch(`/api/dispatch/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: record.id }),
    })
    const data = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!alive()) return { posted: true, ok: false, stale: true, message: '', snapshot: null }
    const ok = response.ok && data?.ok === true
    return {
      posted: true,
      ok,
      stale: false,
      snapshot: null,
      message: ok ? publicText(data?.note) : publicText(data?.error) || t(action === 'stop' ? '停止失敗' : '取消失敗'),
    }
  } catch (error) {
    if (isStalePairingError(error)) return { ...base, stale: true }
    return { posted: true, ok: false, stale: false, snapshot: null, message: t(action === 'stop' ? '停止失敗' : '取消失敗') }
  }
}

async function openChatGPTWindow(): Promise<void> {
  const opened = window.open('https://chatgpt.com/', '_blank')
  if (!opened) throw new Error(t('瀏覽器未開啟 ChatGPT 新分頁，請手動開啟 chatgpt.com。'))
  try { opened.opener = null } catch { /* cross-origin */ }
}

export default function MobileApp({ initialToken, initialPaired, initialDispatches }: MobileAppProps) {
  const [paired, setPaired] = useState(initialPaired === true)
  const startupToken = useRef<string | null>(null)
  const pairingAttempt = useRef(0)
  const [tokenInput, setTokenInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [pairError, setPairError] = useState('')
  const [connected, setConnected] = useState(initialPaired === true)
  const [dispatches, setDispatches] = useState<ConsoleDispatch[]>(initialDispatches || [])
  const [projectDraft, setProjectDraft] = useState('')
  const [taskDraft, setTaskDraft] = useState('')
  const [model, setModel] = useState<DevSpaceModel>(readDevSpaceModel)
  const [notice, setNotice] = useState<{ message: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState('')
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null)
  const [logTextMap, setLogTextMap] = useState<Record<string, string>>({})
  const [replyingId, setReplyingId] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const mounted = useRef(true)

  const isCurrent = (epoch: number) => mounted.current && epoch === pairingAttempt.current
  const beginIntent = (): PairingSnapshot => capturePairing(pairingAttempt.current)
  const intentAlive = (intent: PairingSnapshot) => isCurrent(intent.epoch) && isPairingIntact(intent, pairingAttempt.current)
  const intentFetch = (intent: PairingSnapshot): typeof fetch => createSnapshotFetch(intent, { fetch, isCurrent: () => intentAlive(intent) })

  const pullDispatches = useCallback(async () => {
    try {
      const response = await fetch('/api/dispatches')
      if (response.status === 401) return
      if (!response.ok) { setConnected(false); return }
      const data = await response.json()
      if (Array.isArray(data?.dispatches)) {
        setDispatches(data.dispatches)
        setConnected(true)
      }
    } catch { setConnected(false) }
  }, [])

  useEffect(() => {
    mounted.current = true
    installRemoteFetch()
    let cancelled = false
    if (startupToken.current === null) startupToken.current = tokenFromHash() ?? initialToken ?? getRemoteToken()

    const validateCandidate = (candidate: string) => {
      const attempt = ++pairingAttempt.current
      validateRemoteToken(candidate).then(() => {
        if (cancelled || attempt !== pairingAttempt.current) return
        setRemoteToken(candidate)
        setPaired(true)
        setConnected(true)
        setPairError('')
      }).catch((error: unknown) => {
        if (!cancelled && attempt === pairingAttempt.current) {
          setPaired(false)
          setConnected(false)
          setPairError(error instanceof Error && error.message ? error.message : t('連線失敗，請檢查 Token 或主機狀態'))
        }
      })
    }

    const candidate = startupToken.current.trim()
    if (candidate && initialPaired !== true) validateCandidate(candidate)
    const handlePairingLink = () => {
      const next = tokenFromHash()?.trim()
      if (!next) return
      startupToken.current = next
      setPaired(false)
      setConnected(false)
      validateCandidate(next)
    }
    const handleUnauthorized = () => {
      pairingAttempt.current += 1
      clearRemoteToken()
      setPaired(false)
      setConnected(false)
      setPairError(t('配對已失效，請重新掃 QR 或輸入新的 Token'))
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/m/sw.js').catch(() => {})
    window.addEventListener('ac_remote_unauthorized', handleUnauthorized)
    window.addEventListener('hashchange', handlePairingLink)
    return () => {
      cancelled = true
      mounted.current = false
      window.removeEventListener('ac_remote_unauthorized', handleUnauthorized)
      window.removeEventListener('hashchange', handlePairingLink)
    }
  }, [initialPaired, initialToken])

  useEffect(() => {
    if (!paired) return
    void pullDispatches()
    const timer = setInterval(() => void pullDispatches(), 8000)
    return () => clearInterval(timer)
  }, [paired, pullDispatches])

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
      setConnected(true)
      setTokenInput('')
    } catch (error) {
      if (attempt === pairingAttempt.current) setPairError(error instanceof Error ? error.message : t('連線失敗，請檢查 Token 或主機狀態'))
    } finally { setConnecting(false) }
  }

  const handleUnpair = () => {
    if (!window.confirm(t('確定要解除配對並清除 Token 嗎？'))) return
    pairingAttempt.current += 1
    clearRemoteToken()
    setPaired(false)
    setConnected(false)
    setPairError('')
  }

  const prepareAndOpen = async (preparation: DevSpaceConversationPreparation) => {
    if (busy) return
    setBusy('prepare')
    setNotice(null)
    const draft = prepareDevSpaceConversationDraft(createDevSpaceDraft(model), preparation)
    const prompt = buildDevSpaceConversationPrompt(draft, t)
    const result = await copyThenOpenDevSpace(
      async () => {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
        await navigator.clipboard.writeText(prompt)
      },
      openChatGPTWindow,
    )
    if (result.ok) setNotice({ ok: true, message: t('指示已複製，ChatGPT 已開啟；請選擇「對話」、加入 DevSpace、確認模型後貼上。尚未送出任何訊息。') })
    else if (result.stage === 'copy') setNotice({ ok: false, message: t('無法使用剪貼簿；請在桌面控制台的 DevSpace 分頁手動複製。ChatGPT 尚未開啟，草稿仍保留。') })
    else setNotice({ ok: false, message: t('指示已複製，但 ChatGPT 未開啟；請手動開啟已登入的 ChatGPT 後貼上。') })
    setBusy('')
  }

  const prepareNew = () => {
    const task = taskDraft.trim()
    if (!task) return
    void prepareAndOpen({ task, ...(projectDraft.trim() ? { workspace: projectDraft.trim() } : {}), title: t('手機控制台的新工作'), source: 'mobile' })
  }

  const prepareRecord = (record: ConsoleDispatch, followup = '') => {
    const extra = followup.trim()
    const task = extra
      ? `請根據舊工作與目前補充繼續處理。\n\n【舊工作】\n${record.task}\n\n【本次補充】\n${extra}`
      : `請重新檢查並完成這項舊工作：\n${record.task}`
    void prepareAndOpen({
      task,
      ...(record.cwd || projectDraft.trim() ? { workspace: record.cwd || projectDraft.trim() } : {}),
      title: `舊派工 ${record.id}`,
      originalTool: record.tool,
      source: extra ? 'legacy-followup' : 'legacy-retry',
      context: [
        ...(record.result ? [{ role: 'assistant', text: record.result, label: '舊派工結果' }] : []),
        ...(record.tail ? [{ role: 'assistant', text: record.tail, label: '舊派工最後輸出' }] : []),
        ...(record.issue ? [{ role: 'assistant', text: record.issue, label: '舊派工問題' }] : []),
      ],
    })
  }

  const runControl = async (action: 'stop' | 'cancel', record: ConsoleDispatch) => {
    const intent = beginIntent()
    if (!intentAlive(intent)) { setNotice({ ok: false, message: STALE_PAIRING_NOTE() }); return }
    setBusy(`${action}:${record.id}`)
    const result = await attemptControl(action, record, {
      fetch: intentFetch(intent),
      isCurrent: () => intentAlive(intent),
      confirm: message => window.confirm(message),
    })
    if (mounted.current && intentAlive(intent)) {
      setNotice({ ok: result.ok, message: result.message || (result.ok ? t('操作完成') : t('操作未完成')) })
      if (result.ok) void pullDispatches()
      setBusy('')
    }
  }

  const toggleLog = async (id: string) => {
    if (expandedLogId === id) { setExpandedLogId(null); return }
    setExpandedLogId(id)
    if (logTextMap[id] !== undefined) return
    try {
      const response = await fetch(`/api/dispatch/log?id=${encodeURIComponent(id)}`)
      const data = await response.json()
      setLogTextMap(current => ({ ...current, [id]: response.ok && data?.ok ? String(data.text || '').slice(-3000) : publicText(data?.error) || t('日誌讀取失敗') }))
    } catch { setLogTextMap(current => ({ ...current, [id]: t('日誌讀取失敗') })) }
  }

  if (!paired) return (
    <div className="flex min-h-screen items-center justify-center bg-app px-4 text-ink">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6 shadow-sm">
        <h1 className="text-base font-bold">📱 {t('AI 控制台 遙控')}</h1>
        <p className="mb-5 mt-2 text-xs leading-relaxed text-mute">{t('用桌面版的「📱 手機遙控」掃 QR 會自動配對')}</p>
        <input type="password" value={tokenInput} onChange={event => setTokenInput(event.target.value)} placeholder={t('請輸入存取權限 Token')} className="min-h-[44px] w-full rounded-lg border border-line bg-app px-3.5 text-sm" />
        <button type="button" onClick={handleConnect} disabled={connecting || !tokenInput.trim()} className="mt-3 min-h-[44px] w-full rounded-lg bg-ink px-4 py-2 text-sm font-medium text-invink disabled:opacity-40">{connecting ? t('連線中…') : t('連線')}</button>
        {pairError && <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-300">{pairError}</p>}
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-app text-ink">
      <div className="mx-auto flex w-full max-w-lg flex-col space-y-4 p-4">
        <header className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2"><h1 className="text-base font-bold">{t('AI 控制台 遙控')}</h1><span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} aria-label={connected ? t('連線正常') : t('連不上主機')} /></div>
          <button type="button" onClick={handleUnpair} className="min-h-[44px] rounded px-2.5 text-xs text-mute3">{t('解除配對')}</button>
        </header>

        <QuotaStrip compact />

        <section className="space-y-3 rounded-xl border border-line bg-panel p-3.5">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-mute">💬 {t('準備 ChatGPT 執行對話')}</h2>
          <p className="text-[11px] leading-relaxed text-mute2">{t('手機端不再直接派出 CLI 工單。這裡只會複製指示並開啟 ChatGPT；你仍須選擇「對話」、加入 DevSpace、確認模型並自行貼上送出。')}</p>
          <input value={projectDraft} onChange={event => setProjectDraft(event.target.value)} placeholder={t('專案完整路徑，例如 C:/Projects/app')} className="min-h-[44px] w-full rounded-lg border border-line bg-app px-3 font-mono text-xs" />
          <select value={model} onChange={event => { const next = event.target.value as DevSpaceModel; setModel(next); saveDevSpaceModel(next) }} className="min-h-[44px] w-full rounded-lg border border-line bg-app px-3 text-xs">
            {DEVSPACE_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <textarea value={taskDraft} onChange={event => setTaskDraft(event.target.value)} placeholder={t('要在 ChatGPT 對話完成什麼？')} rows={4} className="w-full rounded-lg border border-line bg-app p-3 text-sm" />
          <button type="button" onClick={prepareNew} disabled={!!busy || !taskDraft.trim()} className="min-h-[44px] w-full rounded-lg bg-ink px-4 py-2 text-sm font-medium text-invink disabled:opacity-40">{busy === 'prepare' ? t('正在複製並開啟…') : t('複製指示並開啟 ChatGPT')}</button>
          {notice && <p role="status" className={`whitespace-pre-wrap text-xs ${notice.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>{notice.message}</p>}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-wider text-mute">📋 {t('舊派工紀錄')}</h2><span className="text-xs text-mute3">{dispatches.length}</span></div>
          {!dispatches.length && <div className="rounded-xl border border-line bg-panel p-6 text-center text-xs text-mute3">{t('目前沒有任何派工紀錄')}</div>}
          {dispatches.map(record => {
            const state = stateOf(record)
            const status = look(state)
            const running = isLive(record) && state === 'running'
            const waiting = state === 'waiting'
            const logOpen = expandedLogId === record.id
            return <article key={record.id} className="space-y-2 rounded-xl border border-line bg-panel p-3.5">
              <div className="flex items-center gap-2 border-b border-line/60 pb-2"><span className="rounded bg-elev px-2 py-0.5 text-xs font-semibold">{record.tool}</span><span className="text-[11px] text-mute3">{startedAgo(record.started)}</span><span className={`ml-auto text-xs ${status.tone}`}>{status.label}</span>{record.outcome && <span className={`text-[11px] ${outcomeTone(record.outcome)}`}>{outcomeLabel(record.outcome)}</span>}</div>
              <p className="text-xs leading-relaxed">{record.task}</p>
              {record.tail && <p className="truncate rounded bg-app px-2 py-1 font-mono text-[11px] text-mute2">{record.tail}</p>}
              <div className="flex flex-wrap gap-2">
                {running && record.mode !== 'terminal' && <button type="button" className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs" disabled={!!busy} onClick={() => void runControl('stop', record)}>{t('⏹ 停止')}</button>}
                {waiting && <button type="button" className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs" disabled={!!busy} onClick={() => void runControl('cancel', record)}>{t('✕ 取消')}</button>}
                <button type="button" className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs" onClick={() => prepareRecord(record)}>{t('在 ChatGPT 對話重做')}</button>
                {!isLocalAnswerRecord(record) && <button type="button" className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs" onClick={() => { setReplyingId(replyingId === record.id ? null : record.id); setReplyText('') }}>{t('在 ChatGPT 對話續作')}</button>}
                <button type="button" className="ml-auto min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs" onClick={() => void toggleLog(record.id)}>{logOpen ? t('收合日誌') : t('查看日誌')}</button>
              </div>
              {replyingId === record.id && <div className="space-y-2 rounded-lg border border-line2 bg-app p-2.5"><textarea value={replyText} onChange={event => setReplyText(event.target.value)} rows={2} placeholder={t('要帶到新 ChatGPT 對話的補充…')} className="w-full rounded border border-line bg-panel p-2 text-xs" /><button type="button" onClick={() => prepareRecord(record, replyText)} disabled={!replyText.trim() || !!busy} className="min-h-[44px] w-full rounded bg-ink px-3 text-xs text-invink disabled:opacity-40">{t('複製續作指示並開啟 ChatGPT')}</button></div>}
              {logOpen && <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-app p-2.5 font-mono text-[11px]">{logTextMap[record.id] ?? t('日誌載入中…')}</pre>}
            </article>
          })}
        </section>
      </div>
    </div>
  )
}
