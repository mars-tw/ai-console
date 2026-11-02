import { useSyncExternalStore } from 'react'
import type { DispatchRecord } from '@/types/data'

export interface DispatchSnapshot {
  dispatches: DispatchRecord[]
  readState: 'idle' | 'loading' | 'ready' | 'error'
  lastSuccess: string | null
}

const states = new Set(['running', 'waiting', 'done', 'failed', 'silent', 'cancelled', 'stopped', 'unknown'])

/** Validate the complete snapshot; discard no bad row as that would imply a complete result. */
export function validateDispatchSnapshot(input: unknown): DispatchRecord[] | null {
  if (!Array.isArray(input)) return null
  const records: DispatchRecord[] = []
  for (const value of input as unknown[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const item = value as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id.trim()
      || (item.tool != null && typeof item.tool !== 'string')
      || (item.task != null && typeof item.task !== 'string')
      || (item.state != null && (typeof item.state !== 'string' || !states.has(item.state)))
      || (item.alive != null && typeof item.alive !== 'boolean')
      || (item.cancelOrderPending != null && typeof item.cancelOrderPending !== 'boolean')
      || (item.result != null && typeof item.result !== 'string')
      || (item.reply != null && typeof item.reply !== 'string')) return null
    // Empty tool represents an unattributed dispatch; it is never mapped to an assumed tool.
    records.push({ ...item, tool: item.tool ?? '', task: item.task ?? '' } as DispatchRecord)
  }
  return records
}

/** Store only; the independent map requests a snapshot only on explicit user action. */
export function createDispatchSnapshotStore() {
  let snapshot: DispatchSnapshot = { dispatches: [], readState: 'idle', lastSuccess: null }
  const listeners = new Set<() => void>()
  const publish = (next: DispatchSnapshot) => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    loading: () => { publish({ ...snapshot, readState: 'loading' }) },
    error: () => { publish({ ...snapshot, readState: 'error' }) },
    ready: (input: unknown, timestamp: string): boolean => {
      const records = validateDispatchSnapshot(input)
      if (!records) {
        publish({ ...snapshot, readState: 'error' })
        return false
      }
      publish({ dispatches: records, readState: 'ready', lastSuccess: timestamp })
      return true
    },
  }
}

export const dispatchSnapshotStore = createDispatchSnapshotStore()

export function useDispatchSnapshot(): DispatchSnapshot {
  return useSyncExternalStore(dispatchSnapshotStore.subscribe, dispatchSnapshotStore.getSnapshot, dispatchSnapshotStore.getSnapshot)
}

/** A bounded read, including body parsing; abort or timeout never accepts a late response. */
export async function readDispatchSnapshotOnce(
  outer: AbortSignal,
  timeoutMs = 12000,
  doFetch: typeof fetch = fetch,
): Promise<unknown> {
  const request = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => { request.abort(); reject(new DOMException('Aborted', 'AbortError')) }
    if (outer.aborted) { onAbort(); return }
    outer.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => { request.abort(); reject(new Error('snapshot timeout')) }, timeoutMs)
  })
  try {
    return await Promise.race([interrupted, (async () => {
      request.signal.throwIfAborted()
      const response = await doFetch('/api/dispatches', { signal: request.signal, cache: 'no-store' })
      request.signal.throwIfAborted()
      if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`)
      const result: unknown = await response.json()
      request.signal.throwIfAborted()
      return result
    })()])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outer.removeEventListener('abort', onAbort)
    request.abort()
  }
}
