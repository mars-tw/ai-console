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
