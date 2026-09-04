/* eslint-disable react-refresh/only-export-components -- 額度狀態與 token 縮寫等純函式需有聚焦單元測試 */
// 額度與今日用量狀態列：顯示各 AI 工具的限流狀態、恢復時間與今日 token 消耗。
// 資料來源為後端 GET /api/dispatch/usage；此處維持唯讀顯示，不介入派工決策。


import { useEffect, useState } from 'react'
import { t } from '@/i18n'

/**
 * 本地元件與後端契約之型別宣告。
 * 遵循無頭派工與計量契約，包含單一工具之今日與本週工作數、token 與美金成本。
 */
export interface ToolUsagePeriod {
  jobs: number
  ok?: number
  failed?: number
  stopped?: number
  in: number
  out: number
  usd: number
}


export interface ToolUsageInfo {
  id: string
  label: string
  mode?: string
  limited: boolean
  reason?: string
  today: ToolUsagePeriod
  week?: ToolUsagePeriod
}

export interface QuotaUsageResponse {
  ok: boolean
  day?: string
  auto?: string
  tools?: ToolUsageInfo[]
  error?: string
}

export const QUOTA_STORAGE_KEY = 'ac_quota_strip'

/**
 * 格式化 token 數量。
 * 依規格大於等於 1,000 以 k 縮寫，大於等於 1,000,000 以 M 縮寫（一位小數，整數時去掉 .0）。
 * 例如：999 -> 999、152173 -> 152k、1234567 -> 1.2M。
 */
export function formatToken(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return `${Math.round(n)}`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  const val = (n / 1_000_000).toFixed(1).replace(/\.0$/, '')
  return `${val}M`
}

/**
 * 格式化美金金額。
 * 規格規定 usd 為 0 表示沒有金額資訊（不顯示 $0），
 * 只有大於 0 時才輸出格式如 $0.0123。
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return ''
  return `$${usd.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`
}

/**
 * 讀取收合狀態初始值。
 * 預設為展開（open）。無痕瀏覽或受限環境下讀取 localStorage 失敗時，
 * 必須靜默退回預設值，避免造成元件崩潰。
 */
export function getStoredOpenState(): boolean {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(QUOTA_STORAGE_KEY)
      if (saved === 'closed') return false
      if (saved === 'open') return true
    }
  } catch {
    // 忽略受限環境之存取例外
  }
  return true
}

/**
 * 保存收合狀態至 localStorage。
 * 依約定存入 'open' 或 'closed'，寫入失敗時不影響目前介面操作。
 */
export function setStoredOpenState(open: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(QUOTA_STORAGE_KEY, open ? 'open' : 'closed')
    }
  } catch {
    // 忽略安全限制或容量超限錯誤
  }
}

/**
 * 取得後端額度用量資料。
 * 提供獨立函式以利單元測試抽換 fetch 實作。
 */
export async function fetchQuotaUsage(customFetch = fetch, signal?: AbortSignal): Promise<QuotaUsageResponse> {
  const res = await customFetch('/api/dispatch/usage', { signal })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const data = (await res.json()) as QuotaUsageResponse
  if (!data || !data.ok) {
    throw new Error(data?.error || 'API returned ok=false')
  }
  return data
}

interface QuotaStripProps {
  compact?: boolean
  initialData?: QuotaUsageResponse
}

