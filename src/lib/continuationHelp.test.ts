import { describe, expect, it } from 'vitest'
import {
  canOpenContinueWork,
  continueWorkBlockedReason,
  normalizeContextMessages,
  ownsContinuationContext,
} from './continuationHelp'

describe('ChatGPT continuation eligibility', () => {
  it('allows read-only and discovered records as bounded context without mutating their source', () => {
    expect(canOpenContinueWork({ readOnly: true })).toBe(true)
    expect(canOpenContinueWork({ sourceKind: 'discovered' })).toBe(true)
    expect(canOpenContinueWork({})).toBe(true)
    expect(canOpenContinueWork(null)).toBe(false)
    expect(continueWorkBlockedReason({ readOnly: true })).toBeNull()
    expect(continueWorkBlockedReason(null)).toBe('找不到對話')
  })
})

describe('normalizeContextMessages', () => {
  it('keeps only the six most recent messages and 300 characters per message', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: 'user', text: `m${i}${'x'.repeat(400)}` }))
    const out = normalizeContextMessages(msgs)
    expect(out).toHaveLength(6)
    expect(out[0].text).toHaveLength(300)
    expect(out[0].text.startsWith('m4')).toBe(true)
  })

  it('normalizes roles and safely ignores malformed entries', () => {
    expect(normalizeContextMessages([
      null as unknown as { role: string; text: string },
      { role: 'tool', text: 'tool output' },
      { role: 'assistant' },
    ])).toEqual([
      { role: 'user', text: 'tool output' },
      { role: 'assistant', text: '' },
    ])
  })
})

describe('ownsContinuationContext', () => {
  it('invalidates late results after closing or switching conversations', () => {
    expect(ownsContinuationContext({
      requestSeq: 2,
      requestId: 2,
      conversationId: 'a',
      activeId: 'a',
      open: true,
    })).toBe(true)
    expect(ownsContinuationContext({
      requestSeq: 3,
      requestId: 2,
      conversationId: 'a',
      activeId: 'a',
      open: true,
    })).toBe(false)
    expect(ownsContinuationContext({
      requestSeq: 2,
      requestId: 2,
      conversationId: 'a',
      activeId: 'b',
      open: true,
    })).toBe(false)
    expect(ownsContinuationContext({
      requestSeq: 2,
      requestId: 2,
      conversationId: 'a',
      activeId: 'a',
      open: false,
    })).toBe(false)
  })
})
