// 「📱 手機遙控」面板：token 不能在畫面上露出來、開關兩種狀態的按鈕要對。
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import RemotePanel, { type RemoteStatus } from './RemotePanel'
import { maskUrl } from '@/lib/maskToken'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'
const on: RemoteStatus = {
  ok: true, enabled: true, bind: '100.64.0.9', port: 5178,
  url: `http://100.64.0.9:5178/m/#t=${TOKEN}`, tokenTail: '2345', tailscale: true,
}
const off: RemoteStatus = { ok: true, enabled: false, bind: '', port: 5178, url: '', tokenTail: '', tailscale: false }

function render(status: RemoteStatus): string {
  return renderToStaticMarkup(createElement(RemotePanel, { initialStatus: status }))
}

describe('maskUrl', () => {
  it('只留 token 末四碼', () => {
    const m = maskUrl(on.url)
    expect(m).not.toContain(TOKEN)
    expect(m.endsWith('2345')).toBe(true)
    expect(m).toContain('http://100.64.0.9:5178/m/#t=')
  })
  it('沒有 token 的網址原樣回', () => {
    expect(maskUrl('http://x/m/')).toBe('http://x/m/')
  })
})

describe('RemotePanel', () => {
  it('收著的時候只顯示標題與狀態，不畫網址', () => {
    // localStorage 在 SSR 環境不存在 → 預設收著
    const html = render(on)
    expect(html).toContain('📱 手機遙控')
    expect(html).toContain('遙控開著')
    expect(html).not.toContain(TOKEN)
    expect(html).not.toContain('#t=')
  })

  it('完整 token 永遠不在畫面上', () => {
    // 展開的內容也走 maskUrl；這裡直接驗證遮罩函式與靜態輸出都不含 token
    expect(render(on)).not.toContain(TOKEN)
    expect(maskUrl(on.url)).not.toContain(TOKEN)
  })

  it('關著的狀態標示遙控關著', () => {
    const html = render(off)
    expect(html).toContain('遙控關著')
    expect(html).not.toContain('遙控開著')
  })
})
