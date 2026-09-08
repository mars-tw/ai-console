import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

function finder(files: string[], env: Record<string, string> = {}, platform = 'win32') {
  const p = platform === 'win32' ? path.win32 : path.posix
  const root = platform === 'win32' ? 'C:\\fixture\\app' : '/fixture/app'
  const source = readFileSync(new URL('../../scripts/find-python.cjs', import.meta.url), 'utf8')
  const module = { exports: {} as { findPython: () => string } }
  runInNewContext(source, {
    module, __dirname: p.join(root, 'scripts'), process: { platform, env },
    require: (name: string) => {
      if (name === 'node:path') return p
      if (name === 'node:os') return { homedir: () => p.join(root, 'synthetic-home') }
      if (name === 'node:fs') return { existsSync: (file: string) => files.includes(file) }
      throw new Error('Unexpected import')
    },
  })
  return module.exports.findPython()
}

const bundle = 'C:\\fixture\\app\\runtime\\python\\python.exe'
const venv = 'C:\\fixture\\app\\.venv\\Scripts\\python.exe'
const kimi = 'C:\\fixture\\roaming\\kimi-desktop\\daimon-share\\daimon\\runtime\\python\\.venv\\Scripts\\python.exe'

describe('Python interpreter discovery', () => {
  it('keeps an explicit valid override before the bundle', () => {
    expect(finder(['C:\\override.exe', bundle, venv], { AI_CONSOLE_PYTHON: 'C:\\override.exe' })).toBe('C:\\override.exe')
  })
  it('prefers the bundle over venv, Kimi and PATH', () => {
    expect(finder([bundle, venv, kimi, 'C:\\bin\\python.exe'], { APPDATA: 'C:\\fixture\\roaming', PATH: 'C:\\bin' })).toBe(bundle)
  })
  it('keeps venv fallback without a bundle', () => {
    expect(finder([venv], { AI_CONSOLE_PYTHON: 'C:\\missing.exe' })).toBe(venv)
  })
  it('keeps Kimi fallback before PATH', () => {
    expect(finder([kimi, 'C:\\bin\\python.exe'], { APPDATA: 'C:\\fixture\\roaming', PATH: 'C:\\bin' })).toBe(kimi)
  })
  it('keeps PATH discovery and unresolved fallback', () => {
    expect(finder(['C:\\bin\\python.exe'], { PATH: 'C:\\bin' })).toBe('C:\\bin\\python.exe')
    expect(finder([])).toBe('python.exe')
  })
  it('does not use the Windows bundle on other platforms', () => {
    expect(finder(['/fixture/app/runtime/python/python.exe', '/fixture/app/.venv/bin/python'], {}, 'linux')).toBe('/fixture/app/.venv/bin/python')
  })
})
