import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// 來源契約：量測與動效沒有純函式介面（這裡沒有 DOM 測試環境），用原始碼比對釘住它們。
import mapSource from './WorkMindMap.tsx?raw'
import WorkMindMap from './WorkMindMap'
import type { DispatchRecord, HubProject, ToolStatus } from '@/types/data'

const record = (values: Partial<DispatchRecord> = {}): DispatchRecord => ({
  id: 'task-1', tool: 'codex', task: 'work', started: '', log: '', mode: 'headless', ...values,
})
const tool = (values: Partial<ToolStatus> = {}): ToolStatus => ({
  label: 'Codex', status: 'active', last_active: '', rate_limited: false, role: '', ...values,
})
const project = (values: Partial<HubProject> = {}): HubProject => ({
  project_id: 'hub', title: 'Hub project', status: 'waiting', updated_at: '2026-01-01T00:00:00Z',
  updated_by: 'codex', next_step: 'Review', needs_handoff: true, ...values,
})
const render = (props: Partial<Parameters<typeof WorkMindMap>[0]> = {}) => renderToStaticMarkup(createElement(WorkMindMap, {
  tools: { codex: tool() },
  projects: [project()],
  dispatches: [],
  dispatchReadState: 'ready',
  dispatchLastSuccess: '2026-01-01T00:00:00Z',
  onRefresh: () => {},
  ...props,
}))

describe('心智圖畫面', () => {
  it('節點掛上穩定的 data-wm-node／側邊／狀態，供量測與連線使用', () => {
    const html = render({ dispatches: [record({ state: 'running' })] })
    expect(html).toContain('data-wm-node="tool:id:codex"')
    expect(html).toContain('data-wm-side="left"')
    expect(html).toContain('data-wm-state="running"')
    expect(html).toContain('data-wm-node="project:id:hub"')
    expect(html).toContain('data-wm-side="right"')
    expect(html).toContain('data-wm-hub="hub"')
  })

  it('工具可用但沒有派工時，分支與恐龍都不是執行中', () => {
    const html = render({ tools: { codex: tool({ status: 'active' }) }, dispatches: [] })
    expect(html).toContain('data-wm-state="idle"')
    expect(html).not.toContain('data-wm-state="running"')
    expect(html).not.toContain('wm-node--running')
    expect(html).not.toContain('wm-dragon--running')
    // 工具活動仍然看得到，只是放在 title 裡，且標明是來源資料。
    expect(html).toMatch(/工具活動（來源）：活躍/)
  })

  it('未確認的派工算成未確認，不混進執行中或等待中', () => {
    const html = render({ dispatches: [record({ id: 'ghost', state: 'unknown' }), record({ id: 'live', state: 'running' })] })
    expect(html).toMatch(/執行中 1/)
    expect(html).toMatch(/未確認 1/)
    expect(html).not.toMatch(/等待中 1/)
    expect(html).toMatch(/其中 1 件狀態未確認/)
  })

  it('取消待確認的那筆不顯示執行中分支，SSR 動效仍暫停', () => {
    const html = render({ dispatches: [record({ state: 'running', cancelOrderPending: true })] })
    expect(html).toContain('data-paused="true"')
    expect(html).toContain('data-wm-state="unknown"')
    expect(html).not.toContain('data-wm-state="running"')
    expect(html).toMatch(/部分取消結果待確認/)
  })

  it('SSR 與讀取失敗時暫停；未知紀錄不升成執行中', () => {
    expect(render({ dispatches: [record({ state: 'unknown' })] })).toContain('data-paused="true"')
    expect(render({ dispatchReadState: 'error', dispatches: [record({ state: 'running' })] })).toContain('data-paused="true"')
    // 只有在畫面可見時才播放，伺服器端輸出一律是暫停的。
    expect(render({ dispatches: [record({ state: 'running' })] })).toContain('data-paused="true"')
  })

  it('上次資料仍然標示為上次資料，未確認任務留在清單裡', () => {
    const html = render({ dispatchReadState: 'error', dispatchLastSuccess: '2026-01-01T00:00:00Z', dispatches: [record({ state: 'waiting' })] })
    expect(html).toMatch(/無法更新派工；以下顯示上次資料|showing the last snapshot/)
    expect(html).toMatch(/（上次資料）/)
  })

  it('提供搜尋、整圖檢視、縮放與清除選取，而且不新增請求按鈕', () => {
    const html = render()
    expect(html).toMatch(/搜尋節點|Search nodes/)
    expect(html).toMatch(/整圖檢視|Fit map/)
    expect(html).toMatch(/清除選取|Clear selection/)
    expect(html).toContain('100%')
    expect(mapSource).not.toMatch(/method:\s*'POST'/)
    expect(mapSource).not.toContain('fetch(')
    expect(mapSource).not.toContain('setInterval')
  })

  it('量測只用一支合併的 requestAnimationFrame，沒有常駐迴圈或計時器', () => {
    expect(mapSource).toContain('if (frame.current !== null) return')
    expect(mapSource).toContain('frame.current = requestAnimationFrame(')
    expect(mapSource).toContain('cancelAnimationFrame(frame.current)')
    expect(mapSource).toContain('new ResizeObserver(() => schedule())')
    expect(mapSource).toContain('observer.disconnect()')
    expect(mapSource).toContain('new IntersectionObserver(')
    expect(mapSource.match(/requestAnimationFrame\(/g)).toHaveLength(1)
  })

  it('大量輸入仍然分頁，不會一次展開一千個節點', () => {
    const many = Array.from({ length: 1000 }, (_, index) => project({ project_id: `p${index}`, title: `Project ${index}` }))
    const html = render({ projects: many })
    expect(html.match(/data-wm-node="project:id:p\d+"/g)).toHaveLength(8)
    expect(html).toMatch(/顯示更多專案|Show more projects/)
    expect(html).toContain('（992）')
  })
})
