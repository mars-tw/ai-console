export type OpenCodeDevSpaceService = 'not_configured' | 'reachable' | 'unreachable'
export type OpenCodeAuthorizationState = 'not_started' | 'checking' | 'waiting_for_owner' | 'authorized' | 'timed_out' | 'failed'
export type OpenCodeMcpState = 'stopped' | 'connecting' | 'connected' | 'failed'
export type OpenCodeConnectionIssue = 'service_unreachable' | 'bridge_failed' | 'authorization_timeout' | 'authorization_failed' | 'connection_failed' | 'disconnected' | null
export type OpenCodeModel = 'gpt-5.6-sol' | 'gpt-6-astra'

export interface OpenCodeDesktopStatus {
  installed: boolean
  version: string | null
  configured: boolean
  allowedRoots: string[]
  /** Local executable/package prerequisites only. This never means MCP is connected. */
  bridgeReady: boolean
  devspaceService: OpenCodeDevSpaceService
  authorization: OpenCodeAuthorizationState
  mcp: OpenCodeMcpState
  connectionIssue: OpenCodeConnectionIssue
  running: boolean
  starting: boolean
  cwd: string | null
  model: OpenCodeModel
  windowOpen: boolean
  error?: string
}

export type OpenCodeReply = { ok: true; status: OpenCodeDesktopStatus } | { ok: false; error: string; code: string }
export interface OpenCodeSelection { cwd: string; model: OpenCodeModel }

export {}

declare global {
  interface Window {
    acOpenCode?: {
      status(): Promise<OpenCodeReply>
      open(input: OpenCodeSelection): Promise<OpenCodeReply>
      reconnect(input: OpenCodeSelection & { confirmInterrupt: true }): Promise<OpenCodeReply>
      stop(): Promise<OpenCodeReply>
    }
  }
}
