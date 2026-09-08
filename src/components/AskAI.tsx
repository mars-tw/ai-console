/* eslint-disable react-refresh/only-export-components -- request shaping is a tested public contract */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t, useLang } from '@/i18n'
import type { Lang } from '@/i18n'
import type { Dispatch, SetStateAction } from 'react'
import { chatContext, nextChatModel, pickChatAnswer, retryChatHistory } from '@/lib/chatResponse'
import type { AIConnection } from './AISetup'

type AskMessage = {
  role: 'user' | 'assistant'
  text: string
  reasoning?: string      // 只回了推理過程時，收合起來的推理草稿
  retryText?: string      // 換模型重問時要重送的那句話
  retryModel?: string     // 重問改用哪個模型（auto 以外的下一個可用模型）
  excludeFromContext?: boolean
}

/**
 * content 為空時不要把 reasoning 當答案。推理草稿是模型的思考過程，
 * 不是給人看的回答——實測等兩分鐘出來一整段英文「Thinking Process」，
 * 第一次用的人會以為 AI 壞掉。這裡回一句明確說明，草稿另外收合放著，
 * 想看的人看得到，但它不能冒充答案。
 */
export type AskSession = { model: string; connectionId?: string; connectionModels?: string[]; messages: AskMessage[]; input: string }

export function askEndpoint(connectionId?: string): string {
  return connectionId ? '/api/ai-connections/chat' : '/api/chat'
}

export function askMessages(history: AskMessage[], text: string, lang: Lang = 'zh-TW') {
  return [
    {
      role: 'system',
      content: lang === 'en'
        ? 'Only answer the question. Do not run commands, call tools, or modify files. Reply in clear English.'
        : '你只負責回答問題。不要執行指令、不要呼叫工具、不要修改檔案。請用繁體中文、白話回答。',
    },
    ...chatContext(history).slice(-12).map((message) => ({ role: message.role, content: message.text })),
    { role: 'user', content: text },
  ]
}

/**
 * GET /api/setup 回的 local 區塊。欄位一律當 unknown 檢查：
 * 後端少給、給錯型別，或回一個字串 'true'，都不能被當成「可以送出」。
 */
export type LocalSetupInfo = {
  models?: unknown
  ready?: unknown
  state?: unknown
  readiness?: unknown
  reason?: unknown
  model?: unknown
}

/**
 * 整份回應可信才採用 local。HTTP 200 但 ok:false 是後端在說「這份資料別信」，
 * 這時候的 local.ready 只是上一輪的殘值，拿去畫成「可以送出」就是騙人。
 */
export function pickSetupLocal(responseOk: boolean, data: unknown): LocalSetupInfo | null {
  if (!responseOk || !data || typeof data !== 'object') return null
  const payload = data as { ok?: unknown; local?: unknown }
  if (payload.ok !== true) return null
  const local = payload.local
  if (!local || typeof local !== 'object' || Array.isArray(local)) return null
  return local as LocalSetupInfo
}

/** 擋下來的原因。UI 文字與測試都從這一個碼推導，不各寫一套。 */
export type AskBlockReason =
  | 'loading'
  | 'local_unavailable'
  | 'local_not_ready'
  | 'local_no_models'
  | 'local_model_missing'
  | 'connection_error'
  | 'connection_missing'
  | 'connection_key'
  | 'connection_model'

export type AskConnectionInfo = Pick<AIConnection, 'id' | 'credentialStatus'>

export type AskPreflightState = {
  connectionId?: string
  model: string
  local: LocalSetupInfo | null
  localLoading: boolean
  connections: readonly AskConnectionInfo[]
  connectionsLoading: boolean
  connectionsError: string
}

export type AskPreflight = { ok: true } | { ok: false; reason: AskBlockReason }

/** local.models 只認真正的字串；後端給 null、數字或 undefined 都當成沒有模型。 */
export function localModels(local: LocalSetupInfo | null | undefined): string[] {
  const raw = local && typeof local === 'object' ? local.models : null
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
}

/** 後端 runtime_readiness 認得的可送狀態。needs_start 是「送出時才載入」，不是還沒好。 */
const LOCAL_READY_STATES = new Set(['ready', 'needs_start'])

