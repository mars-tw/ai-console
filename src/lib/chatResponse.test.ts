import { describe, expect, it } from 'vitest'
import { chatContext, nextChatModel, pickChatAnswer, retryChatHistory } from './chatResponse'

describe('incomplete chat responses', () => {
  it('does not present reasoning or an empty response as a usable answer', () => {
    const draft = pickChatAnswer('  ', 'draft only')
    expect(draft.text).toBe('模型只回了推理過程，沒有給出答案。')
    expect(draft.excludeFromContext).toBe(true)
    expect(pickChatAnswer(null, null).excludeFromContext).toBe(true)
    expect(pickChatAnswer(' final ', 'draft')).toEqual({ text: 'final' })
    expect(chatContext([{ role: 'user', text: 'question' }, { role: 'assistant', ...draft }])).toEqual([{ role: 'user', text: 'question' }])
  })

  it('retries a failed final turn without duplicating the question or discarding later answers', () => {
    const failed = { role: 'assistant', text: 'not an answer', retryText: 'question', retryModel: 'b' }
    const history = [{ role: 'user', text: 'question' }, failed]
    expect(retryChatHistory(history, 1)).toEqual([])
    expect(retryChatHistory([...history, { role: 'user', text: 'later question' }], 1)).toBeNull()
    expect(nextChatModel(['a'], 'a')).toBe('')
    expect(nextChatModel(['a', 'b'], 'a')).toBe('b')
  })
})
