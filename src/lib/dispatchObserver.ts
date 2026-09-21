import type { WorkbenchView } from './workbenchView'
import type { DispatchRecord } from '@/types/data'

/**
 * Legacy dispatch polling is intentionally disabled for every workbench view.
 * `/api/dispatches` is still available when a read-only history panel explicitly requests it,
 * but mounting or switching the application must never create a background observer that can
 * trigger legacy queue flushing or auto-handoff behavior.
 */
export function watchLegacyDispatches(
  _view: WorkbenchView,
  _receive: (records: DispatchRecord[]) => void,
  fetcher: typeof fetch = fetch,
  delay = 3000,
): () => void {
  void fetcher
  void delay
  return () => undefined
}
