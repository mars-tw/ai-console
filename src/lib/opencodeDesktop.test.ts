import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenCodeDesktopStatus } from '@/types/opencode'

interface Manager {
  status(): Promise<OpenCodeDesktopStatus>
  open(input: { cwd: string; model?: string }): Promise<OpenCodeDesktopStatus>
  reconnect(input: { cwd: string; model?: string; confirmInterrupt?: boolean }): Promise<OpenCodeDesktopStatus>
  stop(): Promise<OpenCodeDesktopStatus>
  dispose(): Promise<void>
  connectionForVerification(): { origin: string; authorization: string; cwd: string } | null
}
const require = createRequire(import.meta.url)
const desktop = require('../../electron/opencode.cjs') as {
  parseJsonc(text: string): Record<string, unknown>
  validateWorkspace(value: unknown, roots: string[], io: unknown, paths?: typeof path): string
  trustedSender(event: unknown, getWindow: () => unknown, url: string): boolean
  sameOrigin(value: string, origin: string): boolean
  launchSpec(input: Record<string, unknown>): { file: string; args: string[]; options: { shell: boolean; windowsHide: boolean; env: Record<string, string> } }
  createManager(options: Record<string, unknown>): Manager
  wireOpenCode(options: Record<string, unknown>): Manager
  readBridgeProgress(session: string, io: unknown, temporary?: string, now?: number, maxAge?: number): { state: string; updatedAt: number; fresh: boolean } | null
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  killed = false
  pid = 8123
  kill = vi.fn(() => { this.killed = true; this.exitCode = 0; this.emit('exit', 0) })
}

class FakeWindow extends EventEmitter {
  static instances: FakeWindow[] = []
  destroyed = false
  readonly options: Record<string, unknown>
  show = vi.fn()
  focus = vi.fn()
  loadURL = vi.fn(async () => undefined)
  webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(),
    session: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn() },
    },
  })
  constructor(options: Record<string, unknown>) { super(); this.options = options; FakeWindow.instances.push(this) }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.emit('closed') }
}

const root = 'C:\\Projects'
const project = 'C:\\Projects\\中文專案'
const bridgeSession = '11111111-1111-4111-8111-111111111111'
function makeManager(overrides: Record<string, unknown> = {}) {
  const child = new FakeChild()
  const spawn = vi.fn(() => child)
  const execute = vi.fn((_file: string, _args: string[], _options: Record<string, unknown>, callback: (error: unknown, stdout: string) => void) => callback(null, '1.18.31\n'))
  const options = {
    BrowserWindow: FakeWindow,
    env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
    platform: 'linux', // Exercise owned child.kill without a real Windows command.
    paths: path.win32,
    getRoots: () => [root],
    discover: () => ({ nativeBin: 'C:\\Apps\\opencode.exe', node: 'C:\\Apps\\node.exe', bridge: 'C:\\Apps\\devspace-mcp-bridge.cjs', devspaceRoot: 'C:\\Apps\\node_modules\\@waishnav\\devspace' }),
    io: { statSync: () => ({ isDirectory: () => true }), realpathSync: (value: string) => value },
    devspaceConfig: () => ({ directory: 'C:\\Config', origin: 'http://127.0.0.1:17676', resource: 'https://devspace.example/mcp' }),
    devspaceHealth: vi.fn(async () => true),
    now: () => 100,
    spawn, execFile: execute, freePort: async () => 41111, health: async () => true, sleep: async () => undefined,
    ...overrides,
  }
  return { manager: desktop.createManager(options), child, spawn, execute, options }
}

beforeEach(() => { FakeWindow.instances = [] })

