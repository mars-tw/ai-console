import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  devSpaceRequest, devSpaceRunProblem, parseDevSpaceStatus, parseDevSpaceTask,
  parseDevSpaceTasks, pollDevSpace, withinDevSpaceRoots,
} from './devspace'

const status = () => parseDevSpaceStatus({
  installed: true, configured: true, version: '1.0.8', configPath: 'C:\\config.json',
  allowedRoots: ['C:\\work\\project'], endpoint: 'http://127.0.0.1:7676/mcp',
  service: { running: false, managed: false },
  daemon: { running: false, state: 'unavailable', activeTurns: 0 },
  targets: [{ name: 'codex', kind: 'provider' }, { name: 'claude', kind: 'provider' }, { name: 'local', kind: 'provider' }],
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('DevSpace readiness boundaries', () => {
  it('rejects missing or misleading readiness values', () => {
    expect(() => parseDevSpaceStatus({ installed: 'true', configured: true })).toThrow()
    expect(() => parseDevSpaceStatus({ ...status(), service: {} })).toThrow()
    expect(() => parseDevSpaceStatus({ ...status(), allowedRoots: null })).toThrow()
  })

  it('only offers the three retained configured providers', () => {
    const data = parseDevSpaceStatus({ ...status(), targets: [{ name: 'local', kind: 'provider' }, { name: 'old-provider', kind: 'provider' }, { name: 'codex', kind: 'profile' }] })
    expect(data.targets.map(item => item.name)).toEqual(['local'])
    expect(devSpaceRunProblem(data, 'C:\\work\\project', 'codex', 'Review this')).not.toBe('')
  })

  it('requires installed, configured, allowed root, enabled provider and a prompt', () => {
    const data = status()
    expect(devSpaceRunProblem(data, 'C:\\work\\project', 'local', 'Review this')).toBe('')
    expect(devSpaceRunProblem(null, 'C:\\work\\project', 'local', 'Review')).not.toBe('')
    expect(devSpaceRunProblem({ ...data, installed: false }, 'C:\\work\\project', 'local', 'Review')).not.toBe('')
    expect(devSpaceRunProblem({ ...data, configured: false }, 'C:\\work\\project', 'local', 'Review')).not.toBe('')
    expect(devSpaceRunProblem(data, 'C:\\elsewhere', 'local', 'Review')).not.toBe('')
    expect(devSpaceRunProblem(data, 'C:\\work\\project', 'local', '  ')).not.toBe('')
    // Neither a stopped HTTP server nor a stopped task daemon prevents an explicit run.
    expect(data.service.running).toBe(false)
    expect(data.daemon.running).toBe(false)
  })

  it('supports subdirectories without confusing sibling prefixes or traversal', () => {
    const roots = ['C:\\work\\project']
    expect(withinDevSpaceRoots('c:/WORK/project/src', roots)).toBe(true)
    expect(withinDevSpaceRoots('C:\\work\\project-backup', roots)).toBe(false)
    expect(withinDevSpaceRoots('C:\\work\\project\\..\\secret', roots)).toBe(false)
    expect(withinDevSpaceRoots('C:\\work\\project\\.\\src', roots)).toBe(false)
    expect(withinDevSpaceRoots('/Work/project', ['/work'])).toBe(false)
    expect(withinDevSpaceRoots('/work/project', ['/work'])).toBe(true)
    expect(withinDevSpaceRoots('/work/project', ['/'])).toBe(true)
    expect(withinDevSpaceRoots('  C:\\work\\project ', roots)).toBe(true)
  })

  it('does not interpret unknown task status as completed', () => {
    expect(() => parseDevSpaceTask({ id: '1', status: 'unknown' })).toThrow()
    expect(() => parseDevSpaceTasks(null)).toThrow()
    expect(parseDevSpaceTask({ id: '1', status: 'running', stale: true }).stale).toBe(true)
    expect(parseDevSpaceTask({ id: '1', status: 'failed', error: { code: 'auth', message: 'Sign in' } }).error?.message).toBe('Sign in')
    expect(parseDevSpaceTask({ id: '1', status: 'completed', target: 'reviewer', provider: 'claude' }).provider).toBe('claude')
  })
})

describe('DevSpace reads are serial and cannot update an abandoned view', () => {
  it('waits for a read to settle before scheduling the next one', async () => {
    vi.useFakeTimers()
    let resolve!: (value: string) => void
    const read = vi.fn(() => new Promise<string>(done => { resolve = done }))
    const receive = vi.fn()
    const stop = pollDevSpace(read, receive, vi.fn(), 1000)
    await vi.advanceTimersByTimeAsync(10000)
    expect(read).toHaveBeenCalledTimes(1)
    resolve('result')
    await Promise.resolve()
    expect(receive).toHaveBeenCalledWith('result')
    await vi.advanceTimersByTimeAsync(999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    stop()
  })

  it('aborts on workspace/task switch and ignores an old response even if transport ignores abort', async () => {
    vi.useFakeTimers()
    let resolve!: (value: string) => void
    let signal!: AbortSignal
    const receive = vi.fn()
    const fail = vi.fn()
    const stop = pollDevSpace(current => { signal = current; return new Promise<string>(done => { resolve = done }) }, receive, fail)
    stop()
    expect(signal.aborted).toBe(true)
    resolve('old task output')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10000)
    expect(receive).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries failed reads without overlapping or hiding the error', async () => {
    vi.useFakeTimers()
    const failure = new Error('offline')
    const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('recovered')
    const receive = vi.fn()
    const fail = vi.fn()
    const stop = pollDevSpace(read, receive, fail, 1000)
    await Promise.resolve()
    expect(fail).toHaveBeenCalledWith(failure)
    await vi.advanceTimersByTimeAsync(1000)
    expect(receive).toHaveBeenCalledWith('recovered')
    stop()
  })
})

describe('DevSpace request contract', () => {
  it('posts structured task input and forwards cancellation', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    await devSpaceRequest('run', { cwd: 'C:\\work', prompt: 'literal $() `text`', target: 'codex' }, signal)
    expect(fetcher).toHaveBeenCalledWith('/api/devspace/run', expect.objectContaining({ method: 'POST', signal, body: JSON.stringify({ cwd: 'C:\\work', prompt: 'literal $() `text`', target: 'codex' }) }))
  })

  it('requires both HTTP and application success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'Provider disabled' }) }))
    await expect(devSpaceRequest('run', {})).rejects.toThrow('Provider disabled')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
    await expect(devSpaceRequest('status')).rejects.toThrow()
  })
})
