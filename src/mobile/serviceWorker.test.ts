/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

type WorkerEvent = {
  request?: { url: string; method: string; mode: string }
  respondWith?: (response: Promise<Response>) => void
  waitUntil?: (work: Promise<unknown>) => void
}

function worker() {
  const handlers: Record<string, (event: WorkerEvent) => void> = {}
  const entries = new Map<string, Response>([['/m/', new Response('old shell')]])
  const cache = {
    match: vi.fn(async (key: string) => entries.get(key)?.clone()),
    put: vi.fn(async (key: string, response: Response) => { entries.set(key, response) }),
  }
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ['other-app-cache', 'ac-remote-v1', 'ac-remote-v2']),
    delete: vi.fn(async () => true),
  }
  const fetch = vi.fn(async () => new Response('new shell'))
  runInNewContext(readFileSync('public/m/sw.js', 'utf8'), {
    self: {
      location: { origin: 'http://localhost:5185' },
      addEventListener: (name: string, handler: (event: WorkerEvent) => void) => { handlers[name] = handler },
      clients: { claim: async () => undefined },
    }, caches, fetch, URL, Response,
  })
  return { handlers, cache, caches, fetch }
}

describe('手機 Service Worker 版本更新與範圍', () => {
  it('線上導航取得新版 HTML，離線才回到最近成功的應用殼', async () => {
    const { handlers, cache, fetch } = worker()
    let pending: Promise<Response> | undefined
    const event = {
      request: { url: 'http://localhost:5185/m/', method: 'GET', mode: 'navigate' },
      respondWith: (value: Promise<Response>) => { pending = value },
    }
    handlers.fetch(event)
    expect(await (await pending)?.text()).toBe('new shell')
    expect(cache.put).toHaveBeenCalledTimes(1)
    fetch.mockRejectedValueOnce(new Error('offline'))
    handlers.fetch(event)
    expect(await (await pending)?.text()).toBe('new shell')
  })

  it('只清除自己的過期快取，不刪同來源其他應用的資料', async () => {
    const { handlers, caches } = worker()
    let pending: Promise<unknown> | undefined
    handlers.activate({ waitUntil: (value) => { pending = value } })
    await pending
    expect(caches.delete).toHaveBeenCalledExactlyOnceWith('ac-remote-v1')
  })

  it('快取寫入失敗時仍回傳成功取得的新版頁面', async () => {
    const { handlers, cache } = worker()
    cache.put.mockRejectedValueOnce(new Error('quota exceeded'))
    let pending: Promise<Response> | undefined
    handlers.fetch({
      request: { url: 'http://localhost:5185/m/', method: 'GET', mode: 'navigate' },
      respondWith: (value) => { pending = value },
    })
    expect(await (await pending)?.text()).toBe('new shell')
  })

  it('API、非 GET 與跨來源資源完全不進快取處理', () => {
    const { handlers, caches } = worker()
    const respondWith = vi.fn()
    for (const request of [
      { url: 'http://localhost:5185/api/dispatches', method: 'GET', mode: 'cors' },
      { url: 'http://localhost:5185/m/', method: 'POST', mode: 'cors' },
      { url: 'https://example.com/assets/file.js', method: 'GET', mode: 'cors' },
    ]) handlers.fetch({ request, respondWith })
    expect(respondWith).not.toHaveBeenCalled()
    expect(caches.open).not.toHaveBeenCalled()
  })
})
