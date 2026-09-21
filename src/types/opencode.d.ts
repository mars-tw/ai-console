export interface OpenCodeDesktopStatus {
  installed: boolean
  version: string | null
  configured: boolean
  allowedRoots: string[]
  bridgeReady: boolean
  running: boolean
  starting: boolean
  cwd: string | null
  model: 'gpt-5.6-sol' | 'gpt-6-astra'
  windowOpen: boolean
  error?: string
}

export type OpenCodeReply = { ok: true; status: OpenCodeDesktopStatus } | { ok: false; error: string; code: string }

declare global {
  interface Window {
    acOpenCode?: {
      status(): Promise<OpenCodeReply>
      open(input: { cwd: string; model: 'gpt-5.6-sol' | 'gpt-6-astra' }): Promise<OpenCodeReply>
      stop(): Promise<OpenCodeReply>
    }
  }
}
