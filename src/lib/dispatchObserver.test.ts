import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchLegacyDispatches } from './dispatchObserver'
import { initialWorkbenchView } from './workbenchView'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('conversation workbenches do not trigger legacy auto handoff', () => {
  it.each(['devspace', 'opencode'])('does not call the dispatch endpoint or schedule polling for %s', async view => {
    vi.useFakeTimers()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const stop = watchLegacyDispatches(initialWorkbenchView(`?view=${view}`), vi.fn())
    await vi.advanceTimersByTimeAsync(20000)
    expect(fetcher).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('continues polling on existing legacy pages without overlapping requests', async () => {
    vi.useFakeTimers()
    let resolve!: (value: unknown) => void
    const fetcher = vi.fn(() => new Promise(done => { resolve = done }))
    vi.stubGlobal('fetch', fetcher)
    const receive = vi.fn()
    const stop = watchLegacyDispatches('list', receive)
    await vi.advanceTimersByTimeAsync(9000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    resolve({ ok: true, json: async () => ({ dispatches: [{ id: 'existing' }] }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(receive).toHaveBeenCalledWith([{ id: 'existing' }])
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    stop()
  })

  it('cancels a legacy read on switching to a conversation view and discards late notifications', async () => {
    vi.useFakeTimers()
    let resolve!: (value: unknown) => void
    const fetcher = vi.fn(() => new Promise(done => { resolve = done }))
    vi.stubGlobal('fetch', fetcher)
    const receive = vi.fn()
    const stopOld = watchLegacyDispatches('console', receive)
    const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal
    stopOld()
    const stopNew = watchLegacyDispatches('devspace', receive)
    resolve({ ok: true, json: async () => ({ dispatches: [{ id: 'late' }] }) })
    await vi.advanceTimersByTimeAsync(12000)
    expect(signal?.aborted).toBe(true)
    expect(receive).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
    stopNew()
  })
})
