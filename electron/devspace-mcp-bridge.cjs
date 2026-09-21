'use strict'

// Public stdio adapter for the official DevSpace HTTP server. Authentication is
// a separate native OAuth client: never read DevSpace's owner password or another
// application's tokens. The user completes DevSpace's normal consent form.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')

const WRITE_TOOLS = new Set(['open_workspace', 'read', 'write', 'edit', 'bash', 'grep', 'glob', 'ls', 'apply_patch', 'exec_command', 'write_stdin'])
const READ_TOOLS = new Set(['open_workspace', 'read', 'grep', 'glob', 'ls'])
const CACHE_NAME = 'ai-console-mcp-oauth.json'
const PROGRESS_DIRECTORY = 'ai-console-opencode-status'
const BRIDGE_HEARTBEAT_INTERVAL_MS = 3000
const BRIDGE_PROGRESS_MAX_AGE_MS = 12000
const BRIDGE_PING_TIMEOUT_MS = 2500
const PROGRESS_STATES = new Set([
  'checking_service', 'refreshing_authorization', 'waiting_for_owner', 'authorization_received',
  'connecting', 'connected', 'authorization_timeout', 'authorization_failed',
  'service_unreachable', 'bridge_failed', 'connection_failed', 'disconnected',
])

function fail(message, code) {
  const error = new Error(message)
  if (code) error.code = code
  return error
}

function progressFile(session, temporary = os.tmpdir(), paths = path) {
  if (typeof session !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session)) {
    throw fail('Invalid AI Console bridge session.', 'invalid_session')
  }
  const directory = paths.join(temporary, PROGRESS_DIRECTORY)
  return { directory, file: paths.join(directory, `${session}.json`) }
}

function createProgressReporter(session = process.env.AI_CONSOLE_BRIDGE_SESSION, options = {}) {
  if (!session) return () => undefined
  const io = options.io || fs
  const target = progressFile(session, options.temporary || os.tmpdir(), options.paths || path)
  io.mkdirSync(target.directory, { recursive: true, mode: 0o700 })
  try { io.chmodSync(target.directory, 0o700) } catch { /* Windows may not apply POSIX modes. */ }
  return state => {
    if (!PROGRESS_STATES.has(state)) throw fail('Invalid AI Console bridge progress state.', 'invalid_progress')
    const body = JSON.stringify({ version: 1, session, state, updatedAt: (options.now || Date.now)() })
    io.writeFileSync(target.file, body, { mode: 0o600 })
    try { io.chmodSync(target.file, 0o600) } catch { /* Windows may not apply POSIX modes. */ }
  }
}

function createStateHeartbeat(write, options = {}) {
  const intervalMs = options.intervalMs || BRIDGE_HEARTBEAT_INTERVAL_MS
  const setTimer = options.setInterval || setInterval
  const clearTimer = options.clearInterval || clearInterval
  let state = null, stopped = false
  const timer = setTimer(() => {
    if (!stopped && state && state !== 'connected') write(state)
  }, intervalMs)
  timer?.unref?.()
  return {
    report(next) {
      if (stopped) return
      state = next
      write(next)
    },
    stop() {
      if (stopped) return
      stopped = true
      clearTimer(timer)
    },
  }
}

async function connectRemoteMcp(remote, transport, report) {
  try { await remote.connect(transport) }
  catch (error) {
    report('connection_failed')
    throw Object.assign(fail('DevSpace MCP connection failed.', 'connection_failed'), { cause: error })
  }
}

