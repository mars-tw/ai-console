import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestControlReceipt } from './controlReceipt'

afterEach(() => vi.useRealTimers())

describe('legacy control receipt', () => {
  it('sends one stop request and returns its explicit receipt', async () => {
    const transport = vi.fn(async () => new Response('{"ok":true}')) as typeof fetch
    const result = await requestControlReceipt(transport, 'stop', 'fixture')
    expect(result.body).toEqual({ ok: true })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledWith('/api/dispatch/stop', expect.objectContaining({ method: 'POST' }))
  })

  it('times out an unresponsive body without resending', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response
    }) as typeof fetch
    const pending = requestControlReceipt(transport, 'cancel', 'fixture', 100)
    const rejected = expect(pending).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(signal?.aborted).toBe(true)
    expect(transport).toHaveBeenCalledTimes(1)
  })
})
