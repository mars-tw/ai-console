import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = path.resolve('scripts/quick-launch.ps1')
const scratch: string[] = []
function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ac-quick-launch-'))
  scratch.push(base)
  const source = path.join(base, "中文 空格 & ! quote's")
  const installed = path.join(base, 'installed')
  mkdirSync(path.join(source, 'scripts'), { recursive: true })
  writeFileSync(path.join(source, 'scripts/quick-start.json'), JSON.stringify({
    version: '1.5.1', repository: 'mars-tw/ai-console', asset: 'ai-console-win32-x64-v1.5.1.zip',
  }))
  return { source, installed }
}
function payload(root: string, version = '1.5.1') {
  const files = []
  for (const file of ['AI控制台.exe', 'icudtl.dat', 'resources.pak', 'locales/en-US.pak',
    'resources/app/package.json', 'resources/app/dist/index.html',
    'resources/app/electron/main.cjs', 'resources/app/server/api.py',
    'resources/app/electron/pty.cjs', 'resources/app/electron/preload.cjs',
    'resources/app/server/devspace_console.py', 'resources/app/scripts/find-python.cjs',
    'resources/app/runtime/python/python.exe', 'resources/app/runtime/python/python3.dll',
    'resources/app/runtime/python/python314.dll', 'resources/app/runtime/python/python314.zip',
    'resources/app/runtime/python/python314._pth', 'resources/app/runtime/python/runtime.json']) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    const content = file.endsWith('package.json') ? JSON.stringify({ name: 'ai-console', version, main: 'electron/main.cjs' }) : 'fixture'
    writeFileSync(path.join(root, file), content)
    files.push({ path: file, size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') })
  }
  writeFileSync(path.join(root, 'quick-payload.json'), JSON.stringify({ schemaVersion: 1, version, files }))
}
function plan(source: string, installed: string) {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `
    . $env:AC_TEST_LAUNCH_SCRIPT -LibraryOnly
    function Start-Process { throw 'Unexpected launch during PlanOnly' }
    try {
      $plan = Invoke-QuickLaunch -SourceRoot $env:AC_TEST_SOURCE -InstallRoot $env:AC_TEST_INSTALLED -PlanOnly
      $result = @{ ok = $true; plan = $plan }
    } catch { $result = @{ ok = $false; error = $_.Exception.Message } }
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Depth 5 -Compress)))
  `], { encoding: 'utf8', windowsHide: true, env: {
    ...process.env, AC_TEST_LAUNCH_SCRIPT: script, AC_TEST_SOURCE: source, AC_TEST_INSTALLED: installed,
  } })
  return JSON.parse(Buffer.from(output.trim(), 'base64').toString('utf8'))
}
afterEach(() => {
  for (const directory of scratch.splice(0)) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('ac-quick-launch-')) {
      throw new Error('Refusing unexpected cleanup target')
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Quick launch distribution', () => {
  it('keeps shell wrappers ASCII and disables delayed expansion for ! in folder names', () => {
    for (const file of ['快速安裝.cmd', '快速啟動.cmd']) {
      const source = readFileSync(file, 'utf8')
      expect(source).toMatch(/DisableDelayedExpansion/i)
      expect([...source].every(char => char.charCodeAt(0) < 128)).toBe(true)
      expect(source).not.toContain('%*')
    }
    expect([...readFileSync(script).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it.skipIf(process.platform !== 'win32')('resolves portable paths containing Chinese, spaces and shell metacharacters without launching', () => {
    const { source, installed } = fixture()
    payload(source)
    const result = plan(source, installed)
    expect(result.ok).toBe(true)
    expect(result.plan.mode).toBe('portable')
    expect(result.plan.executable).toBe(path.join(source, 'AI控制台.exe'))
    expect(result.plan.arguments).toEqual(['--devspace'])
  })

  it.skipIf(process.platform !== 'win32')('resolves an installed version through the constrained pointer', () => {
    const { source, installed } = fixture()
    payload(path.join(installed, 'versions/1.5.1'))
    writeFileSync(path.join(installed, 'current.json'), JSON.stringify({ version: '1.5.1', executable: 'versions/1.5.1/AI控制台.exe' }))
    expect(plan(source, installed).plan.mode).toBe('installed')
  })

  it.skipIf(process.platform !== 'win32')('resolves an already-built source checkout without launching', () => {
    const { source, installed } = fixture()
    mkdirSync(path.join(source, 'node_modules/electron/dist'), { recursive: true })
    mkdirSync(path.join(source, 'dist'), { recursive: true })
    writeFileSync(path.join(source, 'node_modules/electron/dist/electron.exe'), 'fixture')
    writeFileSync(path.join(source, 'dist/index.html'), 'fixture')
    writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'ai-console', version: '1.5.1' }))
    const result = plan(source, installed)
    expect(result.ok).toBe(true)
    expect(result.plan.mode).toBe('source')
    expect(result.plan.arguments).toEqual([source, '--devspace'])
  })

  it.skipIf(process.platform !== 'win32')('refuses missing PTY code and the embedded Python DLL for portable and installed apps', () => {
    for (const missing of ['resources/app/electron/pty.cjs', 'resources/app/runtime/python/python314.dll']) {
      const { source, installed } = fixture()
      const app = path.join(installed, 'versions/1.5.1')
      payload(app)
      writeFileSync(path.join(installed, 'current.json'), JSON.stringify({ version: '1.5.1', executable: 'versions/1.5.1/AI控制台.exe' }))
      unlinkSync(path.join(app, missing))
      expect(plan(source, installed).ok).toBe(false)
      payload(source)
      unlinkSync(path.join(source, missing))
      expect(plan(source, installed).ok).toBe(false)
    }
  })

  it.skipIf(process.platform !== 'win32')('requires the manifest and refuses a forged list that omits a critical runtime file', () => {
    const { source, installed } = fixture()
    payload(source)
    const manifest = path.join(source, 'quick-payload.json')
    const data = JSON.parse(readFileSync(manifest, 'utf8'))
    data.files = data.files.filter((file: { path: string }) => file.path !== 'resources/app/runtime/python/python314.dll')
    writeFileSync(manifest, JSON.stringify(data))
    expect(plan(source, installed).ok).toBe(false)
    unlinkSync(manifest)
    expect(plan(source, installed).ok).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('refuses a traversal pointer even when the target file exists', () => {
    const { source, installed } = fixture()
    payload(path.join(installed, 'versions/1.5.1'))
    writeFileSync(path.join(installed, 'current.json'), JSON.stringify({ version: '1.5.1', executable: '../AI控制台.exe' }))
    expect(plan(source, installed).ok).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('refuses an older installed version and an incomplete portable payload', () => {
    const { source, installed } = fixture()
    payload(path.join(installed, 'versions/1.5.0'), '1.5.0')
    writeFileSync(path.join(installed, 'current.json'), JSON.stringify({ version: '1.5.0', executable: 'versions/1.5.0/AI控制台.exe' }))
    expect(plan(source, installed).ok).toBe(false)
    writeFileSync(path.join(source, 'AI控制台.exe'), 'incomplete')
    expect(plan(source, installed).ok).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('reports installation needed without creating a pointer', () => {
    const { source, installed } = fixture()
    const result = plan(source, installed)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('快速安裝.cmd')
  })
})
