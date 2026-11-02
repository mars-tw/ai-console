import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
// The production packaging helper is ESM JavaScript and intentionally has no declaration file.
// @ts-expect-error JavaScript helper has no TypeScript declarations.
import { assertCandidateOutput, assertIsolatedBuildRoot, cleanCommit, packageCandidate, runFreshBuild } from '../../scripts/package-build.mjs'

const checkout = fileURLToPath(new URL('../..', import.meta.url))

describe('isolated packaging safety', () => {
  it('rejects any dirty or untracked checkout before selecting a commit', () => {
    const runner = vi.fn(() => ' M src/file.ts\n?? src/new.ts\n')
    expect(() => cleanCommit(checkout, runner)).toThrow(/clean checkout/)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('pins a clean checkout to the exact commit and rejects an invalid commit', () => {
    const runner = vi.fn().mockReturnValueOnce('').mockReturnValueOnce(`${'a'.repeat(40)}\n`)
    expect(cleanCommit(checkout, runner)).toBe('a'.repeat(40))
    const invalid = vi.fn().mockReturnValueOnce('').mockReturnValueOnce('HEAD')
    expect(() => cleanCommit(checkout, invalid)).toThrow(/source commit/)
  })

  it('refuses the live checkout or a directory inside it as a build snapshot', () => {
    expect(() => assertIsolatedBuildRoot(checkout, checkout)).toThrow(/outside/)
    expect(() => assertIsolatedBuildRoot(checkout, fileURLToPath(new URL('../', import.meta.url)))).toThrow(/outside/)
    expect(() => assertIsolatedBuildRoot(checkout, tmpdir())).not.toThrow()
  })

  it('rejects installed, external and linked output paths without writing them', () => {
    const neverExists = () => false
    expect(() => assertCandidateOutput(checkout, path.join(checkout, 'release', 'clean'), neverExists)).toThrow(/installed/)
    expect(() => assertCandidateOutput(checkout, path.join(checkout, 'release', 'clean', 'nested'), neverExists)).toThrow(/installed/)
    expect(() => assertCandidateOutput(checkout, path.join(checkout, 'outside'), neverExists)).toThrow(/child directory/)
    const candidate = path.join(checkout, 'release', 'candidates', 'fixture')
    expect(() => assertCandidateOutput(checkout, candidate, neverExists)).not.toThrow()
    expect(() => assertCandidateOutput(checkout, candidate, (p: string) => p === candidate, () => ({ isSymbolicLink: () => true }))).toThrow(/Linked/)
  })

  it('calls the injected packager with overwrite disabled', async () => {
    const result = path.resolve('fixture-candidate', 'AI控制台-win32-x64')
    const packager = vi.fn(async (options: unknown) => { void options; return [result] })
    await expect(packageCandidate(packager, { stage: 'fixture-stage', output: 'fixture-candidate', electronVersion: '43', icon: 'fixture-icon' })).resolves.toEqual([result])
    expect(packager).toHaveBeenCalledOnce()
    expect(packager.mock.calls[0][0]).toMatchObject({ dir: 'fixture-stage', out: 'fixture-candidate', overwrite: false, prune: false })
  })

  it('directs all mocked build commands and generated state to the isolated snapshot', () => {
    const run = vi.fn((node: unknown, args: unknown, config: unknown) => { void node; void args; void config })
    const verify = vi.fn(() => ({ js: 'fixture.js', css: 'fixture.css' }))
    const snapshot = tmpdir()
    expect(runFreshBuild({ root: snapshot, checkout, nodePath: 'fixture-node', run, exists: () => true, verify })).toEqual({ js: 'fixture.js', css: 'fixture.css' })
    expect(run).toHaveBeenCalledTimes(3)
    for (const call of run.mock.calls) expect(call[2]).toEqual({ cwd: snapshot })
    expect(run.mock.calls[0][1]).toContain(path.join(snapshot, '.app.tsbuildinfo'))
    expect(run.mock.calls[1][1]).toContain(path.join(snapshot, '.node.tsbuildinfo'))
    expect(run.mock.calls[2][1]).toContain('runner')
    expect(verify).toHaveBeenCalledWith(path.join(snapshot, 'dist'))
  })

  it('fails closed before calling a packager for an existing candidate, and rejects silent skips', async () => {
    const packager = vi.fn(async () => [])
    const options = { stage: 's', output: 'o', electronVersion: '43', icon: 'i' }
    await expect(packageCandidate(packager, options, () => true)).rejects.toThrow(/already exists/)
    expect(packager).not.toHaveBeenCalled()
    await expect(packageCandidate(packager, options, () => false)).rejects.toThrow(/did not create/)
  })
})
