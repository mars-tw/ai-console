import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  devSpaceRequest, devSpaceRunProblem, parseDevSpaceStatus, parseDevSpaceTask,
  parseDevSpaceTasks, pollDevSpace, withinDevSpaceRoots,
  DEVSPACE_MODELS, boundedDevSpaceConversationContext, buildDevSpaceConversationInstructions,
  buildDevSpaceConversationPrompt, clearDevSpaceInstructions, copyThenOpenDevSpace,
  createDevSpaceDraft, devSpaceDispatchBody, devSpaceModelLabel, devSpaceWorkbenchState,
  prepareDevSpaceConversationDraft, readDevSpaceModel, resolveDevSpaceDirectory,
  updateDevSpaceDraft,
} from './devspace'

const status = () => parseDevSpaceStatus({
  installed: true, configured: true, version: '1.0.8', configPath: 'C:\\config.json',
  allowedRoots: ['C:\\work\\project'], endpoint: 'http://127.0.0.1:7676/mcp',
  service: { running: false, managed: false },
  daemon: { running: false, state: 'unavailable', activeTurns: 0 },
  targets: [{ name: 'codex', kind: 'provider' }, { name: 'claude', kind: 'provider' }, { name: 'local', kind: 'provider' }],
  models: [...DEVSPACE_MODELS], defaultModel: 'gpt-5.6-sol',
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('DevSpace readiness boundaries', () => {
  it('rejects missing or misleading readiness values', () => {
    expect(() => parseDevSpaceStatus({ installed: 'true', configured: true })).toThrow()
    expect(() => parseDevSpaceStatus({ ...status(), service: {} })).toThrow()
    expect(() => parseDevSpaceStatus({ ...status(), allowedRoots: null })).toThrow()
  })

  it('only offers the configured Codex provider', () => {
    const data = parseDevSpaceStatus({ ...status(), targets: [{ name: 'local', kind: 'provider' }, { name: 'old-provider', kind: 'provider' }, { name: 'codex', kind: 'profile' }] })
    expect(data.targets.map(item => item.name)).toEqual([])
    expect(devSpaceRunProblem(data, 'C:\\work\\project', 'codex', 'Review this')).not.toBe('')
  })

  it('requires installed, configured, allowed root, enabled provider and a prompt', () => {
    const data = status()
    expect(devSpaceRunProblem(data, 'C:\\work\\project', 'codex', 'Review this')).toBe('')
    expect(devSpaceRunProblem(data, 'C:\\work\\project', 'codex', 'Review this', 'gpt-6-astra')).toBe('')
    expect(devSpaceRunProblem(data, 'C:\\work\\project', 'codex', 'Review this', 'unknown')).not.toBe('')
    expect(devSpaceRunProblem(data, 'C:\\work\\project', 'local', 'Review this')).not.toBe('')
    expect(devSpaceRunProblem(null, 'C:\\work\\project', 'codex', 'Review')).not.toBe('')
    expect(devSpaceRunProblem({ ...data, installed: false }, 'C:\\work\\project', 'codex', 'Review')).not.toBe('')
    expect(devSpaceRunProblem({ ...data, configured: false }, 'C:\\work\\project', 'codex', 'Review')).not.toBe('')
    expect(devSpaceRunProblem(data, 'C:\\elsewhere', 'codex', 'Review')).not.toBe('')
    expect(devSpaceRunProblem(data, 'C:\\work\\project', 'codex', '  ')).not.toBe('')
    // Neither a stopped HTTP server nor a stopped task daemon prevents an explicit run.
    expect(data.service.running).toBe(false)
    expect(data.daemon.running).toBe(false)
  })

  it('refuses a legacy backend that cannot confirm the selected model contract', () => {
    const data = status()
    expect(() => parseDevSpaceStatus({ ...data, models: undefined })).toThrow('背景服務')
    expect(() => parseDevSpaceStatus({ ...data, defaultModel: 'unlisted' })).toThrow()
    expect(() => parseDevSpaceStatus({ ...data, models: [] })).toThrow()
  })

  it('defaults to SOL but preserves an explicit ASTRA preference without trusting invalid saved values', () => {
    expect(readDevSpaceModel({ getItem: () => null })).toBe('gpt-5.6-sol')
    expect(readDevSpaceModel({ getItem: () => 'gpt-6-astra' })).toBe('gpt-6-astra')
    expect(readDevSpaceModel({ getItem: () => 'unknown' })).toBe('gpt-5.6-sol')
    expect(readDevSpaceModel({ getItem: () => { throw new Error('blocked') } })).toBe('gpt-5.6-sol')
  })

  it('always sends the selected model for both new and continued tasks', () => {
    for (const model of DEVSPACE_MODELS) {
      expect(devSpaceDispatchBody('C:/work', ' task ', model.id)).toEqual({ cwd: 'C:/work', target: 'codex', prompt: 'task', model: model.id })
      expect(devSpaceDispatchBody('C:/work', ' next ', model.id, 'agt_1234')).toEqual({ cwd: 'C:/work', id: 'agt_1234', prompt: 'next', model: model.id })
    }
    expect(() => devSpaceDispatchBody('C:/work', 'task', 'unlisted')).toThrow()
    expect(parseDevSpaceTask({ id: 'agt_1234', status: 'running', model: 'gpt-6-astra' }).model).toBe('gpt-6-astra')
    expect(devSpaceModelLabel('gpt-6-astra')).toBe('GPT-6 ASTRA')
  })

  it('keeps the panel usable when obtaining browser storage itself throws', () => {
    vi.stubGlobal('localStorage', undefined)
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: storage access blocked') },
    })
    expect(readDevSpaceModel()).toBe('gpt-5.6-sol')
  })

  it('supports subdirectories without confusing sibling prefixes or traversal', () => {
    const roots = ['C:\\work\\project']
    expect(withinDevSpaceRoots('c:/WORK/project/src', roots)).toBe(true)
    expect(withinDevSpaceRoots('C:\\work\\project-backup', roots)).toBe(false)
    expect(withinDevSpaceRoots('C:\\work\\project\\..\\secret', roots)).toBe(false)
    expect(withinDevSpaceRoots('C:\\work\\project\\.\\src', roots)).toBe(false)
    expect(withinDevSpaceRoots('/Work/project', ['/work'])).toBe(false)
    expect(withinDevSpaceRoots('/work/project', ['/work'])).toBe(true)
    expect(withinDevSpaceRoots('/work/project', ['/'])).toBe(true)
    expect(withinDevSpaceRoots('  C:\\work\\project ', roots)).toBe(true)
  })

  it('does not interpret unknown task status as completed', () => {
    expect(() => parseDevSpaceTask({ id: '1', status: 'unknown' })).toThrow()
    expect(() => parseDevSpaceTasks(null)).toThrow()
    expect(parseDevSpaceTask({ id: '1', status: 'running', stale: true }).stale).toBe(true)
    expect(parseDevSpaceTask({ id: '1', status: 'failed', error: { code: 'auth', message: 'Sign in' } }).error?.message).toBe('Sign in')
    expect(parseDevSpaceTask({ id: '1', status: 'completed', target: 'reviewer', provider: 'claude' }).provider).toBe('claude')
  })
})

