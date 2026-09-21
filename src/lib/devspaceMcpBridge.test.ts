import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
interface Remote { listTools(params?: unknown): Promise<{ tools: { name: string }[] }>; callTool(params: unknown): Promise<unknown> }
interface Filter { listTools(params?: unknown): Promise<{ tools: { name: string }[] }>; callTool(params: unknown): Promise<unknown> }
interface Callback { redirectUri: string; code: Promise<string>; close(): void }
const bridge = require('../../electron/devspace-mcp-bridge.cjs') as {
  oauthEndpoint(value: string, expected: string, config: unknown): string
  validCallback(value: string, redirect: string, state: string): boolean
  callbackListener(redirect: string | undefined, state: string, timeout?: number): Promise<Callback>
  accessToken(config: unknown, options: Record<string, unknown>): Promise<string>
  probeDevSpaceService(config: unknown, fetcher: (url: string, init: RequestInit) => Promise<unknown>): Promise<boolean>
  progressFile(session: string, temporary?: string): { directory: string; file: string }
  createProgressReporter(session: string, options?: Record<string, unknown>): (state: string) => void
  createStateHeartbeat(write: (state: string) => void, options?: Record<string, unknown>): { report(state: string): void; stop(): void }
  connectRemoteMcp(remote: { connect(transport: unknown): Promise<void> }, transport: unknown, report: (state: string) => void): Promise<void>
  monitorRemoteConnection(remote: { ping(options?: unknown): Promise<unknown>; onclose?: () => void; onerror?: (error: Error) => void }, report: (state: string) => void, options?: Record<string, unknown>): { pulse(): Promise<void>; fail(state: string): void; stop(): void }
  BRIDGE_PROGRESS_MAX_AGE_MS: number
  workspaceFilter(remote: Remote, config: unknown, io: unknown, paths: typeof path): Filter
  findDevSpacePackage(env: unknown, io: unknown, resolve: (file: string) => string): string | null
}
const config = { directory: 'C:\\Config', origin: 'http://127.0.0.1:17676', resource: 'https://devspace.example/mcp' }
const metadata = { registration_endpoint: 'https://devspace.example/register', authorization_endpoint: 'https://devspace.example/authorize', token_endpoint: 'https://devspace.example/token' }
const json = (body: unknown, status = 200) => ({ status, text: async () => JSON.stringify(body) })
const unlocked = async () => () => undefined

