import { describe, expect, it } from 'vitest'
import type { DispatchRecord, HubProject, ToolStatus } from '@/types/data'
import {
  anchorPoint,
  branchPath,
  buildWorkMindMap,
  clampZoom,
  filterProjects,
  filterTools,
  fitZoom,
  matchesMapQuery,
  preferredProjects,
  scaledSize,
  statusProjects,
  ZOOM_MAX,
  ZOOM_MIN,
} from './workMindMap'

const record = (values: Partial<DispatchRecord> = {}): DispatchRecord => ({
  id: 'task-1', tool: 'codex', task: 'work', started: '', log: '', mode: 'headless', ...values,
})

describe('unconfirmed work map records', () => {
  it('retains unknown registry records and pending cancellations without inventing running work', () => {
    const input = Array.from({ length: 30 }, (_, i) => record({ id: `legacy-${i}`, state: 'unknown' }))
    input.push(record({ id: 'cancel-pending', state: 'running', cancelOrderPending: true }))
    const node = buildWorkMindMap({ codex: tool() }, [], input).tools[0]
    expect(node).toMatchObject({ unknownCount: 31, runningCount: 0, waitingCount: 0, status: 'active' })
    expect(node.tasks).toHaveLength(31)
    expect(node.tasks.every((task) => task.state === 'unknown')).toBe(true)
  })
})

describe('work map geometry and navigation helpers', () => {
  it('converts scaled DOM edges into scene coordinates and joins exact endpoints', () => {
    const from = anchorPoint({ left: 112, right: 232, top: 124, height: 48 }, { left: 40, top: 100 }, 'right', 1.2)
    const to = anchorPoint({ left: 520, right: 640, top: 220, height: 72 }, { left: 40, top: 100 }, 'left', 1.2)
    expect(from).toEqual({ x: 160, y: 40 })
    expect(to).toEqual({ x: 400, y: 130 })
    expect(branchPath(from, to)).toBe('M160 40 C268 40 292 130 400 130')
    expect(branchPath(to, from)).toBe('M400 130 C292 130 268 40 160 40')
  })

  it('keeps zoom bounds finite and scroll dimensions proportional', () => {
    expect(clampZoom(100)).toBe(ZOOM_MAX)
    expect(clampZoom(-100)).toBe(ZOOM_MIN)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(fitZoom(1000, 850)).toBe(.85)
    expect(fitZoom(0, 0)).toBe(1)
    expect(scaledSize(1000, 600, 1.2)).toEqual({ width: 1200, height: 720 })
    expect(scaledSize(1000, 600, .7)).toEqual({ width: 700, height: 420 })
  })

  it('searches explicit node fields without adding relationships or mutating the source', () => {
    const model = buildWorkMindMap({ codex: tool(), other: tool({ label: 'Other' }) }, [project()], [record({ state: 'unknown', task: 'Investigate zebra' })])
    expect(matchesMapQuery([null, 'Mixed Case'], ' CASE ')).toBe(true)
    expect(filterTools(model.tools, 'ZEBRA').map((node) => node.tool)).toEqual(['codex'])
    expect(filterProjects(model.projects, 'Review').map((node) => node.projectId)).toEqual(['codex'])
    expect(filterProjects(model.projects, 'zebra')).toEqual([])
    expect(model.tools).toHaveLength(2)
  })
})

describe('project snapshot source preference', () => {
  it('prefers supplied status projects, respects an empty list, and falls back when missing', () => {
    const indexed = [project({ title: 'Index snapshot' })]
    const live = [project({ title: 'Status snapshot' })]
    expect(preferredProjects(statusProjects({ projects: live }), indexed)).toEqual(live)
    expect(preferredProjects(statusProjects({ projects: [] }), indexed)).toEqual([])
    expect(preferredProjects(statusProjects({ tools: {} }), indexed)).toEqual(indexed)
    expect(preferredProjects(statusProjects(null), null)).toBeNull()
    expect(preferredProjects(statusProjects({ projects: 'invalid' }), indexed)).toEqual(indexed)
  })
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
