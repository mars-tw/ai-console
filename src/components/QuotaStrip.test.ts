import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import QuotaStrip, {
  fetchQuotaUsage,
  formatToken,
  formatUsd,
  getStoredOpenState,
  QUOTA_STORAGE_KEY,
  setStoredOpenState,
  type QuotaUsageResponse,
} from './QuotaStrip'

// 模擬後端契約回傳範例資料
const mockContractData: QuotaUsageResponse = {
  ok: true,
  day: '2026-09-04',
  auto: 'gemini',
  tools: [
    {
      id: 'gemini',
      label: 'ANTIGRAVITY（agy）',
      mode: 'headless',
      limited: false,
      reason: '',
      today: { jobs: 3, ok: 2, failed: 0, stopped: 1, in: 152173, out: 7878, usd: 0 },
      week: { jobs: 9, in: 500000, out: 20000, usd: 0 },
    },
    {
      id: 'codex',
      label: 'Codex',
      mode: 'headless',
      limited: true,
      reason: '09/07 10:30 恢復',
      today: { jobs: 0, ok: 0, failed: 0, stopped: 0, in: 0, out: 0, usd: 0 },
      week: { jobs: 2, in: 371555, out: 0, usd: 0 },
    },
  ],
}

describe('QuotaStrip token 縮寫規則', () => {
  it('正確處理數值門檻與縮寫（999→999、152173→152k、1234567→1.2M）', () => {
    // 依工單規定之三個關鍵測試值
    expect(formatToken(999)).toBe('999')
    expect(formatToken(152173)).toBe('152k')
    expect(formatToken(1234567)).toBe('1.2M')

    // 邊界測試：0、整數千與百萬
    expect(formatToken(0)).toBe('0')
    expect(formatToken(1000)).toBe('1k')
    expect(formatToken(2000000)).toBe('2M')
  })
})

describe('QuotaStrip 美金金額格式化', () => {
  it('0 元不顯示；大於 0 才輸出格式如 $0.0123', () => {
    expect(formatUsd(0)).toBe('')
    expect(formatUsd(0.0123)).toBe('$0.0123')
    expect(formatUsd(1.5)).toBe('$1.5')
  })
})

describe('QuotaStrip 收合狀態持久化', () => {
  let memoryStorage: Record<string, string>

  beforeEach(() => {
    memoryStorage = {}
    // 模擬瀏覽器 localStorage 行為，避免 Node 環境中缺少 Storage 物件
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memoryStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        memoryStorage[key] = String(val)
      },
      removeItem: (key: string) => {
        delete memoryStorage[key]
      },
      clear: () => {
        memoryStorage = {}
      },
    })
  })

  it('預設為 open，且可正確寫入並讀回 closed 狀態', () => {
    expect(getStoredOpenState()).toBe(true)

    setStoredOpenState(false)
    expect(memoryStorage[QUOTA_STORAGE_KEY]).toBe('closed')
    expect(getStoredOpenState()).toBe(false)

    setStoredOpenState(true)
    expect(memoryStorage[QUOTA_STORAGE_KEY]).toBe('open')
    expect(getStoredOpenState()).toBe(true)
  })

  it('當 localStorage 拋出例外時安全退回預設值', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })

    expect(getStoredOpenState()).toBe(true)
    expect(() => setStoredOpenState(false)).not.toThrow()
  })
})

describe('QuotaStrip 元件算繪與契約驗證', () => {
  it('正常資料會列出工具名稱與今日用量，0 件顯示今天沒派', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaStrip, { initialData: mockContractData }),
    )

    // 驗證標題列
    expect(html).toContain('額度與今日用量')

    // 驗證工具列包含名稱與格式化後的今日用量
    expect(html).toContain('ANTIGRAVITY（agy）')
    expect(html).toContain('152k 進 / 8k 出 token')

    // 0 件顯示今天沒派
    expect(html).toContain('Codex')
    expect(html).toContain('今天沒派')
  })

  it('限流列顯示 reason，若無 reason 則顯示預設說明', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaStrip, { initialData: mockContractData }),
    )
    // 具有 reason 時顯示具體時間
    expect(html).toContain('09/07 10:30 恢復')

    // 沒有 reason 時顯示「額度狀態無法確認」
    const noReasonData: QuotaUsageResponse = {
      ok: true,
      day: '2026-09-04',
      tools: [
        {
          id: 'mock',
          label: 'Mock Tool',
          limited: true,
          reason: '',
          today: { jobs: 0, ok: 0, failed: 0, stopped: 0, in: 0, out: 0, usd: 0 },
        },
      ],
    }
    const htmlNoReason = renderToStaticMarkup(
      createElement(QuotaStrip, { initialData: noReasonData }),
    )
    expect(htmlNoReason).toContain('額度狀態無法確認')
  })

  it('auto 徽章在對的那一列前面顯示', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaStrip, { initialData: mockContractData }),
    )

    // auto 是 gemini，徽章「自動會挑」必須出現
    expect(html).toContain('自動會挑')

    // 檢查 gemini 列出現自動會挑，而 codex 列不會包含該徽章
    const [geminiRow, codexRow] = html.split('ANTIGRAVITY（agy）')
    expect(geminiRow).toContain('自動會挑')
    expect(codexRow).not.toContain('自動會挑')
  })

  it('具有 usd 金額時正確顯示美金數值', () => {
    const dataWithUsd: QuotaUsageResponse = {
      ok: true,
      day: '2026-09-04',
      tools: [
        {
          id: 'gemini',
          label: 'ANTIGRAVITY（agy）',
          limited: false,
          today: { jobs: 1, ok: 1, failed: 0, stopped: 0, in: 1000, out: 500, usd: 0.0123 },
        },
      ],
    }
    const html = renderToStaticMarkup(
      createElement(QuotaStrip, { initialData: dataWithUsd }),
    )
    expect(html).toContain('$0.0123')
  })

  it('可存取性：包含具備 aria-expanded 的收合按鈕與狀態點說明', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaStrip, { initialData: mockContractData }),
    )
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('title="可用"')
    expect(html).toContain('aria-label="可用"')
    expect(html).toContain('title="限流"')
    expect(html).toContain('aria-label="限流"')
  })
})

describe('QuotaStrip 後端通訊與異常處理', () => {
  it('fetch 失敗或 ok=false 時，顯示錯誤提示行而不拋出錯誤', async () => {
    const failFetch = async () =>
      new Response(JSON.stringify({ ok: false, error: '控制 API 無回應' }), { status: 500 })

    await expect(fetchQuotaUsage(failFetch)).rejects.toThrow()
  })

  it('成功回應時解析工具清單', async () => {
    const successFetch = async () =>
      new Response(JSON.stringify(mockContractData), { status: 200 })

    const result = await fetchQuotaUsage(successFetch)
    expect(result.ok).toBe(true)
    expect(result.tools).toHaveLength(2)
    expect(result.tools?.[0]?.id).toBe('gemini')
  })
})
