import { t } from '@/i18n'

export interface ChatResponseMessage {
  role: string
  text: string
  reasoning?: string
  excludeFromContext?: boolean
  retryText?: string
  retryModel?: string
}

/** A draft or transport error must never become an assistant answer in the next request. */
export function pickChatAnswer(content: unknown, reasoning: unknown): Pick<ChatResponseMessage, 'text' | 'reasoning' | 'excludeFromContext'> {
  const text = typeof content === 'string' ? content.trim() : ''
  if (text) return { text }
  const draft = typeof reasoning === 'string' ? reasoning.trim() : ''
  return draft
    ? { text: t('模型只回了推理過程，沒有給出答案。'), reasoning: draft, excludeFromContext: true }
    : { text: t('（空回應）'), excludeFromContext: true }
}

export function chatContext<T extends ChatResponseMessage>(history: T[]): T[] {
  return history.filter(message => !message.excludeFromContext && !message.reasoning)
}

export function nextChatModel(models: string[], used: string): string {
  return models.find(model => model !== used) || ''
}

/** Only retry the last turn: retrying an older failure must not delete later messages. */
export function retryChatHistory<T extends ChatResponseMessage>(history: T[], index: number): T[] | null {
  if (index !== history.length - 1 || index < 1) return null
  const failed = history[index]
  const previous = history[index - 1]
  if (!failed.retryText || !failed.retryModel || previous.role !== 'user' || previous.text !== failed.retryText) return null
  return history.slice(0, index - 1)
}