describe('DevSpace conversation workbench behavior', () => {
  it('keeps a Home-owned draft across a tab round trip and clears only the instructions', () => {
    const entered = updateDevSpaceDraft(createDevSpaceDraft('gpt-5.6-sol'), {
      workspace: 'C:\\使用者\\行銷 專案',
      model: 'gpt-6-astra',
      instructions: '保留這份工作內容',
    })
    const afterTabRoundTrip = updateDevSpaceDraft(entered, {})
    expect(afterTabRoundTrip).toEqual(entered)
    expect(clearDevSpaceInstructions(afterTabRoundTrip)).toEqual({
      workspace: 'C:\\使用者\\行銷 專案',
      model: 'gpt-6-astra',
      instructions: '',
    })
  })

  it('keeps the previous path when the desktop directory picker is cancelled', () => {
    const previous = 'C:\\使用者\\既有 專案'
    expect(resolveDevSpaceDirectory(previous, null)).toBe(previous)
    expect(resolveDevSpaceDirectory(previous, '')).toBe(previous)
    expect(resolveDevSpaceDirectory(previous, 'C:\\使用者\\新 專案')).toBe('C:\\使用者\\新 專案')
  })

  it('never opens ChatGPT when clipboard copying fails', async () => {
    const copy = vi.fn().mockRejectedValue(new Error('clipboard denied'))
    const open = vi.fn().mockResolvedValue(undefined)
    await expect(copyThenOpenDevSpace(copy, open)).resolves.toMatchObject({ ok: false, stage: 'copy' })
    expect(copy).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  it('reports an open failure only after a successful copy', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn().mockRejectedValue(new Error('popup blocked'))
    await expect(copyThenOpenDevSpace(copy, open)).resolves.toMatchObject({ ok: false, stage: 'open' })
    expect(copy).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('distinguishes every actionable readiness reason and allows drafting before MCP starts', () => {
    const data = status()
    expect(devSpaceWorkbenchState(null, '', '', '')).toMatchObject({ reason: 'loading', canCopy: false })
    expect(devSpaceWorkbenchState(data, 'offline', 'C:\\work\\project', 'Review')).toMatchObject({ reason: 'unreadable', canCopy: false })
    expect(devSpaceWorkbenchState({ ...data, installed: false }, '', 'C:\\work\\project', 'Review').reason).toBe('uninstalled')
    expect(devSpaceWorkbenchState({ ...data, configured: false }, '', 'C:\\work\\project', 'Review').reason).toBe('missing-configuration')
    expect(devSpaceWorkbenchState(data, '', 'C:\\elsewhere', 'Review').reason).toBe('invalid-project')
    expect(devSpaceWorkbenchState(data, '', 'C:\\work\\project', '   ').reason).toBe('empty-instructions')
    expect(devSpaceWorkbenchState(data, '', 'C:\\work\\project', 'Review')).toEqual({
      reason: 'mcp-stopped', canCopy: true, canStartMcp: true, executionReady: false,
    })
    expect(devSpaceWorkbenchState({ ...data, service: { ...data.service, running: true } }, '', 'C:\\work\\project', 'Review')).toEqual({
      reason: 'mcp-running', canCopy: true, canStartMcp: false, executionReady: true,
    })
  })

  it('caps imported conversation context at six recent messages and 300 characters each', () => {
    const context = boundedDevSpaceConversationContext(Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'tool',
      text: `${index}: ${'x'.repeat(400)}`,
      label: `source-${index}`,
    })))
    expect(context).toHaveLength(6)
    expect(context[0].text.startsWith('2:')).toBe(true)
    expect(context.every(message => message.text.length <= 300)).toBe(true)
    expect(context[0].role).toBe('user')
    expect(context[1].role).toBe('assistant')
  })

  it('converts every entry point into a new ChatGPT Conversation draft instead of a CLI resume', () => {
    const initial = updateDevSpaceDraft(createDevSpaceDraft('gpt-6-astra'), {
      workspace: 'C:\\old',
      instructions: 'old draft',
    })
    const prepared = prepareDevSpaceConversationDraft(initial, {
      task: '修正錯誤並跑測試',
      workspace: 'C:\\work\\project',
      title: '舊對話',
      originalTool: 'Claude Code',
      source: 'continuation',
      context: [{ role: 'assistant', text: '舊結果' }],
    })
    expect(prepared.workspace).toBe('C:\\work\\project')
    expect(prepared.model).toBe('gpt-6-astra')
    expect(prepared.instructions).toContain('修正錯誤並跑測試')
    expect(prepared.instructions).toContain('Claude Code')
    expect(prepared.instructions).toContain('ChatGPT「對話」')
    expect(prepared.instructions).toContain('不要恢復、重派或接力任何舊 CLI 工單')
    expect(prepared.instructions).not.toContain('claude resume')
  })

  it('builds the exact copy payload with project and model preference but no send claim', () => {
    const draft = updateDevSpaceDraft(createDevSpaceDraft('gpt-6-astra'), {
      workspace: 'C:\\work\\project',
      instructions: buildDevSpaceConversationInstructions({ task: '更新文件' }),
    })
    const prompt = buildDevSpaceConversationPrompt(draft)
    expect(prompt).toContain('ChatGPT「對話」')
    expect(prompt).toContain('C:\\work\\project')
    expect(prompt).toContain('GPT-6 ASTRA')
    expect(prompt).toContain('open_workspace')
    expect(prompt).not.toContain('已送出')
  })
})

