import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearRemoteToken,
  getRemoteToken,
  installRemoteFetch,
  isSameOriginApi,
  setRemoteToken,
  tokenFromHash,
  TOKEN_STORAGE_KEY,
  uninstallRemoteFetch,
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

  it('從 hash 取出 token 並存入 localStorage，同時呼叫 replaceState 清除 hash', () => {
    const extracted = tokenFromHash()
    expect(extracted).toBe('token-from-url')
    expect(getRemoteToken()).toBe('token-from-url')
    expect(replacedUrl).toBe('/m/')
  })

  it('支援多參數 hash 格式（#t=foo&other=bar）', () => {
    window.location.hash = '#t=complex-token-456&mode=debug'
    const extracted = tokenFromHash()
    expect(extracted).toBe('complex-token-456')
    expect(getRemoteToken()).toBe('complex-token-456')
  })

  it('當 hash 無 token 時回傳 null 且不覆蓋既有 token', () => {
    setRemoteToken('keep-existing')
    window.location.hash = '#view=dispatches'
    const extracted = tokenFromHash()
    expect(extracted).toBeNull()
    expect(getRemoteToken()).toBe('keep-existing')
    expect(replacedUrl).toBeNull()
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
