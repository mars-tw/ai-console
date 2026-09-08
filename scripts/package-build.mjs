// Fail-closed frontend build helpers for packaging.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const FRESH_MARKERS = ['expectedMode', '不用操作英文視窗']
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

export function runFreshBuild({ root, nodePath = process.execPath }) {
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc')
  const vite = path.join(root, 'node_modules/vite/bin/vite.js')
  if (!existsSync(tsc)) throw new Error(`Missing TypeScript CLI: ${tsc}`)
  if (!existsSync(vite)) throw new Error(`Missing Vite CLI: ${vite}`)
  runNodeCli(nodePath, [tsc, '-b'], { cwd: root })
  runNodeCli(nodePath, [vite, 'build'], { cwd: root })
  return verifyDistFreshness(path.join(root, 'dist'))
}
