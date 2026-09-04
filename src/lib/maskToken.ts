/** 遮掉配對網址裡的 token：畫面上只留最後四碼，完整的只進 QR 與剪貼簿。 */
export function maskUrl(url: string): string {
  return url.replace(/#t=(.+)$/, (_m, tok: string) => `#t=${'•'.repeat(6)}${tok.slice(-4)}`)
}
