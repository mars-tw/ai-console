import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '@/types/data'
import QuickDispatch from '@/components/QuickDispatch'
import { t } from '@/i18n'
import {
  canOpenContinueWork,
  continueWorkBlockedReason,
  normalizeContextMessages,
  ownsContinuationContext,
  terminalMenuSafetyTips,
  terminalResumeExplanation,
  terminalResumeKind,
} from '@/lib/continuationHelp'
import type { Msg } from '@/lib/workOrder'

export interface ContinueWorkDialogProps {
  open: boolean
  conversation: ConversationSummary
  onClose: () => void
  onToast: (msg: string) => void
  onSetup?: () => void
  apiOk: boolean
  draft: string
  onDraftChange: (value: string) => void
  /** 若 Home 已載入且 id 相符，直接沿用，避免重抓。 */
  detailMessages?: { role: string; text: string }[] | null
  detailLoading?: boolean
  detailForId?: string | null
  detailTailError?: string
}

type CtxState = {
  loading: boolean
  messages: Msg[]
  error: string
  unavailable: boolean
}

const EMPTY_CTX: CtxState = { loading: false, messages: [], error: '', unavailable: false }

const FOCUSABLE = 'textarea:not([disabled]), button:not([disabled]), select:not([disabled]), input:not([disabled]):not([type="hidden"]), summary, a[href]'

function isTrapFocusable(el: HTMLElement): boolean {
  if (el.closest('[hidden]')) return false
  const closedDetails = el.closest('details:not([open])')
  if (closedDetails) {
    return el.tagName === 'SUMMARY' && el.parentElement === closedDetails
  }
  if (el.offsetParent !== null) return true
  if (el.tagName === 'SUMMARY') return true
  const style = window.getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function collectTrapFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isTrapFocusable)
}