describe('public DevSpace MCP OAuth bridge', () => {
  it('maps only expected OAuth paths to the configured loopback origin', () => {
    expect(bridge.oauthEndpoint(metadata.token_endpoint, '/token', config)).toBe(config.origin + '/token')
    for (const target of ['https://evil.test/token', 'https://devspace.example/other', 'https://user:secret@devspace.example/token', 'https://devspace.example/token?leak=1', 'https://devspace.example/token#fragment']) {
      expect(() => bridge.oauthEndpoint(target, '/token', config)).toThrow()
    }
  })

  it('probes only the read-only OAuth metadata endpoint and never opens consent', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(config.origin + '/.well-known/oauth-authorization-server')
      expect(init.redirect).toBe('manual')
      expect(init.headers).toBeUndefined()
      return json(metadata)
    })
    await expect(bridge.probeDevSpaceService(config, fetcher)).resolves.toBe(true)
    expect(fetcher).toHaveBeenCalledOnce()
    await expect(bridge.probeDevSpaceService(config, async () => { throw new Error('offline') })).resolves.toBe(false)
    await expect(bridge.probeDevSpaceService(config, async () => json({ ...metadata, authorization_endpoint: 'https://evil.test/authorize' }))).resolves.toBe(false)
  })

  it('writes fixed progress states to an exact random session without secrets', () => {
    const session = '11111111-1111-4111-8111-111111111111'
    const temporary = mkdtempSync(path.join(tmpdir(), 'ai-console-opencode-progress-'))
    try {
      const report = bridge.createProgressReporter(session, { temporary, now: () => 12345 })
      report('waiting_for_owner')
      const target = bridge.progressFile(session, temporary)
      const text = readFileSync(target.file, 'utf8')
      expect(JSON.parse(text)).toEqual({ version: 1, session, state: 'waiting_for_owner', updatedAt: 12345 })
      expect(text).not.toMatch(/access_token|refresh_token|owner_token|password|Basic |Bearer /i)
      expect(() => report('access_token=secret')).toThrow()
      expect(() => bridge.progressFile('../escape', temporary)).toThrow()
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  })

  it('keeps authorization progress fresh without treating a connected snapshot as a heartbeat', () => {
    let tick: () => void = () => undefined
    const cleared = vi.fn()
    const states: string[] = []
    const heartbeat = bridge.createStateHeartbeat(state => states.push(state), {
      intervalMs: 10,
      setInterval: (callback: () => void) => { tick = callback; return { unref: vi.fn() } },
      clearInterval: cleared,
    })
    heartbeat.report('waiting_for_owner')
    tick()
    expect(states).toEqual(['waiting_for_owner', 'waiting_for_owner'])
    heartbeat.report('connected')
    tick()
    expect(states).toEqual(['waiting_for_owner', 'waiting_for_owner', 'connected'])
    heartbeat.stop()
    tick()
    expect(cleared).toHaveBeenCalledOnce()
    expect(states).toHaveLength(3)
  })

  it('refreshes connected liveness only after MCP ping and records remote error or close', async () => {
    const states: string[] = []
    const remote = { ping: vi.fn(async () => ({})) } as {
      ping(options?: unknown): Promise<unknown>
      onclose?: () => void
      onerror?: (error: Error) => void
    }
    const monitor = bridge.monitorRemoteConnection(remote, state => states.push(state), {
      intervalMs: 10,
      pingTimeoutMs: 5,
      setInterval: () => ({ unref: vi.fn() }),
      clearInterval: vi.fn(),
    })
    expect(states).toEqual(['connected'])
    await monitor.pulse()
    expect(remote.ping).toHaveBeenCalledWith({ timeout: 5 })
    expect(states).toEqual(['connected', 'connected'])
    remote.onerror?.(new Error('upstream failed'))
    expect(states.at(-1)).toBe('connection_failed')
    await monitor.pulse()
    expect(remote.ping).toHaveBeenCalledOnce()

    const closeStates: string[] = []
    const closedRemote = { ping: vi.fn(async () => ({})) } as typeof remote
    bridge.monitorRemoteConnection(closedRemote, state => closeStates.push(state), {
      setInterval: () => ({ unref: vi.fn() }), clearInterval: vi.fn(),
    })
    closedRemote.onclose?.()
    expect(closeStates).toEqual(['connected', 'disconnected'])
  })

  it('keeps a valid Owner authorization separate from a later MCP transport failure', async () => {
    const states: string[] = []
    const cached = {
      resource: config.resource,
      client: { client_id: 'own', token_endpoint_auth_method: 'none' },
      access_token: 'valid-token', expiresAt: Date.now() + 3600000,
    }
    const token = await bridge.accessToken(config, {
      lock: unlocked,
      readCache: () => cached,
      fetch: async () => json(metadata),
      onProgress: (state: string) => states.push(state),
    })
    expect(token).toBe('valid-token')
    await expect(bridge.connectRemoteMcp({
      connect: vi.fn(async () => { throw new Error('transport unavailable') }),
    }, {}, state => states.push(state))).rejects.toMatchObject({ code: 'connection_failed' })
    expect(states).toEqual(['checking_service', 'connecting', 'connection_failed'])
    expect(states).not.toContain('authorization_failed')
  })

  it('performs public native registration and PKCE after browser consent without an owner password', async () => {
    let consent: URL | undefined
    let state = ''
    const close = vi.fn()
    const save = vi.fn()
    const calls: { url: string; init: RequestInit }[] = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      expect(init.redirect).toBe('manual')
      if (url.endsWith('/.well-known/oauth-authorization-server')) return json(metadata)
      if (url.endsWith('/register')) {
        const client = JSON.parse(String(init.body))
        expect(client.client_name).toBe('AI Console OpenCode')
        expect(client.token_endpoint_auth_method).toBe('none')
        return json({ client_id: 'this-client', token_endpoint_auth_method: 'none', client_secret: 'must-not-save' })
      }
      const fields = init.body as URLSearchParams
      expect(fields.get('grant_type')).toBe('authorization_code')
      expect(fields.get('code')).toBe('consented-code')
      expect(fields.has('owner_token')).toBe(false)
      expect(consent?.searchParams.get('code_challenge')).toBe(createHash('sha256').update(fields.get('code_verifier')!).digest('base64url'))
      return json({ access_token: 'this-access', refresh_token: 'this-refresh', expires_in: 3600 })
    })
    const token = await bridge.accessToken(config, {
      lock: unlocked, fetch: fetcher, readCache: () => ({}), writeCache: save,
      callbackListener: async (_redirect: unknown, value: string) => { state = value; return { redirectUri: 'http://127.0.0.1:14444/callback', code: Promise.resolve('consented-code'), close } },
      openConsent: (url: string) => { consent = new URL(url) },
    })
    expect(token).toBe('this-access')
    expect(consent?.origin).toBe(config.origin)
    expect(consent?.searchParams.get('state')).toBe(state)
    expect(consent?.searchParams.has('owner_token')).toBe(false)
    expect(calls.every(call => call.url.startsWith(config.origin + '/'))).toBe(true)
    expect(JSON.stringify(save.mock.calls)).not.toContain('must-not-save')
    expect(close).toHaveBeenCalledOnce()
  })

  it('recovers from an authorization timeout by opening a fresh consent attempt', async () => {
    let saved: Record<string, unknown> = {}
    const writeCache = vi.fn((_file: string, value: Record<string, unknown>) => { saved = value })
    const firstProgress: string[] = []
    const timeout = Object.assign(new Error('timeout'), { code: 'authorization_timeout' })
    const rejectedCode = { then: (_resolve: unknown, reject: (error: Error) => void) => reject(timeout) } as unknown as Promise<string>
    const firstClose = vi.fn()
    await expect(bridge.accessToken(config, {
      lock: unlocked,
      readCache: () => ({}),
      writeCache,
      onProgress: (state: string) => firstProgress.push(state),
      fetch: async (url: string) => url.endsWith('/.well-known/oauth-authorization-server')
        ? json(metadata) : json({ client_id: 'retry-client', token_endpoint_auth_method: 'none' }),
      callbackListener: async () => ({ redirectUri: 'http://127.0.0.1:14444/callback', code: rejectedCode, close: firstClose }),
      openConsent: vi.fn(),
    })).rejects.toMatchObject({ code: 'authorization_timeout' })
    expect(firstProgress).toEqual(['checking_service', 'waiting_for_owner', 'authorization_timeout'])
    expect(saved).toMatchObject({ resource: config.resource, client: { client_id: 'retry-client', token_endpoint_auth_method: 'none' } })
    expect(firstClose).toHaveBeenCalledOnce()

    const secondProgress: string[] = []
    const secondConsent = vi.fn()
    const secondClose = vi.fn()
    const token = await bridge.accessToken(config, {
      lock: unlocked,
      readCache: () => saved,
      writeCache,
      onProgress: (state: string) => secondProgress.push(state),
      fetch: async (url: string, init: RequestInit) => {
        if (url.endsWith('/.well-known/oauth-authorization-server')) return json(metadata)
        expect(url).toBe(config.origin + '/token')
        expect((init.body as URLSearchParams).get('grant_type')).toBe('authorization_code')
        return json({ access_token: 'recovered-access', refresh_token: 'recovered-refresh', expires_in: 3600 })
      },
      callbackListener: async (redirect: string | undefined) => {
        expect(redirect).toBe('http://127.0.0.1:14444/callback')
        return { redirectUri: redirect!, code: Promise.resolve('retry-code'), close: secondClose }
      },
      openConsent: secondConsent,
    })
    expect(token).toBe('recovered-access')
    expect(secondConsent).toHaveBeenCalledOnce()
    expect(secondClose).toHaveBeenCalledOnce()
    expect(secondProgress).toEqual(['checking_service', 'waiting_for_owner', 'authorization_received', 'connecting'])
  })

  it('refreshes only its own cache and never opens consent for a valid access token', async () => {
    const cached = { resource: config.resource, client: { client_id: 'own', token_endpoint_auth_method: 'none' }, access_token: 'still-valid', expiresAt: Date.now() + 3600000 }
    const openConsent = vi.fn()
    const fetcher = vi.fn(async () => json(metadata))
    expect(await bridge.accessToken(config, { lock: unlocked, readCache: () => cached, fetch: fetcher, openConsent })).toBe('still-valid')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(openConsent).not.toHaveBeenCalled()
    const save = vi.fn()
    const refreshed = await bridge.accessToken(config, {
      lock: unlocked, readCache: () => ({ ...cached, expiresAt: 0, refresh_token: 'own-refresh' }), writeCache: save, openConsent,
      fetch: async (url: string, init: RequestInit) => {
        if (url.endsWith('/token')) {
          expect((init.body as URLSearchParams).get('refresh_token')).toBe('own-refresh')
          return json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 })
        }
        return json(metadata)
      },
    })
    expect(refreshed).toBe('renewed')
    expect(openConsent).not.toHaveBeenCalled()
    expect(save.mock.calls[0][1].refresh_token).toBe('rotated')
  })

  it('rejects foreign token endpoints before using a cached token or granting consent', async () => {
    const readCache = vi.fn()
    const openConsent = vi.fn()
    await expect(bridge.accessToken(config, { lock: unlocked, readCache, openConsent, fetch: async () => json({ ...metadata, token_endpoint: 'https://evil.test/token' }) })).rejects.toThrow()
    expect(readCache).not.toHaveBeenCalled()
    expect(openConsent).not.toHaveBeenCalled()
  })

  it('accepts only its exact callback origin, path and OAuth state', () => {
    const target = 'http://127.0.0.1:14444/callback'
    expect(bridge.validCallback(target + '?state=own&code=ok', target, 'own')).toBe(true)
    for (const suffix of ['?state=other&code=ok', '?state=own', '?state=own&code=ok&error=denied']) expect(bridge.validCallback(target + suffix, target, 'own')).toBe(false)
    expect(bridge.validCallback('http://evil.test/callback?state=own&code=ok', target, 'own')).toBe(false)
  })

  it('returns HTTP 400 for malformed browser callbacks without crashing its listener', async () => {
    const listener = await bridge.callbackListener(undefined, 'own', 3000)
    const target = new URL(listener.redirectUri)
    try {
      const invalidStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request({ hostname: target.hostname, port: target.port, path: 'http://%', method: 'GET' }, response => { response.resume(); resolve(response.statusCode) })
        req.once('error', reject); req.end()
      })
      expect(invalidStatus).toBe(400)
      const response = await fetch(listener.redirectUri + '?state=own&code=ok')
      expect(response.status).toBe(200)
      expect(await listener.code).toBe('ok')
    } finally { listener.close() }
  })

  it('uses the official installed package and SDK without requiring its private stdio patch', () => {
    const packageRoot = path.join('C:\\Tools', 'node_modules', '@waishnav', 'devspace')
    const io = { readFileSync: () => '{"name":"@waishnav/devspace"}', statSync: () => ({ isFile: () => true }) }
    const resolver = vi.fn(() => 'official-sdk')
    expect(bridge.findDevSpacePackage({ AI_CONSOLE_DEVSPACE_PACKAGE: packageRoot }, io, resolver)).toBe(packageRoot)
    expect(resolver).toHaveBeenCalledWith(path.join(packageRoot, 'package.json'))
  })
})