describe('OpenCode desktop boundaries', () => {
  it('parses JSONC without damaging quoted URLs or Windows paths', () => {
    expect(desktop.parseJsonc('{"url":"https://example.test/a//b",/* note */"roots":["C:\\\\Projects",],}')).toEqual({ url: 'https://example.test/a//b', roots: ['C:\\Projects'] })
    expect(() => desktop.parseJsonc('{/* unfinished')).toThrow()
  })

  it('validates canonical folders and rejects symlink escape, sibling prefixes and relative paths', () => {
    const io = { statSync: () => ({ isDirectory: () => true }), realpathSync: (value: string) => value.endsWith('escape') ? 'D:\\secret' : value }
    expect(desktop.validateWorkspace(project, [root], io, path.win32)).toBe(project)
    for (const value of ['C:\\Projects-backup', 'C:\\Projects\\escape', 'relative', '', null]) {
      expect(() => desktop.validateWorkspace(value, [root], io, path.win32)).toThrow()
    }
    expect(() => desktop.validateWorkspace(project, [root], { ...io, statSync: () => ({ isDirectory: () => false }) }, path.win32)).toThrow()
  })

  it('admits only the main local renderer and rejects mobile, subframes, other windows and origins', () => {
    const frame = { url: 'http://127.0.0.1:4321/' }
    const window = { webContents: { mainFrame: frame } }
    const event = { sender: window.webContents, senderFrame: frame }
    const validate = (candidate: unknown) => desktop.trustedSender(candidate, () => window, frame.url)
    expect(validate(event)).toBe(true)
    expect(validate({ ...event, sender: {} })).toBe(false)
    expect(validate({ ...event, senderFrame: { url: frame.url } })).toBe(false)
    frame.url = 'http://127.0.0.1:4321/m'
    expect(validate(event)).toBe(false)
    frame.url = 'https://untrusted.test/'
    expect(desktop.trustedSender(event, () => window, 'http://127.0.0.1:4321')).toBe(false)
    expect(desktop.sameOrigin('http://user:password@127.0.0.1:4321/', 'http://127.0.0.1:4321')).toBe(false)
  })

  it('builds only a native serve command with process-scoped, restricted MCP conversation settings', () => {
    const spec = desktop.launchSpec({ nativeBin: 'C:\\Apps\\opencode.exe', node: 'C:\\Apps\\node.exe', bridge: 'C:\\Apps\\bridge.js', cwd: project, port: 41111, password: 'secret', bridgeSession, model: 'gpt-6-astra', env: { OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true' } })
    expect(spec.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '41111', '--no-mdns', '--pure'])
    expect(spec.args.join(' ')).not.toContain('secret')
    expect(spec.options.shell).toBe(false)
    expect(spec.options.windowsHide).toBe(true)
    expect(spec.options.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI).toBe('false')
    const config = JSON.parse(spec.options.env.OPENCODE_CONFIG_CONTENT)
    expect(config.model).toBe('openai/gpt-6-astra')
    expect(config.small_model).toBe(config.model)
    expect(config.enabled_providers).toEqual(['openai'])
    expect(config.provider.openai.whitelist).toEqual(['gpt-5.6-sol', 'gpt-6-astra'])
    expect(config.permission).toMatchObject({ task: 'deny', bash: 'deny', edit: 'deny', 'devspace_*': 'ask' })
    expect(config.mcp.devspace.environment).toEqual({ DEVSPACE_MCP_WORKSPACE: project, DEVSPACE_MCP_WRITE_MODE: 'allowed', AI_CONSOLE_BRIDGE_SESSION: bridgeSession })
    expect(config.mcp.devspace.command).toEqual(['C:\\Apps\\node.exe', 'C:\\Apps\\bridge.js'])
    expect(config.share).toBe('disabled')
    expect(() => desktop.launchSpec({ model: 'unlisted' })).toThrow()
  })

  it('status reads never start a service or AI conversation and never expose credentials', async () => {
    const { manager, spawn, execute } = makeManager()
    const status = await manager.status()
    expect(status).toMatchObject({
      installed: true, version: '1.18.31', configured: true, devspaceService: 'reachable',
      authorization: 'not_started', mcp: 'stopped', running: false,
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(execute.mock.calls[0][1]).toEqual(['--version'])
    expect(JSON.stringify(status)).not.toMatch(/password|Basic |Bearer |access_token|refresh_token/i)
  })

  it('keeps invalid DevSpace configuration separate from service reachability', async () => {
    const { manager, spawn } = makeManager({ devspaceConfig: () => { throw new Error('private path') } })
    await expect(manager.status()).resolves.toMatchObject({
      installed: true, configured: false, bridgeReady: true, devspaceService: 'not_configured',
      authorization: 'not_started', mcp: 'stopped',
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports an unreachable DevSpace service without starting OpenCode or consent', async () => {
    const devspaceHealth = vi.fn(async () => false)
    const { manager, spawn } = makeManager({ devspaceHealth })
    await expect(manager.status()).resolves.toMatchObject({
      installed: true, configured: true, bridgeReady: true, devspaceService: 'unreachable',
      authorization: 'not_started', mcp: 'stopped',
    })
    await expect(manager.open({ cwd: project })).rejects.toMatchObject({ code: 'service' })
    expect(devspaceHealth).toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('marks MCP connected only from the exact owned bridge progress session', async () => {
    let state: string | null = null
    let seenSession = ''
    const readProgress = vi.fn((session: string) => {
      seenSession = session
      return state ? { state, updatedAt: 10 } : null
    })
    const { manager } = makeManager({ readProgress })
    const opening = await manager.open({ cwd: project })
    expect(opening).toMatchObject({ authorization: 'checking', mcp: 'connecting' })
    expect(seenSession).toMatch(/^[0-9a-f-]{36}$/i)
    state = 'connected'
    await expect(manager.status()).resolves.toMatchObject({ authorization: 'authorized', mcp: 'connected', connectionIssue: null })
    state = 'authorization_timeout'
    await expect(manager.status()).resolves.toMatchObject({ authorization: 'timed_out', mcp: 'failed', connectionIssue: 'authorization_timeout' })
    state = 'connection_failed'
    await expect(manager.status()).resolves.toMatchObject({ authorization: 'authorized', mcp: 'failed', connectionIssue: 'connection_failed' })
    state = 'service_unreachable'
    await expect(manager.status()).resolves.toMatchObject({ authorization: 'authorized', mcp: 'failed', connectionIssue: 'service_unreachable' })
    state = 'bridge_failed'
    await expect(manager.status()).resolves.toMatchObject({ authorization: 'authorized', mcp: 'failed', connectionIssue: 'bridge_failed' })
    await manager.dispose()
  })

  it('never reports MCP connected while DevSpace is offline and requires reconnect after a service restart', async () => {
    let current = 100
    let reachable = true
    let progressState = 'connected'
    const devspaceHealth = vi.fn(async () => reachable)
    const readProgress = vi.fn(() => ({ state: progressState, updatedAt: current }))
    const { manager } = makeManager({ now: () => current, devspaceHealth, readProgress })
    await expect(manager.open({ cwd: project })).resolves.toMatchObject({
      devspaceService: 'reachable', authorization: 'authorized', mcp: 'connected',
    })

    current = 200
    reachable = false
    progressState = 'service_unreachable'
    await expect(manager.status()).resolves.toMatchObject({
      devspaceService: 'unreachable', authorization: 'authorized', mcp: 'failed', connectionIssue: 'service_unreachable',
    })

    current = 300
    reachable = true
    await expect(manager.status()).resolves.toMatchObject({
      devspaceService: 'reachable', authorization: 'authorized', mcp: 'failed', connectionIssue: 'disconnected',
    })
    await manager.dispose()
  })

  it('expires a historic connected heartbeat even while the OpenCode parent and DevSpace service remain healthy', async () => {
    let current = 100
    const readProgress = vi.fn(() => ({ state: 'connected', updatedAt: 100 }))
    const { manager } = makeManager({ now: () => current, progressMaxAge: 1000, readProgress })
    await expect(manager.open({ cwd: project })).resolves.toMatchObject({ authorization: 'authorized', mcp: 'connected' })
    current = 1200
    await expect(manager.status()).resolves.toMatchObject({
      running: true, devspaceService: 'reachable', authorization: 'authorized', mcp: 'failed', connectionIssue: 'disconnected',
    })
    await manager.dispose()
  })

  it('turns a vanished bridge into a bounded retry state while the OpenCode parent stays alive', async () => {
    let current = 100
    let bridgePresent = true
    const readProgress = vi.fn(() => bridgePresent ? { state: 'connected', updatedAt: 100 } : null)
    const { manager } = makeManager({ now: () => current, progressMaxAge: 1000, readProgress })
    await expect(manager.open({ cwd: project })).resolves.toMatchObject({ mcp: 'connected' })

    bridgePresent = false
    current = 500
    await expect(manager.status()).resolves.toMatchObject({ running: true, mcp: 'connected' })
    current = 1200
    await expect(manager.status()).resolves.toMatchObject({
      running: true, authorization: 'authorized', mcp: 'failed', connectionIssue: 'disconnected',
    })
    await manager.dispose()
  })

  it('rejects malformed, foreign and oversized bridge progress files', () => {
    const value = (body: unknown, size = 100) => ({
      statSync: () => ({ size }),
      readFileSync: () => JSON.stringify(body),
    })
    expect(desktop.readBridgeProgress(bridgeSession, value({ version: 1, session: bridgeSession, state: 'connected', updatedAt: 10 }), 'C:\\Temp', 20)).toEqual({ state: 'connected', updatedAt: 10, fresh: true })
    expect(desktop.readBridgeProgress(bridgeSession, value({ version: 1, session: bridgeSession, state: 'connected', updatedAt: 10 }), 'C:\\Temp', 13000, 1000)).toEqual({ state: 'connected', updatedAt: 10, fresh: false })
    expect(desktop.readBridgeProgress(bridgeSession, value({ version: 1, session: '22222222-2222-4222-8222-222222222222', state: 'connected', updatedAt: 10 }), 'C:\\Temp')).toBeNull()
    expect(desktop.readBridgeProgress(bridgeSession, value({ version: 1, session: bridgeSession, state: 'connected', updatedAt: 10 }, 5000), 'C:\\Temp')).toBeNull()
    expect(desktop.readBridgeProgress('../escape', value({}), 'C:\\Temp')).toBeNull()
  })

  it('launches one isolated window and injects auth only for its exact managed origin', async () => {
    const { manager, spawn } = makeManager()
    const status = await manager.open({ cwd: project })
    expect(status.running).toBe(true)
    const window = FakeWindow.instances[0]
    expect(window.options.webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true })
    expect(window.options.webPreferences).not.toHaveProperty('preload')
    expect(window.loadURL).toHaveBeenCalledWith(`http://127.0.0.1:41111/${Buffer.from(project).toString('base64url')}/session`)
    const authHandler = window.webContents.session.webRequest.onBeforeSendHeaders.mock.calls[0][1]
    const callback = vi.fn()
    authHandler({ url: 'https://other.test/', requestHeaders: {} }, callback)
    expect(callback).toHaveBeenLastCalledWith({ requestHeaders: {} })
    authHandler({ url: 'http://127.0.0.1:41111/global/health', requestHeaders: {} }, callback)
    expect(callback.mock.calls[1][0].requestHeaders.Authorization).toMatch(/^Basic /)
    expect(JSON.stringify(status)).not.toMatch(/Basic |Bearer |password|access_token|refresh_token/i)
    await manager.open({ cwd: project })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(FakeWindow.instances).toHaveLength(1)
    expect(window.focus).toHaveBeenCalled()
    await expect(manager.open({ cwd: 'C:\\Projects\\different' })).rejects.toThrow()
    await expect(manager.open({ cwd: project, model: 'gpt-6-astra' })).rejects.toThrow()
    await manager.dispose()
  })

  it('stops only its owned child and can reopen a closed conversation window', async () => {
    const { manager, child, spawn } = makeManager()
    await manager.stop()
    expect(child.kill).not.toHaveBeenCalled()
    await manager.open({ cwd: project })
    FakeWindow.instances[0].destroy()
    await manager.open({ cwd: project })
    expect(FakeWindow.instances).toHaveLength(2)
    expect(spawn).toHaveBeenCalledTimes(1)
    const stopped = await manager.stop()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(stopped.running).toBe(false)
    expect(FakeWindow.instances[1].isDestroyed()).toBe(true)
  })

  it('recovers from authorization timeout only after explicit restart and preserves project and model', async () => {
    const children: FakeChild[] = []
    const launches: { env: Record<string, string> }[] = []
    const spawn = vi.fn((file: string, args: string[], options: { env: Record<string, string> }) => {
      expect(file).toBe('C:\\Apps\\opencode.exe')
      expect(args[0]).toBe('serve')
      launches.push(options)
      const child = new FakeChild()
      children.push(child)
      return child
    })
    let progress = 'authorization_timeout'
    const { manager } = makeManager({
      spawn,
      readProgress: () => ({ state: progress, updatedAt: 10 }),
    })
    const timedOut = await manager.open({ cwd: project, model: 'gpt-6-astra' })
    expect(timedOut).toMatchObject({ model: 'gpt-6-astra', authorization: 'timed_out', mcp: 'failed' })
    await expect(manager.reconnect({ cwd: 'C:\\Projects\\different', model: 'gpt-5.6-sol' })).rejects.toMatchObject({ code: 'confirm' })
    expect(spawn).toHaveBeenCalledOnce()
    expect(children[0].kill).not.toHaveBeenCalled()

    progress = 'connected'
    const recovered = await manager.reconnect({ cwd: 'C:\\Projects\\different', model: 'gpt-5.6-sol', confirmInterrupt: true })
    expect(recovered).toMatchObject({ cwd: project, model: 'gpt-6-astra', authorization: 'authorized', mcp: 'connected' })
    expect(children[0].kill).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledTimes(2)
    const firstConfig = JSON.parse(launches[0].env.OPENCODE_CONFIG_CONTENT)
    const secondConfig = JSON.parse(launches[1].env.OPENCODE_CONFIG_CONTENT)
    expect(secondConfig.model).toBe('openai/gpt-6-astra')
    expect(secondConfig.mcp.devspace.environment.DEVSPACE_MCP_WORKSPACE).toBe(project)
    expect(secondConfig.mcp.devspace.environment.AI_CONSOLE_BRIDGE_SESSION).not.toBe(firstConfig.mcp.devspace.environment.AI_CONSOLE_BRIDGE_SESSION)
    await manager.dispose()
  })

  it('cancels a start that is still waiting for a port without spawning later', async () => {
    let releasePort: (port: number) => void = () => undefined
    const port = new Promise<number>(resolve => { releasePort = resolve })
    const { manager, spawn } = makeManager({ freePort: () => port })
    const pending = manager.open({ cwd: project })
    await manager.stop()
    releasePort(41111)
    await expect(pending).rejects.toThrow()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps remote pages out of the OpenCode window and never grants browser permissions', async () => {
    const openExternal = vi.fn()
    const { manager } = makeManager({ openExternal })
    await manager.open({ cwd: project })
    const window = FakeWindow.instances[0]
    const event = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', event, 'http://127.0.0.1:41111/session')
    expect(event.preventDefault).not.toHaveBeenCalled()
    window.webContents.emit('will-navigate', event, 'https://example.test/')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    window.webContents.emit('will-redirect', event, 'file:///C:/secret')
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    const permission = window.webContents.session.setPermissionRequestHandler.mock.calls[0][0]
    const callback = vi.fn()
    permission(window.webContents, 'media', callback)
    expect(callback).toHaveBeenCalledWith(false)
    const popup = window.webContents.setWindowOpenHandler.mock.calls[0][0]
    expect(popup({ url: 'https://auth.example.test/login' })).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.test/login')
    popup({ url: 'http://user:secret@example.test/' })
    expect(openExternal).toHaveBeenCalledOnce()
    await manager.dispose()
  })

  it('cleans up a failed startup and rejects unavailable installations before spawning', async () => {
    const failed = makeManager({ health: async () => false })
    await expect(failed.manager.open({ cwd: project })).rejects.toThrow()
    expect(failed.child.kill).toHaveBeenCalled()
    expect((await failed.manager.status()).running).toBe(false)
    const missing = makeManager({ discover: () => ({ nativeBin: null, node: null, bridge: null }) })
    await expect(missing.manager.open({ cwd: project })).rejects.toThrow()
    expect(missing.spawn).not.toHaveBeenCalled()
  })

  it('protects all IPC handlers before reading status or starting a process', async () => {
    const handlers = new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>()
    const setup = makeManager()
    const mainFrame = { url: 'http://127.0.0.1:4321/' }
    const window = { webContents: { mainFrame } }
    desktop.wireOpenCode({ ...setup.options, ipcMain: { handle: (channel: string, callback: (event: unknown, input?: unknown) => Promise<unknown>) => handlers.set(channel, callback) }, mainWindow: () => window, appUrl: mainFrame.url })
    expect([...handlers.keys()]).toEqual(['opencode:status', 'opencode:open', 'opencode:reconnect', 'opencode:stop'])
    for (const handler of handlers.values()) expect(await handler({ sender: {}, senderFrame: mainFrame }, { cwd: project })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(setup.spawn).not.toHaveBeenCalled()
    expect(setup.execute).not.toHaveBeenCalled()
    expect(await handlers.get('opencode:status')!({ sender: window.webContents, senderFrame: mainFrame })).toMatchObject({ ok: true, status: { installed: true, running: false } })
  })

  it('waits for OpenCode cleanup once before completing Electron quit', async () => {
    const main = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8')
    const cleanup = main.slice(main.indexOf('let quitCleanupStarted = false'), main.indexOf("app.on('window-all-closed'"))
    expect(cleanup).not.toBe('')
    let finish: () => void = () => undefined
    const pending = new Promise<void>(resolve => { finish = resolve })
    const dispose = vi.fn(() => pending)
    const killAll = vi.fn()
    let beforeQuit: (event: { preventDefault(): void }) => void = () => undefined
    const quit = vi.fn()
    vm.runInNewContext(cleanup, {
      openCode: { dispose }, ptyMgr: { killAll }, log: vi.fn(),
      app: { on: (_name: string, handler: typeof beforeQuit) => { beforeQuit = handler }, quit },
    })
    const event = { preventDefault: vi.fn() }
    beforeQuit(event)
    beforeQuit(event)
    expect(dispose).toHaveBeenCalledOnce()
    expect(killAll).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    beforeQuit(event)
    expect(dispose).toHaveBeenCalledOnce()
  })
})
