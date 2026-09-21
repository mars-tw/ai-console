'use strict'

// A local, user-opened conversation surface. No prompts, credentials, or job
// commands cross this module's renderer API.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const http = require('node:http')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const { packageCandidates, findDevSpacePackage } = require('./devspace-mcp-bridge.cjs')

const CHANNELS = ['opencode:status', 'opencode:open', 'opencode:stop']
const MODELS = ['gpt-5.6-sol', 'gpt-6-astra']
const ERRORS = {
  forbidden: '只能從本機工作臺操作 OpenCode。',
  config: '無法讀取 DevSpace 允許目錄，請先完成 DevSpace 設定。',
  workspace: '請選擇 DevSpace 允許目錄內已存在的專案資料夾。',
  missing: '尚未找到 OpenCode，請先安裝後重新整理。',
  bridge: '找不到 DevSpace 對話連線程式或 Node.js，請先完成 DevSpace 安裝。',
  busy: 'OpenCode 已在另一個專案啟動，請先停止服務再切換專案。',
  starting: 'OpenCode 正在啟動，請稍候。',
  start: 'OpenCode 無法啟動，請確認安裝完成後再試一次。',
  stopped: 'OpenCode 啟動已取消。',
  window: 'OpenCode 對話視窗無法開啟，請再試一次。',
  model: '請選擇 GPT-5.6 SOL 或 GPT-6 ASTRA。',
}

function failure(code) { return Object.assign(new Error(ERRORS[code] || ERRORS.start), { code }) }
function safeError(error) {
  return { ok: false, code: Object.hasOwn(ERRORS, error?.code) ? error.code : 'start', error: ERRORS[error?.code] || ERRORS.start }
}

// JSONC comments/trailing commas without interpreting comment markers in strings.
function parseJsonc(text) {
  const source = text.replace(/^\uFEFF/, '')
  let result = '', quoted = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (quoted) {
      result += c
      if (c === '\\') result += source[++i] ?? ''
      else if (c === '"') quoted = false
    } else if (c === '"') { quoted = true; result += c }
    else if (source.slice(i, i + 2) === '//') {
      while (i < source.length && source[i] !== '\n') i++
      result += '\n'
    } else if (source.slice(i, i + 2) === '/*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) throw failure('config')
      i = end + 1
      result += ' '
    } else if (c !== ',' || !/^\s*[}\]]/.test(source.slice(i + 1))) result += c
  }
  return JSON.parse(result)
}

function allowedRoots({ env = process.env, home = os.homedir(), io = fs } = {}) {
  try {
    let roots
    if (env.DEVSPACE_ALLOWED_ROOTS !== undefined) roots = env.DEVSPACE_ALLOWED_ROOTS.split(',')
    else {
      const directory = env.DEVSPACE_CONFIG_DIR || path.join(home, '.devspace')
      const jsonc = path.join(directory, 'config.jsonc')
      const file = io.existsSync(jsonc) ? jsonc : path.join(directory, 'config.json')
      if (io.statSync(file).size > 1024 * 1024) throw failure('config')
      const config = parseJsonc(io.readFileSync(file, 'utf8'))
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure('config')
      if (config.configVersion !== undefined && config.configVersion !== 1) throw failure('config')
      roots = (config.workspaces && typeof config.workspaces === 'object' ? config.workspaces : config).allowedRoots
    }
    if (!Array.isArray(roots) || roots.some(value => typeof value !== 'string')) throw failure('config')
    return [...new Set(roots.filter(value => value.trim()).map(value => {
      const full = value.trim().replace(/^~(?=[/\\]|$)/, home)
      if (!path.isAbsolute(full) || !io.statSync(full).isDirectory()) throw failure('config')
      return io.realpathSync(full)
    }))]
  } catch { throw failure('config') }
}

function validateWorkspace(value, roots, io = fs, paths = path) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32767 || value.includes('\0') || !paths.isAbsolute(value.trim())) throw failure('workspace')
  try {
    if (!io.statSync(value.trim()).isDirectory()) throw failure('workspace')
    const resolved = io.realpathSync(value.trim())
    const accepted = roots.some(root => {
      const canonical = io.realpathSync(root)
      const relative = paths.relative(canonical, resolved)
      return relative === '' || (!relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative))
    })
    if (!accepted) throw failure('workspace')
    return resolved
  } catch { throw failure('workspace') }
}

