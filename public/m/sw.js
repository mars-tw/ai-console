// 手機遙控最小化 Service Worker
// 僅快取 /m/ 應用殼與 /assets/ 靜態資源，所有 /api/ 控制端點一律走網路不予快取。

const CACHE_NAME = 'ac-remote-v1'
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
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    }).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // /api/ 路徑一律走網路不快取，避免派工狀態與認證產生快取陳舊
  if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
    return
  }

  // 僅快取 /m/ 應用殼與 /assets/ 靜態資源
  if (url.pathname.startsWith('/m/') || url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse
        }
        return fetch(event.request).then((networkResponse) => {
          if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
            return networkResponse
          }
          const responseToCache = networkResponse.clone()
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache)
          })
          return networkResponse
        }).catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('/m/')
          }
        })
      })
    )
  }
})
