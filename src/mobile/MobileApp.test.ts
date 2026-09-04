import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MobileApp, { type ConsoleDispatch, type DispatchTool } from './MobileApp'

// 模擬派工契約資料
const mockDispatches: ConsoleDispatch[] = [
  {
    id: 'disp-stopped',
    tool: 'claude',
    task: '修正前端樣式與色彩對齊語意色票',
    started: '20260904-093000',
    log: '',
    mode: 'headless',
    state: 'stopped',
    outcome: 'stopped',
    tail: 'Interrupted by user',
  },
  {
    id: 'disp-running',
    tool: 'codex',
    task: '執行背景重構與大型檔案清理作業',
    started: '20260904-094500',
    log: '',
    mode: 'headless',
    state: 'running',
    tail: 'Processing file 42/100...',
  },
  {
    id: 'disp-waiting',
    tool: 'kimi',
    task: '等待終端輸入交互與確認指令',
    started: '20260904-095000',
    log: '',
    mode: 'terminal',
    state: 'waiting',
  },
  {
    id: 'disp-done',
    tool: 'qwen',
    task: '快速修復型別錯誤並產出回歸測試報告',
    started: '20260904-091500',
    log: '',
    mode: 'headless',
    state: 'done',
    outcome: 'ok',
    handedOffTo: 'gemini',
    handoffFrom: 'claude',
  },
]

// 模擬工具清單資料（含可用與限流）
const mockTools: DispatchTool[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    mode: 'headless',
    limited: false,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    mode: 'headless',
    limited: true,
    reason: '09/07 10:30 恢復',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    mode: 'headless',
    limited: true,
    reason: '',
  },
]

describe('MobileApp 配對畫面算繪', () => {
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
    })
  })

  it('沒 token 時渲染配對畫面，包含掃描說明、Token 輸入框與連線按鈕', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: false,
        initialToken: '',
      }),
    )

    // 驗證標題與掃描引導文字
    expect(html).toContain('AI 控制台 遙控')
    expect(html).toContain('用桌面版的「📱 手機遙控」掃 QR 會自動配對')

    // 驗證 Token 輸入框與連線按鈕
    expect(html).toContain('請輸入存取權限 Token')
    expect(html).toContain('連線')
  })
})

describe('MobileApp 主畫面派工清單與動作按鈕', () => {
  it('有清單資料時每列狀態與動作按鈕正確（stopped 列有重派、running 列有停止、waiting 列有取消）', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: true,
        initialToken: 'valid-test-token',
        initialDispatches: mockDispatches,
        initialTools: mockTools,
        initialAuto: 'claude',
      }),
    )

    // 1. stopped 列：必須有「↻ 重派」按鈕與「已停止」標籤
    expect(html).toContain('已停止')
    expect(html).toContain('↻ 重派')

    // 2. running 列：必須有「⏹ 停止」按鈕與「執行中」標籤
    expect(html).toContain('執行中')
    expect(html).toContain('⏹ 停止')

    // 3. waiting 列：必須有「✕ 取消」按鈕與「等你執行」標籤
    expect(html).toContain('等你執行')
    expect(html).toContain('✕ 取消')

    // 4. done 無頭列：具有「💬 補一句」按鈕與「完成」標籤
    expect(html).toContain('完成')
    expect(html).toContain('💬 補一句')

    // 5. 檢驗工作內容前 80 字有正常呈現
    expect(html).toContain('修正前端樣式與色彩對齊語意色票')
    expect(html).toContain('執行背景重構與大型檔案清理作業')
  })

  it('正確呈現 tail 行輸出與自動接力徽章', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: true,
        initialToken: 'valid-test-token',
        initialDispatches: mockDispatches,
        initialTools: mockTools,
      }),
    )

    // tail 輸出
    expect(html).toContain('Interrupted by user')
    expect(html).toContain('Processing file 42/100...')

    // 接力徽章
    expect(html).toContain('↪ 已自動接力給 gemini')
    expect(html).toContain('↩ 從 claude 接力而來')
  })

  it('掛載既有 QuotaStrip 元件', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: true,
        initialToken: 'valid-test-token',
      }),
    )

    // QuotaStrip 的收合標題
    expect(html).toContain('額度與今日用量')
  })
})

describe('MobileApp 快速派工工具選單', () => {
  it('限流工具在下拉是 disabled，且顯示具體 reason 或預設說明', () => {
    const html = renderToStaticMarkup(
      createElement(MobileApp, {
        initialPaired: true,
        initialToken: 'valid-test-token',
        initialTools: mockTools,
        initialAuto: 'claude',
      }),
    )

    // 預設選自動並顯示「自動會挑：claude」
    expect(html).toContain('自動會挑：claude')

    // Codex 是限流工具：選項必須被 disabled 且標示原因
    expect(html).toContain('Codex CLI (限流：09/07 10:30 恢復)')

    // Qwen 無具體 reason：退回通用「額度狀態無法確認」
    expect(html).toContain('Qwen Code (限流：額度狀態無法確認)')

    // Claude 是可用工具，不該被標為限流
    expect(html).toContain('Claude Code')
    expect(html).not.toContain('Claude Code (限流')
  })
})