export default function ContinueWorkDialog({
  open,
  conversation,
  onClose,
  onToast,
  onSetup,
  apiOk,
  draft,
  onDraftChange,
  detailMessages,
  detailLoading = false,
  detailForId,
  detailTailError = '',
}: ContinueWorkDialogProps) {
  const titleId = useId()
  const descId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const taskInputId = 'cwd-task'
  const launchSeq = useRef(0)
  const launchInFlight = useRef(false)
  const ctxSeq = useRef(0)
  const openRef = useRef(open)
  const focusedOnOpen = useRef(false)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const focusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [ctx, setCtx] = useState<CtxState>(EMPTY_CTX)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [terminalPhase, setTerminalPhase] = useState<'idle' | 'opening' | 'opened' | 'failed'>('idle')
  const [terminalStatus, setTerminalStatus] = useState('')
  const [terminalCmd, setTerminalCmd] = useState('')

  openRef.current = open

  const blocked = continueWorkBlockedReason(conversation)
  const canWork = canOpenContinueWork(conversation)

  const resetTerminal = useCallback(() => {
    setTerminalPhase('idle')
    setTerminalStatus('')
    setTerminalCmd('')
  }, [])

  const focusInitialField = useCallback(() => {
    const root = panelRef.current
    if (!root || focusedOnOpen.current || !openRef.current) return
    const nodes = collectTrapFocusables(root)
    const task = root.querySelector<HTMLElement>(`#${taskInputId}`)
    const first = (task && isTrapFocusable(task) ? task : null) || nodes[0]
    first?.focus()
    focusedOnOpen.current = true
  }, [taskInputId])

  const runCloseCleanup = useCallback(() => {
    openRef.current = false
    ctxSeq.current += 1
    launchSeq.current += 1
    launchInFlight.current = false
    focusedOnOpen.current = false
    if (focusTimeoutRef.current !== null) {
      clearTimeout(focusTimeoutRef.current)
      focusTimeoutRef.current = null
    }
    // Close while still attached so native <dialog> teardown runs before unmount.
    const el = dialogRef.current
    if (el?.open) el.close()
    const restore = restoreFocusRef.current
    restoreFocusRef.current = null
    // Defer past native close/unmount focus restitution; skip if reopened or user moved on.
    if (!restore) return
    focusTimeoutRef.current = setTimeout(() => {
      focusTimeoutRef.current = null
      if (openRef.current || !restore.isConnected) return
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement &&
        active !== restore
      ) {
        return
      }
      restore.focus()
    }, 0)
  }, [])

  useEffect(() => {
    if (!open) {
      setCtx(EMPTY_CTX)
      setAdvancedOpen(false)
      resetTerminal()
      runCloseCleanup()
      return
    }
    openRef.current = true
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    resetTerminal()
    const el = dialogRef.current
    if (el && !el.open) el.showModal()
    if (focusTimeoutRef.current !== null) clearTimeout(focusTimeoutRef.current)
    focusTimeoutRef.current = setTimeout(focusInitialField, 0)
  }, [open, conversation.id, resetTerminal, focusInitialField, runCloseCleanup])

  // Layout cleanup: dialog still in DOM — close before detachment, then deferred restore.
  useLayoutEffect(() => () => { runCloseCleanup() }, [runCloseCleanup])

  useEffect(() => {
    if (!open) return
    const requestId = ++ctxSeq.current
    const convId = conversation.id

    const matchedDetail = detailForId === convId && Array.isArray(detailMessages)
    if (matchedDetail) {
      if (detailLoading) {
        setCtx({ loading: true, messages: [], error: '', unavailable: false })
        return
      }
      const normalized = normalizeContextMessages(detailMessages)
      setCtx({
        loading: false,
        messages: normalized,
        error: detailTailError,
        unavailable: !normalized.length && !conversation.hasMessages,
      })
      return
    }

    if (!conversation.hasMessages) {
      setCtx({ loading: false, messages: [], error: '', unavailable: true })
      return
    }

    if (!apiOk) {
      setCtx({
        loading: false,
        messages: [],
        error: t('控制 API 離線，無法讀取對話背景。你仍可手動寫工單，但不會自動帶入訊息。'),
        unavailable: true,
      })
      return
    }

    const ac = new AbortController()
    setCtx({ loading: true, messages: [], error: '', unavailable: false })

    const load = async () => {
      try {
        const exportedRes = await fetch(`/data/conv/${encodeURIComponent(convId)}.json`, {
          signal: ac.signal,
          cache: 'no-cache',
        })
        if (ac.signal.aborted) return
        if (!exportedRes.ok) throw new Error(`HTTP ${exportedRes.status}`)
        const exported = await exportedRes.json() as { messages?: { role: string; text: string }[]; truncated?: boolean }
        let messages = exported.messages
        if (exported.truncated) {
          const tailRes = await fetch(`/api/conv/tail?id=${encodeURIComponent(convId)}`, {
            signal: ac.signal,
            cache: 'no-store',
          })
          if (ac.signal.aborted) return
          const tail = await tailRes.json()
          if (!tailRes.ok || !tail?.ok || !Array.isArray(tail.messages)) {
            throw new Error(tail?.code || 'tail')
          }
          messages = tail.messages
        }
        if (!ownsContinuationContext({
          requestSeq: ctxSeq.current,
          requestId,
          conversationId: convId,
          activeId: conversation.id,
          open: openRef.current,
        })) return
        const normalized = normalizeContextMessages(messages)
        setCtx({
          loading: false,
          messages: normalized,
          error: '',
          unavailable: !normalized.length,
        })
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return
        if (!ownsContinuationContext({
          requestSeq: ctxSeq.current,
          requestId,
          conversationId: convId,
          activeId: conversation.id,
          open: openRef.current,
        })) return
        setCtx({
          loading: false,
          messages: [],
          error: t('無法讀取這份對話的近期訊息。你仍可手動寫工單，但不會自動帶入訊息。'),
          unavailable: true,
        })
      }
    }
    void load()
    return () => ac.abort()
  }, [
    open,
    conversation.id,
    conversation.hasMessages,
    apiOk,
    detailForId,
    detailMessages,
    detailLoading,
    detailTailError,
  ])

  useEffect(() => {
    if (!open) return
    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const nodes = collectTrapFocusables(panelRef.current)
      if (!nodes.length) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    const blockBgShortcuts = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', trap, true)
    window.addEventListener('keydown', blockBgShortcuts, true)
    return () => {
      window.removeEventListener('keydown', trap, true)
      window.removeEventListener('keydown', blockBgShortcuts, true)
    }
  }, [open, onClose])

  const launchTerminal = async () => {
    if (!canWork || !apiOk || launchInFlight.current || !openRef.current) return
    if (terminalResumeKind(conversation.tool) === 'unsupported') {
      setTerminalPhase('failed')
      setTerminalStatus(t(terminalResumeExplanation(conversation.tool)))
      return
    }
    launchInFlight.current = true
    const requestId = ++launchSeq.current
    setTerminalPhase('opening')
    setTerminalStatus(t('正在開啟原工具終端機…'))
    try {
      const r = await fetch('/api/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: conversation.id }),
      })
      const d = await r.json().catch(() => null) as { ok?: boolean; error?: string; cmd?: string } | null
      if (requestId !== launchSeq.current || !openRef.current) return
      if (r.ok && d?.ok === true) {
        setTerminalPhase('opened')
        setTerminalStatus(t('已開啟終端機視窗。這只代表視窗打開了，工作尚未開始，也尚未完成。'))
        if (typeof d.cmd === 'string') setTerminalCmd(d.cmd)
        return
      }
      const err = typeof d?.error === 'string' ? d.error : t('無法啟動')
      setTerminalPhase('failed')
      setTerminalStatus(t('無法開啟：{err}', { err }))
      if (typeof d?.cmd === 'string') setTerminalCmd(d.cmd)
    } catch {
      if (requestId !== launchSeq.current || !openRef.current) return
      setTerminalPhase('failed')
      setTerminalStatus(t('控制 API 無回應'))
    } finally {
      if (requestId === launchSeq.current) launchInFlight.current = false
    }
  }

  const copyCmd = async () => {
    if (!terminalCmd) return
    try {
      await navigator.clipboard.writeText(terminalCmd)
      onToast(t('已複製接續指令'))
    } catch {
      onToast(t('複製失敗，請手動選取指令'))
    }
  }

  const ctxHint = ctx.loading
    ? t('正在載入這份對話的近期訊息…')
    : ctx.unavailable
      ? (ctx.error || t('這份對話沒有可帶入的近期訊息；仍可建立新工單，但不會附上舊對話背景。'))
      : t('將建立新工單，最多附帶最近 {n} 則訊息（每則最多 300 字）作為背景，不是恢復原 AI 的完整對話。', { n: ctx.messages.length })

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-50 m-0 box-border h-[100dvh] w-screen max-h-none max-w-[100vw] border-0 bg-transparent p-0 backdrop:bg-black/40 open:flex open:items-center open:justify-center open:overflow-hidden open:p-3 sm:open:p-4"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onMouseDown={(e) => { if (e.target === dialogRef.current) onClose() }}
    >
      <div
        ref={panelRef}
        role="document"
        className="flex max-h-[min(calc(100dvh-1.5rem),720px)] w-full min-w-0 max-w-[min(100vw-1.5rem,28rem)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl"
      >
        <header className="flex-none border-b border-line px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold text-ink">{t('繼續工作')}</h2>
              <p id={descId} className="mt-1 text-xs leading-5 text-mute2">
                {t('在控制台內建立新工單並交給不用操作英文視窗的 AI；不會自動打開英文終端機，也不會恢復原 AI 的完整對話。')}
              </p>
            </div>
            <button
              type="button"
              className="flex-none rounded-md border border-line px-2.5 py-1.5 text-xs text-mute2 hover:bg-elev"
              onClick={onClose}
              aria-label={t('關閉')}
            >
              ✕
            </button>
          </div>
          <dl className="mt-3 space-y-1 text-xs text-mute2">
            <div className="flex gap-2">
              <dt className="flex-none text-mute3">{t('對話')}</dt>
              <dd className="min-w-0 truncate font-medium text-ink2" title={conversation.title}>{conversation.title}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="flex-none text-mute3">{t('原工具')}</dt>
              <dd>{conversation.toolLabel}</dd>
            </div>
          </dl>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
          {blocked ? (
            <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {t(blocked)}
            </p>
          ) : (
            <>
              <section aria-labelledby="cwd-primary-heading" className="min-w-0 overflow-hidden rounded-lg border border-line2 bg-elev/40 p-3">
                <h3 id="cwd-primary-heading" className="text-sm font-semibold text-ink">{t('建立新工單（建議）')}</h3>
                <p className="mt-1 text-xs leading-5 text-mute2">{ctxHint}</p>
                {ctx.error && !ctx.loading && (
                  <p role="status" className="mt-2 text-xs text-amber-600 dark:text-amber-400">{ctx.error}</p>
                )}
                <QuickDispatch
                  key={conversation.id}
                  conv={{ title: conversation.title, projectDir: conversation.projectDir }}
                  recent={ctx.messages}
                  onToast={onToast}
                  onSetup={onSetup}
                  draft={draft}
                  onDraftChange={onDraftChange}
                  disabled={ctx.loading}
                  headlessOnly
                  initialTool={conversation.tool}
                  expectedMode="headless"
                  inputIdPrefix="cwd"
                  embedded
                  withContextDefault={!ctx.unavailable && ctx.messages.length > 0}
                />
              </section>

              <details
                className="mt-3 rounded-lg border border-line px-3 py-2"
                open={advancedOpen}
                onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
              >
                <summary tabIndex={0} className="cursor-pointer text-sm font-medium text-ink2">
                  {t('原工具終端機（進階）')}
                </summary>
                <div className="mt-2 space-y-2 text-xs leading-5 text-mute2">
                  <p>{t(terminalResumeExplanation(conversation.tool))}</p>
                  <ul className="list-disc space-y-1 pl-4">
                    {terminalMenuSafetyTips().map((tip) => (
                      <li key={tip}>{t(tip)}</li>
                    ))}
                  </ul>
                  {terminalPhase === 'opened' ? (
                    <div className="rounded-md border border-line2 bg-panel/80 p-2">
                      <p role="status" className="text-ink2">{terminalStatus}</p>
                      {terminalCmd && (
                        <button
                          type="button"
                          className="mt-2 rounded border border-line px-2 py-1 text-xs hover:bg-elev"
                          onClick={() => void copyCmd()}
                        >
                          {t('複製接續指令（選用）')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="mt-2 block rounded-md bg-ink px-3 py-1.5 text-xs text-invink hover:bg-ink2"
                        onClick={() => { resetTerminal(); setAdvancedOpen(false) }}
                      >
                        {t('返回中文工作區')}
                      </button>
                    </div>
                  ) : (
                    <>
                      {terminalStatus && (
                        <p role="status" className={terminalPhase === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-mute2'}>
                          {terminalStatus}
                        </p>
                      )}
                      {terminalCmd && terminalPhase === 'failed' && (
                        <button
                          type="button"
                          className="rounded border border-line px-2 py-1 text-xs hover:bg-elev"
                          onClick={() => void copyCmd()}
                        >
                          {t('複製接續指令（選用）')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink2 hover:bg-elev disabled:opacity-40"
                        disabled={!apiOk || terminalPhase === 'opening' || !conversation.resume}
                        onClick={() => void launchTerminal()}
                      >
                        {terminalPhase === 'opening' ? t('開啟中…') : t('開啟原工具終端機')}
                      </button>
                      {!apiOk && <p className="text-amber-600">{t('控制 API 離線，無法開啟終端機。')}</p>}
                    </>
                  )}
                </div>
              </details>
            </>
          )}
        </div>
      </div>
    </dialog>
  )
}