function trustedSender(event, mainWindow, appUrl) {
  const window = mainWindow()
  if (!window || window.isDestroyed?.() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false
  try {
    const sender = new URL(event.senderFrame.url)
    const app = new URL(appUrl)
    return sender.origin === app.origin && !sender.username && !sender.password && !/^\/m(?:\/|$)/.test(sender.pathname)
  } catch { return false }
}

function sameOrigin(value, origin) {
  try {
    const url = new URL(value)
    return url.origin === origin && !url.username && !url.password
  } catch { return false }
}

function discover({ env = process.env, io = fs, platform = process.platform } = {}) {
  const exists = file => { try { return !!file && io.statSync(file).isFile() } catch { return false } }
  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode'
  const nativeBin = packageCandidates(env).map(root => path.join(root, 'opencode-ai', 'bin', binaryName)).find(exists)
    || (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/g, ''), binaryName)).find(exists)
  const bridge = path.join(__dirname, 'devspace-mcp-bridge.cjs')
  const executable = platform === 'win32' ? 'node.exe' : 'node'
  const node = (env.PATH || env.Path || '').split(path.delimiter)
    .map(directory => path.join(directory.replace(/^"|"$/g, ''), executable))
    .find(file => { try { return path.isAbsolute(file) && io.statSync(file).isFile() } catch { return false } })
  return { nativeBin: nativeBin || null, node: node || null, bridge: exists(bridge) ? bridge : null, devspaceRoot: findDevSpacePackage(env, io) }
}