describe('DevSpace reads are serial and cannot update an abandoned view', () => {
  it('waits for a read to settle before scheduling the next one', async () => {
    vi.useFakeTimers()
    let resolve!: (value: string) => void
    const read = vi.fn(() => new Promise<string>(done => { resolve = done }))
    const receive = vi.fn()
    const stop = pollDevSpace(read, receive, vi.fn(), 1000)
    await vi.advanceTimersByTimeAsync(10000)
    expect(read).toHaveBeenCalledTimes(1)
    resolve('result')
    await Promise.resolve()
    expect(receive).toHaveBeenCalledWith('result')
    await vi.advanceTimersByTimeAsync(999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)
    stop()
  })

  it('aborts on workspace/task switch and ignores an old response even if transport ignores abort', async () => {
    vi.useFakeTimers()
    let resolve!: (value: string) => void
    let signal!: AbortSignal
    const receive = vi.fn()
    const fail = vi.fn()
    const stop = pollDevSpace(current => { signal = current; return new Promise<string>(done => { resolve = done }) }, receive, fail)
    stop()
    expect(signal.aborted).toBe(true)
    resolve('old task output')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10000)
    expect(receive).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries failed reads without overlapping or hiding the error', async () => {
    vi.useFakeTimers()
    const failure = new Error('offline')
    const read = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('recovered')
    const receive = vi.fn()
    const fail = vi.fn()
    const stop = pollDevSpace(read, receive, fail, 1000)
    await Promise.resolve()
    expect(fail).toHaveBeenCalledWith(failure)
    await vi.advanceTimersByTimeAsync(1000)
    expect(receive).toHaveBeenCalledWith('recovered')
    stop()
  })
})

describe('DevSpace request contract', () => {
  it('refuses background run and continuation before making a network request', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(devSpaceRequest('run', { cwd: 'C:\\work', prompt: 'task' })).rejects.toThrow('ChatGPT')
    await expect(devSpaceRequest('continue', { id: 'old', prompt: 'next' })).rejects.toThrow('ChatGPT')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('posts structured service-control input and forwards cancellation', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
    vi.stubGlobal('fetch', fetcher)
    const signal = new AbortController().signal
    await devSpaceRequest('start', { requestedBy: 'workbench' }, signal)
    expect(fetcher).toHaveBeenCalledWith('/api/devspace/start', expect.objectContaining({ method: 'POST', signal, body: JSON.stringify({ requestedBy: 'workbench' }) }))
  })

  it('requires both HTTP and application success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'Provider disabled' }) }))
    await expect(devSpaceRequest('start', {})).rejects.toThrow('Provider disabled')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
    await expect(devSpaceRequest('status')).rejects.toThrow()
  })
})
