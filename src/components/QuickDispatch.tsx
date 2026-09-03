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
 */
import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { GUIDE_STEPS, buildOrder } from '@/lib/workOrder'
import type { GuideStep, Msg } from '@/lib/workOrder'

export type DispatchTool = {
  id: string
  label: string
  mode: 'headless' | 'terminal' | 'local'
  limited: boolean
  /** 後端如果給了限流原因就直接顯示；目前 /api/dispatch/tools 沒有這個欄位，會退回通用說明 */
  reason?: string
}

/** 下拉裡每個工具後面那句話。差別在「派出去之後還需不需要你」 */
function modeNote(m: DispatchTool['mode']): string {
  if (m === 'terminal') return t('要你到終端按一下')
  if (m === 'local') return t('不燒雲端額度')
  return t('會自己跑完')
}

export interface QuickDispatchProps {
  conv: { title: string; projectDir: string } | null
  recent: Msg[]
  onToast: (s: string) => void
  disabled?: boolean
}

/**
 * 這是一個「會真的執行工作」的獨立輸入區，不接收聊天輸入框的 value/setter。
 * 兩種意圖在型別層就分開，呼叫端不可能再把提問草稿誤當成工單送出。
 */
export default function QuickDispatch({
  conv, recent, onToast, disabled,
}: QuickDispatchProps) {
  const [tools, setTools] = useState<DispatchTool[]>([])
  const [auto, setAuto] = useState('')
  const [tool, setTool] = useState('auto')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string; warn?: boolean } | null>(null)
  const [withCtx, setWithCtx] = useState(true)
  const [taskDraft, setTaskDraft] = useState('')

  // 引導狀態
  const [guiding, setGuiding] = useState(false)
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Partial<Record<GuideStep['key'], string>>>({})
  const stepRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let gone = false
    fetch('/api/dispatch/tools')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (gone || !d?.ok) return
        setTools(d.tools || [])
        setAuto(d.auto || '')
      })
      .catch(() => { /* 拿不到就退回只有「自動」可選，不要擋住派工 */ })
    return () => { gone = true }
  }, [])

  // 換一份對話就把引導收掉。上一份對話問到一半的答案套到新的對話上，
  // 會產出一份看起來很完整但講的是別件事的工單 —— 那是最難發現的錯。
  useEffect(() => {
    setGuiding(false); setStep(0); setAnswers({}); setResult(null); setTaskDraft('')
  }, [conv?.projectDir, conv?.title])

  useEffect(() => { if (guiding) stepRef.current?.focus() }, [guiding, step])

  const cur = GUIDE_STEPS[step]
  const curVal = (cur && answers[cur.key]) || ''
  const canNext = !!cur && (cur.optional || curVal.trim().length > 0)

  const finishGuide = () => {
    const order = buildOrder(answers, {
      title: conv?.title,
      dir: conv?.projectDir,
      recent: withCtx ? recent : undefined,
    })
    setTaskDraft(order)
    setGuiding(false)
    setStep(0)
    onToast(t('工單已經寫進執行區，可以再修改，確認後按「開始執行」'))
  }

  const send = async () => {
    const task = taskDraft.trim()
    if (!task || sending) return
    if (!window.confirm(t('這會真的交給 AI 執行工作，可能讀寫專案檔案。確定要開始嗎？'))) return
    setSending(true)
    setResult(null)
    try {
      const body: Record<string, unknown> = { tool, task }
      // 工作目錄關係到「這件派工改了什麼」問不問得出來 ——
      // 家目錄不是 git 專案，沒給的話 diff 永遠是空的
      if (conv?.projectDir) body.cwd = conv.projectDir
      const r = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!d?.ok) {
        setResult({ ok: false, msg: d?.error || t('派工失敗') })
        return
      }
      const who = d.tool as string
      const parts: string[] = []
      if (d.rerouted) parts.push(t('{why}，改派給 {to}', { why: d.rerouted.why, to: d.rerouted.to }))
      if (d.mode === 'terminal') {
        parts.push(t('{who} 已經開了終端並帶入指令，但**還沒有人按下去**——要到那個視窗按一下它才會開始。', { who }))
      } else {
        parts.push(t('已經交給 {who}，它會自己跑完。到主控台可以看進度。', { who }))
      }
      setResult({ ok: true, msg: parts.join(' '), warn: d.mode === 'terminal' })
      setTaskDraft('')
    } catch (e) {
      setResult({ ok: false, msg: t('派工失敗：{err}', { err: String(e) }) })
    } finally {
      setSending(false)
    }
  }

  const picked = tools.find((x) => x.id === tool)

  return (
    <section className="mt-3 rounded-lg border border-line2 bg-elev/50 p-3" aria-labelledby="quick-dispatch-title">
      <div className="mb-2">
        <h3 id="quick-dispatch-title" className="text-sm font-semibold">⚡ {t('交給 AI 執行')}</h3>
        <p className="mt-0.5 text-xs text-mute2">{t('這裡會真的開始工作，不是傳送問題。請寫清楚希望 AI 完成什麼。')}</p>
      </div>
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
          <label className="mb-1 block text-sm text-ink2" htmlFor="qd-guide">
            {t(cur.ask)}{cur.optional && <span className="ml-1 text-xs text-mute3">{t('（可以跳過）')}</span>}
          </label>
          <p className="mb-1.5 text-xs text-mute2">{t(cur.hint)}</p>
          <textarea
            id="qd-guide"
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
        <div>
          <label className="mb-1 block text-xs font-medium text-ink2" htmlFor="qd-task">
            {t('要 AI 完成什麼？')}
          </label>
          <textarea
            id="qd-task"
            className="min-h-20 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-line3"
            placeholder={t('例：整理這段對話的結論，更新專案文件，並跑過測試確認沒有問題。')}
            value={taskDraft}
            onChange={(e) => setTaskDraft(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              aria-label={t('派給哪個工具')}
              className="rounded-md border border-line2 bg-panel px-2 py-1 text-xs text-ink2 [&>option]:bg-panel [&>option]:text-ink2"
              value={tool}
              onChange={(e) => setTool(e.target.value)}
            >
              <option value="auto">
                {auto ? t('🤖 自動（現在會給 {who}）', { who: auto }) : t('🤖 自動')}
              </option>
              {tools.map((x) => (
                <option key={x.id} value={x.id} disabled={x.limited}>
                  {/* 頁尾狀態刻意把限流顯示成「閒置（可用）」（畫面寧可說能用、路由寧可當不能用，
                      見 api.py `_limited_tools`），不寫原因的話同一畫面兩種說法，
                      使用者無從判斷到底能不能派 */}
                  {x.label}{x.limited
                    ? t('（額度用完：{reason}）', { reason: x.reason || t('額度狀態無法確認，先當不可用') })
                    : ` — ${modeNote(x.mode)}`}
                </option>
              ))}
            </select>
            <button
              className="rounded-md border border-line px-2 py-1 text-xs hover:bg-elev"
              title={t('不知道工單怎麼寫的話，用四個問題帶你寫完')}
              onClick={() => { setGuiding(true); setStep(0) }}
            >
              🧭 {t('引導我寫')}
            </button>
            {recent.length > 0 && (
              <label className="flex items-center gap-1 text-xs text-mute2">
                <input type="checkbox" checked={withCtx} onChange={(e) => setWithCtx(e.target.checked)} />
                {t('帶上這段對話當背景')}
              </label>
            )}
            <button
              className="ml-auto rounded-md bg-ink px-4 py-2 text-xs font-medium text-invink hover:bg-ink2 disabled:opacity-40"
              disabled={disabled || sending || !taskDraft.trim()}
              title={picked?.mode === 'terminal' ? t('這個工具派出去之後還要你到終端按一下') : undefined}
              onClick={send}
            >
              {sending ? t('正在交付…') : t('開始執行')}
            </button>
          </div>
          {tools.some((x) => x.limited) && (
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
          className={`mt-2 text-xs ${result.ok
            ? (result.warn ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')
            : 'text-red-600 dark:text-red-400'}`}
        >
          {result.msg}
        </div>
      )}
    </section>
  )
}
