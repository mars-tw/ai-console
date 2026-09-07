import { describe, expect, it } from 'vitest'
import { askEndpoint, askMessages } from './AskAI'

describe('Ask AI request boundary', () => {
  it('keeps builtin LM Studio on the guarded chat endpoint and saved AI on its own endpoint', () => {
    expect(askEndpoint()).toBe('/api/chat')
    expect(askEndpoint('')).toBe('/api/chat')
    expect(askEndpoint('custom-ai-1')).toBe('/api/ai-connections/chat')
  })
  it('uses an answer-only system boundary and keeps the current question last', () => {
    const messages = askMessages([{ role: 'assistant', text: '前一題' }], '新問題')
    expect(messages[0].content).toContain('只負責回答問題')
    expect(messages[0].content).toContain('不要呼叫工具')
    expect(messages.at(-1)).toEqual({ role: 'user', content: '新問題' })
  })

  it('uses an English answer-only boundary when the UI is English', () => {
    const messages = askMessages([], 'What does this mean?', 'en')
    expect(messages[0].content).toContain('Only answer the question')
    expect(messages[0].content).toContain('Reply in clear English')
    expect(messages[0].content).not.toContain('繁體中文')
  })

  it('excludes reasoning-only and error placeholders from future question context', () => {
    const messages = askMessages([
      { role: 'user', text: 'previous question' },
      { role: 'assistant', text: 'no answer', reasoning: 'unfinished draft' },
      { role: 'assistant', text: 'transport failed', excludeFromContext: true },
    ], 'new question')
    expect(messages.map(message => message.content)).not.toContain('no answer')
    expect(messages.map(message => message.content)).not.toContain('transport failed')
    expect(messages.at(-1)?.content).toBe('new question')
  })
})
