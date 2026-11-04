import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkMindMapView from './WorkMindMapView'

afterEach(() => vi.unstubAllGlobals())

describe('independent work map', () => {
  it('renders unavailable sources and an explicit refresh without starting a request', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const html = renderToStaticMarkup(createElement(WorkMindMapView))
    expect(html).toMatch(/更新任務資料|Refresh task data/)
    expect(html).toMatch(/尚未讀取任務資料|Task data has not been read/)
    expect(html).toMatch(/工具資料未取得|tool data unavailable/i)
    expect(html).toMatch(/專案資料未取得|project data unavailable/i)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
