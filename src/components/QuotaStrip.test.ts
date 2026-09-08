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
  type ToolUsagePeriod,
} from './QuotaStrip'

const zero: ToolUsagePeriod = { jobs: 0, ok: 0, failed: 0, stopped: 0, in: 0, out: 0, usd: 0 }

// 模擬後端契約回傳範例資料（含真實的 ready/state/mode 欄位）
const mockContractData: QuotaUsageResponse = {
  ok: true,
  day: '2026-09-04',
  auto: 'gemini',
  tools: [
    {
      id: 'gemini',
      label: 'ANTIGRAVITY（agy）',
      mode: 'headless',
      ready: true,
      limited: false,
      state: 'login_unverified',
      readiness: 'installed_unverified',
      authStatus: 'unknown',
      reason: '',
      today: { jobs: 3, ok: 2, failed: 0, stopped: 1, in: 152173, out: 7878, usd: 0 },
      week: { jobs: 9, in: 500000, out: 20000, usd: 0 },
    },
    {
      id: 'codex',
      label: 'Codex',
      mode: 'headless',
      ready: false,
      limited: true,
      state: 'limited',
      readiness: 'installed_unverified',
      reason: '09/07 10:30 恢復',
      today: { ...zero },
      week: { jobs: 2, in: 371555, out: 0, usd: 0 },
    },
  ],
}

const render = (initialData: QuotaUsageResponse) =>
  renderToStaticMarkup(createElement(QuotaStrip, { initialData }))

// 直接回傳物件的假 fetch，讓 NaN／Infinity 等值不被 JSON 轉換吃掉
const jsonFetch = (payload: unknown) => async () =>
  ({ ok: true, status: 200, json: async () => payload }) as unknown as Response

const usageRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'gemini',
  label: 'Gemini',
  mode: 'headless',
  ready: true,
  limited: false,
  state: 'ready',
  today: { ...zero },
  ...over,
})

describe('QuotaStrip token 縮寫規則', () => {
  it('正確處理數值門檻與縮寫（999→999、152173→152k、1234567→1.2M）', () => {
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
    const html = render(mockContractData)

    expect(html).toContain('額度與今日用量')
    expect(html).toContain('ANTIGRAVITY（agy）')
    expect(html).toContain('152k 進 / 8k 出 token')
    expect(html).toContain('Codex')
    expect(html).toContain('今天沒派')
  })

  it('限流列顯示 reason，若無 reason 則顯示預設說明', () => {
    const html = render(mockContractData)
    expect(html).toContain('額度用完')
    expect(html).toContain('09/07 10:30 恢復')

    const noReasonData: QuotaUsageResponse = {
      ok: true,
      day: '2026-09-04',
      tools: [
        {
          id: 'mock',
          label: 'Mock Tool',
          mode: 'headless',
          ready: false,
          limited: true,
          state: 'limited',
          reason: '',
          today: { ...zero },
        },
      ],
    }
    expect(render(noReasonData)).toContain('額度狀態無法確認')
  })

  it('auto 徽章只在伺服器 auto 真的可派工的那一列出現', () => {
    const html = render(mockContractData)
    expect(html).toContain('自動會挑')

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
          mode: 'headless',
          ready: true,
          limited: false,
          state: 'ready',
          today: { jobs: 1, ok: 1, failed: 0, stopped: 0, in: 1000, out: 500, usd: 0.0123 },
        },
      ],
    }
    expect(render(dataWithUsd)).toContain('$0.0123')
  })

  it('可存取性：收合按鈕具 aria-expanded，狀態點以誠實字樣說明', () => {
    const html = render(mockContractData)
    expect(html).toContain('aria-expanded="true"')
    // 已安裝但登入未驗證的 CLI 只能是中性字樣，不得宣稱可用或已登入
    expect(html).toContain('title="已找到工具，登入待確認"')
    expect(html).toContain('aria-label="已找到工具，登入待確認"')
    expect(html).toContain('title="額度用完"')
    expect(html).not.toContain('bg-emerald')
    expect(html).not.toContain('title="可用"')
  })
})

