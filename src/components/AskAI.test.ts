import { describe, expect, it } from 'vitest'
import { askMessages } from './AskAI'

describe('Ask AI request boundary', () => {
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
})
