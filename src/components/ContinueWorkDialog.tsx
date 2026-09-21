import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '@/types/data'
import QuickDispatch from '@/components/QuickDispatch'
import { t } from '@/i18n'
import {
  continueWorkBlockedReason,
  normalizeContextMessages,
  ownsContinuationContext,
} from '@/lib/continuationHelp'
import type { Msg } from '@/lib/workOrder'
import type { DevSpaceConversationPreparation } from '@/lib/devspace'

export interface ContinueWorkDialogProps {
  open: boolean
  conversation: ConversationSummary
  onClose: () => void
  onToast: (msg: string) => void
  onPrepareConversation: (request: DevSpaceConversationPreparation) => void
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
const FOCUSABLE = 'textarea:not([disabled]), button:not([disabled]), input:not([disabled]):not([type="hidden"]), summary, a[href]'

function isTrapFocusable(el: HTMLElement): boolean {
  if (el.closest('[hidden]')) return false
  const closedDetails = el.closest('details:not([open])')
  if (closedDetails) return el.tagName === 'SUMMARY' && el.parentElement === closedDetails
  if (el.offsetParent !== null) return true
  if (el.tagName === 'SUMMARY') return true
  const style = window.getComputedStyle(el)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function collectTrapFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isTrapFocusable)
}

/**
 * Continuing an indexed conversation creates a bounded DevSpace prompt. It never calls the old
 * resume command, launches a terminal, posts a dispatch, or claims to restore the original session.
 */
