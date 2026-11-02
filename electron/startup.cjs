'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/** Match the backend's normcase(realpath(APP_ROOT)) contract. */
function expectedIdentity(appRoot, platform = process.platform) {
  const real = fs.realpathSync(appRoot)
  const canonical = platform === 'win32' ? path.win32.normalize(real).toLowerCase() : path.normalize(real)
  const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('Missing application version')
  return {
    service: 'ai-console', version: manifest.version,
    appRootHash: hash(Buffer.from(canonical, 'utf8')),
    serverCodeSha256: hash(fs.readFileSync(path.join(appRoot, 'server', 'api.py'))),
  }
}

function identityMatches(data, expected) {
  return !!data && data.ok === true && Object.entries(expected).every(([key, value]) => data[key] === value)
}

/** Whole-response deadline, including peers that never send headers or trickle the body. */
function probeHealth(http, url, expected, deadline, now = () => performance.now()) {
  return new Promise((resolve) => {
    const remaining = Math.min(2000, Math.max(0, deadline - now()))
    if (!remaining) return resolve('conflict')
    let request
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => { finish('conflict'); request?.destroy() }, remaining)
    try {
      request = http.get(url, (response) => {
        if (response.statusCode !== 200) { finish('conflict'); response.destroy(); return }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (part) => {
          body += part
          if (body.length > 8192) { finish('conflict'); request.destroy() }
        })
        response.on('end', () => {
          try { finish(identityMatches(JSON.parse(body), expected) ? 'match' : 'conflict') }
          catch { finish('conflict') }
        })
        response.on('error', () => finish('conflict'))
        response.on('aborted', () => finish('conflict'))
      })
      request.on('error', (error) => finish(error?.code === 'ECONNREFUSED' ? 'absent' : 'conflict'))
    } catch { finish('conflict') }
  })
}

/** Only an actual connection refusal permits spawning; never stop an unknown listener. */
async function ensureBackend({ probe, launch, now = () => performance.now(), sleep, timeout = 30000 }) {
  const deadline = now() + timeout
  const first = await probe(deadline)
  if (first === 'match') return { ok: true, reused: true }
  if (first !== 'absent' || now() >= deadline) return { ok: false, reason: 'conflict' }
  let child
  try { child = launch() } catch { return { ok: false, reason: 'launch' } }
  const stopOwned = () => {
    try { if (child && child.exitCode == null && child.signalCode == null) child.kill() } catch { /* exited */ }
  }
  while (now() < deadline) {
    await sleep(Math.min(500, Math.max(0, deadline - now())))
    if (now() >= deadline) break
    const state = await probe(deadline)
    if (state === 'match') return { ok: true, reused: false }
    if (state !== 'absent') { stopOwned(); return { ok: false, reason: 'conflict' } }
  }
  // This is only the child launched above, never a pre-existing listener.
  stopOwned()
  return { ok: false, reason: 'timeout' }
}

/** Only the current desktop main frame at the expected local origin may invoke IPC. */
function trustedSender(event, win, appURL) {
  if (!win || win.isDestroyed() || !event || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false
  try {
    const frame = new URL(event.senderFrame.url)
    return frame.origin === new URL(appURL).origin && !frame.username && !frame.password && !frame.pathname.startsWith('/m')
  } catch { return false }
}

module.exports = { expectedIdentity, identityMatches, probeHealth, ensureBackend, trustedSender }