function monitorRemoteConnection(remote, report, options = {}) {
  const intervalMs = options.intervalMs || BRIDGE_HEARTBEAT_INTERVAL_MS
  const pingTimeoutMs = options.pingTimeoutMs || BRIDGE_PING_TIMEOUT_MS
  const setTimer = options.setInterval || setInterval
  const clearTimer = options.clearInterval || clearInterval
  let stopped = false, pinging = false, timer
  const failConnection = state => {
    if (stopped) return
    stopped = true
    clearTimer(timer)
    report(state)
    try { options.onFailure?.(state) } catch { /* Liveness reporting must not throw. */ }
  }
  remote.onclose = () => failConnection('disconnected')
  remote.onerror = () => failConnection('connection_failed')
  const pulse = async () => {
    if (stopped || pinging) return
    pinging = true
    try {
      await remote.ping({ timeout: pingTimeoutMs })
      if (!stopped) report('connected')
    } catch { failConnection('connection_failed') }
    finally { pinging = false }
  }
  timer = setTimer(() => { void pulse() }, intervalMs)
  timer?.unref?.()
  report('connected')
  return {
    pulse,
    fail: failConnection,
    stop() {
      if (stopped) return
      stopped = true
      clearTimer(timer)
    },
  }
}
function packageCandidates(env = process.env, paths = path) {
  return [...new Set([
    ...(env.APPDATA ? [paths.join(env.APPDATA, 'npm', 'node_modules')] : []),
    ...(env.npm_config_prefix ? [paths.join(env.npm_config_prefix, 'node_modules'), paths.join(env.npm_config_prefix, 'lib', 'node_modules')] : []),
    ...(env.PATH || env.Path || '').split(paths.delimiter).filter(Boolean).flatMap(directory => {
      const base = directory.replace(/^"|"$/g, '')
      return [paths.join(base, 'node_modules'), paths.resolve(base, '..', 'lib', 'node_modules')]
    }),
  ])]
}

function findDevSpacePackage(env = process.env, io = fs, resolve = file => createRequire(file).resolve('@modelcontextprotocol/sdk/client/index.js')) {
  const candidates = [env.AI_CONSOLE_DEVSPACE_PACKAGE, ...packageCandidates(env).map(root => path.join(root, '@waishnav', 'devspace'))].filter(Boolean)
  for (const directory of candidates) {
    try {
      const manifest = path.join(directory, 'package.json')
      const info = JSON.parse(io.readFileSync(manifest, 'utf8'))
      if (info.name !== '@waishnav/devspace' || !io.statSync(path.join(directory, 'dist', 'cli.js')).isFile()) continue
      resolve(manifest)
      return directory
    } catch { /* Try the next official installation location. */ }
  }
  return null
}

function devSpaceServiceConfig(env = process.env, io = fs) {
  const { parseJsonc } = require('./opencode.cjs')
  const directory = env.DEVSPACE_CONFIG_DIR || path.join(os.homedir(), '.devspace')
  const jsonc = path.join(directory, 'config.jsonc')
  const file = io.existsSync(jsonc) ? jsonc : path.join(directory, 'config.json')
  if (io.statSync(file).size > 1024 * 1024) throw fail('DevSpace configuration is too large.')
  const config = parseJsonc(io.readFileSync(file, 'utf8'))
  const server = config.server && typeof config.server === 'object' ? config.server : config
  const port = Number(env.PORT || server.port || 7676)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('Invalid DevSpace local port.')
  const host = env.HOST || server.host || '127.0.0.1'
  if (!['127.0.0.1', 'localhost', '0.0.0.0', '::', '::1', '[::1]'].includes(host)) throw fail('The OpenCode bridge requires a local DevSpace server.')
  const origin = `http://${host === '::1' || host === '[::1]' ? '[::1]' : '127.0.0.1'}:${port}`
  const publicUrl = new URL(env.DEVSPACE_PUBLIC_BASE_URL || server.publicBaseUrl || origin)
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) throw fail('Invalid DevSpace public URL.')
  return { directory, origin, resource: new URL('/mcp', publicUrl).href }
}

function runtimeConfig(env = process.env, io = fs) {
  const { allowedRoots, validateWorkspace } = require('./opencode.cjs')
  return {
    ...devSpaceServiceConfig(env, io),
    workspace: validateWorkspace(env.DEVSPACE_MCP_WORKSPACE, allowedRoots({ env, io }), io),
    readOnly: env.DEVSPACE_MCP_WRITE_MODE === 'read_only',
  }
}

