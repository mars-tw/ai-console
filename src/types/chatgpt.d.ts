export {}
declare global {
  interface Window {
    acChatGPT?: { open(): Promise<{ ok: boolean; error?: string }> }
  }
}
