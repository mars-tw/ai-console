// 手機遙控最小化 Service Worker
// 僅快取 /m/ 應用殼與 /assets/ 靜態資源，所有 /api/ 控制端點一律走網路不予快取。

const CACHE_PREFIX = 'ac-remote-'
const CACHE_NAME = `${CACHE_PREFIX}v2`
const SHELL_ASSETS = [
  '/m/',
  '/m/manifest.webmanifest',
  '/m/icon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(SHELL_ASSETS).catch(() => {
        // 部分靜態檔若暫不可用不中斷安裝
      })
    }).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    }).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return

  // /api/ 路徑一律走網路不快取，避免派工狀態與認證產生快取陳舊
  if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
    return
  }

  // HTML 必須優先取新版，否則固定快取會永久指向舊版的 hashed assets。
  if (event.request.mode === 'navigate' && (url.pathname === '/m' || url.pathname.startsWith('/m/'))) {
    event.respondWith((async () => {
      const cachedShell = async () => {
        try {
          return await (await caches.open(CACHE_NAME)).match('/m/')
        } catch {
          return undefined
        }
      }
      try {
        const response = await fetch(event.request)
        if (response.ok) {
          try {
            await (await caches.open(CACHE_NAME)).put('/m/', response.clone())
          } catch { /* 快取不可寫時仍顯示最新頁面 */ }
          return response
        }
        return (await cachedShell()) || response
      } catch {
        return (await cachedShell()) || Response.error()
      }
    })())
    return
  }

  // 僅快取 /m/ 應用殼與 /assets/ 靜態資源
  if (url.pathname.startsWith('/m/') || url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => cache.match(event.request)).catch(() => undefined).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse
        }
        return fetch(event.request).then(async (networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse
          }
          const responseToCache = networkResponse.clone()
          try {
            const cache = await caches.open(CACHE_NAME)
            await cache.put(event.request, responseToCache)
          } catch { /* 靜態資源快取失敗不阻止線上使用 */ }
          return networkResponse
        }).catch(() => {
          return Response.error()
        })
      })
    )
  }
})