async function probeDevSpaceService(config, fetcher = fetch) {
  try {
    const response = await fetcher(`${config.origin}/.well-known/oauth-authorization-server`, {
      redirect: 'manual', signal: AbortSignal.timeout(1200),
    })
    if (response.status < 200 || response.status >= 300) return false
    const body = await response.text()
    if (body.length > 64 * 1024) return false
    const metadata = JSON.parse(body)
    oauthEndpoint(metadata.registration_endpoint, '/register', config)
    oauthEndpoint(metadata.authorization_endpoint, '/authorize', config)
    oauthEndpoint(metadata.token_endpoint, '/token', config)
    return true
  } catch { return false }
}

function oauthEndpoint(value, expectedPath, config) {
  const url = new URL(value)
  const resourceOrigin = new URL(config.resource).origin
  if (![config.origin, resourceOrigin].includes(url.origin) || url.pathname !== expectedPath || url.search || url.hash || url.username || url.password) {
    throw fail('DevSpace returned an unexpected OAuth endpoint.')
  }
  // OAuth secrets are sent only to this explicitly configured loopback server.
  return new URL(expectedPath, config.origin).href
}

async function jsonRequest(url, init, fetcher = fetch) {
  let response
  try {
    response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) })
  } catch {
    throw fail('DevSpace service is unreachable. Start DevSpace and retry the OpenCode connection.', 'service_unreachable')
  }
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(fail(`DevSpace OAuth HTTP ${response.status}. Check that its service is running and authorize the OpenCode connection.`, 'authorization_failed'), { status: response.status })
  }
  const body = await response.text()
  if (body.length > 1024 * 1024) throw fail('DevSpace OAuth response is too large.', 'authorization_failed')
  try { return JSON.parse(body) }
  catch { throw fail('DevSpace returned an invalid OAuth response.', 'authorization_failed') }
}

function validCallback(value, redirectUri, state) {
  const url = new URL(value, redirectUri)
  const target = new URL(redirectUri)
  return url.origin === target.origin && url.pathname === '/callback' && !url.username && !url.password
    && url.searchParams.get('state') === state && !!url.searchParams.get('code') && !url.searchParams.has('error')
}

async function callbackListener(redirectUri, state, timeout = 150000) {
  const previous = redirectUri ? new URL(redirectUri) : null
  if (previous && (previous.protocol !== 'http:' || previous.hostname !== '127.0.0.1' || previous.pathname !== '/callback' || !previous.port || previous.username || previous.password || previous.search || previous.hash)) {
    throw fail('Invalid saved DevSpace OAuth callback. Remove only the AI console OAuth cache and reconnect.')
  }
  let resolveCode, rejectCode, timer
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  // Prevent an early bind error from creating an unhandled pending rejection.
  code.catch(() => {})
  let callbackUrl
  const server = http.createServer((request, response) => {
    let received
    try { received = new URL(request.url || '/', callbackUrl) } catch { /* Reject malformed callback requests below. */ }
    if (!received || request.method !== 'GET' || request.headers.host !== new URL(callbackUrl).host || !validCallback(received.href, callbackUrl, state)) {
      response.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      response.end('Invalid OAuth callback. Return to the DevSpace authorization page.')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end('DevSpace 授權已收到。可以關閉此頁，回到 OpenCode 等待 MCP 連線完成。')
    resolveCode(received.searchParams.get('code'))
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(previous ? Number(previous.port) : 0, '127.0.0.1', resolve)
    })
  } catch { throw fail('The DevSpace OAuth callback port is unavailable. Close the previous authorization window and retry.', 'authorization_failed') }
  callbackUrl = `http://127.0.0.1:${server.address().port}/callback`
  timer = setTimeout(() => rejectCode(fail('DevSpace authorization timed out. Reopen OpenCode and finish its browser consent form.', 'authorization_timeout')), timeout)
  return {
    redirectUri: callbackUrl, code,
    close() { clearTimeout(timer); server.close(); server.closeAllConnections() },
  }
}

