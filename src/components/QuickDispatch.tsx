/* eslint-disable react-refresh/only-export-components -- preparation helpers are verified without a DOM */
import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { GUIDE_STEPS, buildOrder } from '@/lib/workOrder'
import type { GuideStep, Msg } from '@/lib/workOrder'
import type { DevSpaceConversationPreparation } from '@/lib/devspace'

/** Kept as a public display type for older read-only status views. */
export type DispatchTool = {
  id: string
  label: string
  mode: 'headless' | 'terminal' | 'local'
  limited: boolean
  reason?: string
  ready?: boolean
  state?: string
  readiness?: string
  authStatus?: string
}

export interface QuickDispatchProps {
  conv: { title: string; projectDir: string } | null
  recent: Msg[]
  onToast: (s: string) => void
  onPrepareConversation?: (request: DevSpaceConversationPreparation) => void
  disabled?: boolean
  draft?: string
  onDraftChange?: (value: string) => void
  inputIdPrefix?: string
  embedded?: boolean
  withContextDefault?: boolean
  /** Original tool is display/context only; it is never selected as an executor. */
  initialTool?: string
}

export function buildQuickConversationPreparation(input: {
  task: string
  conv: QuickDispatchProps['conv']
  recent?: readonly Msg[]
  withContext?: boolean
  originalTool?: string
  source?: DevSpaceConversationPreparation['source']
}): DevSpaceConversationPreparation {
  return {
    task: input.task.trim(),
    ...(input.conv?.projectDir ? { workspace: input.conv.projectDir } : {}),
    ...(input.conv?.title ? { title: input.conv.title } : {}),
    ...(input.originalTool ? { originalTool: input.originalTool } : {}),
    source: input.source || 'new-work',
    context: input.withContext === false
      ? []
      : (input.recent || []).map(message => ({ role: message.role, text: message.text })),
  }
}

/**
 * This panel only prepares a bounded ChatGPT Conversation request. It never posts a job,
 * chooses an execution provider, resumes a CLI session, or clears the user's draft.
 */
