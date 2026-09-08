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
 * 取得後使用 history.replaceState 清除 hash；通過配對驗證才另外保存，
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

/** 驗證受保護的端點；公開 health 只能證明主機在線，不能驗證 token。 */
export async function validateRemoteToken(candidate: string, customFetch = fetch): Promise<void> {
  const response = await customFetch('/api/dispatch/tools', {
    headers: { Authorization: `Bearer ${candidate}` },
  })
  const data = await response.json()
  if (!response.ok || data?.ok !== true || !Array.isArray(data.tools)) {
    throw new Error(typeof data?.error === 'string' ? data.error : '')
  }
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
    let sentToken = ''

    if (isSameOriginApi(input, targetWindow)) {
      const token = getRemoteToken()
      if (typeof Request !== 'undefined' && input instanceof Request) {
        const headers = new Headers(input.headers)
        if (init?.headers) {
          new Headers(init.headers).forEach((value, key) => {
            headers.set(key, value)
          })
        }
        if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
        sentToken = (headers.get('Authorization') || '').replace(/^Bearer /, '')
        finalInput = new Request(input, { ...init, headers })
        finalInit = undefined
      } else {
        const headers = new Headers(init?.headers)
        if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
        sentToken = (headers.get('Authorization') || '').replace(/^Bearer /, '')
        finalInit = { ...init, headers }
      }
    }

    const response = await originalFetch(finalInput, finalInit)

    // 舊請求晚回 401 不應解除剛以新 token 完成的配對。
    if (response.status === 401 && sentToken && sentToken === getRemoteToken()) {
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

// ─────────────────────────────────────────────────────────────
// 工單級配對快照（intent-scoped pairing snapshot）
//
// 為什麼只有「配對代次」不夠：原生 confirm() 會同步卡住 JS，這段期間別的分頁或
// 新的配對連結可以把 localStorage 裡的 token 由 A 換成 B，而代次一動也沒動。
// 若送出時讓攔截器「當下重讀」token，就會拿新配對的 B，去送使用者在 A 那份配對下
// 才同意的那一件舊工單。
//
// 作法是兩層，缺一不可：
//   1) 工單一開始就把 token 與代次一起釘住，之後每個非同步邊界（含 confirm 之後、
//      POST 之前）都重驗一次，不一致就整件中止。
//   2) 傳輸層一律帶「當初那把 token」的明確 Authorization，永遠不重讀較新的 token。
//
// localStorage 沒有跨分頁的原子性保證，這裡也不宣稱做得到：就算本頁讀到的是過期
// 的快取值，被保證的仍然是「絕不用 B 去送 A 的工單」——第 (2) 層獨力守住這條線。
// ─────────────────────────────────────────────────────────────

/** 中止原因；只記錄原因代碼，絕不記錄或回傳任何 token 內容。 */
export type StalePairingReason = 'missing_token' | 'pairing_changed' | 'token_rotated' | 'no_transport'

export interface StalePairingError extends Error {
  readonly acStalePairing: true
  readonly reason: StalePairingReason
}

/** 配對已經不是當初那一份：這是「中止」，不是「派工失敗」。 */
export function stalePairingError(reason: StalePairingReason = 'pairing_changed'): StalePairingError {
  const error = new Error(`stale_pairing:${reason}`) as Error & { acStalePairing: true; reason: StalePairingReason }
  error.name = 'StalePairingError'
  error.acStalePairing = true
  error.reason = reason
  return error
}

export function isStalePairingError(value: unknown): value is StalePairingError {
  return !!value && typeof value === 'object'
    && (value as { acStalePairing?: unknown }).acStalePairing === true
}

export interface PairingSnapshot {
  /** 這件工單當初綁定的 token：只在傳輸層當作 Authorization 用，不進畫面、訊息或日誌 */
  readonly token: string
  /** 這件工單當初的配對代次 */
  readonly epoch: number
}

/** 工單起手式：把「現在這把 token」與「現在這一代配對」一起釘住。 */
export function capturePairing(epoch: number, readToken: () => string = getRemoteToken): PairingSnapshot {
  return { token: readToken() || '', epoch }
}

/**
 * 這件工單綁的配對還在嗎？三個條件都要成立：
 * 有 token（空的／被清掉一律安全地失敗）、代次沒換、而且 token 還是同一把。
 */
export function isPairingIntact(
  snapshot: PairingSnapshot | null | undefined,
  currentEpoch: number,
  readToken: () => string = getRemoteToken,
): boolean {
  if (!snapshot || !snapshot.token) return false
  if (snapshot.epoch !== currentEpoch) return false
  return (readToken() || '') === snapshot.token
}

export interface SnapshotFetchOptions {
  /** 底層傳輸（預設用全域 fetch，也就是已安裝的攔截器） */
  fetch?: typeof fetch
  /** 同源判定所依據的 window（測試可注入） */
  win?: typeof window
  /** 送出前的外部存活判定（掛載中、同一代配對…） */
  isCurrent?: () => boolean
  /** 讀取目前 token 的方式（測試可注入，用來模擬送出當下才換 token） */
  readToken?: () => string
}

/**
 * 產生「只屬於這一件工單」的 fetch：
 * - 送出前再驗一次快照（token 空掉、代次換了、token 被換掉都直接中止，不送）。
 * - 同源 /api/ 請求一律帶當初那把 token 的明確 Authorization；因為標頭已經明確設定，
 *   外層 installRemoteFetch 不會（也不該）拿較新的 token 覆蓋它。
 * - 跨域與靜態資源原樣放行，絕不附上這件工單的憑證。
 */
export function createSnapshotFetch(
  snapshot: PairingSnapshot,
  options: SnapshotFetchOptions = {},
): typeof fetch {
  const readToken = options.readToken ?? getRemoteToken
  const fallbackWin = { location: { origin: 'http://localhost' } } as unknown as typeof window
  const win = options.win ?? (typeof window !== 'undefined' ? window : fallbackWin)

  const snapshotFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const send = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined)
    if (typeof send !== 'function') throw stalePairingError('no_transport')

    // 送出前的最後一道閘（每一次請求都走這裡，含 confirm 之後那一次）
    if (!snapshot || !snapshot.token) throw stalePairingError('missing_token')
    if (options.isCurrent && !options.isCurrent()) throw stalePairingError('pairing_changed')
    if ((readToken() || '') !== snapshot.token) throw stalePairingError('token_rotated')

    if (!isSameOriginApi(input, win)) {
      return send(input, init)
    }

    if (typeof Request !== 'undefined' && input instanceof Request) {
      const headers = new Headers(input.headers)
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => {
          headers.set(key, value)
        })
      }
      // 明確用「當初那把」：不重讀 localStorage，race 也拿不到較新的 token
      headers.set('Authorization', `Bearer ${snapshot.token}`)
      return send(new Request(input, { ...init, headers }))
    }

    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${snapshot.token}`)
    return send(input, { ...init, headers })
  }

  return snapshotFetch as unknown as typeof fetch
}