export default function QuotaStrip({ compact, initialData }: QuotaStripProps) {
  const [open, setOpen] = useState<boolean>(getStoredOpenState)
  const [data, setData] = useState<QuotaUsageResponse | null>(initialData ?? null)
  const [hasError, setHasError] = useState<boolean>(false)

  // 點擊標題列切換展開或收合狀態，並持久化到本地儲存
  const toggleOpen = () => {
    setOpen((prev) => {
      const next = !prev
      setStoredOpenState(next)
      return next
    })
  }

  useEffect(() => {
    // 若外部已注入 initialData 且不需要輪詢（例如部分靜態預覽場景），仍可在掛載時啟動標準輪詢
    let timer: ReturnType<typeof setInterval> | null = null
    const controller = new AbortController()

    const load = async () => {
      try {
        const res = await fetchQuotaUsage(fetch, controller.signal)
        setData(res)
        setHasError(false)
      } catch {
        if (controller.signal.aborted) return
        setHasError(true)
      }
    }

    // 掛載時先抓取一次最新用量
    if (!initialData) {
      void load()
    }

    // 每 60 秒定期刷新一次，卸載時確實清掉計時器以避免記憶體洩漏
    timer = setInterval(() => {
      void load()
    }, 60000)

    return () => {
      if (timer) clearInterval(timer)
      controller.abort()
    }
  }, [initialData])

  return (
    <div
      className={`rounded border border-line bg-panel text-ink2 ${
        compact ? 'p-2 text-[10px]' : 'p-3 text-xs'
      }`}
    >
      {/* 標題列：收合按鈕為真正的 button，具備標準 aria-expanded 屬性 */}
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggleOpen}
          className="flex items-center gap-2 text-left font-medium tracking-wide text-mute hover:text-ink2 focus-visible:ring-1"
        >
          <span className="text-mute3" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span>{t('額度與今日用量')}</span>
        </button>
      </div>

      {open && (
        <div className="mt-2">
          {/* 後端無回應或失敗時顯示錯誤提示行，維持整體面板外觀不拋錯 */}
          {hasError ? (
            <div className="text-mute3">
              {t('額度資訊拿不到（控制 API 無回應）')}
            </div>
          ) : data && data.tools && data.tools.length > 0 ? (
            <div className="flex flex-col divide-y divide-line">
              {data.tools.map((tool) => {
                const isAuto = Boolean(data.auto && tool.id === data.auto)
                const hasJobs = tool.today.jobs > 0
                const usdText = formatUsd(tool.today.usd)

                return (
                  <div
                    key={tool.id}
                    className="flex flex-wrap items-center gap-2 py-1.5 first:pt-0 last:pb-0 text-mute2"
                  >
                    {/* auto 那一列前面標小徽章「自動會挑」，讓使用者一眼認出 */}
                    {isAuto && (
                      <span className="flex-none rounded bg-elev px-1.5 py-0.5 text-[10px] font-medium text-mute">
                        {t('自動會挑')}
                      </span>
                    )}

                    {/* 狀態點：可用＝綠、限流＝琥珀；提供 title 與 aria-label 供輔助科技使用 */}
                    <span
                      className={`inline-block h-2 w-2 flex-none rounded-full ${
                        tool.limited
                          ? 'bg-amber-500 dark:bg-amber-400'
                          : 'bg-emerald-500 dark:bg-emerald-400'
                      }`}
                      title={tool.limited ? t('限流') : t('可用')}
                      aria-label={tool.limited ? t('限流') : t('可用')}
                    />

                    {/* 工具名稱 */}
                    <span className="font-medium text-ink2">{tool.label}</span>

                    {/* 限流時顯示 reason，若無 reason 則顯示預設說明 */}
                    {tool.limited && (
                      <span className="text-[10px] text-amber-700 dark:text-amber-300">
                        {tool.reason && tool.reason.trim()
                          ? tool.reason
                          : t('額度狀態無法確認')}
                      </span>
                    )}

                    {/* 今日用量：0 件顯示「今天沒派」，大於 0 件顯示工作數與進出 token 縮寫 */}
                    <span className="text-mute3">
                      {hasJobs
                        ? t('{n} 件 · {in} 進 / {out} 出 token', {
                            n: tool.today.jobs,
                            in: formatToken(tool.today.in),
                            out: formatToken(tool.today.out),
                          })
                        : t('今天沒派')}
                    </span>

                    {/* 只有美金金額大於 0 時才呈現，避免 $0 造成「完全免費」之誤導 */}
                    {usdText && (
                      <span className="font-mono text-mute2">{usdText}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
