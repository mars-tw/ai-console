/** Single stop/cancel request. A lost response can follow a successful action. */
export async function requestControlReceipt(
  transport: typeof fetch,
  action: 'stop' | 'cancel',
  id: string,
  timeoutMs = 12000,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('control receipt timeout')) }, timeoutMs)
  })
  try {
    return await Promise.race([deadline, (async () => {
      const response = await transport(`/api/dispatch/${action}`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      })
      const body: unknown = await response.json().catch(() => null)
      return { response, body }
    })()])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