function openConsent(url, origin, env = process.env, platform = process.platform) {
  const parsed = new URL(url)
  if (parsed.origin !== origin || parsed.pathname !== '/authorize' || parsed.username || parsed.password) throw fail('Invalid DevSpace authorization URL.')
  const command = platform === 'win32'
    ? [path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', parsed.href]]
    : platform === 'darwin' ? ['/usr/bin/open', [parsed.href]] : ['xdg-open', [parsed.href]]
  const browser = spawn(command[0], command[1], { shell: false, windowsHide: true, detached: true, stdio: 'ignore' })
  browser.on('error', () => { process.stderr.write('The DevSpace consent browser could not open. Return to AI Console and use Reconnect. No authorization URL or credential was printed.\n') })
  browser.unref()
}

function readCache(file, resource, io = fs) {
  try {
    if (io.statSync(file).size > 64 * 1024) return {}
    const cache = JSON.parse(io.readFileSync(file, 'utf8'))
    return cache.resource === resource ? cache : {}
  } catch { return {} }
}
function writeCache(file, cache, io = fs) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    io.writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600, flag: 'wx' })
    io.renameSync(temporary, file)
    io.chmodSync(file, 0o600)
  } finally { try { io.unlinkSync(temporary) } catch { /* Atomic rename already removed it. */ } }
}

async function cacheLock(file) {
  const directory = file + '.lock'
  const deadline = Date.now() + 160000
  while (true) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 })
      fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' })
      return () => { try { fs.unlinkSync(path.join(directory, 'owner.json')); fs.rmdirSync(directory) } catch { /* Do not remove another client's lock. */ } }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'))
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0) }
          catch (missing) {
            if (missing.code === 'ESRCH') { fs.unlinkSync(path.join(directory, 'owner.json')); fs.rmdirSync(directory); continue }
          }
        }
      } catch { /* A client may still be creating its lock metadata. */ }
      if (Date.now() >= deadline) throw fail('Another OpenCode window is authorizing DevSpace. Finish that consent form first.', 'authorization_failed')
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
}

function reportProgress(options, state) {
  if (typeof options?.onProgress !== 'function') return
  try { options.onProgress(state) } catch { /* Status reporting must never weaken or break OAuth. */ }
}

async function accessToken(config, options = {}) {
  let release
  try { release = await (options.lock || cacheLock)(path.join(config.directory, CACHE_NAME)) }
  catch (error) {
    reportProgress(options, error?.code === 'service_unreachable' ? 'service_unreachable' : 'authorization_failed')
    throw error
  }
  try {
    return await authorize(config, options)
  } catch (error) {
    const state = error?.code === 'authorization_timeout' ? 'authorization_timeout'
      : error?.code === 'service_unreachable' ? 'service_unreachable' : 'authorization_failed'
    reportProgress(options, state)
    throw error
  } finally { release() }
}

