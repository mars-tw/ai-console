// Build a distributable from an explicit staging set, never the live checkout.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import packager from 'electron-packager'
import pythonTools from './find-python.cjs'
import { runFreshBuild, verifyDistFreshness } from './package-build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildPython = pythonTools.findPython()
const scratch = mkdtempSync(path.join(os.tmpdir(), 'ai-console-package-'))
const stage = path.join(scratch, 'app')
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const electronVersion = JSON.parse(readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version
const output = path.join(root, 'release', 'clean')

function copy(relative, filter) {
  const source = path.join(root, relative)
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

try {
  const built = runFreshBuild({ root, nodePath: process.execPath })
  verifyDistFreshness(path.join(root, 'dist'))
  process.stdout.write(`Fresh frontend build verified: ${built.js}, ${built.css}\n`)

  mkdirSync(stage)
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const included = tracked.filter((file) => (
    /^(electron\/[^/]+\.cjs|server\/[^/]+\.py|tools\/[^/]+\.(py|json)|build\/icon\.(ico|png)|docs\/[^/]+\.png)$/.test(file)
    || ['README.md', 'LICENSE', 'scripts/find-python.cjs'].includes(file)
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
  execFileSync(buildPython, ['-B', '-X', 'utf8', path.join(root, 'scripts/bundle_python.py'), stage], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  execFileSync(buildPython, ['-B', '-X', 'utf8', path.join(root, 'scripts/audit_release.py'), stage, '--kind', 'stage', '--version', manifest.version, '--check-local-pairing'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  const paths = await packager({
    dir: stage, name: 'AI控制台', platform: 'win32', arch: 'x64',
    electronVersion, out: output, overwrite: true, prune: false,
    icon: path.join(root, 'build/icon.ico'),
  })
  for (const directory of paths) execFileSync(buildPython, ['-B', '-X', 'utf8', path.join(root, 'scripts/audit_release.py'), directory, '--kind', 'windows', '--version', manifest.version, '--check-local-pairing'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  process.stdout.write(`Distributable ready: ${paths.join(', ')}\n`)
} finally {
  // scratch is created here, outside the checkout and local installation.
  rmSync(scratch, { recursive: true, force: true })
}
