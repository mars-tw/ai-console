import { describe, expect, it, vi } from 'vitest'
import { watchLegacyDispatches } from './dispatchObserver'
import type { WorkbenchView } from './workbenchView'

describe('legacy dispatch observer is disabled globally', () => {
  it.each<WorkbenchView>(['list', 'ask', 'console', 'devspace', 'opencode', 'office', 'rpg', 'skills', 'setup'])('%s never polls dispatch history in the background', view => {
    const fetcher = vi.fn()
    const receive = vi.fn()
    const stop = watchLegacyDispatches(view, receive, fetcher as unknown as typeof fetch, 1)
    expect(fetcher).not.toHaveBeenCalled()
    expect(receive).not.toHaveBeenCalled()
    expect(() => stop()).not.toThrow()
  })
})