async function authorize(config, options) {
  const fetcher = options.fetch || fetch
  const load = options.readCache || readCache
  const save = options.writeCache || writeCache
  const file = path.join(config.directory, CACHE_NAME)
  reportProgress(options, 'checking_service')
  const metadata = await jsonRequest(`${config.origin}/.well-known/oauth-authorization-server`, {}, fetcher)
  const registration = oauthEndpoint(metadata.registration_endpoint, '/register', config)
  const authorization = oauthEndpoint(metadata.authorization_endpoint, '/authorize', config)
  const tokenEndpoint = oauthEndpoint(metadata.token_endpoint, '/token', config)
  let cache = load(file, config.resource)
  const client = cache.client
  if (typeof client?.client_id !== 'string' || client.token_endpoint_auth_method !== 'none') cache = { resource: config.resource }
  if (typeof cache.access_token === 'string' && cache.access_token && cache.expiresAt > Date.now() + 120000) {
    reportProgress(options, 'connecting')
    return cache.access_token
  }
  const exchange = fields => jsonRequest(tokenEndpoint, { method: 'POST', body: new URLSearchParams(fields) }, fetcher)
  let tokens
  if (cache.refresh_token && cache.client) {
    reportProgress(options, 'refreshing_authorization')
    try { tokens = await exchange({ grant_type: 'refresh_token', client_id: cache.client.client_id, refresh_token: cache.refresh_token, resource: config.resource }) }
    catch (error) { if (![400, 401].includes(error.status)) throw error }
  }
  if (!tokens) {
    const state = crypto.randomBytes(24).toString('base64url')
    const verifier = crypto.randomBytes(32).toString('base64url')
    const listener = await (options.callbackListener || callbackListener)(cache.client?.redirect_uris?.[0], state)
    try {
      if (!cache.client) {
        const registered = await jsonRequest(registration, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          client_name: 'AI Console OpenCode', redirect_uris: [listener.redirectUri], token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        }) }, fetcher)
        if (typeof registered.client_id !== 'string' || registered.token_endpoint_auth_method !== 'none') throw fail('Invalid DevSpace OAuth client registration.', 'authorization_failed')
        // Keep only native-client metadata. Never cache a client secret.
        cache.client = { client_id: registered.client_id, token_endpoint_auth_method: 'none', redirect_uris: [listener.redirectUri] }
        save(file, cache)
      }
      const url = new URL(authorization)
      url.search = new URLSearchParams({ client_id: cache.client.client_id, redirect_uri: listener.redirectUri, response_type: 'code',
        scope: 'devspace', resource: config.resource, state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString()
      reportProgress(options, 'waiting_for_owner')
      ;(options.openConsent || openConsent)(url.href, config.origin)
      const code = await listener.code
      reportProgress(options, 'authorization_received')
      tokens = await exchange({ grant_type: 'authorization_code', client_id: cache.client.client_id, code, code_verifier: verifier,
        redirect_uri: listener.redirectUri, resource: config.resource })
    } finally { listener.close() }
  }
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0) {
    throw fail('Invalid DevSpace OAuth token response.', 'authorization_failed')
  }
  save(file, { resource: config.resource, client: cache.client, access_token: tokens.access_token,
    ...(typeof tokens.refresh_token === 'string' ? { refresh_token: tokens.refresh_token } : {}),
    expiresAt: Date.now() + Number(tokens.expires_in) * 1000 })
  reportProgress(options, 'connecting')
  return tokens.access_token
}

function workspaceFilter(remote, config, io = fs, paths = path) {
  const allowed = config.readOnly ? READ_TOOLS : WRITE_TOOLS
  const ids = new Set()
  const canonical = value => {
    if (typeof value !== 'string' || !paths.isAbsolute(value)) throw fail('Use the assigned absolute workspace path.')
    return io.realpathSync(value)
  }
  const matches = value => paths.relative(canonical(config.workspace), canonical(value)) === ''
  return {
    async listTools(params) { const result = await remote.listTools(params); return { ...result, tools: result.tools.filter(tool => allowed.has(tool.name)) } },
    async callTool(params) {
      if (!allowed.has(params.name)) throw fail('This tool is not available in the OpenCode conversation.')
      const args = params.arguments || {}
      if (params.name === 'open_workspace') {
        if (!matches(args.path) || (args.mode && args.mode !== 'checkout')) throw fail('This conversation is bound to its selected project.')
      } else {
        const supplied = [args.workspace_id, args.workspaceId].filter(id => id !== undefined)
        if (!supplied.length || new Set(supplied).size !== 1 || supplied.some(id => typeof id !== 'string' || !ids.has(id))) throw fail('Open the assigned workspace before using its tools.')
      }
      const result = await remote.callTool(params)
      if (params.name === 'open_workspace' && !result.isError) {
        const data = result.structuredContent
        const returned = [data?.workspace_id, data?.workspaceId].filter(id => id !== undefined)
        const id = returned[0]
        if (new Set(returned).size !== 1 || typeof id !== 'string' || !matches(data.root)) throw fail('DevSpace did not confirm the assigned workspace.')
        ids.add(id)
      }
      return result
    },
  }
}

