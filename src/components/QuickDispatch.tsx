/**
 * 對話欄的「直接派工」與「引導我寫」。
 *
 * ── 為什麼要有這個 ──
 *
 * 派工原本只有一條路：主控台 → 打一句話 → 按「分析並排程」→ 等地端模型
 * 拆解 → 拆完才看得到工具下拉 → 改工具 → 派出。實測那次拆解跑了 78 秒
 * 還沒回來（最後是按「不等了，整件當一件」逃出來的）。
 *
 * 而使用者真正的處境常常是：正在看一份對話，想接著把它交出去做。
 * 這時候他已經知道要做什麼、也知道要給誰 —— 拆解那一步不但沒有幫助，
 * 還把「我已經想清楚了」硬轉成「再等一分鐘」。
 *
 * 所以這裡刻意**不經過 /api/plan**，直接打 /api/dispatch。
 * 拆解仍然留在主控台給「我還沒想清楚，幫我拆」的情況用 —— 兩種需求
 * 本來就不同，不該共用同一條唯一的路。
 *
 * ── 引導我寫 ──
 *
 * 另一半的問題相反：知道要交出去，但寫不出一份夠清楚的工單，
 * 於是派出一句「幫我看看 p52」，agent 只好自己猜要做到哪裡。
 * 引導把它拆成四個回答得出來的問題，最後組成工單。
 *
 * 四個問題是有意義的最小集合，不是隨便列的：
 *   目標   —— 沒有它，agent 不知道什麼時候該停
 *   範圍   —— 沒有它，agent 會動到你沒想過的檔案
 *   完成標準 —— 沒有它，「做完了」變成它說了算
 *   禁止   —— 沒有它，不可逆的動作沒有護欄
 * 少一個都會在真實派工裡出事，多一個就沒有人願意填完。
 *
 * ── 就緒度（本次修正） ──
 *
 * 舊版拿不到 /api/dispatch/tools 時「安靜地退回只有自動可選」，等於在
 * 狀態未知的情況下讓人按下去執行；而確認視窗又出現在任何檢查之前，
 * 使用者先被問「確定要動檔案嗎」，按了才發現根本派不出去。
 * 現在一律 fail closed：讀不到、格式不對、狀態未確認都不能派工，
 * 但畫面永遠給得出下一步（重新檢查／去設定），不會變成死路。
 */
/* eslint-disable react-refresh/only-export-components -- 派工前置判讀為純函式，需可被無 DOM 的聚焦測試直接呼叫 */
import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { GUIDE_STEPS, buildOrder } from '@/lib/workOrder'
import type { GuideStep, Msg } from '@/lib/workOrder'
import {
  canDispatch,
  parseDispatchReadiness,
  toolReadinessLabel,
  type ReadinessSnapshot,
  type ReadinessTool,
} from '@/lib/aiReadiness'
import {
  filterHeadlessDispatchTools,
  pickInitialHeadlessTool,
  resolveDispatchRecipientLabel,
} from '@/lib/continuationHelp'

/** 對外型別維持原欄位（Office 等呼叫端沿用），就緒度欄位一律選填。 */
export type DispatchTool = {
  id: string
  label: string
  mode: 'headless' | 'terminal' | 'local'
  limited: boolean
  /** 後端如果給了限流原因就直接顯示 */
  reason?: string
  ready?: boolean
  state?: string
  readiness?: string
  authStatus?: string
}

export const READINESS_LOADING_REASON = '正在確認可用的 AI 工具…'
export const READINESS_FAILED_REASON = '工具狀態讀不到，先當作不能派工'

/** 一律 fail closed 的空快照：沒有工具、沒有 auto、不得派工。 */
export function deniedReadiness(reason: string): ReadinessSnapshot {
  return { ok: false, tools: [], auto: null, ready: false, reason }
}

/** 尚未讀到任何狀態前的預設值，本身就是「不能派工」。 */
export const LOADING_READINESS: ReadinessSnapshot = deniedReadiness(READINESS_LOADING_REASON)

/**
 * 讀取就緒度快照。fetch 可注入以利測試。
 * 任何失敗（網路、HTTP 非 2xx、JSON 壞掉、形狀不合）都回拒絕快照，
 * 絕不退回「只有自動」或本地模型。
 */
