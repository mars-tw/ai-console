// Fail-closed frontend build helpers for packaging.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const FRESH_MARKERS = ['chatgpt-conversation-devspace-v1', 'copy-before-open']
export const STALE_ASSET_HINTS = ['index-DrDEtqsP.js', 'index-CzY6O1JB.css']

export function verifyDistFreshness(distDir) {
  const assets = path.join(distDir, 'assets')
  if (!existsSync(assets)) throw new Error(`Missing dist assets: ${assets}`)
  const files = readdirSync(assets)
  const jsName = files.filter((file) => file.startsWith('index-') && file.endsWith('.js'))
  const cssName = files.filter((file) => file.startsWith('index-') && file.endsWith('.css'))
  if (jsName.length !== 1) throw new Error(`Expected exactly one index-*.js, found: ${jsName.join(', ') || '(none)'}`)
  if (cssName.length !== 1) throw new Error(`Expected exactly one index-*.css, found: ${cssName.length}`)
  const jsPath = path.join(assets, jsName[0])
  const cssPath = path.join(assets, cssName[0])
  const js = readFileSync(jsPath, 'utf8')
  const css = readFileSync(cssPath, 'utf8')
  for (const marker of FRESH_MARKERS) {
    if (!js.includes(marker)) throw new Error(`Fresh build marker missing in ${jsName[0]}: ${marker}`)
  }
  for (const stale of STALE_ASSET_HINTS) {
    if (js.includes(stale) || css.includes(stale)) throw new Error(`Stale asset reference detected: ${stale}`)
  }
  const htmlPath = path.join(distDir, 'index.html')
  if (!existsSync(htmlPath)) throw new Error(`Missing dist/index.html`)
  const html = readFileSync(htmlPath, 'utf8')
  if (!html.includes(jsName[0]) || !html.includes(cssName[0])) {
    throw new Error(`dist/index.html does not reference current assets ${jsName[0]} / ${cssName[0]}`)
  }
  return { js: jsName[0], css: cssName[0], jsPath, cssPath }
}

export function assertPackagingMayProceed(buildExitCode, distDir) {
  if (buildExitCode !== 0) {
    throw new Error(`Build failed with exit ${buildExitCode}; packaging refused`)
  }
  return verifyDistFreshness(distDir)
}

export function runNodeCli(nodePath, args, options) {
  execFileSync(nodePath, args, { stdio: 'inherit', windowsHide: true, ...options })
}

/** Refuse to silently package only part of a dirty or untracked working tree. */
export function cleanCommit(root, run = execFileSync) {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
  if (status.trim()) throw new Error('Packaging requires a clean checkout; commit or explicitly isolate changes first')
  const commit = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('Cannot identify the source commit')
  return commit
}

export function assertIsolatedBuildRoot(checkout, snapshot) {
  const source = realpathSync(checkout)
  const target = realpathSync(snapshot)
  const rel = path.relative(source, target)
  if (!rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
    throw new Error('Build snapshot must be outside the live checkout')
  }
}

/** Candidate roots must stay beneath release and never overlap the installed clean tree. */
export function assertCandidateOutput(root, output, exists = existsSync, stat = lstatSync) {
  const release = path.join(root, 'release').toLowerCase()
  const target = path.resolve(output).toLowerCase()
  if (!target.startsWith(release + path.sep)) throw new Error('Package output must be a child directory of release/')
  const installed = path.join(release, 'clean')
  if (target === installed || target.startsWith(installed + path.sep)) {
    throw new Error('Package output cannot replace the installed release/clean directory')
  }
  for (let cursor = path.resolve(output); cursor.toLowerCase() !== path.resolve(root).toLowerCase(); cursor = path.dirname(cursor)) {
    if (exists(cursor) && stat(cursor).isSymbolicLink()) throw new Error('Linked package output refused')
    if (path.dirname(cursor) === cursor) throw new Error('Package output ancestry is invalid')
  }
}

/** Keep packaging policy explicit and injectable for tests; never overwrite an installation. */
export async function packageCandidate(packager, { stage, output, electronVersion, icon }, exists = existsSync) {
  const target = path.resolve(output, 'AI控制台-win32-x64')
  if (exists(target)) throw new Error('Candidate already exists; refusing to overwrite or reuse it')
  const result = await packager({
    dir: stage, name: 'AI控制台', platform: 'win32', arch: 'x64',
    electronVersion, out: output, overwrite: false, prune: false, icon,
  })
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0] !== 'string' || path.resolve(result[0]) !== target) {
    throw new Error('Packager did not create the expected candidate')
  }
  return result
}

export function runFreshBuild({ root, checkout, nodePath = process.execPath, run = runNodeCli, exists = existsSync, verify = verifyDistFreshness }) {
  assertIsolatedBuildRoot(checkout, root)
  const dist = path.join(root, 'dist')
  if (existsSync(dist) && lstatSync(dist).isSymbolicLink()) throw new Error('Linked build output refused')
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc')
  const vite = path.join(root, 'node_modules/vite/bin/vite.js')
  if (!exists(tsc)) throw new Error(`Missing TypeScript CLI: ${tsc}`)
  if (!exists(vite)) throw new Error(`Missing Vite CLI: ${vite}`)
  run(nodePath, [tsc, '-p', 'tsconfig.app.json', '--incremental', '--tsBuildInfoFile', path.join(root, '.app.tsbuildinfo')], { cwd: root })
  run(nodePath, [tsc, '-p', 'tsconfig.node.json', '--incremental', '--tsBuildInfoFile', path.join(root, '.node.tsbuildinfo')], { cwd: root })
  run(nodePath, [vite, 'build', '--configLoader', 'runner'], { cwd: root })
  return verify(dist)
}
