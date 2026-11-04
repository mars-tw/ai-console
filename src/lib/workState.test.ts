import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkStateObserver, isWorkStateFresh, readWorkStateOnce, validateWorkState, type WorkState } from './workState'

const payload = (): WorkState & { ok: true } => ({ ok: true, schemaVersion: 1, checkedAt: new Date().toISOString(), validForMs: 15000,
  coverage: 'registered_recent_30', taskDataAvailable: true, tools: {}, projects: [], dispatches: [], runtimeSessions: [],
  sources: { registry: { state: 'ready' }, projects: { state: 'ready' }, runtimeSessions: { state: 'ready' } } })
afterEach(() => vi.useRealTimers())
describe('passive work-state contract', () => {
  it('requires complete typed sources, identity for running and coherent outcomes', () => {
    expect(validateWorkState(payload())).not.toBeNull()
    expect(validateWorkState({ ...payload(), sources: {} })).toBeNull()
    const row = { id: 'one', tool: 'codex', task: '', state: 'running', runtimePhase: 'running', taskOutcome: 'unknown', providerOutcome: 'unknown', cancelOrderPending: false,
      evidence: { process: 'unverified', reason: '', terminal: null, terminalReason: '' } }
    expect(validateWorkState({ ...payload(), dispatches: [row] })).toBeNull()
    expect(validateWorkState({ ...payload(), dispatches: [{ ...row, state: 'done' }] })).toBeNull()
    expect(validateWorkState({ ...payload(), dispatches: [{ ...row, state: 'failed' }] })).toBeNull()
    expect(validateWorkState({ ...payload(), dispatches: [{ ...row, state: 'unknown' }] })).not.toBeNull()
  })
  it('uses producer snapshot time, rejecting old or implausibly future snapshots', () => {
    const data = payload(), checked = Date.parse(data.checkedAt)
    expect(isWorkStateFresh(data, checked + 14999)).toBe(true)
    expect(isWorkStateFresh(data, checked + 15000)).toBe(false)
    expect(isWorkStateFresh(data, checked - 6000)).toBe(false)
  })
  it('only reads the passive GET and bounds a hung response body', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const fetcher = vi.fn(async (_url, init) => { signal = init?.signal as AbortSignal; return { ok: true, json: () => new Promise(() => {}) } as Response }) as typeof fetch
    const request = readWorkStateOnce(new AbortController().signal, fetcher, 100)
    const rejected = expect(request).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(fetcher).toHaveBeenCalledWith('/api/work-state', expect.objectContaining({ cache: 'no-store' }))
    expect(signal?.aborted).toBe(true)
  })
  it('rejects late data after abort even if fetch ignores its signal', async () => {
    let finish!: (r: Response) => void
    const outer = new AbortController()
    const request = readWorkStateOnce(outer.signal, (() => new Promise<Response>((resolve) => { finish = resolve })) as typeof fetch)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    outer.abort(); await rejected
    finish(new Response(JSON.stringify(payload())))
  })
})
describe('bounded visible observation', () => {
  const setup = (read = vi.fn(async () => payload())) => {
    const onData = vi.fn(), onReadState = vi.fn(), onObservation = vi.fn()
    return { controller: createWorkStateObserver({ read, onData, onReadState, onObservation }), read, onData, onReadState, onObservation }
  }
  it('does not request while invisible and never starts observation by becoming visible', async () => {
    const { controller, read } = setup()
    await controller.refresh(); controller.start()
    expect(read).not.toHaveBeenCalled()
    controller.setVisible(true)
    expect(read).not.toHaveBeenCalled()
    await controller.refresh()
    expect(read).toHaveBeenCalledTimes(1)
    controller.dispose()
  })
  it('observes every 5 seconds then stops after 2 minutes', async () => {
    vi.useFakeTimers()
    const { controller, read, onObservation } = setup()
    controller.setVisible(true); controller.start()
    await vi.advanceTimersByTimeAsync(119999)
    expect(read).toHaveBeenCalledTimes(24)
    await vi.advanceTimersByTimeAsync(60000)
    expect(read).toHaveBeenCalledTimes(24)
    expect(onObservation).toHaveBeenLastCalledWith('limit')
    controller.dispose()
  })
  it.each(['hidden', 'offscreen'] as const)('aborts on %s, ignores late data and allows explicit manual recovery', async (reason) => {
    vi.useFakeTimers()
    let finish!: (value: WorkState) => void
    let signal!: AbortSignal
    const read = vi.fn((s: AbortSignal) => { signal = s; return new Promise<WorkState>((resolve) => { finish = resolve }) })
    const onData = vi.fn(), onReadState = vi.fn(), onObservation = vi.fn()
    const controller = createWorkStateObserver({ read, onData, onReadState, onObservation })
    controller.setVisible(true); controller.start(); controller.setVisible(false, reason)
    expect(signal.aborted).toBe(true)
    expect(onReadState).toHaveBeenLastCalledWith('error')
    finish(payload()); await vi.advanceTimersByTimeAsync(20000)
    expect(onData).not.toHaveBeenCalled()
    controller.setVisible(true)
    expect(read).toHaveBeenCalledTimes(1)
    void controller.refresh()
    expect(read).toHaveBeenCalledTimes(2)
    controller.dispose()
    expect(signal.aborted).toBe(true)
  })
})