describe('public DevSpace workspace tool boundary', () => {
  const workspace = 'C:\\Projects\\chosen'
  const io = { realpathSync: (value: string) => value.endsWith('escape') ? 'D:\\private' : value }
  function setup(snake = false, readOnly = false) {
    const callTool = vi.fn(async () => ({ structuredContent: { [snake ? 'workspace_id' : 'workspaceId']: 'known', root: workspace }, content: [] }))
    const remote = { callTool, listTools: async () => ({ tools: ['open_workspace', 'read', 'write', 'agents_run', 'agents_continue', 'download_artifact'].map(name => ({ name })) }) }
    return { callTool, filter: bridge.workspaceFilter(remote, { workspace, readOnly }, io, path.win32) }
  }
  it('filters job APIs and supports official 1.0.8 camelCase workspace IDs', async () => {
    const { filter } = setup()
    expect((await filter.listTools()).tools.map(tool => tool.name)).toEqual(['open_workspace', 'read', 'write'])
    await filter.callTool({ name: 'open_workspace', arguments: { path: workspace } })
    await expect(filter.callTool({ name: 'read', arguments: { workspaceId: 'known', path: 'README.md' } })).resolves.toBeDefined()
    await expect(filter.callTool({ name: 'agents_run', arguments: { workspaceId: 'known' } })).rejects.toThrow()
  })
  it('supports newer snake_case IDs without letting a second ID bypass the boundary', async () => {
    const { filter, callTool } = setup(true)
    await filter.callTool({ name: 'open_workspace', arguments: { path: workspace } })
    await filter.callTool({ name: 'read', arguments: { workspace_id: 'known' } })
    await expect(filter.callTool({ name: 'read', arguments: { workspace_id: 'known', workspaceId: 'foreign' } })).rejects.toThrow()
    expect(callTool).toHaveBeenCalledTimes(2)
  })
  it('rejects unopened IDs, other paths, symlink escapes, worktrees and read-only writes', async () => {
    const { filter, callTool } = setup(false, true)
    await expect(filter.callTool({ name: 'read', arguments: { workspaceId: 'foreign' } })).rejects.toThrow()
    for (const args of [{ path: 'C:\\Projects\\other' }, { path: workspace + '\\escape' }, { path: workspace, mode: 'worktree' }]) await expect(filter.callTool({ name: 'open_workspace', arguments: args })).rejects.toThrow()
    expect(callTool).not.toHaveBeenCalled()
    await filter.callTool({ name: 'open_workspace', arguments: { path: workspace } })
    await expect(filter.callTool({ name: 'write', arguments: { workspaceId: 'known' } })).rejects.toThrow()
  })
  it('rejects contradictory workspace aliases returned by a remote server', async () => {
    const { filter, callTool } = setup()
    callTool.mockResolvedValueOnce({ structuredContent: { workspace_id: 'known', workspaceId: 'other', root: workspace }, content: [] })
    await expect(filter.callTool({ name: 'open_workspace', arguments: { path: workspace } })).rejects.toThrow()
    await expect(filter.callTool({ name: 'read', arguments: { workspace_id: 'known' } })).rejects.toThrow()
    expect(callTool).toHaveBeenCalledOnce()
  })
})