describe('QuotaStrip 就緒度顯示規則', () => {
  it('沒有本地模型：不顯示 auto 徽章與綠燈，改標示尚未設定', () => {
    const noAi: QuotaUsageResponse = {
      ok: true,
      auto: 'local', // 與實際狀態矛盾的 auto，必須被丟掉
      tools: [
        {
          id: 'local',
          label: '本地模型',
          mode: 'local',
          ready: false,
          limited: false,
          state: 'needs_model',
          reason: '尚未下載模型',
          today: { ...zero },
        },
      ],
    }
    const html = render(noAi)
    expect(html).toContain('本地模型')
    expect(html).toContain('尚未設定')
    expect(html).toContain('尚未下載模型')
    expect(html).not.toContain('自動會挑')
    expect(html).not.toContain('bg-emerald')
  })

  it('本地送出時準備為灰色可嘗試；本地就緒才給綠燈', () => {
    const prepare: QuotaUsageResponse = {
      ok: true,
      tools: [
        {
          id: 'local',
          label: '本地模型',
          mode: 'local',
          ready: true,
          limited: false,
          state: 'needs_start',
          today: { ...zero },
        },
      ],
    }
    const prepareHtml = render(prepare)
    expect(prepareHtml).toContain('送出時準備')
    expect(prepareHtml).toContain('bg-slate-400')
    expect(prepareHtml).not.toContain('bg-emerald')

    // prepare_on_send 只是 readiness 欄位別名，出現在 state 只能標狀態未確認
    const aliasHtml = render({
      ok: true,
      auto: 'local',
      tools: [
        {
          id: 'local',
          label: '本地模型',
          mode: 'local',
          ready: true,
          limited: false,
          state: 'prepare_on_send',
          today: { ...zero },
        },
      ],
    })
    expect(aliasHtml).toContain('狀態未確認')
    expect(aliasHtml).not.toContain('自動會挑')
    expect(aliasHtml).not.toContain('bg-emerald')

    const readyHtml = render({
      ok: true,
      auto: 'local',
      tools: [
        {
          id: 'local',
          label: '本地模型',
          mode: 'local',
          ready: true,
          limited: false,
          state: 'ready',
          today: { ...zero },
        },
      ],
    })
    expect(readyHtml).toContain('bg-emerald')
    expect(readyHtml).toContain('自動會挑')
  })

  it('缺 ready 或旗標型別錯誤的舊列仍可見，但只能標狀態未確認', () => {
    const legacy: QuotaUsageResponse = {
      ok: true,
      auto: 'legacy',
      tools: [
        { id: 'legacy', label: '舊工具', today: { ...zero } },
        {
          id: 'weird',
          label: '怪工具',
          mode: 'headless',
          ready: 'true',
          limited: false,
          state: 'ready',
          today: { ...zero },
        },
      ],
    }
    const html = render(legacy)
    expect(html).toContain('舊工具')
    expect(html).toContain('怪工具')
    expect(html).toContain('狀態未確認')
    expect(html).not.toContain('自動會挑')
    expect(html).not.toContain('bg-emerald')
  })

  it('空清單顯示中性設定提示而非空白', () => {
    expect(render({ ok: true, tools: [] })).toContain('還沒有可用的工具，請先完成安裝或設定')
  })
})

