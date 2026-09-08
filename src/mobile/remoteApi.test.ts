import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  capturePairing,
  clearRemoteToken,
  createSnapshotFetch,
  getRemoteToken,
  installRemoteFetch,
  isPairingIntact,
  isSameOriginApi,
  isStalePairingError,
  setRemoteToken,
  tokenFromHash,
  TOKEN_STORAGE_KEY,
  uninstallRemoteFetch,
  validateRemoteToken,
  type PairingSnapshot,
  type StalePairingError,
} from './remoteApi'

describe('remoteApi token 儲存與存取', () => {
  let memoryStorage: Record<string, string>

  beforeEach(() => {
    memoryStorage = {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memoryStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        memoryStorage[key] = String(val)
      },
      removeItem: (key: string) => {
        delete memoryStorage[key]
      },
      clear: () => {
        memoryStorage = {}
      },
    })
  })

  it('可正確寫入、讀回並清除 token', () => {
    expect(getRemoteToken()).toBe('')

    setRemoteToken('test-token-123')
    expect(memoryStorage[TOKEN_STORAGE_KEY]).toBe('test-token-123')
    expect(getRemoteToken()).toBe('test-token-123')

    clearRemoteToken()
    expect(memoryStorage[TOKEN_STORAGE_KEY]).toBeUndefined()
    expect(getRemoteToken()).toBe('')
  })

  it('在 localStorage 存取拋出例外時安全退回空字串，不造成應用中斷', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError: access denied')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    })

    expect(getRemoteToken()).toBe('')
    expect(() => setRemoteToken('abc')).not.toThrow()
    expect(() => clearRemoteToken()).not.toThrow()
  })
})

describe('remoteApi tokenFromHash 網址解析與清理', () => {
  let memoryStorage: Record<string, string>
  let replacedUrl: string | null = null

  beforeEach(() => {
    memoryStorage = {}
    replacedUrl = null

    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memoryStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        memoryStorage[key] = String(val)
      },
      removeItem: (key: string) => {
        delete memoryStorage[key]
      },
    })

    vi.stubGlobal('window', {
      location: {
        hash: '#t=token-from-url',
        pathname: '/m/',
        search: '',
        origin: 'http://localhost:5178',
      },
      history: {
        replaceState: (_data: unknown, _title: string, url: string) => {
          replacedUrl = url
        },
      },
    })
  })

  it('從 hash 取出 token 並清除網址，但驗證前不保存憑證', () => {
    const extracted = tokenFromHash()
    expect(extracted).toBe('token-from-url')
    expect(getRemoteToken()).toBe('')
    expect(replacedUrl).toBe('/m/')
  })

  it('支援多參數 hash 格式（#t=foo&other=bar）', () => {
    window.location.hash = '#t=complex-token-456&mode=debug'
    const extracted = tokenFromHash()
    expect(extracted).toBe('complex-token-456')
    expect(getRemoteToken()).toBe('')
  })

  it('當 hash 無 token 時回傳 null 且不覆蓋既有 token', () => {
    setRemoteToken('keep-existing')
    window.location.hash = '#view=dispatches'
    const extracted = tokenFromHash()
    expect(extracted).toBeNull()
    expect(getRemoteToken()).toBe('keep-existing')
    expect(replacedUrl).toBeNull()
  })

  it('錯誤候選只驗證一次受保護端點，不保存候選或覆蓋既有憑證', async () => {
    setRemoteToken('existing-token')
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), { status: 401 }))
    await expect(validateRemoteToken('bad-candidate', request)).rejects.toThrow('Invalid token')
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/dispatch/tools', {
      headers: { Authorization: 'Bearer bad-candidate' },
    })
    expect(getRemoteToken()).toBe('existing-token')
  })

  it('HTTP 200 仍須含正確工具資料才能完成驗證', async () => {
    await expect(validateRemoteToken('candidate', async () => new Response(JSON.stringify({ ok: true })))).rejects.toThrow()
    await expect(validateRemoteToken('candidate', async () => new Response(JSON.stringify({ ok: true, tools: [] })))).resolves.toBeUndefined()
    expect(getRemoteToken()).toBe('')
  })
})

describe('isSameOriginApi 同源與 API 路徑比對', () => {
  const mockWin = {
    location: {
      origin: 'http://127.0.0.1:5178',
    },
  } as unknown as typeof window

  it('同源且以 /api/ 開頭或為 /api 回傳 true', () => {
    expect(isSameOriginApi('/api/dispatches', mockWin)).toBe(true)
    expect(isSameOriginApi('http://127.0.0.1:5178/api/dispatch/tools', mockWin)).toBe(true)
    expect(isSameOriginApi('/api', mockWin)).toBe(true)
  })

  it('非同源或非 /api 路徑回傳 false', () => {
    expect(isSameOriginApi('https://example.com/api/dispatches', mockWin)).toBe(false)
    expect(isSameOriginApi('/m/icon.svg', mockWin)).toBe(false)
    expect(isSameOriginApi('/assets/index.js', mockWin)).toBe(false)
    expect(isSameOriginApi('http://127.0.0.1:5178/data/index.json', mockWin)).toBe(false)
  })
})