export default function QuickDispatch({
  conv,
  recent,
  onToast,
  onPrepareConversation,
  disabled,
  draft,
  onDraftChange,
  inputIdPrefix,
  embedded,
  withContextDefault,
  initialTool,
}: QuickDispatchProps) {
  const [localDraft, setLocalDraft] = useState('')
  const controlled = typeof draft === 'string'
  const taskDraft = controlled ? draft : localDraft
  const writeDraft = (value: string) => {
    if (!controlled) setLocalDraft(value)
    onDraftChange?.(value)
  }

  const [guiding, setGuiding] = useState(false)
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Partial<Record<GuideStep['key'], string>>>({})
  const stepRef = useRef<HTMLTextAreaElement>(null)
  const [withContextOverride, setWithContextOverride] = useState<boolean | null>(null)
  const withContext = withContextOverride ?? (withContextDefault ?? true)
  const [notice, setNotice] = useState('')

  useEffect(() => { if (guiding) stepRef.current?.focus() }, [guiding, step])

  const current = GUIDE_STEPS[step]
  const currentValue = (current && answers[current.key]) || ''
  const canNext = !!current && (current.optional || currentValue.trim().length > 0)

  const finishGuide = () => {
    writeDraft(buildOrder(answers))
    setGuiding(false)
    setStep(0)
    setNotice(t('工作內容已整理完成；確認後準備 ChatGPT 對話。'))
  }

  const prepare = () => {
    const task = taskDraft.trim()
    if (!task || disabled || !onPrepareConversation) return
    onPrepareConversation(buildQuickConversationPreparation({
      task,
      conv,
      recent,
      withContext,
      originalTool: initialTool,
      source: initialTool ? 'continuation' : 'new-work',
    }))
    const message = t('已準備 ChatGPT 對話草稿；尚未貼上、送出或執行任何工作。')
    setNotice(message)
    onToast(message)
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
          <h3 id="quick-dispatch-title" className="text-sm font-semibold">💬 {t('準備 ChatGPT 執行對話')}</h3>
          <p className="mt-0.5 text-xs leading-5 text-mute2">
            {t('這裡只整理專案與工作指示，之後會帶你到 ChatGPT「對話」使用 DevSpace MCP；不會在背景建立 CLI 工單。')}
          </p>
        </div>
      )}

      {guiding && current ? (
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-sm font-medium">🧭 {t('一步一步把工作指示寫清楚')}</span>
            <span className="text-xs text-mute3">{step + 1} / {GUIDE_STEPS.length}</span>
            <button type="button" className="ml-auto rounded px-2 py-1 text-xs text-mute3 hover:text-ink3" onClick={() => { setGuiding(false); setStep(0) }}>
              {t('關掉')}
            </button>
          </div>
          <label className="mb-1 block text-sm text-ink2" htmlFor={guideInputId}>
            {t(current.ask)}{current.optional && <span className="ml-1 text-xs text-mute3">{t('（可以跳過）')}</span>}
          </label>
          <p className="mb-1.5 text-xs text-mute2">{t(current.hint)}</p>
          <textarea
            id={guideInputId}
            ref={stepRef}
            className="min-h-16 w-full rounded-md border border-line bg-transparent px-3 py-2 text-sm outline-none focus:border-line3"
            placeholder={t('例：{eg}', { eg: t(current.eg) })}
            value={currentValue}
            onChange={event => setAnswers({ ...answers, [current.key]: event.target.value })}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canNext) {
                event.preventDefault()
                if (step === GUIDE_STEPS.length - 1) finishGuide()
                else setStep(step + 1)
              }
            }}
          />
          <div className="mt-1.5 flex items-center gap-2">
            {step > 0 && <button type="button" className="rounded-md border border-line px-2 py-1 text-xs hover:bg-elev" onClick={() => setStep(step - 1)}>{t('← 上一步')}</button>}
            {current.optional && !currentValue.trim() && (
              <button type="button" className="rounded-md px-2 py-1 text-xs text-mute2 hover:text-ink3" onClick={() => (step === GUIDE_STEPS.length - 1 ? finishGuide() : setStep(step + 1))}>
                {t('這題跳過')}
              </button>
            )}
            <button type="button" className="ml-auto rounded-md bg-ink px-3 py-1.5 text-xs text-invink hover:bg-ink2 disabled:opacity-40" disabled={!canNext} onClick={() => (step === GUIDE_STEPS.length - 1 ? finishGuide() : setStep(step + 1))}>
              {step === GUIDE_STEPS.length - 1 ? t('產生工作指示') : t('下一步 →')}
            </button>
          </div>
        </div>
      ) : (
        <div className="min-w-0">
          <label className="mb-1 block text-xs font-medium text-ink2" htmlFor={taskInputId}>{t('要在 ChatGPT 對話完成什麼？')}</label>
          <textarea
            id={taskInputId}
            className="min-h-20 w-full max-w-full rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-line3"
            placeholder={t('例：整理這段對話的結論，更新專案文件，並跑過測試確認沒有問題。')}
            value={taskDraft}
            disabled={disabled}
            onChange={event => writeDraft(event.target.value)}
          />
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
            <button type="button" className="shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-elev" title={t('不知道工作指示怎麼寫的話，用四個問題帶你寫完')} onClick={() => { setGuiding(true); setStep(0) }}>
              🧭 {t('引導我寫')}
            </button>
            {recent.length > 0 && (
              <label className="flex items-center gap-1 text-xs text-mute2">
                <input type="checkbox" checked={withContext} onChange={event => setWithContextOverride(event.target.checked)} />
                {t('帶上這段對話的近期必要背景')}
              </label>
            )}
            <button
              type="button"
              className="ml-auto shrink-0 rounded-md bg-ink px-4 py-2 text-xs font-medium text-invink hover:bg-ink2 disabled:opacity-40"
              disabled={disabled || !taskDraft.trim() || !onPrepareConversation}
              onClick={prepare}
            >
              {t('準備 ChatGPT 對話')}
            </button>
          </div>
          {!onPrepareConversation && <p className="mt-2 text-xs text-mute3">{t('請從 AI 控制台的 DevSpace 分頁準備執行對話。')}</p>}
        </div>
      )}

      {notice && <p role="status" aria-live="polite" className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
    </section>
  )
}
