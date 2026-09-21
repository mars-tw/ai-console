export type WorkbenchView = 'list' | 'ask' | 'console' | 'devspace' | 'opencode' | 'office' | 'rpg' | 'skills' | 'setup'

export function isConversationWorkbench(view: unknown): view is 'devspace' | 'opencode' {
  return view === 'devspace' || view === 'opencode'
}

export function initialWorkbenchView(search: string): WorkbenchView {
  const view = new URLSearchParams(search).get('view')
  // Old execution links pointed at `console`; opening them now lands on the unified
  // ChatGPT Conversation + DevSpace preparation page instead of a CLI job screen.
  if (view === 'console') return 'devspace'
  return isConversationWorkbench(view) ? view : 'list'
}
