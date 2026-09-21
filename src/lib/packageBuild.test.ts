import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const probeScript = path.join(repo, 'scripts/package-build.mjs')
const packageScript = readFileSync(path.join(repo, 'scripts/package.mjs'), 'utf8')
const currentMarkers = ['chatgpt-conversation-devspace-v1', 'copy-before-open']
const legacyMarkers = ['expectedMode', '不用操作英文視窗']

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

interface FixtureOptions {
  markers?: string[]
  jsName?: string
  cssName?: string
  htmlJs?: string
  htmlCss?: string
  jsExtra?: string
  cssExtra?: string
}

function writeFixture(root: string, options: FixtureOptions = {}) {
  const assets = path.join(root, 'assets')
  const jsName = options.jsName || 'index-BmJHgFPr.js'
  const cssName = options.cssName || 'index-BRhDTqQu.css'
  mkdirSync(assets, { recursive: true })
  writeFileSync(
    path.join(assets, jsName),
    `export const markers = ${JSON.stringify(options.markers || currentMarkers)};${options.jsExtra || ''}`,
  )
  writeFileSync(path.join(assets, cssName), `body{}${options.cssExtra || ''}`)
  writeFileSync(
    path.join(root, 'index.html'),
    `<link href="./assets/${options.htmlCss || cssName}"><script src="./assets/${options.htmlJs || jsName}"></script>`,
  )
}

describe('packaging build freshness guard', () => {
  it('packages the linked ChatGPT Conversation workflow document in both app and quick payload', () => {
    expect(packageScript.match(/docs\/chatgpt-conversation-workflow\.md/g)).toHaveLength(2)
  })

  it('refuses packaging after a non-zero build exit', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pack-guard-'))
    try {
      writeFixture(root)
      const result = probe(1, root)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/packaging refused/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not accept a bundle that only contains the removed CLI continuation markers', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pack-legacy-flow-'))
    try {
      writeFixture(root, { markers: legacyMarkers })
      const result = probe(0, root)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Fresh build marker missing')
      expect(result.error).toContain(currentMarkers[0])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses stale asset references even when current workflow markers are present', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pack-stale-'))
    try {
      writeFixture(root, { jsExtra: 'export const stale="index-DrDEtqsP.js";' })
      const result = probe(0, root)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/Stale asset reference detected: index-DrDEtqsP\.js/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires exactly one current JavaScript entry asset', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pack-duplicate-'))
    try {
      writeFixture(root)
      writeFileSync(
        path.join(root, 'assets', 'index-duplicate.js'),
        `export const markers = ${JSON.stringify(currentMarkers)}`,
      )
      const result = probe(0, root)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/Expected exactly one index-\*\.js/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires index.html to reference the unique current assets', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pack-html-'))
    try {
      writeFixture(root, { htmlJs: 'index-old.js' })
      const result = probe(0, root)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/dist\/index\.html does not reference current assets/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts dist that contains the current ChatGPT Conversation workflow markers', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pack-fresh-'))
    try {
      writeFixture(root)
      const result = probe(0, root)
      expect(result.ok).toBe(true)
      expect(result.assets?.js).toBe('index-BmJHgFPr.js')
      expect(result.assets?.css).toBe('index-BRhDTqQu.css')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
