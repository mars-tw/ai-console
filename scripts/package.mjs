// Build a distributable from an explicit staging set, never the live checkout.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import packager from 'electron-packager'
import pythonTools from './find-python.cjs'
import { assertCandidateOutput, cleanCommit, packageCandidate, runFreshBuild, verifyDistFreshness } from './package-build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildPython = pythonTools.findPython()
const electronVersion = JSON.parse(readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version
const flags = process.argv.slice(2)
if (flags.length && (flags.length !== 2 || flags[0] !== '--out')) {
  throw new Error('Usage: npm run pack -- [--out release/<directory>]')
}
const releaseRoot = path.join(root, 'release')
const explicitOutput = flags.length ? path.resolve(root, flags[1]) : null
const outputBase = explicitOutput || path.join(releaseRoot, 'candidates')
assertCandidateOutput(root, outputBase)
const quickFiles = [
  '快速安裝.cmd', '快速啟動.cmd',
  'scripts/quick-install.ps1', 'scripts/quick-launch.ps1', 'scripts/setup-devspace.ps1', 'scripts/quick-start.json',
  'scripts/quick-payload.ps1',
  'docs/install-and-run.md', 'docs/quick-start.md', 'docs/devspace-desktop.md',
  'docs/chatgpt-conversation-workflow.md',
]
const scratch = mkdtempSync(path.join(os.tmpdir(), 'ai-console-package-'))
const stage = path.join(scratch, 'app')
const snapshot = path.join(scratch, 'source')
const depsLink = path.join(snapshot, 'node_modules')
let manifest

function copy(relative, filter) {
  const source = path.join(snapshot, relative)
  const destination = path.join(stage, relative)
  if (!existsSync(source)) throw new Error(`Required packaging input is missing: ${relative}`)
  cpSync(source, destination, {
    recursive: true,
    filter: (file) => {
      if (lstatSync(file).isSymbolicLink()) throw new Error(`Linked packaging input refused: ${relative}`)
      return !filter || filter(path.relative(source, file).replaceAll('\\', '/'))
    },
  })
}

function writePayloadManifest(directory) {
  const files = []
  const visit = (relative) => {
    const full = path.join(directory, relative)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) throw new Error(`Linked payload entry refused: ${relative}`)
    if (stat.isDirectory()) {
      for (const name of readdirSync(full).sort()) visit(path.join(relative, name))
    } else if (relative !== 'quick-payload.json') {
      files.push({ path: relative.replaceAll('\\', '/'), size: stat.size,
        sha256: createHash('sha256').update(readFileSync(full)).digest('hex') })
    }
  }
  visit('')
  writeFileSync(path.join(directory, 'quick-payload.json'), JSON.stringify({
    schemaVersion: 1, version: manifest.version, files,
  }, null, 2) + '\n')
}

try {
  // Package a clean, immutable commit rather than unreviewed working-tree changes.
  const commit = cleanCommit(root)
  mkdirSync(snapshot)
  const archive = path.join(scratch, 'source.zip')
  execFileSync('git', ['archive', '--format=zip', '-o', archive, commit], { cwd: root, stdio: 'inherit', windowsHide: true })
  execFileSync(buildPython, ['-B', '-X', 'utf8', path.join(root, 'scripts/extract_snapshot.py'), archive, snapshot], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  symlinkSync(path.join(root, 'node_modules'), depsLink, process.platform === 'win32' ? 'junction' : 'dir')
  manifest = JSON.parse(readFileSync(path.join(snapshot, 'package.json'), 'utf8'))
  const built = runFreshBuild({ root: snapshot, checkout: root, nodePath: process.execPath })
  verifyDistFreshness(path.join(snapshot, 'dist'))
  process.stdout.write(`Fresh frontend build verified: ${built.js}, ${built.css}\n`)

  mkdirSync(stage)
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', commit], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const included = tracked.filter((file) => (
    /^(electron\/[^/]+\.cjs|server\/[^/]+\.py|tools\/[^/]+\.(py|json)|build\/icon\.(ico|png)|docs\/[^/]+\.png)$/.test(file)
    || ['README.md', 'LICENSE', 'licenses-ai-office-MIT.txt', 'docs/devspace-desktop.md', 'docs/chatgpt-conversation-workflow.md', 'docs/install-and-run.md', 'docs/quick-start.md', 'docs/releases/v1.7.0.md', 'docs/releases/v1.8.0.md', 'docs/releases/v1.9.0.md', 'docs/releases/v1.9.1.md', 'docs/releases/v1.9.2.md', 'scripts/find-python.cjs'].includes(file)
  ))
  for (const file of included) copy(file)
  copy('dist', (relative) => relative !== 'data' && !relative.startsWith('data/'))
  for (const module of ['node-pty', 'node-addon-api']) copy(`node_modules/${module}`)
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    main: manifest.main,
    type: manifest.type,
    dependencies: { 'node-pty': manifest.dependencies['node-pty'] },
  }, null, 2) + '\n')
  execFileSync(buildPython, ['-B', '-X', 'utf8', path.join(snapshot, 'scripts/bundle_python.py'), stage], {
    cwd: snapshot, stdio: 'inherit', windowsHide: true,
  })
  execFileSync(buildPython, ['-B', '-X', 'utf8', path.join(snapshot, 'scripts/audit_release.py'), stage, '--kind', 'stage', '--version', manifest.version, '--check-local-pairing'], {
    cwd: snapshot, stdio: 'inherit', windowsHide: true,
  })
  assertCandidateOutput(root, outputBase)
  mkdirSync(outputBase, { recursive: true })
  assertCandidateOutput(root, outputBase)
  const output = explicitOutput || mkdtempSync(path.join(outputBase, 'candidate-'))
  const paths = await packageCandidate(packager, {
    stage, output, electronVersion, icon: path.join(snapshot, 'build/icon.ico'),
  })
  for (const directory of paths) {
    for (const file of quickFiles) {
      if (!tracked.includes(file)) throw new Error(`Quick-start input must be tracked: ${file}`)
      const source = path.join(snapshot, file)
      if (lstatSync(source).isSymbolicLink()) throw new Error(`Linked quick-start input refused: ${file}`)
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
      cpSync(source, path.join(directory, file))
    }
    writePayloadManifest(directory)
    execFileSync(buildPython, ['-B', '-X', 'utf8', path.join(snapshot, 'scripts/audit_release.py'), directory, '--kind', 'windows', '--version', manifest.version, '--check-local-pairing'], {
      cwd: snapshot, stdio: 'inherit', windowsHide: true,
    })
  }
  process.stdout.write(`Distributable ready: ${paths.join(', ')}\n`)
} finally {
  // Unlink only the verified junction before recursive scratch cleanup.
  if (existsSync(depsLink)) {
    if (!lstatSync(depsLink).isSymbolicLink() || realpathSync(depsLink) !== realpathSync(path.join(root, 'node_modules'))) {
      throw new Error('Refusing to clean an unexpected dependency link')
    }
    if (process.platform === 'win32') rmdirSync(depsLink)
    else unlinkSync(depsLink)
  }
  rmSync(scratch, { recursive: true, force: true })
}
