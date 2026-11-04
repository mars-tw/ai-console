import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('current release metadata', () => {
  it('keeps package, lock and quick-start asset pinned to one version', () => {
    const manifest = JSON.parse(read('package.json')) as { version: string }
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version: string }> }
    const quick = JSON.parse(read('scripts/quick-start.json')) as { version: string; repository: string; asset: string }
    expect(manifest.version).toBe('1.9.1')
    expect(lock.version).toBe(manifest.version)
    expect(lock.packages[''].version).toBe(manifest.version)
    expect(quick).toEqual({ version: manifest.version, repository: 'mars-tw/ai-console', asset: `ai-console-win32-x64-v${manifest.version}.zip` })
  })

  it('uses matching release downloads in current guides without rewriting the v1.7 history', () => {
    for (const file of ['README.md', 'docs/quick-start.md', 'docs/install-and-run.md']) {
      const content = read(file)
      expect(content).toContain('releases/download/v1.9.1/ai-console-quick-start-v1.9.1.zip')
      expect(content).toContain('releases/download/v1.9.1/ai-console-win32-x64-v1.9.1.zip')
    }
    const historical = read('docs/releases/v1.7.0.md')
    expect(historical).toContain('releases/download/v1.7.0/ai-console-win32-x64-v1.7.0.zip')
    const notes = read('docs/releases/v1.8.0.md')
    expect(notes).toContain('STOP_IDENTITY_UNKNOWN')
    expect(notes).toContain('CANCELLATION_RESULT_UNKNOWN')
    expect(notes).toContain('409 USE_CHATGPT_CONVERSATION')
  })
})