describe('installRemoteFetch 請求攔截包裝', () => {
  let memoryStorage: Record<string, string>
  let interceptedCalls: { input: RequestInfo | URL; init?: RequestInit }[]
  let mockFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  beforeEach(() => {
    memoryStorage = { [TOKEN_STORAGE_KEY]: 'bearer-secret-777' }
    interceptedCalls = []

    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memoryStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        memoryStorage[key] = String(val)
      },
      removeItem: (key: string) => {
        delete memoryStorage[key]
      },
    })

    mockFetch = async (input, init) => {
      interceptedCalls.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    vi.stubGlobal('window', {
      location: {
        origin: 'http://localhost:5178',
      },
      fetch: mockFetch,
      dispatchEvent: vi.fn(),
    })
  })

  it('fetch 包裝只對同源 /api/ 請求加上 Authorization: Bearer <token>', async () => {
    installRemoteFetch(window)

    // 1. 同源 API 請求：必須加 header
    await window.fetch('/api/dispatches')
    expect(interceptedCalls).toHaveLength(1)
    const call1Headers = new Headers(interceptedCalls[0].init?.headers)
    expect(call1Headers.get('Authorization')).toBe('Bearer bearer-secret-777')

    // 2. 跨域請求：原樣放行，不得附加憑證
    await window.fetch('https://external-api.example.com/api/test')
    expect(interceptedCalls).toHaveLength(2)
    const call2Headers = new Headers(interceptedCalls[1].init?.headers)
    expect(call2Headers.get('Authorization')).toBeNull()

    // 3. 同源非 /api/ 靜態檔：原樣放行
    await window.fetch('/m/icon.svg')
    expect(interceptedCalls).toHaveLength(3)
    const call3Headers = new Headers(interceptedCalls[2].init?.headers)
    expect(call3Headers.get('Authorization')).toBeNull()

    uninstallRemoteFetch(window)
  })

  it('保留請求原本自訂的標頭（如 Content-Type）', async () => {
    installRemoteFetch(window)

    await window.fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'auto', task: 'test' }),
    })

    expect(interceptedCalls).toHaveLength(1)
    const headers = new Headers(interceptedCalls[0].init?.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer bearer-secret-777')

    uninstallRemoteFetch(window)
  })

  it('明確配對 Authorization 優先於已保存的舊 token，包含 Request 輸入', async () => {
    installRemoteFetch(window)
    await window.fetch('/api/dispatch/tools', { headers: { Authorization: 'Bearer replacement' } })
    expect(new Headers(interceptedCalls[0].init?.headers).get('Authorization')).toBe('Bearer replacement')
    await window.fetch(new Request('http://localhost:5178/api/dispatch/tools', { headers: { Authorization: 'Bearer request-token' } }))
    expect((interceptedCalls[1].input as Request).headers.get('Authorization')).toBe('Bearer request-token')
    uninstallRemoteFetch(window)
  })

  it('舊 token 的延遲 401 不解除新 token 的配對', async () => {
    let finish: ((response: Response) => void) | undefined
    window.fetch = () => new Promise<Response>((resolve) => { finish = resolve })
    installRemoteFetch(window)
    const pending = window.fetch('/api/dispatches')
    setRemoteToken('new-token')
    finish?.(new Response('{}', { status: 401 }))
    await pending
    expect(window.dispatchEvent).not.toHaveBeenCalled()
    uninstallRemoteFetch(window)
  })

  it('當 API 回傳 401 時觸發 ac_remote_unauthorized 事件', async () => {
    const unauthorizedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      interceptedCalls.push({ input, init })
      return new Response(JSON.stringify({ ok: false }), { status: 401 })
    }
    window.fetch = unauthorizedFetch
    installRemoteFetch(window)

    const response = await window.fetch('/api/dispatches')
    expect(response.status).toBe(401)
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1)

    uninstallRemoteFetch(window)
  })
})

