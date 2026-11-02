import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDispatchSnapshotStore, readDispatchSnapshotOnce, validateDispatchSnapshot } from './dispatchSnapshot'
import { stateOf } from './dispatchState'

describe('dispatch snapshots', () => {
  afterEach(() => vi.useRealTimers())

  it('starts idle and does not imply a mount-time read', () => {
    expect(createDispatchSnapshotStore().getSnapshot()).toMatchObject({ readState: 'idle', lastSuccess: null, dispatches: [] })
  })
  it('accepts complete responses and derives no dispatch state from tool metadata', () => {
    const store = createDispatchSnapshotStore()
    const rows = [
      { id: 'a', tool: 'codex', task: 'first', state: 'waiting', alive: true },
      { id: 'b', tool: 'codex', task: 'second', alive: true },
      { id: 'c', tool: null, task: null, state: 'running' },
    ]
    expect(store.ready(rows, '2026-11-01T00:00:00Z')).toBe(true)
    const snapshot = store.getSnapshot()
    expect(snapshot.readState).toBe('ready')
    expect(snapshot.lastSuccess).toBe('2026-11-01T00:00:00Z')
    expect(snapshot.dispatches.map(stateOf)).toEqual(['waiting', 'running', 'running'])
    expect(snapshot.dispatches[2]).toMatchObject({ tool: '', task: '' })
    expect(rows[2]).toMatchObject({ tool: null, task: null })
  })

  it('retains the last successful data and timestamp through loading, errors and invalid snapshots', () => {
    const store = createDispatchSnapshotStore()
    store.ready([{ id: 'a', tool: 'grok', state: 'running' }], 'first')
    const records = store.getSnapshot().dispatches
    store.loading()
    expect(store.getSnapshot()).toMatchObject({ dispatches: records, readState: 'loading', lastSuccess: 'first' })
    store.error()
    expect(store.getSnapshot()).toMatchObject({ dispatches: records, readState: 'error', lastSuccess: 'first' })
    expect(store.ready([{ id: 'valid' }, null], 'second')).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ dispatches: records, readState: 'error', lastSuccess: 'first' })
    expect(store.getSnapshot().dispatches).toBe(records)
  })

  it('rejects invalid state, alive and identifiers instead of treating malformed data as empty', () => {
    expect(validateDispatchSnapshot(null)).toBeNull()
    expect(validateDispatchSnapshot([{ id: '' }])).toBeNull()
    expect(validateDispatchSnapshot([{ id: 'a', state: 'RUNNING' }])).toBeNull()
    expect(validateDispatchSnapshot([{ id: 'a', alive: 'yes' }])).toBeNull()
    expect(validateDispatchSnapshot([{ id: 'a', tool: {} }])).toBeNull()
    expect(validateDispatchSnapshot([{ id: 'a', cancelOrderPending: 'true' }])).toBeNull()
    expect(validateDispatchSnapshot([])).toEqual([])
  })

  it('accepts a minimal pending cancellation without inventing a completed task', () => {
    const rows = validateDispatchSnapshot([{ id: 'pending-old', state: 'unknown', cancelOrderPending: true }])
    expect(rows?.[0]).toMatchObject({ id: 'pending-old', state: 'unknown', cancelOrderPending: true, tool: '', task: '' })
    expect(stateOf(rows![0])).toBe('unknown')
    expect(stateOf({ ...rows![0], state: 'cancelled' })).toBe('unknown')
  })

  it('notifies subscribers on changes and stops notifying after unsubscribe', () => {
    const store = createDispatchSnapshotStore()
    const calls: string[] = []
    const unsubscribe = store.subscribe(() => { calls.push(store.getSnapshot().readState) })
    store.loading()
    store.ready([], 'time')
    store.error()
    unsubscribe()
    store.loading()
    expect(calls).toEqual(['loading', 'ready', 'error'])
  })

  it('times out a hung body and aborts the only GET', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return { ok: true, json: () => new Promise(() => {}) } as Response
    }) as typeof fetch
    const pending = readDispatchSnapshotOnce(new AbortController().signal, 100, fetcher)
    const rejected = expect(pending).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(signal?.aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not accept a late response after cancellation', async () => {
    let finish!: (value: Response) => void
    const pendingResponse = new Promise<Response>((resolve) => { finish = resolve })
    const fetcher = vi.fn(() => pendingResponse) as typeof fetch
    const outer = new AbortController()
    const pending = readDispatchSnapshotOnce(outer.signal, 1000, fetcher)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    outer.abort()
    await rejected
    finish(new Response('{"ok":true,"dispatches":[]}'))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
