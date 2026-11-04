import { stateOf } from './dispatchState'
import type { DispatchRecord, HubProject, ToolStatus } from '@/types/data'

export interface WorkMindMapTask {
  id: string
  tool: string | null
  task: string
  /** `unknown` covers unconfirmed records (including pending cancellations) and is never counted as work. */
  state: 'running' | 'waiting' | 'unknown'
}

export interface WorkMindMapTool {
  id: string
  tool: string | null
  label: string
  status: string
  toolStatus: string
  runningCount: number
  waitingCount: number
  unknownCount: number
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
        unknownCount: 0,
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
    if (state !== 'running' && state !== 'waiting' && state !== 'unknown') continue
    const key = toolKey(dispatch.tool)
    const node = ensureTool(key)
    node.tasks.push({ id: text(dispatch.id), tool: key, task: text(dispatch.task), state })
    if (state === 'running') node.runningCount += 1
    else if (state === 'waiting') node.waitingCount += 1
    // An unconfirmed record is not work in progress and is not finished work either.
    else node.unknownCount += 1
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

/* ------------------------------------------------------------------ *
 * Project source selection
 * ------------------------------------------------------------------ */

/**
 * Projects carried by the existing `/api/status` response.
 * `null` means that response said nothing about projects, so the caller must fall
 * back to its own copy; it never means "no projects".
 */
export function statusProjects(payload: unknown): HubProject[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const raw = (payload as { projects?: unknown }).projects
  if (!Array.isArray(raw)) return null
  return raw.filter((item): item is HubProject => !!item && typeof item === 'object' && !Array.isArray(item))
}

/** Prefer the live status payload; fall back to the stored index only when status carried none. */
export function preferredProjects(
  live: HubProject[] | null | undefined,
  fallback: HubProject[] | null | undefined,
): HubProject[] | null {
  return live ?? fallback ?? null
}

/* ------------------------------------------------------------------ *
 * Branch geometry (pure, so the drawn graph can be tested)
 * ------------------------------------------------------------------ */

export interface MapPoint { x: number; y: number }

const round = (value: number) => Math.round(value * 10) / 10

/**
 * One cubic branch between two measured DOM anchors, in unscaled scene coordinates.
 * Horizontal control points keep the curve leaving each card sideways, so the line
 * meets the node edge instead of crossing the card.
 */
export function branchPath(from: MapPoint, to: MapPoint): string {
  const safe = (point: MapPoint): MapPoint => ({
    x: Number.isFinite(point.x) ? point.x : 0,
    y: Number.isFinite(point.y) ? point.y : 0,
  })
  const a = safe(from)
  const b = safe(to)
  const dx = b.x - a.x
  const lean = Math.max(16, Math.abs(dx) * 0.45) * (dx < 0 ? -1 : 1)
  return `M${round(a.x)} ${round(a.y)} C${round(a.x + lean)} ${round(a.y)} ${round(b.x - lean)} ${round(b.y)} ${round(b.x)} ${round(b.y)}`
}

/** Anchor on the left or right edge of a measured rect, converted out of the scaled scene. */
export function anchorPoint(
  rect: { left: number; right: number; top: number; height: number },
  scene: { left: number; top: number },
  edge: 'left' | 'right',
  scale = 1,
): MapPoint {
  const divisor = Number.isFinite(scale) && scale > 0.05 ? scale : 1
  return {
    x: round(((edge === 'left' ? rect.left : rect.right) - scene.left) / divisor),
    y: round((rect.top + rect.height / 2 - scene.top) / divisor),
  }
}

/* ------------------------------------------------------------------ *
 * Zoom and search
 * ------------------------------------------------------------------ */

export const ZOOM_MIN = 0.7
export const ZOOM_MAX = 1.4
export const ZOOM_STEP = 0.1

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100))
}

/** Zoom that brings the whole scene width into view, still inside the supported range. */
export function fitZoom(sceneWidth: number, viewportWidth: number): number {
  if (!Number.isFinite(sceneWidth) || !Number.isFinite(viewportWidth)) return 1
  if (sceneWidth <= 0 || viewportWidth <= 0) return 1
  return clampZoom(Math.floor((viewportWidth / sceneWidth) * 100) / 100)
}

/** Scaled scene box, so the scroll container keeps real bounds when zoomed either way. */
export function scaledSize(width: number, height: number, scale: number): { width: number; height: number } {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
  return {
    width: Math.max(0, Math.round((Number.isFinite(width) ? width : 0) * factor)),
    height: Math.max(0, Math.round((Number.isFinite(height) ? height : 0) * factor)),
  }
}

/** Case-insensitive node search over the fields a node actually shows. */
export function matchesMapQuery(fields: Array<string | null | undefined>, query: string): boolean {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!needle) return true
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(needle))
}

export function filterTools(tools: WorkMindMapTool[], query: string): WorkMindMapTool[] {
  if (!query.trim()) return tools
  return tools.filter((item) => matchesMapQuery(
    [item.label, item.tool, item.status, item.toolStatus, ...item.tasks.map((task) => task.task)],
    query,
  ))
}

export function filterProjects(projects: WorkMindMapProject[], query: string): WorkMindMapProject[] {
  if (!query.trim()) return projects
  return projects.filter((item) => matchesMapQuery([item.title, item.projectId, item.status, item.next_step], query))
}