/**
 * 送得出去嗎。
 *
 * 實測第一次用的人打完字按送出，輸入框先被清空，然後才發現根本沒有模型 ——
 * 問題不見了、畫面只剩一行紅字。所以「能不能送」必須是清空輸入框之前就算得出來的
 * 純函式，而且只認事實：
 *   - 地端要 /api/setup 的 local.ready === true（存在模型不等於可以載入），
 *     狀態還要是後端認得的 ready／needs_start，而且清單非空、選到的那個確實在清單裡；
 *     'auto' 只在有模型時才算數。
 *   - 已加入的 AI 要目錄讀完、沒有錯誤、那筆連線還在、選了具體模型，
 *     而且金鑰不是 missing。not_set 是「這個服務不需要金鑰」（地端／自架），
 *     跟 missing 是兩回事，混在一起會把能用的連線擋死。
 */
export function askPreflight(state: AskPreflightState): AskPreflight {
  const chosen = typeof state.model === 'string' ? state.model.trim() : ''
  if (state.connectionId) {
    if (state.connectionsLoading) return { ok: false, reason: 'loading' }
    if (state.connectionsError) return { ok: false, reason: 'connection_error' }
    const connection = state.connections.find(item => item?.id === state.connectionId)
    if (!connection) return { ok: false, reason: 'connection_missing' }
    if (connection.credentialStatus === 'missing') return { ok: false, reason: 'connection_key' }
    // 雲端服務可能計費，所以不替使用者猜模型：一定要他自己選過。
    if (!chosen || chosen === 'auto') return { ok: false, reason: 'connection_model' }
    return { ok: true }
  }
  if (state.localLoading) return { ok: false, reason: 'loading' }
  if (!state.local || typeof state.local !== 'object') return { ok: false, reason: 'local_unavailable' }
  // ready 和 state 要對得上。ready:true 卻沒給 state、或 state 是 unknown／busy，
  // 是自相矛盾的回報 —— 這種時候只能當成還沒好，不然使用者按下去才撞上載入失敗。
  const readyState = typeof state.local.state === 'string' ? state.local.state : ''
  if (state.local.ready !== true || !LOCAL_READY_STATES.has(readyState)) return { ok: false, reason: 'local_not_ready' }
  const available = localModels(state.local)
  if (!available.length) return { ok: false, reason: 'local_no_models' }
  if (!chosen) return { ok: false, reason: 'local_model_missing' }
  if (chosen !== 'auto' && !available.includes(chosen)) return { ok: false, reason: 'local_model_missing' }
  return { ok: true }
}

/** 擋下來要說人話，而且要說得出下一步。 */
export function askBlockMessage(reason: AskBlockReason): string {
  switch (reason) {
    case 'loading': return '正在檢查可用的 AI，請稍候再送出。'
    case 'connection_error': return '無法讀取已加入的 AI，請重新檢查後再送出。'
    case 'connection_missing': return '找不到這個已加入的 AI，請重新到「接入 AI」選一個。'
    case 'connection_key': return '這個 AI 少了金鑰，請先到「接入 AI」補上。'
    case 'connection_model': return '請先在「接入 AI」檢查此連線並選擇模型。'
    case 'local_no_models': return '這台電腦還沒有可用的地端模型，請先設定 AI。'
    case 'local_model_missing': return '選到的模型目前不可用，請重新選一個可用的模型。'
    default: return '地端 AI 還沒準備好，請先設定 AI 再送出。'
  }
}

export type AskSubmitPlan =
  | { action: 'ignore' }
  | { action: 'blocked'; reason: AskBlockReason }
  | { action: 'send'; text: string }

/**
 * 送出（滑鼠、Enter、換模型重問）共用的同一個判斷。
 * 三條路都得先過這裡，任何一條繞過去就會出現「問題被吃掉」的那個 bug。
 */
export function planAskSubmit(input: { text: string; busy: boolean; state: AskPreflightState }): AskSubmitPlan {
  const text = (input.text || '').trim()
  if (!text || input.busy) return { action: 'ignore' }
  const preflight = askPreflight(input.state)
  if (!preflight.ok) return { action: 'blocked', reason: preflight.reason }
  return { action: 'send', text }
}

/**
 * 送失敗的那句話可不可以放回輸入框。
 *
 * 只有「使用者送出後完全沒有再動過輸入框」而且「輸入框現在是空的」才放回去。
 * 打了新問題要保留新的；打了又自己清掉，是他決定不要 —— 舊句子不能自己長回來。
 */
export function shouldRestoreDraft(input: {
  draft: string
  currentInput: string
  editSeqAtSend: number
  editSeq: number
}): boolean {
  if (!input.draft.trim()) return false
  if (input.editSeq !== input.editSeqAtSend) return false
  return input.currentInput.trim() === ''
}

