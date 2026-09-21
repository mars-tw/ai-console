// ChatGPT Conversation continuation helpers (pure functions; no DOM or network).
import type { Msg } from '@/lib/workOrder'

/**
 * Any indexed conversation may be used as read-only context for a new ChatGPT conversation.
 * `readOnly` and `sourceKind=discovered` still protect the original record from mutation; they do
 * not require a CLI resume or force the user back to the original provider.
 */
export function canOpenContinueWork(conv: object | null | undefined): boolean {
  return !!conv
}

export function continueWorkBlockedReason(conv: object | null | undefined): string | null {
  return conv ? null : '找不到對話'
}

const CTX_MSGS = 6
const CTX_CHARS = 300

/** Recent context: at most six messages and 300 characters per message. */
export function normalizeContextMessages(
  messages: readonly { role?: string; text?: string }[] | null | undefined,
): Msg[] {
  if (!messages?.length) return []
  const out: Msg[] = []
  for (const raw of messages.slice(-CTX_MSGS)) {
    if (!raw || typeof raw !== 'object') continue
    const text = typeof raw.text === 'string' ? raw.text : ''
    out.push({
      role: raw.role === 'assistant' ? 'assistant' : 'user',
      text: text.slice(0, CTX_CHARS),
    })
  }
  return out
}

/** Late context reads cannot update a closed dialog or a different selected conversation. */
export function ownsContinuationContext(input: {
  requestSeq: number
  requestId: number
  conversationId: string
  activeId: string | null
  open: boolean
}): boolean {
  return input.open
    && input.requestSeq === input.requestId
    && input.activeId === input.conversationId
}