export async function fetchReadiness(
  doFetch: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ReadinessSnapshot> {
  try {
    const res = await doFetch('/api/dispatch/tools', { signal })
    if (!res || res.ok !== true) return deniedReadiness(READINESS_FAILED_REASON)
    const data = await res.json()
    const snap = parseDispatchReadiness(data)
    return snap.ok ? snap : deniedReadiness(snap.reason || READINESS_FAILED_REASON)
  } catch {
    return deniedReadiness(READINESS_FAILED_REASON)
  }
}

/** 「開始執行」是否可按。載入中／讀不到／未就緒／外部停用／送出中／空白皆為否。 */
export function canStartDispatch(opts: {
  snapshot: ReadinessSnapshot
  requested: string
  draft: string
  loading?: boolean
  sending?: boolean
  disabled?: boolean
}): boolean {
  const { snapshot, requested, draft, loading, sending, disabled } = opts
  if (loading || sending || disabled) return false
  if (!snapshot || snapshot.ok !== true) return false
  if (typeof draft !== 'string' || !draft.trim()) return false
  return canDispatch(requested, snapshot.tools, snapshot.auto)
}

/** 正常回應：HTTP 要 ok，body 也要 ok===true，兩者缺一都不算成功。 */
export function isAcceptedDispatch(httpOk: boolean, data: unknown): boolean {
  if (httpOk !== true) return false
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  return (data as Record<string, unknown>).ok === true
}

/**
 * 只有「被接受」且「使用者送出後沒再動過草稿」才清空。
 * 送出後又打了字（包含改成空白）就留著他的新內容，不被非同步回應蓋掉。
 */
export function shouldClearDraftAfterSend(
  accepted: boolean,
  sent: { draft: string; editSeq: number },
  now: { draft: string; editSeq: number },
): boolean {
  if (accepted !== true) return false
  return sent.editSeq === now.editSeq && sent.draft === now.draft
}

/** 下拉裡每個工具後面那句話。差別在「派出去之後還需不需要你」 */
function modeNote(m: string | undefined): string {
  if (m === 'terminal') return t('要你到終端按一下')
  if (m === 'local') return t('只回答，不改檔（不燒雲端額度）')
  if (m === 'headless') return t('會自己跑完')
  return t('模式未知')
}

/** 下拉選項文字：就緒度用共用判讀，模式用實際模式，不再只看 limited。 */
function optionText(x: ReadinessTool): string {
  const parts = [t(toolReadinessLabel(x)), modeNote(typeof x.mode === 'string' ? x.mode : undefined)]
  if (x.reason && x.reason.trim()) parts.push(t(x.reason.trim()))
  return `${x.label} — ${parts.join(' · ')}`
}

export interface QuickDispatchProps {
  conv: { title: string; projectDir: string } | null
  recent: Msg[]
  onToast: (s: string) => void
  disabled?: boolean
  /** 未就緒時帶使用者去設定；沒給就只顯示文字指引，不放按不動的按鈕 */
  onSetup?: () => void
  /** 受控草稿（呼叫端保管於記憶體）；未給時元件自己存 */
  draft?: string
  onDraftChange?: (value: string) => void
  /** 新手繼續工作對話框：只允許無頭工具，並在 POST 帶 expectedMode */
  headlessOnly?: boolean
  /** 已知原工具時優先選它；不可用時不悄悄換人 */
  initialTool?: string
  expectedMode?: 'headless'
  /** 避免與其他 QuickDispatch 實例的 input id 衝突 */
  inputIdPrefix?: string
  /** 嵌入對話框時收合外層標題 */
  embedded?: boolean
  withContextDefault?: boolean
}

/**
 * 這是一個「會真的執行工作」的獨立輸入區，不接收聊天輸入框的 value/setter。
 * 兩種意圖在型別層就分開，呼叫端不可能再把提問草稿誤當成工單送出。
 */
export default function QuickDispatch({
  conv, recent, onToast, disabled, onSetup, draft, onDraftChange,
  headlessOnly, initialTool, expectedMode, inputIdPrefix, embedded, withContextDefault,
}: QuickDispatchProps) {
  const [snapshot, setSnapshot] = useState<ReadinessSnapshot>(LOADING_READINESS)
  const [loading, setLoading] = useState(true)
  const [tool, setTool] = useState('auto')
  const [sending, setSending] = useState(false)
  const [posting, setPosting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string; warn?: boolean } | null>(null)
  const [withCtx, setWithCtx] = useState(withContextDefault ?? true)
  const [localDraft, setLocalDraft] = useState('')

  // 受控草稿：父層給了 draft 就以父層為準，換分頁／卸載回來內容還在（純記憶體，不落地）
  const isControlled = typeof draft === 'string'
  const taskDraft = isControlled ? draft : localDraft
  const controlledRef = useRef(isControlled)
  controlledRef.current = isControlled
  const draftRef = useRef(taskDraft)
  draftRef.current = taskDraft
  const editSeq = useRef(0)
  const writeDraft = (v: string) => {
    editSeq.current += 1
    draftRef.current = v
    if (!isControlled) setLocalDraft(v)
    onDraftChange?.(v)
  }

  // 引導狀態
  const [guiding, setGuiding] = useState(false)
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Partial<Record<GuideStep['key'], string>>>({})
  const stepRef = useRef<HTMLTextAreaElement>(null)

  const loadSeq = useRef(0)
  const loadAbort = useRef<AbortController | null>(null)
  const sendSeq = useRef(0)          // 遞增即作廢：取消／換對話／卸載後不會有遲到的確認視窗或 POST
  const sendingRef = useRef(false)   // 同步鎖，連點第二下進不來（setState 是非同步的，擋不住）
  const postedRef = useRef(false)    // 已經 POST 出去就不再讓人「取消」，伺服器接下的工作不主動中止
  const preflightAbort = useRef<AbortController | null>(null)
  const toolPickKey = useRef('')
  const userPickedTool = useRef(false)
  const withCtxTouched = useRef(false)

  const visibleTools = (snap: ReadinessSnapshot): ReadinessTool[] => (
    headlessOnly ? filterHeadlessDispatchTools(snap.tools) : snap.tools
  )

  const convPickKey = `${conv?.title ?? ''}|${conv?.projectDir ?? ''}|${initialTool ?? ''}|${headlessOnly ? 'h' : 'a'}`

  const syncToolAfterReadiness = (snap: ReadinessSnapshot, forceInitial = false) => {
    const rows = visibleTools(snap)
    const auto = rows.some((row) => row.id === snap.auto) ? snap.auto : null
    const pinnedInitial = headlessOnly && !!initialTool && initialTool !== 'auto'
    if (forceInitial || toolPickKey.current !== convPickKey) {
      toolPickKey.current = convPickKey
      userPickedTool.current = false
      setTool(pickInitialHeadlessTool(initialTool, rows, auto))
      return
    }
    if (userPickedTool.current) return
    if (pinnedInitial) {
      setTool(initialTool!)
      return
    }
    if (tool === 'auto' && canDispatch('auto', rows, auto)) {
      setTool('auto')
    }
  }

  const loadReadiness = (signal?: AbortSignal) => {
    const seq = ++loadSeq.current
    setLoading(true)
    return fetchReadiness(fetch, signal).then((snap) => {
      if (seq !== loadSeq.current || signal?.aborted) return
      setSnapshot(snap)
      syncToolAfterReadiness(snap)
      setLoading(false)
    })
  }

  useEffect(() => {
    const ac = new AbortController()
    loadAbort.current = ac
    void loadReadiness(ac.signal)
    return () => {
      loadAbort.current?.abort()
      // 卸載：作廢前置檢查，但不碰任何已經送出的工作
      sendSeq.current += 1
      preflightAbort.current?.abort()
      preflightAbort.current = null
    }
    // 只在掛載時抓一次，之後靠「重新檢查」重讀狀態
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refresh = () => {
    loadAbort.current?.abort() // 上一次還在飛的查詢直接作廢，避免舊結果蓋掉新的
    const ac = new AbortController()
    loadAbort.current = ac
    void loadReadiness(ac.signal)
  }

  useEffect(() => {
    if (withContextDefault !== undefined && !withCtxTouched.current) setWithCtx(withContextDefault)
  }, [withContextDefault])

  // 換一份對話就把引導收掉。上一份對話問到一半的答案套到新的對話上，
  // 會產出一份看起來很完整但講的是別件事的工單 —— 那是最難發現的錯。
  useEffect(() => {
    setGuiding(false); setStep(0); setAnswers({}); setResult(null)
    toolPickKey.current = convPickKey
    userPickedTool.current = false
    withCtxTouched.current = false
    const rows = visibleTools(snapshot)
    const auto = rows.some((row) => row.id === snapshot.auto) ? snapshot.auto : null
    setTool(pickInitialHeadlessTool(initialTool, rows, auto))
    // 受控草稿由父層依對話保管，這裡不能清（清了等於幫使用者刪掉另一份對話的工單）
    if (!controlledRef.current) setLocalDraft('')
    sendSeq.current += 1
    preflightAbort.current?.abort()
    preflightAbort.current = null
    sendingRef.current = false
    setSending(false)
    setPosting(false)
    // convPickKey／visibleTools 刻意不列入：只在換對話時重置工具選擇，不在每次快照更新時重設
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [conv?.projectDir, conv?.title, initialTool])

  useEffect(() => { if (guiding) stepRef.current?.focus() }, [guiding, step])

  const cur = GUIDE_STEPS[step]
  const curVal = (cur && answers[cur.key]) || ''
  const canNext = !!cur && (cur.optional || curVal.trim().length > 0)

  const finishGuide = () => {
    const order = buildOrder(answers, {
      title: conv?.title,
      dir: conv?.projectDir,
    })
    writeDraft(order)
    setGuiding(false)
    setStep(0)
    onToast(t('工單已經寫進執行區，可以再修改，確認後按「開始執行」'))
  }

  const tools = visibleTools(snapshot)
  const headlessAuto = tools.some((row) => row.id === snapshot.auto) ? snapshot.auto : null
  const autoUsable = canDispatch('auto', tools, headlessAuto)
  const picked = tools.find((x) => x.id === tool) || snapshot.tools.find((x) => x.id === tool)
  const pickedUsable = canDispatch(tool, tools, headlessAuto)
  const initialPinned = headlessOnly
    && !!initialTool
    && initialTool !== 'auto'
    && tool === initialTool
    && !pickedUsable
  const startable = canStartDispatch({ snapshot, requested: tool, draft: taskDraft, loading, sending, disabled })
    && (!headlessOnly || pickedUsable)

  /** 不能派工時要說得出原因，且原因來自快照本身，不是猜的。 */
  const blockedReason = (): string => {
    if (loading) return t(READINESS_LOADING_REASON)
    if (!snapshot.ok) return t(snapshot.reason || READINESS_FAILED_REASON)
    if (pickedUsable) return ''
    if (tool === 'auto') return t(snapshot.reason || '目前沒有可自動派工的工具')
    if (!picked) return t('找不到這個工具，請重新檢查狀態')
    const why = picked.reason && picked.reason.trim() ? ` · ${t(picked.reason.trim())}` : ''
    return `${t(toolReadinessLabel(picked))}${why}`
  }

  const cancelSend = () => {
    if (!sendingRef.current || postedRef.current) return // 已交付的工作絕不自動中止
    sendSeq.current += 1
    preflightAbort.current?.abort()
    preflightAbort.current = null
    sendingRef.current = false
    setSending(false)
    setResult({ ok: false, msg: t('已取消，還沒有送出任何工作。') })
  }

  const send = async () => {
    // disabled 要擋住行為本身，不能只擋按鈕
    if (disabled || sendingRef.current || sending) return
    const task = taskDraft.trim()
    if (!task) return
    // 第一道門：共用判讀。發生在確認視窗、狀態轉換與清稿之前 —— 派不出去就不該先嚇人一次
    if (!canStartDispatch({ snapshot, requested: tool, draft: taskDraft, loading, disabled })) {
      setResult({ ok: false, msg: t('現在不能派工：{why}', { why: blockedReason() || t(READINESS_FAILED_REASON) }) })
      return
    }
    sendingRef.current = true
    postedRef.current = false
    const seq = ++sendSeq.current
    const sent = { draft: taskDraft, editSeq: editSeq.current }
    const ac = new AbortController()
    preflightAbort.current = ac
    setSending(true)
    setPosting(false)
    setResult(null)
    try {
      // 第二道門：確認前重新查一次。中途變成限流／未知就收手，連 POST 都不發（伺服器仍會自己複查）
      const fresh = await fetchReadiness(fetch, ac.signal)
      if (seq !== sendSeq.current) return
      setSnapshot(fresh)
      const freshTools = visibleTools(fresh)
      const freshAuto = freshTools.some((row) => row.id === fresh.auto) ? fresh.auto : null
      if (!fresh.ok || !canDispatch(tool, freshTools, freshAuto)) {
        setResult({ ok: false, msg: t('工具狀態剛剛變了，這次沒有送出。請按「重新檢查」後再試。') })
        return
      }
      // auto 在這一刻釘死成快照裡那一個：使用者只同意了地端「只回答」，
      // 就不能在 POST 之後被伺服器路由到會改檔的 CLI。晚點不能用由後端擋下。
      const resolvedTool = tool === 'auto' ? (freshAuto || '') : tool
      const matched = fresh.tools.find((x) => x.id === resolvedTool) as { mode?: unknown } | undefined
      if (!resolvedTool || !canDispatch(resolvedTool, freshTools, freshAuto)) {
        setResult({ ok: false, msg: t('工具狀態剛剛變了，這次沒有送出。請按「重新檢查」後再試。') })
        return
      }
      if (headlessOnly && matched?.mode !== 'headless') {
        setResult({ ok: false, msg: t('這次只能使用不用操作英文視窗的 AI；請重新檢查或改選其他工具。') })
        return
      }
      const answerOnly = typeof matched?.mode === 'string' ? matched.mode === 'local' : resolvedTool === 'local'
      const recipient = resolveDispatchRecipientLabel(resolvedTool, freshTools, freshAuto)
      if (!window.confirm(answerOnly
        ? t('這會交給 {who}：只回答，不改檔。確定要開始嗎？', { who: recipient })
        : t('這會交給 {who} 執行工作，可能讀寫專案檔案。確定要開始嗎？', { who: recipient }))) {
        setResult({ ok: false, msg: t('已取消，工單留在這裡沒有送出。') })
        return
      }
      if (seq !== sendSeq.current) return
      const body: Record<string, unknown> = {
        tool: resolvedTool,
        task: buildOrder({ goal: task }, { recent: withCtx ? recent : undefined }),
      }
      if (expectedMode) body.expectedMode = expectedMode
      // 工作目錄關係到「這件派工改了什麼」問不問得出來 ——
      // 家目錄不是 git 專案，沒給的話 diff 永遠是空的
      if (conv?.projectDir) body.cwd = conv.projectDir
      postedRef.current = true
      setPosting(true)
      // 這個請求刻意不帶 signal：送出後就是伺服器的工作，不能被畫面上的操作中止
      const r = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = (await r.json().catch(() => null)) as Record<string, unknown> | null
      if (seq !== sendSeq.current) return
      if (!isAcceptedDispatch(r.ok, d)) {
        const err = d && typeof d.error === 'string' ? d.error : ''
        setResult({ ok: false, msg: err || t('派工失敗') })
        return // 失敗不動草稿，使用者寫的東西留著
      }
      const str = (v: unknown) => (typeof v === 'string' ? v : '')
      const data = d as Record<string, unknown>
      const who = str(data.tool) || resolvedTool
      const mode = str(data.mode)
      const reply = str(data.reply) || str(data.answer)
      const parts: string[] = []
      const rr = data.rerouted && typeof data.rerouted === 'object' ? data.rerouted as Record<string, unknown> : null
      if (rr) parts.push(t('{why}，改派給 {to}', { why: str(rr.why), to: str(rr.to) }))
      if (mode === 'terminal') {
        parts.push(t('{who} 已經開了終端並帶入指令，但**還沒有人按下去**——要到那個視窗按一下它才會開始。', { who }))
      } else if (mode === 'sync' || mode === 'local' || (reply && !str(data.jobId) && !str(data.id))) {
        // 同步回覆＝只是回答，沒有動到任何檔案；不能講成「已執行完成」。
        // 後端同步派工實際會回 { mode:'sync', id, reply }：那個 id 只是這次回覆的編號，
        // 不是排程中的工作，所以不能因為「有 id」就掉到下面講成已送出、去主控台看進度。
        parts.push(reply
          ? t('這是回答，沒有修改任何檔案：{reply}', { reply })
          : t('已經回覆，這只是回答，沒有修改任何檔案。'))
      } else {
        parts.push(t('已送出給 {who}，到主控台可以看進度。送出不代表一定會完成。', { who }))
      }
      setResult({ ok: true, msg: parts.join(' '), warn: mode === 'terminal' })
      if (shouldClearDraftAfterSend(true, sent, { draft: draftRef.current, editSeq: editSeq.current })) {
        writeDraft('')
      }
    } catch (e) {
      if (seq !== sendSeq.current) return
      setResult({ ok: false, msg: t('派工失敗：{err}', { err: String(e) }) })
    } finally {
      if (seq === sendSeq.current) {
        sendingRef.current = false
        preflightAbort.current = null
        setSending(false)
        setPosting(false)
      }
    }
  }

  const taskInputId = `${inputIdPrefix || 'qd'}-task`
  const guideInputId = `${inputIdPrefix || 'qd'}-guide`

  return (
    <section
      className={embedded ? 'mt-2 min-w-0 overflow-hidden' : 'mt-3 rounded-lg border border-line2 bg-elev/50 p-3'}
      aria-labelledby={embedded ? undefined : 'quick-dispatch-title'}
    >
      {!embedded && (
        <div className="mb-2">
          <h3 id="quick-dispatch-title" className="text-sm font-semibold">⚡ {t('交給 AI 執行')}</h3>
          <p className="mt-0.5 text-xs text-mute2">{t('這裡會真的開始工作，不是傳送問題。請寫清楚希望 AI 完成什麼。')}</p>
        </div>
      )}
      {guiding && cur ? (
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-sm font-medium">🧭 {t('一步一步把工單寫清楚')}</span>
            <span className="text-xs text-mute3">{step + 1} / {GUIDE_STEPS.length}</span>
            <button
              className="ml-auto rounded px-2 py-1 text-xs text-mute3 hover:text-ink3"
              onClick={() => { setGuiding(false); setStep(0) }}
            >
              {t('關掉')}
            </button>
          </div>
          <label className="mb-1 block text-sm text-ink2" htmlFor={guideInputId}>
            {t(cur.ask)}{cur.optional && <span className="ml-1 text-xs text-mute3">{t('（可以跳過）')}</span>}
          </label>
          <p className="mb-1.5 text-xs text-mute2">{t(cur.hint)}</p>
          <textarea
            id={guideInputId}
            ref={stepRef}
            className="min-h-16 w-full rounded-md border border-line bg-transparent px-3 py-2 text-sm outline-none focus:border-line3"
            placeholder={t('例：{eg}', { eg: t(cur.eg) })}
            value={curVal}
            onChange={(e) => setAnswers({ ...answers, [cur.key]: e.target.value })}
            onKeyDown={(e) => {
              // Ctrl+Enter 前進。單純 Enter 不行 —— 這幾格本來就常常要換行寫多條
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canNext) {
                e.preventDefault()
                if (step === GUIDE_STEPS.length - 1) finishGuide()
                else setStep(step + 1)
              }
            }}
          />
          <div className="mt-1.5 flex items-center gap-2">
            {step > 0 && (
              <button className="rounded-md border border-line px-2 py-1 text-xs hover:bg-elev" onClick={() => setStep(step - 1)}>
                {t('← 上一步')}
              </button>
            )}
            {cur.optional && !curVal.trim() && (
              <button
                className="rounded-md px-2 py-1 text-xs text-mute2 hover:text-ink3"
                onClick={() => (step === GUIDE_STEPS.length - 1 ? finishGuide() : setStep(step + 1))}
              >
                {t('這題跳過')}
              </button>
            )}
            <button
              className="ml-auto rounded-md bg-ink px-3 py-1.5 text-xs text-invink hover:bg-ink2 disabled:opacity-40"
              disabled={!canNext}
              onClick={() => (step === GUIDE_STEPS.length - 1 ? finishGuide() : setStep(step + 1))}
            >
              {step === GUIDE_STEPS.length - 1 ? t('產生工單') : t('下一步 →')}
            </button>
          </div>
        </div>
      ) : (
        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-ink2" htmlFor={taskInputId}>
            {t('要 AI 完成什麼？')}
          </label>
          <textarea
            id={taskInputId}
            className="min-h-20 w-full max-w-full rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-line3"
            placeholder={t('例：整理這段對話的結論，更新專案文件，並跑過測試確認沒有問題。')}
            value={taskDraft}
            onChange={(e) => writeDraft(e.target.value)}
          />
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
            <select
              aria-label={t('派給哪個工具')}
              className="min-w-0 max-w-full shrink basis-full rounded-md border border-line2 bg-panel px-2 py-1 text-xs text-ink2 sm:basis-auto sm:max-w-[min(100%,14rem)] [&>option]:bg-panel [&>option]:text-ink2"
              value={tool}
              onChange={(e) => { userPickedTool.current = true; setTool(e.target.value) }}
            >
              {/* 自動只有在伺服器 auto 真的可派工時才選得到，不猜、不退回本地 */}
              <option value="auto" disabled={!autoUsable}>
                {autoUsable
                  ? t('🤖 自動（現在會給 {who}）', { who: headlessAuto || '' })
                  : t('🤖 自動（目前沒有可自動派工的工具）')}
              </option>
              {tools.map((x) => (
                // 不可用的工具照樣列出來（看不到會以為工具消失了），但選不動並附上原因
                <option key={x.id} value={x.id} disabled={!canDispatch(x.id, tools, headlessAuto)}>
                  {optionText(x)}
                </option>
              ))}
            </select>
            <button
              className="shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-elev disabled:opacity-40"
              title={t('重新讀取各工具目前的狀態')}
              disabled={loading}
              onClick={refresh}
            >
              {loading ? t('檢查中…') : t('重新檢查')}
            </button>
            <button
              className="shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-elev"
              title={t('不知道工單怎麼寫的話，用四個問題帶你寫完')}
              onClick={() => { setGuiding(true); setStep(0) }}
            >
              🧭 {t('引導我寫')}
            </button>
            {recent.length > 0 && (
              <label className="flex items-center gap-1 text-xs text-mute2">
                <input
                  type="checkbox"
                  checked={withCtx}
                  onChange={(e) => { withCtxTouched.current = true; setWithCtx(e.target.checked) }}
                />
                {t('帶上這段對話當背景')}
              </label>
            )}
            {sending && !posting && (
              <button
                className="rounded-md border border-line px-2 py-1 text-xs hover:bg-elev"
                onClick={cancelSend}
              >
                {t('取消')}
              </button>
            )}
            <button
              className="ml-auto shrink-0 rounded-md bg-ink px-4 py-2 text-xs font-medium text-invink hover:bg-ink2 disabled:opacity-40"
              disabled={!startable}
              title={picked?.mode === 'terminal' ? t('這個工具派出去之後還要你到終端按一下') : undefined}
              onClick={send}
            >
              {sending ? (posting ? t('正在交付…') : t('確認狀態中…')) : t('開始執行')}
            </button>
          </div>
          {initialPinned && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {t('原工具 {who} 目前無法在背景自動執行；請重新檢查、改選其他工具，或使用下方進階終端機。', { who: initialTool || '' })}
            </p>
          )}
          {!sending && !pickedUsable && (
            // 未就緒時一定要給得出下一步：說原因、可重新檢查、能去設定
            <div className="mt-2 min-w-0 overflow-hidden rounded-md border border-line2 bg-panel/60 p-2 text-xs text-mute2">
              <p className="break-words">{t('現在不能派工：{why}', { why: blockedReason() })}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  className="rounded-md border border-line px-2 py-1 text-xs hover:bg-elev disabled:opacity-40"
                  disabled={loading}
                  onClick={refresh}
                >
                  {t('重新檢查')}
                </button>
                {onSetup ? (
                  <button className="rounded-md border border-line px-2 py-1 text-xs hover:bg-elev" onClick={onSetup}>
                    {t('去設定 AI')}
                  </button>
                ) : (
                  // 沒有 onSetup 就不要放按了沒反應的按鈕，直接說去哪裡設定
                  <span className="text-mute3">{t('請用上方標題列的「接入 AI」完成設定。')}</span>
                )}
              </div>
            </div>
          )}
          {tools.some((x) => x.limited === true) && (
            // 有限流工具時才出現這行：解釋「為什麼不能選」之外，
            // 也要讓人知道它不是壞掉、不用做任何事就會回來
            <p className="mt-1.5 text-xs text-mute3">
              {t('標為「額度用完」的工具，確認恢復後會自動解鎖。')}
            </p>
          )}
        </div>
      )}
      {result && (
        <div
          role="status"
          aria-live="polite"
          className={`mt-2 whitespace-pre-wrap text-xs ${result.ok
            ? (result.warn ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')
            : 'text-red-600 dark:text-red-400'}`}
        >
          {result.msg}
        </div>
      )}
    </section>
  )
}