// 以下 token 皆為合成字串，不是任何真實憑證；全程也不碰真的網路。
describe('createSnapshotFetch 工單級配對綁定（token + 代次）', () => {
  let memoryStorage: Record<string, string>
  let calls: { input: RequestInfo | URL; init?: RequestInit }[]

  const authOf = (index: number) => new Headers(calls[index]?.init?.headers).get('Authorization')
  const winOf = () => window

  beforeEach(() => {
    memoryStorage = { [TOKEN_STORAGE_KEY]: 'token-A' }
    calls = []

    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memoryStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        memoryStorage[key] = String(val)
      },
      removeItem: (key: string) => {
        delete memoryStorage[key]
      },
    })

    vi.stubGlobal('window', {
      location: { origin: 'http://localhost:5178' },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      dispatchEvent: vi.fn(),
    })
  })

  it('同源 /api/ 帶「當初那把」token；跨域與靜態資源一律不帶工單授權', async () => {
    const send = createSnapshotFetch(capturePairing(3), { fetch: window.fetch, win: winOf() })

    await send('/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'claude', task: 'x' }),
    })
    expect(authOf(0)).toBe('Bearer token-A')
    expect(new Headers(calls[0].init?.headers).get('Content-Type')).toBe('application/json')

    await send('https://external-api.example.com/api/dispatch')
    await send('/m/icon.svg')
    await send('/assets/index.js')
    expect(authOf(1)).toBeNull()
    expect(authOf(2)).toBeNull()
    expect(authOf(3)).toBeNull()
  })

  it('Request 物件輸入同樣帶當初那把 token 的明確授權', async () => {
    const send = createSnapshotFetch(capturePairing(1), { fetch: window.fetch, win: winOf() })
    await send(new Request('http://localhost:5178/api/dispatch/followup', { method: 'POST' }))
    expect((calls[0].input as Request).headers.get('Authorization')).toBe('Bearer token-A')
  })

  it('token 由 A 換成 B（代次沒動）：整件中止，零請求，錯誤訊息不含 token', async () => {
    const intent = capturePairing(1)
    const send = createSnapshotFetch(intent, { fetch: window.fetch, win: winOf() })

    setRemoteToken('token-B')
    const error = await send('/api/dispatch', { method: 'POST' }).catch((e: unknown) => e)

    expect(isStalePairingError(error)).toBe(true)
    expect((error as StalePairingError).reason).toBe('token_rotated')
    expect((error as Error).message).not.toContain('token-A')
    expect((error as Error).message).not.toContain('token-B')
    expect(calls).toHaveLength(0)
    expect(isPairingIntact(intent, 1)).toBe(false)
  })

  it('token 被清空／從未配對：安全地失敗，零請求', async () => {
    clearRemoteToken()
    const intent = capturePairing(1)
    expect(intent.token).toBe('')

    const send = createSnapshotFetch(intent, { fetch: window.fetch, win: winOf() })
    const error = await send('/api/dispatch/stop', { method: 'POST' }).catch((e: unknown) => e)

    expect(isStalePairingError(error)).toBe(true)
    expect((error as StalePairingError).reason).toBe('missing_token')
    expect(calls).toHaveLength(0)
  })

  it('配對換代（epoch 變了）：整件中止，零請求', async () => {
    const intent = capturePairing(1)
    const send = createSnapshotFetch(intent, {
      fetch: window.fetch,
      win: winOf(),
      isCurrent: () => isPairingIntact(intent, 2),
    })

    const error = await send('/api/dispatch/cancel', { method: 'POST' }).catch((e: unknown) => e)
    expect(isStalePairingError(error)).toBe(true)
    expect((error as StalePairingError).reason).toBe('pairing_changed')
    expect(calls).toHaveLength(0)
  })

  it('送出當下才被換掉時仍用當初那把 A 授權：永遠不會拿 B 去送舊工單', async () => {
    // 真實儲存已經是 B（別的分頁換了配對），本頁讀到的還是舊快取 A —— 沒有跨分頁原子性可言，
    // 但被保證的是：這件工單只會帶 A 出去。
    memoryStorage[TOKEN_STORAGE_KEY] = 'token-B'
    const intent: PairingSnapshot = { token: 'token-A', epoch: 1 }
    const send = createSnapshotFetch(intent, {
      fetch: window.fetch,
      win: winOf(),
      readToken: () => 'token-A',
    })

    await send('/api/dispatch', { method: 'POST', body: '{}' })

    expect(authOf(0)).toBe('Bearer token-A')
    expect(authOf(0)).not.toContain('token-B')
    expect(getRemoteToken()).toBe('token-B')
  })

  it('疊在攔截器上：明確授權不被較新的 token 覆蓋，且舊配對的延遲 401 不解除新配對', async () => {
    let finish: ((response: Response) => void) | undefined
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return new Promise<Response>((resolve) => { finish = resolve })
    }) as typeof fetch
    installRemoteFetch(window)

    const send = createSnapshotFetch({ token: 'token-A', epoch: 1 }, {
      fetch: window.fetch,
      win: winOf(),
      readToken: () => 'token-A',
    })
    const pending = send('/api/dispatch/stop', { method: 'POST', body: '{}' })

    setRemoteToken('token-B') // 舊請求還在飛的時候完成了新配對
    finish?.(new Response('{}', { status: 401 }))
    await pending

    expect(authOf(0)).toBe('Bearer token-A')
    expect(window.dispatchEvent).not.toHaveBeenCalled()
    expect(getRemoteToken()).toBe('token-B')

    uninstallRemoteFetch(window)
  })

  it('isPairingIntact：token、代次、有無憑證三者都要成立', () => {
    const intent: PairingSnapshot = { token: 'token-A', epoch: 2 }
    expect(isPairingIntact(intent, 2, () => 'token-A')).toBe(true)
    expect(isPairingIntact(intent, 2, () => 'token-B')).toBe(false)
    expect(isPairingIntact(intent, 3, () => 'token-A')).toBe(false)
    expect(isPairingIntact(intent, 2, () => '')).toBe(false)
    expect(isPairingIntact({ token: '', epoch: 2 }, 2, () => '')).toBe(false)
    expect(isPairingIntact(null, 2, () => 'token-A')).toBe(false)
  })
})