export type ConsumedDraft = { draft: string; editSeq: number }

/** 一次送出借走的東西：吃掉的草稿、送出前的紀錄，還有寫進去的那個訊息陣列本身。 */
export type AskRollback = {
  consumed?: ConsumedDraft
  priorHistory: AskMessage[]
  echoed?: AskMessage[]
}

/**
 * 把這次送出借走的狀態交還給使用者。卸載、取消、失敗都走這一條。
 *
 * 只還「這次請求現在還握著」的部分：訊息用同一個陣列參考認人，內容一樣但已經
 * 被換掉（切到別份對話、又送了新的一句）就不是我們的了，硬還回去會蓋掉新的畫面。
 * 輸入框同理 —— 使用者後來打的字（包含打了又自己清空）比舊句子重要。
 */
export function rollbackAskSession(session: AskSession, rollback: AskRollback, editSeq: number): AskSession {
  const consumed = rollback.consumed
  const draft = consumed && shouldRestoreDraft({
    draft: consumed.draft,
    currentInput: session.input,
    editSeqAtSend: consumed.editSeq,
    editSeq,
  }) ? consumed.draft : null
  const ownsMessages = !!rollback.echoed && session.messages === rollback.echoed
  if (rollback.echoed && !ownsMessages) return session
  if (draft === null && !ownsMessages) return session
  return {
    ...session,
    ...(draft === null ? {} : { input: draft }),
    ...(ownsMessages ? { messages: rollback.priorHistory } : {}),
  }
}

/** 進行中的那一次送出。rollback 是它自己的回滾動作，卸載時同步呼叫。 */
type ActiveAsk = { seq: number; controller: AbortController; rollback: () => void }