describe('QuotaStrip 後端通訊與異常處理', () => {
  it('fetch 失敗時不讀取回應內容，直接拋錯', async () => {
    const failFetch = async () =>
      ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('不該讀取失敗回應的內容')
        },
      }) as unknown as Response

    await expect(fetchQuotaUsage(failFetch)).rejects.toThrow('HTTP 500')
  })

  it('ok=false 或形狀不合的回應一律拒收', async () => {
    const okFalse = async () =>
      new Response(JSON.stringify({ ok: false, error: '控制 API 無回應' }), { status: 200 })
    await expect(fetchQuotaUsage(okFalse)).rejects.toThrow()

    const badShape = async () =>
      new Response(JSON.stringify({ ok: true, tools: { gemini: {} } }), { status: 200 })
    await expect(fetchQuotaUsage(badShape)).rejects.toThrow()

    const dupIds = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          tools: [
            { id: 'gemini', label: 'A', mode: 'headless', ready: true, limited: false, state: 'ready' },
            { id: 'gemini', label: 'B', mode: 'headless', ready: true, limited: false, state: 'ready' },
          ],
        }),
        { status: 200 },
      )
    await expect(fetchQuotaUsage(dupIds)).rejects.toThrow()
  })

  it('成功回應時保留計量資料，並正規化 auto', async () => {
    const successFetch = async () =>
      new Response(JSON.stringify(mockContractData), { status: 200 })

    const result = await fetchQuotaUsage(successFetch)
    expect(result.ok).toBe(true)
    expect(result.tools).toHaveLength(2)
    expect(result.tools?.[0]?.id).toBe('gemini')
    expect(result.tools?.[0]?.today.in).toBe(152173)
    expect(result.tools?.[0]?.week?.jobs).toBe(9)
    expect(result.auto).toBe('gemini')
  })

  it('原始列的物件型 reason 不會被帶回，結果可安全算繪', async () => {
    const result = await fetchQuotaUsage(jsonFetch({ ok: true, auto: 'gemini', tools: [usageRow({ reason: {} })] }))
    expect(result.tools?.[0]?.reason).toBeUndefined()
    const html = render(result)
    expect(html).toContain('Gemini')
    expect(html).not.toContain('[object Object]')
  })

  it('保留通過驗證的件數、token、成本與本週資料', async () => {
    const today = { jobs: 3, ok: 2, failed: 0, stopped: 1, in: 1000, out: 500, usd: 0.0123 }
    const result = await fetchQuotaUsage(
      jsonFetch({ ok: true, tools: [usageRow({ today, week: { jobs: 9, in: 5, out: 6, usd: 0 } })] }),
    )
    expect(result.tools?.[0]?.today).toEqual(today)
    expect(result.tools?.[0]?.week?.jobs).toBe(9)
  })

  it.each<[string, Record<string, unknown>]>([
    ['today 缺漏', usageRow({ today: undefined })],
    ['today 非物件', usageRow({ today: 3 })],
    ['today 為陣列', usageRow({ today: [] })],
    ['today 少了 usd', usageRow({ today: { jobs: 0, in: 0, out: 0 } })],
    ['計量是字串', usageRow({ today: { jobs: '3', in: 0, out: 0, usd: 0 } })],
    ['計量為負數', usageRow({ today: { jobs: -1, in: 0, out: 0, usd: 0 } })],
    ['計量為 NaN', usageRow({ today: { jobs: 0, in: NaN, out: 0, usd: 0 } })],
    ['計量為 Infinity', usageRow({ today: { jobs: 0, in: 0, out: Infinity, usd: 0 } })],
    ['選填計數型別錯誤', usageRow({ today: { jobs: 1, ok: '1', in: 0, out: 0, usd: 0 } })],
    ['week 形狀不合', usageRow({ week: { jobs: 1, in: 1, out: 1 } })],
  ])('%s → 拒收且不臆測補 0', async (_name, row) => {
    await expect(fetchQuotaUsage(jsonFetch({ ok: true, tools: [row] }))).rejects.toThrow()
  })

  it('auto 指向未就緒工具時被清成 null', async () => {
    const staleAuto = async () =>
      new Response(
        JSON.stringify({
          ...mockContractData,
          auto: 'codex', // 限流中，不可為 auto
        }),
        { status: 200 },
      )
    const result = await fetchQuotaUsage(staleAuto)
    expect(result.auto).toBeNull()
  })
})
