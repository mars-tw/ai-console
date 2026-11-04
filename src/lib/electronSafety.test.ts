import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const startup = createRequire(import.meta.url)('../../electron/startup.cjs')
const expected = { service: 'ai-console', version: '1.4.1', appRootHash: 'root', serverCodeSha256: 'code' }
const appURL = 'http://127.0.0.1:5177/'

function mockHttp(payload: unknown, status = 200) {
  return { get: (_url: string, callback: (response: EventEmitter & { statusCode: number; destroy: () => void; setEncoding: () => void }) => void) => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: status, destroy: vi.fn(), setEncoding: vi.fn() })
      callback(response)
      response.emit('data', JSON.stringify(payload))
      response.emit('end')
    })
    return request
  } }
}

describe('Electron service identity and boundary', () => {
  it('accepts only the exact root, code, version and service identity', async () => {
    const probe = (value: unknown) => startup.probeHealth(mockHttp(value), appURL, expected, performance.now() + 1000)
    await expect(probe({ ok: true, ...expected })).resolves.toBe('match')
    for (const partial of [{ ok: true }, { ok: true, ...expected, appRootHash: 'other' }, { ok: true, ...expected, serverCodeSha256: 'old' }, { ok: true, ...expected, version: 'old' }]) {
      await expect(probe(partial)).resolves.toBe('conflict')
    }
  })

  it('treats a hanging peer as a conflict within the whole-response deadline', async () => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const result = await startup.probeHealth({ get: () => request }, appURL, expected, performance.now() + 25)
    expect(result).toBe('conflict')
    expect(request.destroy).toHaveBeenCalledOnce()
  })

  it('waits for the delayed Windows connection refusal instead of reporting a conflict', async () => {
    vi.useFakeTimers()
    try {
      const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      const http = { get: () => {
        setTimeout(() => request.emit('error', { code: 'ECONNREFUSED' }), 2100)
        return request
      } }
      const result = startup.probeHealth(http, appURL, expected, 10000, () => 0)
      await vi.advanceTimersByTimeAsync(2100)
      await expect(result).resolves.toBe('absent')
      expect(request.destroy).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('still rejects a stalled peer at the five-second probe cap', async () => {
    vi.useFakeTimers()
    try {
      const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      const result = startup.probeHealth({ get: () => request }, appURL, expected, 10000, () => 0)
      await vi.advanceTimersByTimeAsync(5000)
      await expect(result).resolves.toBe('conflict')
      expect(request.destroy).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('closes an unexpected HTTP status instead of draining an unbounded body', async () => {
    const response = Object.assign(new EventEmitter(), { statusCode: 503, destroy: vi.fn() })
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const http = { get: (_url: string, callback: (r: typeof response) => void) => { queueMicrotask(() => callback(response)); return request } }
    await expect(startup.probeHealth(http, appURL, expected, performance.now() + 1000)).resolves.toBe('conflict')
    expect(response.destroy).toHaveBeenCalledOnce()
  })

  it('never launches or kills anything when the port is occupied by an unverified service', async () => {
    const launch = vi.fn()
    const result = await startup.ensureBackend({ probe: async () => 'conflict', launch, sleep: async () => {} })
    expect(result).toEqual({ ok: false, reason: 'conflict' })
    expect(launch).not.toHaveBeenCalled()
  })

  it('caps the entire startup wait and only stops the child it started', async () => {
    let clock = 0
    const child = { exitCode: null, signalCode: null, kill: vi.fn() }
    const result = await startup.ensureBackend({
      now: () => clock, timeout: 30000,
      sleep: async (ms: number) => { clock += ms },
      probe: async (deadline: number) => { clock += Math.min(2000, deadline - clock); return 'absent' },
      launch: () => child,
    })
    expect(result).toEqual({ ok: false, reason: 'timeout' })
    expect(clock).toBeLessThanOrEqual(30000)
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('reports an exited owned child promptly after one final identity probe', async () => {
    let clock = 0
    const child = { exitCode: null as number | null, signalCode: null, startupFailureCode: 'HEALTH_UNVERIFIED', kill: vi.fn() }
    const probe = vi.fn(async () => 'absent')
    const result = await startup.ensureBackend({
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; child.exitCode = 1 },
      probe, launch: () => child,
    })
    expect(result).toEqual({ ok: false, reason: 'exit', code: 'HEALTH_UNVERIFIED' })
    expect(clock).toBe(500)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('accepts an exact matching peer after the launched child exits in a bind race', async () => {
    const child = { exitCode: 0, signalCode: null, kill: vi.fn() }
    const probe = vi.fn().mockResolvedValueOnce('absent').mockResolvedValueOnce('match')
    await expect(startup.ensureBackend({ probe, launch: () => child, sleep: async () => {} }))
      .resolves.toEqual({ ok: true, reused: false })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('does not wait out the full timeout after an interpreter spawn error', async () => {
    const child = { exitCode: null, signalCode: null, startupSpawnFailed: true, startupFailureCode: 'SPAWN_FAILED', kill: vi.fn() }
    await expect(startup.ensureBackend({ probe: async () => 'absent', launch: () => child, sleep: async () => {} }))
      .resolves.toEqual({ ok: false, reason: 'exit', code: 'SPAWN_FAILED' })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('logs only approved startup codes across split chunks and never raw diagnostic text', () => {
    const stderr = new EventEmitter()
    const child = { stderr, startupFailureCode: undefined as string | undefined }
    const log = vi.fn()
    startup.captureStartupDiagnostics(child, log)
    stderr.emit('data', 'private-fixture-text\nAI_CONSOLE_START')
    stderr.emit('data', 'UP:HEALTH_UNVERIFIED\r\nAI_CONSOLE_STARTUP:unapproved-fixture\n')
    expect(child.startupFailureCode).toBe('HEALTH_UNVERIFIED')
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/private-fixture|unapproved-fixture/)
    expect(log).toHaveBeenCalledWith('Python 啟動代碼：HEALTH_UNVERIFIED')
  })

  it('limits retained diagnostics without logging oversized Python output', () => {
    const stderr = new EventEmitter()
    const child = { stderr, startupFailureCode: undefined as string | undefined }
    const log = vi.fn()
    startup.captureStartupDiagnostics(child, log)
    stderr.emit('data', 'private-fixture'.repeat(10000))
    stderr.emit('data', '\nAI_CONSOLE_STARTUP:PORT_BIND_FAILED\n')
    expect(child.startupFailureCode).toBe('PORT_BIND_FAILED')
    expect(log.mock.calls.flat().join('\n')).not.toContain('private-fixture')
  })

  it('shows recovery for the observed failure instead of always requesting another download', () => {
    const source = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8')
    const fn = source.match(/function errorPage\(reason, failure = ''\) \{[\s\S]*?\r?\n\}/)?.[0]
    if (!fn) throw new Error('Cannot locate startup recovery page')
    const render = runInNewContext(`${fn}\nerrorPage`, { app: { isPackaged: true }, LOG: 'fixture.log' }) as (reason: string, code: string) => string
    for (const code of ['conflict', 'HEALTH_UNVERIFIED', 'PORT_BIND_FAILED', 'exit']) {
      const html = decodeURIComponent(render('fixture', code))
      expect(html).toContain('fixture.log')
      expect(html).not.toContain('重新下載')
    }
  })

  it('rejects other senders, subframes, foreign ports and mobile paths', () => {
    const frame = { url: appURL }
    const contents = { mainFrame: frame }
    const win = { webContents: contents, isDestroyed: () => false }
    expect(startup.trustedSender({ sender: contents, senderFrame: frame }, win, appURL)).toBe(true)
    expect(startup.trustedSender({ sender: {}, senderFrame: frame }, win, appURL)).toBe(false)
    expect(startup.trustedSender({ sender: contents, senderFrame: { url: appURL } }, win, appURL)).toBe(false)
    frame.url = 'http://127.0.0.1:5178/'
    expect(startup.trustedSender({ sender: contents, senderFrame: frame }, win, appURL)).toBe(false)
    frame.url = `${appURL}m/`
    expect(startup.trustedSender({ sender: contents, senderFrame: frame }, win, appURL)).toBe(false)
  })
})

describe('owned terminal exit confirmation', () => {
  function harness(active: boolean, choice: number) {
    const source = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8')
    const fn = source.match(/function confirmOwnedPtyExit\(\) \{[\s\S]*?\r?\n\}/)?.[0]
    if (!fn) throw new Error('Cannot locate exit guard')
    const show = vi.fn(() => choice)
    const context = { ptyMgr: { list: () => active ? [{ exited: false }] : [{ exited: true }] }, dialog: { showMessageBoxSync: show }, win: { isDestroyed: () => false }, quitApproved: false }
    return { invoke: runInNewContext(`${fn}\nconfirmOwnedPtyExit`, context) as () => boolean, show }
  }

  it('does not prompt without a live owned session', () => {
    const x = harness(false, 0)
    expect(x.invoke()).toBe(true)
    expect(x.show).not.toHaveBeenCalled()
  })

  it('keeps work on cancel and only allows exit on the explicit terminate choice', () => {
    expect(harness(true, 0).invoke()).toBe(false)
    expect(harness(true, 1).invoke()).toBe(true)
  })

  it('keeps OpenCode alive on cancel and disposes it once after confirmed exit', async () => {
    const source = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8')
    const start = source.indexOf("app.on('before-quit'")
    const end = source.indexOf("app.on('window-all-closed'", start)
    if (start < 0 || end < 0) throw new Error('Cannot locate production quit handler')
    type QuitHandler = (event: { preventDefault: () => void }) => void
    let handler: QuitHandler | undefined
    let allowed = false
    const killAll = vi.fn()
    const dispose = vi.fn(async () => {})
    const quit = vi.fn()
    runInNewContext(`let quitCleanupStarted = false; let quitCleanupDone = false;\n${source.slice(start, end)}`, {
      app: { on: (_name: string, fn: typeof handler) => { handler = fn }, quit },
      confirmOwnedPtyExit: () => allowed, ptyMgr: { killAll }, openCode: { dispose }, log: () => {},
    })
    if (!handler) throw new Error('Quit handler not registered')
    const invoke = handler as QuitHandler
    const preventDefault = vi.fn()
    invoke({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(killAll).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    allowed = true
    invoke({ preventDefault })
    expect(killAll).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    invoke({ preventDefault })
    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe('sensitive IPC handlers', () => {
  it('rejects untrusted frames before invoking terminal or notification operations', () => {
    const source = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8')
    const pty = source.match(/function wirePty\(\) \{[\s\S]*?\r?\n\}/)?.[0]
    const notify = source.match(/function wireNotify\(\) \{[\s\S]*?\r?\n\}/)?.[0]
    if (!pty || !notify) throw new Error('Cannot locate production IPC registrations')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const frame = { url: appURL }
    const contents = { mainFrame: frame, send: vi.fn() }
    const win = { webContents: contents, isDestroyed: () => false }
    const ptyMgr = { available: vi.fn(), open: vi.fn(), write: vi.fn(), resize: vi.fn(), close: vi.fn(), list: vi.fn(), backlog: vi.fn(), sweep: vi.fn() }
    const notification = { isSupported: vi.fn(() => true) }
    const context = {
      trustedSender: startup.trustedSender, APP_URL: appURL, win, ptyMgr, Notification: notification,
      ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) },
      setInterval: () => ({ unref() {} }), log: () => {}, activeNotifications: new Set(),
      quitCleanupStarted: false, quitCleanupDone: false,
    }
    runInNewContext(`${pty}\n${notify}\nwirePty(); wireNotify()`, context)
    // Ignore the informational availability probe in wirePty itself.
    vi.mocked(ptyMgr.available).mockClear()
    const bad = { sender: contents, senderFrame: { url: appURL } }
    for (const channel of ['pty:available', 'pty:open', 'pty:write', 'pty:resize', 'pty:close', 'pty:list', 'pty:backlog', 'notify:available', 'notify:send']) {
      expect(handlers.has(channel)).toBe(true)
      handlers.get(channel)?.(bad, 'x', 'x', 80, 24)
    }
    for (const fn of Object.values(ptyMgr)) expect(fn).not.toHaveBeenCalled()
    expect(notification.isSupported).not.toHaveBeenCalled()
    const good = { sender: contents, senderFrame: frame }
    context.quitCleanupStarted = true
    expect(handlers.get('pty:open')?.(good, { id: 'fixture', tool: 'shell' })).toEqual({ error: '控制台正在結束' })
    expect(ptyMgr.open).not.toHaveBeenCalled()
  })
})