async function main(onProgress = () => undefined, options = {}) {
  const heartbeat = createStateHeartbeat(state => {
    try { onProgress(state) } catch { /* Never let status reporting alter the connection. */ }
  }, options)
  const report = heartbeat.report
  try {
    const config = runtimeConfig()
    const directory = findDevSpacePackage()
    if (!directory) throw fail('Install official @waishnav/devspace with Node.js 22.19 or newer before opening OpenCode.', 'bridge_failed')
    const requireSdk = createRequire(path.join(directory, 'package.json'))
    const load = specifier => import(pathToFileURL(requireSdk.resolve('@modelcontextprotocol/sdk/' + specifier)).href)
    const [{ Client }, { StreamableHTTPClientTransport }, { Server }, { StdioServerTransport }, types] = await Promise.all([
      load('client/index.js'), load('client/streamableHttp.js'), load('server/index.js'), load('server/stdio.js'), load('types.js'),
    ])
    const token = await accessToken(config, { onProgress: report })
    const remote = new Client({ name: 'ai-console-opencode', version: '1.0.0' })
    await connectRemoteMcp(remote, new StreamableHTTPClientTransport(new URL(config.origin + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }), report)
    const closeRemote = () => {
      try { void remote.close().catch(() => undefined) } catch { /* The transport may already be closed. */ }
    }
    const filtered = workspaceFilter(remote, config)
    const server = new Server({ name: 'devspace', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(types.ListToolsRequestSchema, request => filtered.listTools(request.params))
    server.setRequestHandler(types.CallToolRequestSchema, request => filtered.callTool(request.params))
    let monitor
    server.onclose = () => {
      monitor?.fail('disconnected')
      heartbeat.stop()
      closeRemote()
    }
    try {
      await server.connect(new StdioServerTransport())
      monitor = monitorRemoteConnection(remote, report, {
        ...options,
        onFailure: closeRemote,
      })
    } catch (error) {
      report('connection_failed')
      heartbeat.stop()
      try { await remote.close() } catch { /* Preserve the original connection failure. */ }
      throw Object.assign(fail('OpenCode could not attach the DevSpace MCP bridge.', 'connection_failed'), { cause: error })
    }
  } catch (error) {
    heartbeat.stop()
    throw error
  }
}

module.exports = {
  packageCandidates, findDevSpacePackage, devSpaceServiceConfig, probeDevSpaceService, runtimeConfig,
  oauthEndpoint, validCallback, callbackListener, accessToken, workspaceFilter, readCache, writeCache,
  progressFile, createProgressReporter, createStateHeartbeat, connectRemoteMcp, monitorRemoteConnection,
  BRIDGE_PROGRESS_MAX_AGE_MS, CACHE_NAME,
}
if (require.main === module) {
  let report
  try { report = createProgressReporter() }
  catch {
    process.stderr.write('DevSpace MCP status session is invalid. Reopen OpenCode from AI Console. No work was submitted.\n')
    process.exitCode = 1
  }
  if (report) main(report).catch(error => {
    const state = error?.code === 'authorization_timeout' ? 'authorization_timeout'
      : error?.code === 'service_unreachable' ? 'service_unreachable'
        : error?.code === 'authorization_failed' ? 'authorization_failed'
          : error?.code === 'connection_failed' ? 'connection_failed' : 'bridge_failed'
    try { report(state) } catch { /* The fixed stderr message below remains available. */ }
    process.stderr.write('DevSpace MCP could not connect. Start DevSpace, reopen OpenCode, and finish the DevSpace browser authorization using the Owner password from your own setup. No work was submitted.\n')
    process.exitCode = 1
  })
}
