import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const probeScript = path.join(repo, 'scripts/package-build.mjs')
const markers = ['expectedMode', '不用操作英文視窗']

function probe(buildExitCode: number, distDir: string) {
  const code = `
    import { assertPackagingMayProceed } from ${JSON.stringify(pathToFileURL(probeScript).href)};
    const distDir = ${JSON.stringify(distDir)};
    const exitCode = ${buildExitCode};
    try {
      const assets = assertPackagingMayProceed(exitCode, distDir);
      console.log(JSON.stringify({ ok: true, assets }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    }
  `
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })) as {
    ok: boolean
    error?: string
    assets?: { js: string; css: string }
  }
}

function writeStaleFixture(root: string) {
  const assets = path.join(root, 'assets')
  mkdirSync(assets, { recursive: true })
  writeFileSync(path.join(assets, 'index-DrDEtqsP.js'), 'console.log("stale bundle")')
  writeFileSync(path.join(assets, 'index-CzY6O1JB.css'), 'body{}')
  writeFileSync(path.join(root, 'index.html'), '<script src="./assets/index-DrDEtqsP.js"></script>')
}

function writeFreshFixture(root: string) {
  const assets = path.join(root, 'assets')
  mkdirSync(assets, { recursive: true })
  const js = `export const markers = ${JSON.stringify(markers)}`
  writeFileSync(path.join(assets, 'index-BmJHgFPr.js'), js)
  writeFileSync(path.join(assets, 'index-BRhDTqQu.css'), 'body{}')
  writeFileSync(
    path.join(root, 'index.html'),
    '<link href="./assets/index-BRhDTqQu.css"><script src="./assets/index-BmJHgFPr.js"></script>',
  )
}

describe('packaging build freshness guard', () => {
  it('refuses packaging after a non-zero build exit', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pack-guard-'))
    try {
      writeFreshFixture(root)
      const result = probe(1, root)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/packaging refused/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses stale dist even when a build claims success', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pack-stale-'))
    try {
      writeStaleFixture(root)
      const result = probe(0, root)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/Fresh build marker missing|Stale asset reference/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts dist that contains continue-flow markers', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pack-fresh-'))
    try {
      writeFreshFixture(root)
      const result = probe(0, root)
      expect(result.ok).toBe(true)
      expect(result.assets?.js).toBe('index-BmJHgFPr.js')
      expect(result.assets?.css).toBe('index-BRhDTqQu.css')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