export default function AskAI({ session, onSessionChange, onSetup }: { session: AskSession; onSessionChange: Dispatch<SetStateAction<AskSession>>; onSetup?: () => void }) {
  const lang = useLang()
  const [local, setLocal] = useState<LocalSetupInfo | null>(null)
  const [localLoading, setLocalLoading] = useState(true)
  const [connections, setConnections] = useState<AIConnection[]>([])
  const [connectionsLoading, setConnectionsLoading] = useState(true)
  const [connectionsError, setConnectionsError] = useState('')
  const { model, connectionId, messages, input } = session
  const connection = connections.find(item => item.id === connectionId)
  const models = localModels(local)
  const shownModels = connectionId ? Array.from(new Set([...(connection?.models || session.connectionModels || []), connection?.model || '', model].filter(item => item && item !== 'auto'))) : models
  const setModel = (value: string) => onSessionChange(current => ({ ...current, model: value }))
  const setMessages = (value: AskMessage[]) => onSessionChange(current => ({ ...current, messages: value }))
  const setInput = (value: string) => onSessionChange(current => ({ ...current, input: value }))
  const [busy, setBusy] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [routeInfo, setRouteInfo] = useState('')
  const [error, setError] = useState('')
  /** 進行中的那一次送出；卸載或失敗要靠它把借走的草稿與提問交還回去。 */
  const activeRef = useRef<ActiveAsk | null>(null)
  /** 按下送出到 React 把 busy 畫出來之間還有幾毫秒。連按兩下不能送出兩次。 */
  const inFlightRef = useRef(false)
  /** 每次送出遞增；被取代或元件卸載後的舊回應不能再回頭改畫面。 */
  const requestSeqRef = useRef(0)
  const mountedRef = useRef(true)
  /**
   * 使用者「自己動過輸入框」的次數。
   * 失敗後把問題放回輸入框，只在這個數字沒變的時候做 —— 見 shouldRestoreDraft。
   */
  const editSeqRef = useRef(0)

  /**
   * 地端可用性只認 /api/setup 的 local。
   * /api/models 是庫存清單，「有這個檔案」不等於「現在載得動」——
   * 拿庫存當準備好，使用者按下送出才會撞上載入失敗。
   */
  const refreshSetup = useCallback(async (signal?: AbortSignal) => {
    setLocalLoading(true)
    try {
      const response = await fetch('/api/setup', { signal, cache: 'no-store' })
      const data = response.ok ? await response.json() : null
      if (!signal?.aborted) setLocal(pickSetupLocal(response.ok, data))
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') return
      setLocal(null)   // 讀不到就是不知道能不能送，一律當成還沒準備好
    } finally {
      if (!signal?.aborted) setLocalLoading(false)
    }
  }, [])

  const refreshConnections = useCallback(async (signal?: AbortSignal) => {
    setConnectionsLoading(true)
    try {
      const response = await fetch('/api/ai-connections', { signal, cache: 'no-store' })
      const result = await response.json()
      if (!response.ok || !result?.ok) throw new Error(result?.error || result?.loadError || `HTTP ${response.status}`)
      if (signal?.aborted) return
      setConnections(Array.isArray(result.connections) ? result.connections : [])
      setConnectionsError('')
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') return
      setConnectionsError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (!signal?.aborted) setConnectionsLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refreshSetup(controller.signal)
    void refreshConnections(controller.signal)
    return () => controller.abort()
  }, [refreshSetup, refreshConnections])

  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [busy])

  /**
   * StrictMode 開發模式會 setup → cleanup → setup 演一次。掛載時一定要把 mounted
   * 設回 true，只在 cleanup 設 false 的話，第二次 setup 之後每個回應都會被當成
   * 「已卸載」丟掉 —— 畫面永遠停在正在回答。
   *
   * 真的卸載（回首頁、去設定）時，先同步把這次請求借走的狀態交還，再丟掉膠囊、
   * 讓還在飛的回應失效，最後才 abort：順序反過來就會來不及還，草稿跟著消失。
   */
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const active = activeRef.current
      if (!active) return   // StrictMode 的空跑：沒有進行中的請求就什麼都不要動
      active.rollback()
      activeRef.current = null
      requestSeqRef.current += 1
      inFlightRef.current = false
      active.controller.abort()
    }
  }, [])

  // 「換個模型再問一次」要挑的模型：目前這個的下一個。
  // 只有一個可用模型時沒有「下一個」可換，回傳空字串讓按鈕不出現，
  // 別讓人按了重問卻跑同一個模型、得到同樣只有推理過程的結果。
  const nextModelAfter = (used: string) => nextChatModel(shownModels, used)

  const preflightState = (chosenModel: string): AskPreflightState => ({
    connectionId, model: chosenModel, local, localLoading, connections, connectionsLoading, connectionsError,
  })
  const preflight = askPreflight(preflightState(model))

  /** 三條送出路徑（滑鼠、Enter、換模型重問）都走這一個判斷。 */
  const planSubmit = (text: string, chosenModel: string) => planAskSubmit({
    text,
    busy: busy || inFlightRef.current,
    state: preflightState(chosenModel),
  })

  /** 卸載、取消、送失敗都走這一條回滾，內容一律交給 rollbackAskSession 判斷。 */
  const rollbackRequest = (capsule: AskRollback) => {
    onSessionChange(current => rollbackAskSession(current, capsule, editSeqRef.current))
  }

  const ask = async (rawText: string, chosenModel: string, history: AskMessage[], consumed?: ConsumedDraft) => {
    const plan = planSubmit(rawText, chosenModel)
    if (plan.action !== 'send') {
      if (plan.action === 'blocked') {
        setError(t(askBlockMessage(plan.reason)))
        rollbackRequest({ consumed, priorHistory: history })   // 還沒送出，沒有提問要收回
      }
      return
    }
    const text = plan.text
    // 同步佔住，不能等 React 把 busy 重繪出來 —— 連按兩下之間沒有那一幀。
    inFlightRef.current = true
    const seq = ++requestSeqRef.current
    const isCurrent = () => mountedRef.current && requestSeqRef.current === seq
    /** 狀態現在還歸這次請求管嗎：卸載或被下一次送出取代之後就不歸了。 */
    const owns = () => activeRef.current?.seq === seq
    setBusy(true)
    setSeconds(0)
    setError('')
    setRouteInfo('')
    const controller = new AbortController()
    const echoed = [...history, { role: 'user' as const, text }]
    const capsule: AskRollback = { consumed, priorHistory: history, echoed }
    activeRef.current = { seq, controller, rollback: () => rollbackRequest(capsule) }
    setMessages(echoed)
    try {
      let selected = chosenModel
      if (!connectionId && selected === 'auto') {
        const response = await fetch('/api/route?task=general', { signal: controller.signal })
        const data = await response.json()
        // 選模型也要等，這中間使用者可能已經離開或按了停止。
        controller.signal.throwIfAborted()
        if (!isCurrent() || !owns()) return
        if (!response.ok || !data?.ok || !data.model) throw new Error(data?.reason || t('自動選擇模型失敗'))
        selected = data.model
        setRouteInfo(t('自動選擇：{model} — {reason}', { model: data.model, reason: data.reason || '' }))
      }
      const response = await fetch(askEndpoint(connectionId), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(connectionId ? { id: connectionId } : {}), model: selected, messages: askMessages(history, text, lang) }),
      })
      const data = await response.json()
      controller.signal.throwIfAborted()
      if (!isCurrent() || !owns()) return
      const noAnswer = ['reasoning_only', 'empty_reply'].includes(data?.status)
      if ((!response.ok || !data?.ok) && !noAnswer) throw new Error([data?.error || t('回答失敗'), data?.nextAction].filter(Boolean).join(' '))
      if (noAnswer) setError([data?.error, data?.nextAction].filter(Boolean).join(' '))
      const picked = pickChatAnswer(data.content, data.reasoning)
      const reply: AskMessage = picked.excludeFromContext
        ? { role: 'assistant', ...picked, retryText: text, retryModel: nextModelAfter(selected) }
        : { role: 'assistant', text: picked.text }
      setMessages([...echoed, reply])
    } catch (failure) {
      // 舊請求（已被取代或元件已卸載）不能回頭蓋掉使用者現在的輸入與聊天串。
      if (!isCurrent() || !owns()) return
      if (failure instanceof Error && failure.name === 'AbortError') {
        setError(t('已停止等待這次回答。'))
      } else {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
      // 沒有拿到回答的那一則提問不留在紀錄裡：留著它，加上放回輸入框的原句，
      // 同一句會在畫面上出現兩次，再送一次還會被當成上下文送出去。
      rollbackRequest(capsule)
    } finally {
      if (owns()) activeRef.current = null
      if (requestSeqRef.current === seq) {
        inFlightRef.current = false
        setBusy(false)
      }
    }
  }

  const send = () => {
    const plan = planSubmit(input, model)
    if (plan.action !== 'send') {
      if (plan.action === 'blocked') setError(t(askBlockMessage(plan.reason)))
      return   // 送不出去就不能清掉輸入框：問題被吃掉是最傷人的那一種失敗
    }
    const consumed: ConsumedDraft = { draft: input, editSeq: editSeqRef.current }
    setInput('')
    void ask(plan.text, model, messages, consumed)
  }

  /**
   * 換個模型重問同一句。先把那次只有推理過程、沒給答案的回覆拿掉再重送：
   * 留著它，下一發會把「沒有給出答案」這句標記當成有效上下文送回給模型。
   */
  const retryWithModel = (failedIndex: number) => {
    const failed = messages[failedIndex]
    const text = failed?.retryText
    const chosenModel = failed?.retryModel
    if (!text || !chosenModel) return
    const base = retryChatHistory(messages, failedIndex)
    if (!base) return
    // 重問不碰輸入框：那裡可能已經是使用者剛打好、還沒送出的下一個問題。
    void ask(text, chosenModel, base)
  }

  return (
    <section className="h-full overflow-y-auto bg-app px-4 py-6 sm:px-8" aria-labelledby="ask-ai-title">
      <div className="mx-auto max-w-3xl">
        <p className="text-xs font-medium tracking-widest text-mute2">ASK AI</p>
        <h1 id="ask-ai-title" className="mt-1 text-2xl font-semibold text-ink">💬 {t('直接問 AI')}</h1>
        <p className="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-300">
          {t('這裡只回答問題，不會改檔、不會執行工作，也不會派給其他 AI。')}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label className="text-sm text-ink2" htmlFor="ask-connection">{t('使用哪個 AI')}</label>
          <select id="ask-connection" disabled={busy || connectionsLoading} className="max-w-full rounded-md border border-line2 bg-panel px-2 py-1.5 text-sm disabled:opacity-40" value={connectionId || ''} onChange={event => { const next = connections.find(item => item.id === event.target.value); if (event.target.value && !next) return; setError(''); setRouteInfo(''); onSessionChange(current => ({ ...current, connectionId: next?.id, connectionModels: next?.models, model: next?.model || 'auto' })) }}>
            <option value="">LM Studio</option>
            {connectionId && !connection && <option value={connectionId}>{t('連線尚未載入或已移除')}</option>}
            {connections.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <label className="text-sm text-ink2" htmlFor="ask-model">{t('選擇模型')}</label>
          <select id="ask-model" disabled={busy || (!connectionId && (localLoading || !models.length))} className="max-w-full rounded-md border border-line2 bg-panel px-2 py-1.5 text-sm disabled:opacity-40" value={!connectionId && (localLoading || !models.length) ? '' : model} onChange={(event) => setModel(event.target.value)}>
            {!connectionId && (localLoading || !models.length) && <option value="" disabled>{localLoading ? t('正在檢查地端模型…') : t('尚未安裝地端模型')}</option>}
            {!connectionId && !localLoading && models.length > 0 && <option value="auto">{t('🤖 自動（建議）')}</option>}
            {shownModels.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          {onSetup && <button type="button" className="text-sm underline" onClick={onSetup}>{t('接入其他 AI')}</button>}
        </div>
        {connectionsError && <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t('無法讀取已加入的 AI：{err}', { err: connectionsError })}</p>}
        {connectionId && <p className="mt-2 text-xs leading-5 text-mute2">{t('問題與本頁聊天紀錄會傳送到所選服務；雲端服務可能計費。')}</p>}

        {!preflight.ok && preflight.reason === 'loading' && (
          <p role="status" className="mt-2 text-xs text-mute2">
            {connectionId ? t('正在檢查這個 AI 的設定…') : t('正在檢查地端模型…')}
          </p>
        )}
        {!preflight.ok && preflight.reason !== 'loading' && (
          <div role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
            <p className="font-medium">{t(askBlockMessage(preflight.reason))}</p>
            {/* 先講「你的字還在」再講怎麼設定：擔心白打一場的人才有心情去設定。 */}
            <p className="mt-1 text-xs leading-5">{t('你打的問題會留著，設定好之後直接送出就好。')}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {onSetup && (
                <button
                  type="button"
                  className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-invink hover:bg-ink2"
                  onClick={onSetup}
                >
                  {t('設定 AI')}
                </button>
              )}
              <button
                type="button"
                className="rounded-md border border-amber-400 px-3 py-1.5 text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900"
                onClick={() => { void refreshSetup(); void refreshConnections() }}
              >
                {t('重新檢查')}
              </button>
            </div>
          </div>
        )}

        {routeInfo && <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-300">{routeInfo}</p>}
        {error && <p role="alert" className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}

        <div className="mt-4 flex min-h-64 flex-col gap-3 rounded-xl border border-line bg-panel p-4" role="log" aria-live="polite" aria-busy={busy}>
          {messages.length === 0 ? (
            <div className="m-auto text-center text-sm text-mute2">
              <p>{t('例如：這段文字是什麼意思？')}</p>
              <p className="mt-1">{t('例如：我下一步應該先做什麼？')}</p>
            </div>
          ) : messages.map((message, index) => (
            <div key={index} className={`max-w-[90%] rounded-lg px-4 py-3 text-sm leading-6 ${message.role === 'user' ? 'ml-auto bg-elev' : 'mr-auto border border-line'}`}>
              <div className="mb-1 text-xs text-mute3">{message.role === 'user' ? t('你') : t('AI 回答')}</div>
              <div className="whitespace-pre-wrap break-words">{message.text}</div>
              {message.reasoning && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer select-none text-mute3">{t('看它的推理過程')}</summary>
                  <div className="mt-1 whitespace-pre-wrap break-words text-mute2">{message.reasoning}</div>
                </details>
              )}
              {message.retryModel && index === messages.length - 1 && (
                <button
                  type="button"
                  className="mt-2 rounded-md border border-line2 px-2.5 py-1 text-xs text-ink2 hover:bg-elev disabled:opacity-40"
                  disabled={busy}
                  onClick={() => retryWithModel(index)}
                >
                  {t('換個模型再問一次')}
                </button>
              )}
            </div>
          ))}
          {busy && <p role="status" className="text-xs text-mute2">{t('正在回答… {n} 秒', { n: seconds })}</p>}
        </div>

        <div className="mt-3 flex gap-2">
          <textarea
            className="min-h-20 flex-1 rounded-lg border border-line2 bg-panel px-3 py-2 text-sm outline-none focus:border-line3"
            placeholder={t('輸入想問的問題…')}
            value={input}
            onChange={(event) => { editSeqRef.current += 1; setInput(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }}
          />
          {busy ? (
            <button className="self-end rounded-lg border border-line2 px-4 py-2 text-sm hover:bg-elev" onClick={() => activeRef.current?.controller.abort()}>{t('停止等待')}</button>
          ) : (
            <button className="self-end rounded-lg bg-ink px-5 py-2 text-sm font-medium text-invink hover:bg-ink2 disabled:opacity-40" disabled={!input.trim() || !preflight.ok} onClick={() => void send()}>{t('送出問題')}</button>
          )}
        </div>
      </div>
    </section>
  )
}
