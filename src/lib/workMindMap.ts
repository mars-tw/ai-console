import { stateOf } from './dispatchState'
import type { DispatchRecord, HubProject, ToolStatus } from '@/types/data'

export interface WorkMindMapTask {
  id: string
  tool: string | null
  task: string
  state: 'running' | 'waiting'
}

export interface WorkMindMapTool {
  id: string
  tool: string | null
  label: string
  status: string
  toolStatus: string
  runningCount: number
  waitingCount: number
  tasks: WorkMindMapTask[]
}

export interface WorkMindMapProject {
  id: string
  projectId: string
  title: string
  status: string
  next_step: string
  needs_handoff: boolean
}

export interface WorkMindMap {
  tools: WorkMindMapTool[]
  projects: WorkMindMapProject[]
}

// Keep valid identifiers exact: differing spellings cannot be assumed to be the same tool.
function toolKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

/** Build a view of supplied data only; there is no inferred tool-to-project relationship. */
export function buildWorkMindMap(
  tools: Record<string, ToolStatus>,
  projects: HubProject[],
  dispatches: DispatchRecord[],
): WorkMindMap {
  const byTool = new Map<string | null, WorkMindMapTool>()

  const ensureTool = (key: string | null, metadata?: ToolStatus | null) => {
    let node = byTool.get(key)
    if (!node) {
      const toolStatus = typeof metadata?.status === 'string' ? metadata.status : 'unknown'
      // Tool availability is not proof of a running or waiting dispatch.
      const baseStatus = toolStatus && toolStatus !== 'running' && toolStatus !== 'waiting'
        ? toolStatus : 'unknown'
      node = {
        id: key === null ? 'tool:unattributed' : `tool:id:${key}`,
        tool: key,
        label: text(metadata?.label, key ?? 'unknown'),
        status: baseStatus,
        toolStatus,
        runningCount: 0,
        waitingCount: 0,
        tasks: [],
      }
      byTool.set(key, node)
    }
    return node
  }

  for (const [key, metadata] of Object.entries(tools ?? {})) {
    ensureTool(toolKey(key), metadata)
  }
  for (const dispatch of dispatches ?? []) {
    if (!dispatch || typeof dispatch !== 'object') continue
    const state = stateOf(dispatch)
    if (state !== 'running' && state !== 'waiting') continue
    const key = toolKey(dispatch.tool)
    const node = ensureTool(key)
    node.tasks.push({ id: text(dispatch.id), tool: key, task: text(dispatch.task), state })
    if (state === 'running') node.runningCount += 1
    else node.waitingCount += 1
  }

  for (const node of byTool.values()) {
    if (node.runningCount) node.status = 'running'
    else if (node.waitingCount) node.status = 'waiting'
  }

  return {
    tools: [...byTool.values()],
    projects: (projects ?? []).filter((project): project is HubProject => !!project && typeof project === 'object').map((project) => {
      const projectId = text(project.project_id)
      return {
        id: `project:id:${projectId}`,
        projectId,
        title: text(project.title, projectId),
        status: text(project.status, 'unknown'),
        next_step: text(project.next_step),
        needs_handoff: project.needs_handoff === true,
      }
    }),
  }
}
