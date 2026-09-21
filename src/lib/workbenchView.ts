export type WorkbenchView = 'list' | 'ask' | 'console' | 'devspace' | 'opencode' | 'office' | 'rpg' | 'skills' | 'setup'

export function isConversationWorkbench(view: unknown): view is 'devspace' | 'opencode' {
  return view === 'devspace' || view === 'opencode'
}

export function initialWorkbenchView(search: string): WorkbenchView {
  const view = new URLSearchParams(search).get('view')
  return isConversationWorkbench(view) ? view : 'list'
}
