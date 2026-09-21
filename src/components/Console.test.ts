import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Console, { canDispatchAll, isLocalAnswerRecord, planReplyMessage } from './Console'
import type { ReadinessSnapshot, ReadinessTool } from '@/lib/aiReadiness'

const src = readFileSync(new URL('./Console.tsx', import.meta.url), 'utf8')
const home = readFileSync(new URL('../pages/Home.tsx', import.meta.url), 'utf8')

const tool = (id: string, over: Partial<ReadinessTool> = {}): ReadinessTool =>
  ({ id, label: id, mode: 'headless', ready: true, limited: false, state: 'ready', ...over })
const snap = (tools: ReadinessTool[], auto: string | null = null): ReadinessSnapshot =>
  ({ ok: true, tools, auto, ready: auto !== null, reason: '' })

describe('legacy compatibility formatters', () => {
  it('keeps readiness parsing fail-closed for old callers', () => {
    expect(canDispatchAll(['claude'], snap([tool('claude')]))).toBe(true)
    expect(canDispatchAll(['auto'], snap([tool('claude')], 'claude'))).toBe(true)
    expect(canDispatchAll(['claude'], null)).toBe(false)
    expect(canDispatchAll(['claude'], snap([tool('claude', { limited: true })]))).toBe(false)
    expect(canDispatchAll(['claude'], snap([tool('claude'), tool('claude')]))).toBe(false)
  })

  it('formats only public string fields from old responses', () => {
    expect(planReplyMessage({ error: ' A ', note: 'B', nextAction: 'C' })).toBe('A・B・C')
    expect(planReplyMessage({ error: { code: 500 }, note: ['x'] })).toBe('')
    expect(planReplyMessage(null)).toBe('')
  })

  it('distinguishes local answer records', () => {
    expect(isLocalAnswerRecord({ tool: 'local', mode: 'headless' })).toBe(true)
    expect(isLocalAnswerRecord({ tool: 'claude', mode: 'sync' })).toBe(true)
    expect(isLocalAnswerRecord({ tool: 'claude', mode: 'headless' })).toBe(false)
  })
})

describe('Console unified ChatGPT execution route', () => {
  it('renders preparation and read-only legacy history language', () => {
    const html = renderToStaticMarkup(createElement(Console, {
      draft: '修正測試',
      onDraftChange: () => undefined,
      onPrepareConversation: () => undefined,
    }))
    expect(html).toContain('執行準備與舊派工紀錄')
    expect(html).toContain('修正測試')
    expect(html).toContain('準備 ChatGPT 對話')
    expect(html).toContain('舊派工紀錄（唯讀）')
    expect(html).not.toContain('全部派出')
    expect(html).not.toContain('分析並排程')
    expect(html).not.toContain('另開終端')
  })

  it('contains no new-work, retry, followup, schedule-run or launch POST route', () => {
    for (const forbidden of [
      '/api/dispatch/batch',
      '/api/dispatch/followup',
      '/api/dispatch/retry',
      '/api/schedule/run',
      '/api/schedule/save',
      '/api/launch',
      'acPty',
      'LiveTerminal',
    ]) expect(src).not.toContain(forbidden)
    expect(src).not.toMatch(/fetch\(['"]\/api\/dispatch['"]/)
    expect(src).toContain("fetch('/api/dispatches'")
    expect(src).toContain("action: 'stop' | 'cancel'")
    expect(src).toContain('`/api/dispatch/${action}`')
  })

  it('routes new, retry, follow-up and schedule records into the shared callback', () => {
    expect(src).toContain("source: 'new-work'")
    expect(src).toContain("source: 'legacy-retry'")
    expect(src).toContain("source: 'legacy-followup'")
    expect(src).toContain("source: 'schedule'")
    expect(src).toContain('onPrepareConversation(request)')
    expect(src).toContain('沒有建立或接續任何 CLI 工單')
  })

  it('Home passes the same preparation callback to both Console instances', () => {
    const tags = home.match(/<Console[\s\S]*?\/>/g) || []
    expect(tags).toHaveLength(2)
    for (const tag of tags) {
      expect(tag).toContain('draft={consoleDraft}')
      expect(tag).toContain('onDraftChange={setConsoleDraft}')
      expect(tag).toContain('onPrepareConversation={prepareChatGPTConversation}')
    }
  })
})
