import { useEffect, useRef } from 'react'
import WorkMindMap from '@/components/WorkMindMap'
import { dispatchSnapshotStore, readDispatchSnapshotOnce, useDispatchSnapshot } from '@/lib/dispatchSnapshot'
import type { HubProject, ToolStatus } from '@/types/data'

interface Props {
  tools: Record<string, ToolStatus> | null
  projects: HubProject[] | null
}

/** No mount-time request or background polling: only the refresh button starts a read. */
export default function WorkMindMapView({ tools, projects }: Props) {
  const { dispatches, readState, lastSuccess } = useDispatchSnapshot()
  const active = useRef<AbortController | null>(null)

  useEffect(() => () => {
    const request = active.current
    active.current = null
    if (request) { request.abort(); dispatchSnapshotStore.error() }
  }, [])

  const refresh = async () => {
    if (active.current) return
    const request = new AbortController()
    active.current = request
    dispatchSnapshotStore.loading()
    try {
      const raw = await readDispatchSnapshotOnce(request.signal)
      if (active.current !== request || request.signal.aborted) return
      const body = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as { ok?: unknown; dispatches?: unknown } : null
      if (body?.ok === true) dispatchSnapshotStore.ready(body.dispatches, new Date().toISOString())
      else dispatchSnapshotStore.error()
    } catch {
      if (active.current === request && !request.signal.aborted) dispatchSnapshotStore.error()
    } finally {
      if (active.current === request) active.current = null
    }
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <WorkMindMap tools={tools} projects={projects} dispatches={dispatches} dispatchReadState={readState} dispatchLastSuccess={lastSuccess} onRefresh={() => void refresh()} />
    </div>
  )
}
