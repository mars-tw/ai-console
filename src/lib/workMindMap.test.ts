import { describe, expect, it } from 'vitest'
import type { DispatchRecord, HubProject, ToolStatus } from '@/types/data'
import { buildWorkMindMap } from './workMindMap'

const record = (values: Partial<DispatchRecord> = {}): DispatchRecord => ({
  id: 'task-1', tool: 'codex', task: 'work', started: '', log: '', mode: 'headless', ...values,
})
const tool = (values: Partial<ToolStatus> = {}): ToolStatus => ({
  label: 'Codex', status: 'active', last_active: '', rate_limited: false, role: '', ...values,
})
const project = (values: Partial<HubProject> = {}): HubProject => ({
  project_id: 'codex', title: 'Project', status: 'waiting', updated_at: '', updated_by: '',
  next_step: 'Review', needs_handoff: true, ...values,
})

describe('buildWorkMindMap', () => {
  it('distinguishes running, waiting, legacy and terminal dispatches using stateOf', () => {
    const result = buildWorkMindMap({ codex: tool() }, [], [
      record({ id: 'running', state: 'running', alive: false }),
      record({ id: 'waiting', state: 'waiting', alive: true }),
      record({ id: 'old-running', alive: true }),
      record({ id: 'old-waiting', alive: false }),
      record({ id: 'done', state: 'done', alive: true }),
      record({ id: 'failed', state: 'failed', alive: true }),
      record({ id: 'cancelled', state: 'cancelled' }),
    ])
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]).toMatchObject({
      id: 'tool:id:codex', tool: 'codex', label: 'Codex', status: 'running',
      toolStatus: 'active', runningCount: 2, waitingCount: 2,
    })
    expect(result.tools[0].tasks.map(({ id, state }) => [id, state])).toEqual([
      ['running', 'running'], ['waiting', 'waiting'], ['old-running', 'running'], ['old-waiting', 'waiting'],
    ])
  })

  it('does not mistake available tools or waiting tasks for running work', () => {
    const result = buildWorkMindMap({
      codex: tool({ status: 'running' }),
      idle: tool({ label: 'Idle', status: 'idle' }),
    }, [], [record({ tool: 'idle', state: 'waiting', alive: true })])
    expect(result.tools[0]).toMatchObject({ status: 'unknown', toolStatus: 'running', runningCount: 0 })
    expect(result.tools[1]).toMatchObject({ status: 'waiting', toolStatus: 'idle', runningCount: 0, waitingCount: 1 })
  })

  it('retains unknown and malformed tool ids without merging them into known tools', () => {
    const result = buildWorkMindMap({ codex: tool() }, [], [
      record({ id: 'remote', tool: 'external', state: 'running' }),
      record({ id: 'missing', tool: '' as string, state: 'waiting' }),
      record({ id: 'malformed', tool: null as unknown as string, state: 'running' }),
      record({ id: 'odd', tool: '\ud800', state: 'running' }),
    ])
    expect(result.tools.find((node) => node.tool === 'external')).toMatchObject({
      label: 'external', toolStatus: 'unknown', runningCount: 1,
    })
    expect(result.tools.find((node) => node.tool === null)).toMatchObject({
      id: 'tool:unattributed', label: 'unknown', runningCount: 1, waitingCount: 1,
    })
    expect(result.tools.find((node) => node.tool === '\ud800')?.tasks[0].id).toBe('odd')
  })

  it('keeps projects independent from tools even when identifiers match', () => {
    const result = buildWorkMindMap({ codex: tool() }, [project()], [record({ state: 'running' })])
    expect(result.projects).toEqual([{
      id: 'project:id:codex', projectId: 'codex', title: 'Project', status: 'waiting',
      next_step: 'Review', needs_handoff: true,
    }])
    expect(result.tools[0].id).not.toBe(result.projects[0].id)
    expect(result.projects[0]).not.toHaveProperty('tool')
  })

  it('supports empty inputs and preserves all active tasks without a display limit', () => {
    expect(buildWorkMindMap({}, [], [])).toEqual({ tools: [], projects: [] })
    const tasks = Array.from({ length: 1000 }, (_, i) => record({ id: String(i), state: 'waiting' }))
    const node = buildWorkMindMap({}, [], tasks).tools[0]
    expect(node.waitingCount).toBe(1000)
    expect(node.tasks).toHaveLength(1000)
  })
})
