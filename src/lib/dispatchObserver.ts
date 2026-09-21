import { isConversationWorkbench } from './workbenchView'
import type { DispatchRecord } from '@/types/data'

/** The legacy read endpoint may hand work to another agent; conversation clients must never poll it. */
export function watchLegacyDispatches(view: string, receive: (records: DispatchRecord[]) => void): () => void {
  if (isConversationWorkbench(view)) return () => {}
  const controller = new AbortController()
  let pulling = false
  const pull = async () => {
    if (pulling || controller.signal.aborted) return
    pulling = true
    try {
      const response = await fetch('/api/dispatches', { signal: controller.signal })
      if (!response.ok) return
      const data = await response.json()
      if (!controller.signal.aborted && Array.isArray(data?.dispatches)) receive(data.dispatches)
    } catch {
      // Completion notifications cannot block the workbench when a read fails or is cancelled.
    } finally { pulling = false }
  }
  void pull()
  const timer = setInterval(() => { void pull() }, 3000)
  return () => { controller.abort(); clearInterval(timer) }
}
