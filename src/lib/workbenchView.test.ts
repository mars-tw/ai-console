import { describe, expect, it } from 'vitest'
import { initialWorkbenchView, isConversationWorkbench } from './workbenchView'

describe('unified ChatGPT workbench route', () => {
  it('redirects legacy console links to the DevSpace conversation preparation page', () => {
    expect(initialWorkbenchView('?view=console')).toBe('devspace')
  })

  it('keeps explicit conversation workbenches and rejects unknown values', () => {
    expect(initialWorkbenchView('?view=devspace')).toBe('devspace')
    expect(initialWorkbenchView('?view=opencode')).toBe('opencode')
    expect(initialWorkbenchView('?view=unknown')).toBe('list')
    expect(isConversationWorkbench('devspace')).toBe(true)
    expect(isConversationWorkbench('opencode')).toBe(true)
    expect(isConversationWorkbench('console')).toBe(false)
  })
})
