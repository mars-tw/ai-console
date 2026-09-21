import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import DevSpaceConsole from './DevSpaceConsole'
import { EN } from '@/i18n/en'

describe('official ChatGPT conversation entry', () => {
  it('prepares local instructions and keeps copying disabled until a configured project is known', () => {
    const html = renderToStaticMarkup(createElement(DevSpaceConsole))
    expect(html).toContain('DevSpace 對話入口')
    expect(html).toContain('開啟 ChatGPT 對話')
    expect(html).toContain('id="devspace-project"')
    expect(html).toContain('id="devspace-instructions"')
    expect(html).toContain('id="devspace-model"')
    expect(html).toContain('GPT-5.6 SOL')
    expect(html).toContain('GPT-6 ASTRA')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>複製對話指示/)
    expect(html).not.toContain('送出工作')
    expect(html).not.toContain('送出訊息')
    expect(html).not.toContain('MCP 已連線')
  })

  it('has English translations for its labels, notices and copied instructions', () => {
    const source = readFileSync(new URL('./DevSpaceConsole.tsx', import.meta.url), 'utf8')
    const labels = [...source.matchAll(/(?:\bt|setNotice|setError)\('([^']+)'\)/g)].map(match => match[1]).filter(Boolean)
    expect(labels.length).toBeGreaterThan(20)
    for (const label of labels) expect(EN[label], label).toBeTruthy()
  })
})
