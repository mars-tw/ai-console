// 手機遙控 API 與 Token 管理模組
// 負責在 Tailscale 網路環境下，安全存取遙控伺服器所需的 Bearer Token，
// 並攔截同源的 /api/ 請求自動注入 Authorization 標頭，使既有桌面端元件毋須改動即可復用。

export const TOKEN_STORAGE_KEY = 'ac_remote_token'

/**
 * 從 localStorage 讀取遙控 token。
 * 必須使用 try/catch 包覆，避免受限的無痕瀏覽或私密模式下存取例外導致畫面崩潰。
 */
export function getRemoteToken(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(TOKEN_STORAGE_KEY) || ''
    }
  } catch {
    // 忽略私密模式或安全性限制造成的儲存例外
  }
  return ''
}

/**
 * 將遙控 token 寫入 localStorage。
 * 遵循契約於讀寫時皆進行例外防護。
 */
export function setRemoteToken(token: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TOKEN_STORAGE_KEY, token)
    }
  } catch {
    // 忽略儲存空間超限或被禁用的例外
  }
}

/**
 * 清除已保存的遙控 token。
 */
export function clearRemoteToken(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    }
  } catch {
    // 忽略清除時的例外
  }
}

/**
 * 從網址的 location.hash 解析 token（格式如 #t=<token>），
 * 成功取得後存入 localStorage 並使用 history.replaceState 清除 hash，
 * 避免使用者在手機上重新整理或分享網址時洩漏憑證。
 */
export function tokenFromHash(): string | null {
  try {
    if (typeof window === 'undefined' || !window.location) {
      return null
    }

    const hash = window.location.hash || ''
    if (!hash) {
      return null
    }

    const raw = hash.startsWith('#') ? hash.slice(1) : hash
    const params = new URLSearchParams(raw)
    const token = params.get('t')

    if (token) {
      setRemoteToken(token)
      if (window.history && typeof window.history.replaceState === 'function') {
        const cleanUrl = (window.location.pathname || '') + (window.location.search || '')
        window.history.replaceState(null, '', cleanUrl || '/')
      }
      return token
    }
  } catch {
    // 忽略網址解析異常
  }
  return null
}

/**
 * 判斷目標請求是否為「同源」且「路徑以 /api/ 開頭或剛好為 /api」。
 * 嚴格比對同源，避免將敏感的 Bearer Token 傳遞至外部第三方網站。
 */
export function isSameOriginApi(input: RequestInfo | URL, win: typeof window = window): boolean {
  try {
    const origin = (win && win.location && win.location.origin) || 'http://localhost'
    let urlStr = ''

    if (typeof input === 'string') {
      urlStr = input
    } else if (input instanceof URL) {
      urlStr = input.href
    } else if (typeof Request !== 'undefined' && input instanceof Request) {
      urlStr = input.url
    }

    const resolved = new URL(urlStr, origin)
    const currentOrigin = (win && win.location && win.location.origin) || origin

    if (resolved.origin !== currentOrigin) {
      return false
    }

    return resolved.pathname.startsWith('/api/') || resolved.pathname === '/api'
  } catch {
    return false
  }
}

const ORIGINAL_FETCH_SYM = '__ac_remote_original_fetch'

/**
 * 包裝 window.fetch，僅對同源且以 /api/ 開頭的請求自動帶上 Authorization: Bearer <token>。
 * 其他靜態資源（如 /m/、/assets/）或跨域請求原樣放行。
 * 若遇伺服器回傳 401 狀態，發送自訂事件以便畫面即時切換至配對狀態。
 */
export function installRemoteFetch(targetWindow: typeof window = typeof window !== 'undefined' ? window : ({} as typeof window)): void {
  if (!targetWindow || typeof targetWindow.fetch !== 'function') {
    return
  }

  const win = targetWindow as unknown as Record<string, unknown>
  if (win[ORIGINAL_FETCH_SYM]) {
    // 已經安裝過，避免重複包裝
    return
  }

  const originalFetch = targetWindow.fetch.bind(targetWindow)
  win[ORIGINAL_FETCH_SYM] = originalFetch

  targetWindow.fetch = async function remoteFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let finalInput = input
    let finalInit = init

    if (isSameOriginApi(input, targetWindow)) {
      const token = getRemoteToken()
      if (token) {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          const headers = new Headers(input.headers)
          if (init?.headers) {
            new Headers(init.headers).forEach((value, key) => {
              headers.set(key, value)
            })
          }
          headers.set('Authorization', `Bearer ${token}`)
          finalInput = new Request(input, { ...init, headers })
          finalInit = undefined
        } else {
          const headers = new Headers(init?.headers)
          headers.set('Authorization', `Bearer ${token}`)
          finalInit = { ...init, headers }
        }
      }
    }

    const response = await originalFetch(finalInput, finalInit)

    if (response.status === 401 && isSameOriginApi(input, targetWindow)) {
      if (typeof targetWindow.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
        targetWindow.dispatchEvent(new CustomEvent('ac_remote_unauthorized', { detail: { status: 401 } }))
      }
    }

    return response
  }
}

/**
 * 還原原始 window.fetch，供測試清理環境使用。
 */
export function uninstallRemoteFetch(targetWindow: typeof window = typeof window !== 'undefined' ? window : ({} as typeof window)): void {
  const win = targetWindow as unknown as Record<string, unknown>
  if (win && win[ORIGINAL_FETCH_SYM]) {
    targetWindow.fetch = win[ORIGINAL_FETCH_SYM] as typeof window.fetch
    delete win[ORIGINAL_FETCH_SYM]
  }
}
