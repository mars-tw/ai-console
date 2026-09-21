import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MobileApp, {
  attemptControl,
  attemptDispatch,
  canFollowupRecord,
  isAnswerOnlyTool,
  isLocalAnswerRecord,
  readinessFromProps,
  STALE_PAIRING_NOTE,
  type ConsoleDispatch,
  type DispatchTool,
} from './MobileApp'

const src = readFileSync(new URL('./MobileApp.tsx', import.meta.url), 'utf8')

const record: ConsoleDispatch = {
  id: 'old-1',
  tool: 'claude',
  task: '修正型別錯誤',
  started: '20260904-091500',
  log: '',
  mode: 'headless',
  state: 'done',
  cwd: 'C:\\work',
}

const tools: DispatchTool[] = [{
  id: 'claude', label: 'Claude', mode: 'headless', ready: true,
  limited: false, state: 'ready',
}]

beforeEach(() => vi.restoreAllMocks())

describe('legacy helper boundaries', () => {
  it('keeps old readiness parsing fail-closed without using it to dispatch', () => {
    expect(readinessFromProps()).toMatchObject({ ok: false, auto: null, tools: [] })
    expect(readinessFromProps(tools, 'claude')).toMatchObject({ ok: true, auto: 'claude' })
    expect(isAnswerOnlyTool('local', [])).toBe(true)
    expect(isAnswerOnlyTool('claude', tools)).toBe(false)
  })

  it('recognizes answer-only records and excludes them from continuation controls', () => {
    expect(isLocalAnswerRecord({ tool: 'local', mode: 'headless' })).toBe(true)
    expect(isLocalAnswerRecord({ tool: 'claude', mode: 'sync' })).toBe(true)
    expect(canFollowupRecord({ tool: 'claude', mode: 'headless' })).toBe(true)
    expect(canFollowupRecord({ tool: 'local', mode: 'sync' })).toBe(false)
  })

  it('attemptDispatch never reads readiness, opens confirmation, or posts a job', async () => {
    const fetcher = vi.fn()
    const confirm = vi.fn()
    const result = await attemptDispatch('auto', '更新專案', { fetch: fetcher as unknown as typeof fetch, confirm })
    expect(result).toMatchObject({ posted: false, ok: false, stale: false })
    expect(result.message).toContain('ChatGPT')
    expect(fetcher).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('attemptDispatch preserves stale pairing semantics without network access', async () => {
    const fetcher = vi.fn()
    const result = await attemptDispatch('claude', '更新專案', {
      fetch: fetcher as unknown as typeof fetch,
      isCurrent: () => false,
    })
    expect(result.stale).toBe(true)
    expect(result.posted).toBe(false)
    expect(result.message).toBe('')
    expect(fetcher).not.toHaveBeenCalled()
    expect(STALE_PAIRING_NOTE()).toContain('配對已變更')
  })
})

describe('legacy record controls', () => {
  it.each(['retry', 'followup'] as const)('%s returns the ChatGPT route without POST', async action => {
    const fetcher = vi.fn()
    const result = await attemptControl(action, record, {
      fetch: fetcher as unknown as typeof fetch,
      text: action === 'followup' ? '補一句' : undefined,
    })
    expect(result).toMatchObject({ posted: false, ok: false, stale: false })
    expect(result.message).toContain('ChatGPT')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['stop', 'cancel'] as const)('%s may operate an already-existing legacy record', async action => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, note: 'done' }),
    })
    const result = await attemptControl(action, record, {
      fetch: fetcher as unknown as typeof fetch,
      confirm: () => true,
    })
    expect(result).toMatchObject({ posted: true, ok: true, message: 'done' })
    expect(fetcher).toHaveBeenCalledWith(`/api/dispatch/${action}`, expect.objectContaining({ method: 'POST' }))
  })

  it('does not stop when the user cancels confirmation', async () => {
    const fetcher = vi.fn()
    const result = await attemptControl('stop', record, {
      fetch: fetcher as unknown as typeof fetch,
      confirm: () => false,
    })
    expect(result.posted).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('mobile unified ChatGPT UI', () => {
  it('renders copy-and-open preparation with project and model selection', () => {
    const html = renderToStaticMarkup(createElement(MobileApp, {
      initialPaired: true,
      initialDispatches: [record],
    }))
    expect(html).toContain('準備 ChatGPT 執行對話')
    expect(html).toContain('複製指示並開啟 ChatGPT')
    expect(html).toContain('GPT-5.6 SOL')
    expect(html).toContain('GPT-6 ASTRA')
    expect(html).toContain('在 ChatGPT 對話重做')
    expect(html).toContain('在 ChatGPT 對話續作')
    expect(html).not.toContain('派出去')
    expect(html).not.toContain('重派')
    expect(html).not.toContain('排隊送出')
  })

  it('contains no direct new-work, retry or followup request', () => {
    expect(src).not.toMatch(/fetch\(['"]\/api\/dispatch['"]/)
    expect(src).not.toContain('/api/dispatch/retry')
    expect(src).not.toContain('/api/dispatch/followup')
    expect(src).not.toContain('attemptDispatch(selectedTool')
    expect(src).toContain('copyThenOpenDevSpace')
    expect(src).toContain('buildDevSpaceConversationPrompt')
    expect(src).toContain("source: 'mobile'")
    expect(src).toContain("source: extra ? 'legacy-followup' : 'legacy-retry'")
  })

  it('keeps authenticated polling read-only and preserves stop/cancel endpoints', () => {
    expect(src).toContain("fetch('/api/dispatches')")
    expect(src).toContain('`/api/dispatch/${action}`')
    expect(src).toContain("action === 'retry' || action === 'followup'")
  })
})