function launchSpec({ nativeBin, node, bridge, devspaceRoot, cwd, port, password, model = MODELS[0], env = process.env }) {
  if (!MODELS.includes(model)) throw failure('model')
  const permissions = {
    '*': 'ask', task: 'deny', bash: 'deny', read: 'deny', edit: 'deny',
    glob: 'deny', grep: 'deny', list: 'deny', lsp: 'deny', external_directory: 'deny',
    'devspace_*': 'ask',
  }
  const config = {
    $schema: 'https://opencode.ai/config.json', share: 'disabled', autoupdate: false,
    model: `openai/${model}`, small_model: `openai/${model}`,
    enabled_providers: ['openai'], provider: { openai: { whitelist: [...MODELS] } },
    permission: permissions,
    mcp: { devspace: {
      type: 'local', command: [node, bridge], enabled: true, timeout: 180000,
      environment: { DEVSPACE_MCP_WORKSPACE: cwd, DEVSPACE_MCP_WRITE_MODE: 'allowed',
        ...(devspaceRoot ? { AI_CONSOLE_DEVSPACE_PACKAGE: devspaceRoot } : {}) },
    } },
  }
  return {
    file: nativeBin,
    args: ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--no-mdns', '--pure'],
    options: {
      cwd, shell: false, windowsHide: true, stdio: 'ignore',
      env: {
        ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'false', OPENCODE_AUTO_SHARE: 'false',
        OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'false',
        OPENCODE_ENABLE_PARALLEL: 'false', OPENCODE_EXPERIMENTAL_PARALLEL: 'false',
        OPENCODE_PERMISSION: JSON.stringify(permissions),
      },
    },
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function checkHealth(origin, authorization) {
  return new Promise(resolve => {
    const request = http.get(`${origin}/global/health`, { headers: { Authorization: authorization }, timeout: 800 }, response => {
      let text = ''
      response.on('data', chunk => { text += chunk; if (text.length > 8192) request.destroy() })
      response.once('end', () => {
        try { const body = JSON.parse(text); resolve(response.statusCode === 200 && body.healthy === true && typeof body.version === 'string') }
        catch { resolve(false) }
      })
      response.once('error', () => resolve(false))
    })
    request.once('timeout', () => request.destroy())
    request.once('error', () => resolve(false))
  })
}

function createManager(options) {
  const { BrowserWindow } = options
  const env = options.env || process.env
  const io = options.io || fs
  const spawn = options.spawn || childProcess.spawn
  const execFile = options.execFile || childProcess.execFile
  const getRoots = options.getRoots || (() => allowedRoots({ env, io }))
  const getTools = options.discover || (() => discover({ env, io }))
  const health = options.health || checkHealth
  const allocatePort = options.freePort || freePort
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  let owned = null, opening = null, disposed = false, versionCache = null, generation = 0

  async function version(file) {
    if (!file) return null
    if (versionCache?.file === file && Date.now() - versionCache.time < 30000) return versionCache.value
    const value = await new Promise(resolve => execFile(file, ['--version'], {
      windowsHide: true, shell: false, timeout: 3000, maxBuffer: 4096,
    }, (error, stdout) => resolve(!error && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(String(stdout).trim()) ? String(stdout).trim() : null)))
    versionCache = { file, value, time: Date.now() }
    return value
  }

  async function status() {
    const tools = getTools()
    let roots = [], configError = ''
    try { roots = getRoots() } catch { configError = ERRORS.config }
    const active = owned && owned.child.exitCode === null && !owned.child.killed
    return {
      installed: !!tools.nativeBin, version: await version(tools.nativeBin),
      configured: roots.length > 0, allowedRoots: roots, bridgeReady: !!tools.bridge && !!tools.node && !!tools.devspaceRoot,
      running: !!active && owned.ready, starting: !!active && !owned.ready,
      cwd: active ? owned.cwd : null,
      model: active ? owned.model : MODELS[0],
      windowOpen: !!active && !!owned.window && !owned.window.isDestroyed(),
      ...(configError ? { error: configError } : {}),
    }
  }

  function showWindow(service) {
    if (service.window && !service.window.isDestroyed()) { service.window.show(); service.window.focus(); return Promise.resolve() }
    const window = new BrowserWindow({
      width: 1180, height: 820, minWidth: 780, minHeight: 540,
      title: 'OpenCode 對話', autoHideMenuBar: true, show: false,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        partition: `opencode-${crypto.randomUUID()}`, webSecurity: true,
      },
    })
    service.window = window
    const session = window.webContents.session
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.setPermissionCheckHandler(() => false)
    session.webRequest.onBeforeSendHeaders({ urls: [`${service.origin}/*`] }, (details, callback) => {
      if (sameOrigin(details.url, service.origin)) {
        callback({ requestHeaders: { ...details.requestHeaders, Authorization: service.authorization } })
      } else callback({ requestHeaders: details.requestHeaders })
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      // Provider sign-in links can be opened outside the unprivileged window.
      try { const target = new URL(url); if (target.protocol === 'https:' && !target.username && !target.password) options.openExternal?.(target.href) } catch { /* Invalid links are ignored. */ }
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => { if (!sameOrigin(url, service.origin)) event.preventDefault() })
    window.webContents.on('will-redirect', (event, url) => { if (!sameOrigin(url, service.origin)) event.preventDefault() })
    window.on('closed', () => { if (service.window === window) service.window = null })
    // OpenCode's own directory route uses UTF-8 base64url, without a prompt.
    const directory = Buffer.from(service.cwd, 'utf8').toString('base64url')
    return window.loadURL(`${service.origin}/${directory}/session`).then(() => { if (!window.isDestroyed()) window.show() }).catch(() => {
      if (!window.isDestroyed()) window.destroy()
      throw failure('window')
    })
  }

  async function stopOwned(service) {
    if (!service) return
    service.cancelled = true
    if (service.window && !service.window.isDestroyed()) service.window.destroy()
    if (service.child.exitCode === null && !service.child.killed) {
      if ((options.platform || process.platform) === 'win32' && Number.isInteger(service.child.pid)) {
        await new Promise(resolve => execFile(path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/pid', String(service.child.pid), '/T', '/F'], { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 4096 }, () => resolve()))
      }
      if (service.child.exitCode === null && !service.child.killed) { try { service.child.kill() } catch { /* Already exited. */ } }
    }
    if (owned === service) owned = null
  }

  async function start(cwd, model = MODELS[0]) {
    const attempt = generation
    if (disposed) throw failure('stopped')
    if (!MODELS.includes(model)) throw failure('model')
    const workspace = validateWorkspace(cwd, getRoots(), io, options.paths || path)
    if (owned) {
      if (owned.cwd !== workspace || owned.model !== model) throw failure('busy')
      if (!owned.ready) throw failure('starting')
      await showWindow(owned)
      return status()
    }
    const tools = getTools()
    if (!tools.nativeBin) throw failure('missing')
    if (!tools.node || !tools.bridge || !tools.devspaceRoot) throw failure('bridge')
    const port = await allocatePort()
    if (disposed || attempt !== generation) throw failure('stopped')
    const password = crypto.randomBytes(32).toString('base64url')
    const spec = launchSpec({ ...tools, cwd: workspace, port, password, model, env })
    const child = spawn(spec.file, spec.args, spec.options)
    const service = { child, cwd: workspace, model, origin: `http://127.0.0.1:${port}`, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, ready: false, cancelled: false, window: null }
    owned = service
    child.once('error', () => { service.cancelled = true })
    child.once('exit', () => {
      service.cancelled = true
      if (owned === service) owned = null
      if (service.window && !service.window.isDestroyed()) service.window.destroy()
    })
    try {
      const deadline = Date.now() + 30000
      for (let i = 0; i < 100 && Date.now() < deadline; i++) {
        if (service.cancelled || disposed) throw failure('stopped')
        if (child.exitCode !== null) throw failure('start')
        if (await health(service.origin, service.authorization)) {
          if (service.cancelled || disposed || owned !== service) throw failure('stopped')
          service.ready = true
          await showWindow(service)
          return status()
        }
        await sleep(250)
      }
      throw failure('start')
    } catch (error) { await stopOwned(service); throw error }
  }

  return {
    status,
    open(input) {
      if (opening) return Promise.reject(failure('starting'))
      opening = start(input?.cwd, input?.model).finally(() => { opening = null })
      return opening
    },
    async stop() { generation++; await stopOwned(owned); return status() },
    async dispose() { disposed = true; generation++; await stopOwned(owned) },
    // Main-process verification only. Never return this through an IPC handler.
    connectionForVerification() { return owned ? { origin: owned.origin, authorization: owned.authorization, cwd: owned.cwd } : null },
  }
}

function wireOpenCode(options) {
  const manager = createManager(options)
  for (const channel of CHANNELS) options.ipcMain.handle(channel, async (event, input) => {
    if (!trustedSender(event, options.mainWindow, options.appUrl)) return safeError(failure('forbidden'))
    try {
      const status = channel === 'opencode:open' ? await manager.open(input)
        : channel === 'opencode:stop' ? await manager.stop() : await manager.status()
      return { ok: true, status }
    } catch (error) { return safeError(error) }
  })
  return manager
}

module.exports = { wireOpenCode, createManager, validateWorkspace, trustedSender, sameOrigin, launchSpec, parseJsonc, allowedRoots, discover }