export default function ContinueWorkDialog({
  open,
  conversation,
  onClose,
  onToast,
  onPrepareConversation,
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
  const ctxSeq = useRef(0)
  const openRef = useRef(open)
  const focusedOnOpen = useRef(false)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const focusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [ctx, setCtx] = useState<CtxState>(EMPTY_CTX)

  openRef.current = open
  const blocked = continueWorkBlockedReason(conversation)

  const focusInitialField = useCallback(() => {
    const root = panelRef.current
    if (!root || focusedOnOpen.current || !openRef.current) return
    const task = root.querySelector<HTMLElement>('#cwd-task')
    const first = (task && isTrapFocusable(task) ? task : null) || collectTrapFocusables(root)[0]
    first?.focus()
    focusedOnOpen.current = true
  }, [])

  const runCloseCleanup = useCallback(() => {
    openRef.current = false
    ctxSeq.current += 1
    focusedOnOpen.current = false
    if (focusTimeoutRef.current !== null) {
      clearTimeout(focusTimeoutRef.current)
      focusTimeoutRef.current = null
    }
    const dialog = dialogRef.current
    if (dialog?.open) dialog.close()
    const restore = restoreFocusRef.current
    restoreFocusRef.current = null
    if (!restore) return
    focusTimeoutRef.current = setTimeout(() => {
      focusTimeoutRef.current = null
      if (openRef.current || !restore.isConnected) return
      const active = document.activeElement
      if (active instanceof HTMLElement
        && active !== document.body
        && active !== document.documentElement
        && active !== restore) return
      restore.focus()
    }, 0)
  }, [])

  useEffect(() => {
    if (!open) {
      setCtx(EMPTY_CTX)
      runCloseCleanup()
      return
    }
    openRef.current = true
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    if (focusTimeoutRef.current !== null) clearTimeout(focusTimeoutRef.current)
    focusTimeoutRef.current = setTimeout(focusInitialField, 0)
  }, [open, conversation.id, focusInitialField, runCloseCleanup])

  useLayoutEffect(() => () => { runCloseCleanup() }, [runCloseCleanup])

  useEffect(() => {
    if (!open) return
    const requestId = ++ctxSeq.current
    const conversationId = conversation.id
    const owns = () => ownsContinuationContext({
      requestSeq: ctxSeq.current,
      requestId,
      conversationId,
      activeId: conversation.id,
      open: openRef.current,
    })

    const matchedDetail = detailForId === conversationId && Array.isArray(detailMessages)
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
        error: t('控制 API 離線，無法讀取對話背景。你仍可手動準備 ChatGPT 對話，但不會自動帶入訊息。'),
        unavailable: true,
      })
      return
    }

    const controller = new AbortController()
    setCtx({ loading: true, messages: [], error: '', unavailable: false })
    const load = async () => {
      try {
        const exportedResponse = await fetch(`/data/conv/${encodeURIComponent(conversationId)}.json`, {
          signal: controller.signal,
          cache: 'no-cache',
        })
        if (!exportedResponse.ok) throw new Error(`HTTP ${exportedResponse.status}`)
        const exported = await exportedResponse.json() as { messages?: { role: string; text: string }[]; truncated?: boolean }
        let messages = exported.messages
        if (exported.truncated) {
          const tailResponse = await fetch(`/api/conv/tail?id=${encodeURIComponent(conversationId)}`, {
            signal: controller.signal,
            cache: 'no-store',
          })
          const tail = await tailResponse.json()
          if (!tailResponse.ok || !tail?.ok || !Array.isArray(tail.messages)) throw new Error(tail?.code || 'tail')
          messages = tail.messages
        }
        if (!owns()) return
        const normalized = normalizeContextMessages(messages)
        setCtx({ loading: false, messages: normalized, error: '', unavailable: !normalized.length })
      } catch (error) {
        if ((error as Error)?.name === 'AbortError' || !owns()) return
        setCtx({
          loading: false,
          messages: [],
          error: t('無法讀取這份對話的近期訊息。你仍可手動準備 ChatGPT 對話，但不會自動帶入訊息。'),
          unavailable: true,
        })
      }
    }
    void load()
    return () => controller.abort()
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
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const nodes = collectTrapFocusables(panelRef.current)
      if (!nodes.length) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', trap, true)
    return () => window.removeEventListener('keydown', trap, true)
  }, [open, onClose])

  const contextHint = ctx.loading
    ? t('正在載入這份對話的近期訊息…')
    : ctx.unavailable
      ? (ctx.error || t('這份對話沒有可帶入的近期訊息；仍可建立 ChatGPT 對話草稿。'))
      : t('最多帶入最近 {n} 則訊息（每則最多 300 字）作為背景；這不是恢復原 AI 的完整 session。', { n: ctx.messages.length })

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-50 m-0 box-border h-[100dvh] w-screen max-h-none max-w-[100vw] border-0 bg-transparent p-0 backdrop:bg-black/40 open:flex open:items-center open:justify-center open:overflow-hidden open:p-3 sm:open:p-4"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onCancel={event => { event.preventDefault(); onClose() }}
      onMouseDown={event => { if (event.target === dialogRef.current) onClose() }}
    >
      <div
        ref={panelRef}
        role="document"
        className="flex max-h-[min(calc(100dvh-1.5rem),720px)] w-full min-w-0 max-w-[min(100vw-1.5rem,32rem)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl"
      >
        <header className="flex-none border-b border-line px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold text-ink">{t('在 ChatGPT 對話續作')}</h2>
              <p id={descId} className="mt-1 text-xs leading-5 text-mute2">
                {t('把工作內容、專案路徑與必要背景準備到 DevSpace 分頁，再由你貼入 ChatGPT「對話」。不會呼叫原工具 CLI、resume、背景工單或 auto-handoff。')}
              </p>
            </div>
            <button type="button" className="flex-none rounded-md border border-line px-2.5 py-1.5 text-xs text-mute2 hover:bg-elev" onClick={onClose} aria-label={t('關閉')}>✕</button>
          </div>
          <dl className="mt-3 space-y-1 text-xs text-mute2">
            <div className="flex gap-2"><dt className="flex-none text-mute3">{t('對話')}</dt><dd className="min-w-0 truncate font-medium text-ink2" title={conversation.title}>{conversation.title}</dd></div>
            <div className="flex gap-2"><dt className="flex-none text-mute3">{t('原紀錄工具')}</dt><dd>{conversation.toolLabel}</dd></div>
            <div className="flex gap-2"><dt className="flex-none text-mute3">{t('專案資料夾')}</dt><dd className="min-w-0 break-all font-mono">{conversation.projectDir || t('尚未記錄')}</dd></div>
          </dl>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
          {blocked ? (
            <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">{t(blocked)}</p>
          ) : (
            <section aria-labelledby="cwd-primary-heading" className="min-w-0 overflow-hidden rounded-lg border border-line2 bg-elev/40 p-3">
              <h3 id="cwd-primary-heading" className="text-sm font-semibold text-ink">{t('準備續作指示')}</h3>
              <p className="mt-1 text-xs leading-5 text-mute2">{contextHint}</p>
              {ctx.error && !ctx.loading && <p role="status" className="mt-2 text-xs text-amber-600 dark:text-amber-400">{ctx.error}</p>}
              <QuickDispatch
                key={conversation.id}
                conv={{ title: conversation.title, projectDir: conversation.projectDir }}
                recent={ctx.messages}
                onToast={onToast}
                onPrepareConversation={request => onPrepareConversation({
                  ...request,
                  source: 'continuation',
                  originalTool: conversation.toolLabel || conversation.tool,
                })}
                draft={draft}
                onDraftChange={onDraftChange}
                disabled={ctx.loading}
                initialTool={conversation.toolLabel || conversation.tool}
                inputIdPrefix="cwd"
                embedded
                withContextDefault={!ctx.unavailable && ctx.messages.length > 0}
              />
            </section>
          )}
        </div>
      </div>
    </dialog>
  )
}
