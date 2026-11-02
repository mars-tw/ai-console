import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDispatchPuller } from './dispatchPull'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const response = (id: string) => new Response(JSON.stringify({ ok: true, dispatches: [{ id }] }), { status: 200 })

afterEach(() => vi.useRealTimers())

describe('mobile dispatch snapshot ownership', () => {
  it('aborts the old pairing and ignores its late 200 after a new pairing has returned', async () => {
    const pairing = { epoch: 1, token: 'synthetic-A' }
    const old = deferred<Response>()
    const delivered: string[] = []
    const signals: AbortSignal[] = []
    let count = 0
    const reader = createDispatchPuller<{ id: string }>({
      capture: () => ({ ...pairing }),
      isCurrent: (snapshot) => snapshot.epoch === pairing.epoch && snapshot.token === pairing.token,
      request: (_snapshot, signal) => { signals.push(signal); return count++ === 0 ? old.promise : Promise.resolve(response('new')) },
      onData: (rows) => delivered.push(rows[0].id),
      onFailure: () => delivered.push('error'),
    })
    const first = reader.pull()
    pairing.epoch += 1
    pairing.token = 'synthetic-B'
    reader.cancel()
    expect(signals[0].aborted).toBe(true)
    await reader.pull()
    old.resolve(response('old'))
    await first
    await Promise.resolve()
    expect(delivered).toEqual(['new'])
  })

  it('ignores a response if the token rotates without an epoch change', async () => {
    const pairing = { epoch: 1, token: 'synthetic-A' }
    const pending = deferred<Response>()
    const onData = vi.fn()
    const onFailure = vi.fn()
    const reader = createDispatchPuller<{ id: string }>({
      capture: () => ({ ...pairing }),
      isCurrent: (snapshot) => snapshot.epoch === pairing.epoch && snapshot.token === pairing.token,
      request: () => pending.promise,
      onData,
      onFailure,
    })
    const request = reader.pull()
    pairing.token = 'synthetic-B'
    pending.resolve(response('old'))
    await request
    expect(onData).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('does not overlap same-pairing polls and rejects invalid snapshots', async () => {
    const pending = deferred<Response>()
    const request = vi.fn(() => pending.promise)
    const onData = vi.fn()
    const onFailure = vi.fn()
    const reader = createDispatchPuller({
      capture: () => ({ epoch: 1, token: 'synthetic-A' }),
      isCurrent: () => true,
      request,
      onData,
      onFailure,
    })
    const first = reader.pull()
    await reader.pull()
    expect(request).toHaveBeenCalledTimes(1)
    pending.resolve(new Response(JSON.stringify({ ok: false, dispatches: [] }), { status: 200 }))
    await first
    expect(onData).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledTimes(1)
  })

  it('times out an ignored AbortSignal and permits the next poll', async () => {
    vi.useFakeTimers()
    const request = vi.fn(() => new Promise<Response>(() => {}))
    const onFailure = vi.fn()
    const reader = createDispatchPuller({
      capture: () => ({ epoch: 1, token: 'synthetic-A' }),
      isCurrent: () => true,
      request,
      onData: vi.fn(),
      onFailure,
      timeoutMs: 50,
    })
    const first = reader.pull()
    await vi.advanceTimersByTimeAsync(50)
    await first
    expect(onFailure).toHaveBeenCalledTimes(1)
    const second = reader.pull()
    expect(request).toHaveBeenCalledTimes(2)
    reader.cancel()
    await second
  })
})
