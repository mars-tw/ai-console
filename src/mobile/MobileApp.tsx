// 手機遙控主畫面（PWA 前端）
// 提供使用者在行動裝置瀏覽器上，透過 Tailscale 網路遙控操作 AI 派工。
// 具備 401 自動轉配對、8 秒狀態輪詢、安全邊界留白與符合行動觸控標準的按鈕尺寸。

import { useEffect, useState, useCallback } from 'react'
import { t } from '@/i18n'
import QuotaStrip from '@/components/QuotaStrip'
import { isLive, look, stateOf } from '@/lib/dispatchState'
import type { DispatchRecord } from '@/types/data'
import {
  clearRemoteToken,
  getRemoteToken,
  installRemoteFetch,
  setRemoteToken,
  tokenFromHash,
} from './remoteApi'

export type ConsoleDispatch = DispatchRecord & {
  outcome?: 'ok' | 'no_changes' | 'blocked' | 'error' | 'stopped' | null
  handedOffTo?: string
  handoffFrom?: string
}

export interface DispatchTool {
  id: string
  label: string
  mode: 'headless' | 'terminal' | 'local'
  limited: boolean
  reason?: string
}

export interface MobileAppProps {
  initialToken?: string
  initialPaired?: boolean
  initialDispatches?: ConsoleDispatch[]
  initialTools?: DispatchTool[]
  initialAuto?: string
}

/** 計算派工發起距今時間 */
function startedAgo(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(stamp || '')
  if (!m) return ''
  const [, y, mo, d, h, mi, se] = m
  const t0 = new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime()
  const s = Math.max(0, Math.round((Date.now() - t0) / 1000))
  if (s < 60) return t('剛剛')
  if (s < 3600) return t('{n} 分前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小時前', { n: Math.floor(s / 3600) })
  return t('{n} 天前', { n: Math.floor(s / 86400) })
}

/** 依 outcome 回傳對應之語意說明 */
function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'ok':
      return t('已完成')
    case 'no_changes':
      return t('跑完了但沒有改到任何檔案')
    case 'blocked':
      return t('依規範停下（沒有執行）')
    case 'stopped':
      return t('被停止（沒有跑完）')
    case 'error':
      return t('執行失敗')
    default:
      return outcome
  }
}

/** 依 outcome 回傳語意色調樣式 */
function outcomeTone(outcome: string): string {
  switch (outcome) {
    case 'ok':
      return 'text-emerald-700 dark:text-emerald-300'
    case 'no_changes':
    case 'stopped':
      return 'text-amber-700 dark:text-amber-300'
    case 'blocked':
      return 'text-sky-700 dark:text-sky-300'
    case 'error':
      return 'text-red-700 dark:text-red-300'
    default:
      return 'text-mute2'
  }
}

export default function MobileApp({
  initialToken,
  initialPaired,
  initialDispatches,
  initialTools,
  initialAuto = '',
}: MobileAppProps) {
  // 配對狀態：若外部未顯式指定，則檢驗是否已有有效 token
  const [paired, setPaired] = useState<boolean>(() => {
    if (typeof initialPaired === 'boolean') {
      return initialPaired
    }
    const tok = initialToken ?? getRemoteToken()
    return Boolean(tok && tok.trim())
  })

  // 配對頁面之 token 輸入與連線中狀態
  const [tokenInput, setTokenInput] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [pairError, setPairError] = useState('')

  // 連線健康與輪詢狀態
  const [connected, setConnected] = useState(true)

  // 快速派工表單狀態
  const [tools, setTools] = useState<DispatchTool[]>(initialTools ?? [])
  const [autoTool, setAutoTool] = useState<string>(initialAuto)
  const [selectedTool, setSelectedTool] = useState<string>('auto')
  const [taskDraft, setTaskDraft] = useState<string>('')
  const [dispatching, setDispatching] = useState<boolean>(false)
  const [dispatchNotice, setDispatchNotice] = useState<{ message: string; ok: boolean } | null>(null)

  // 派工清單與展開之日誌紀錄
  const [dispatches, setDispatches] = useState<ConsoleDispatch[]>(initialDispatches ?? [])
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null)
  const [logTextMap, setLogTextMap] = useState<Record<string, string>>({})
  const [logLoadingMap, setLogLoadingMap] = useState<Record<string, boolean>>({})

  // 補一句（Followup）展開列與輸入內容
  const [replyingId, setReplyingId] = useState<string | null>(null)
  const [replyText, setReplyText] = useState<string>('')
  const [replySending, setReplySending] = useState<boolean>(false)

  // 抓取派工清單與更新連線狀態
  const pullDispatches = useCallback(async () => {
    try {
      const res = await fetch('/api/dispatches')
      if (res.status === 401) {
        setPaired(false)
        setConnected(false)
        return
      }
      if (!res.ok) {
        setConnected(false)
        return
      }
      const data = await res.json()
      if (data && Array.isArray(data.dispatches)) {
        setDispatches(data.dispatches)
        setConnected(true)
      }
    } catch {
      setConnected(false)
    }
  }, [])

  // 抓取可用工具清單
  const pullTools = useCallback(async () => {
    try {
      const res = await fetch('/api/dispatch/tools')
      if (res.status === 401) {
        setPaired(false)
        return
      }
      if (res.ok) {
        const data = await res.json()
        if (data && data.ok) {
          if (Array.isArray(data.tools)) {
            setTools(data.tools)
          }
          if (typeof data.auto === 'string') {
            setAutoTool(data.auto)
          }
        }
      }
    } catch {
      // 靜默處理網路異常，維持預設選項
    }
  }, [])

  // 初始化安裝 fetch 攔截器、解析 hash、註冊 PWA 與排程輪詢
  useEffect(() => {
    installRemoteFetch()
    const hashTok = tokenFromHash()
    if (hashTok) {
      setPaired(true)
    }

    // 註冊 Service Worker，支援離線快取
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/m/sw.js').catch(() => {
        // 註冊失敗不拋錯，不影響使用者操作核心派工功能
      })
    }

    // 動態在 head 補上 PWA 所需之 manifest 與 theme-color
    if (typeof document !== 'undefined' && document.head) {
      if (!document.head.querySelector('link[rel="manifest"]')) {
        const link = document.createElement('link')
        link.rel = 'manifest'
        link.href = '/m/manifest.webmanifest'
        document.head.appendChild(link)
      }
      if (!document.head.querySelector('meta[name="theme-color"]')) {
        const meta = document.createElement('meta')
        meta.name = 'theme-color'
        meta.content = '#18181b'
        document.head.appendChild(meta)
      }
    }

    // 監聽 401 未授權自訂事件
    const handleUnauthorized = () => {
      setPaired(false)
      setConnected(false)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('ac_remote_unauthorized', handleUnauthorized)
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('ac_remote_unauthorized', handleUnauthorized)
      }
    }
  }, [])

  // 當處於已配對狀態時，每 8 秒輪詢一次派工與連線狀態
  useEffect(() => {
    if (!paired) return

    void pullDispatches()
    void pullTools()

    const timer = setInterval(() => {
      void pullDispatches()
    }, 8000)

    return () => clearInterval(timer)
  }, [paired, pullDispatches, pullTools])

  // 配對連線處理
  const handleConnect = async () => {
    const candidate = tokenInput.trim()
    if (!candidate || connecting) return
    setConnecting(true)
    setPairError('')

    try {
      // 直連 /api/health 驗證 Token 是否正確
      const res = await fetch('/api/health', {
        headers: { Authorization: `Bearer ${candidate}` },
      })
      if (res.ok) {
        setRemoteToken(candidate)
        setPaired(true)
        setTokenInput('')
        void pullDispatches()
        void pullTools()
      } else {
        setPairError(t('連線失敗，請檢查 Token 或主機狀態'))
      }
    } catch {
      setPairError(t('連線失敗，請檢查 Token 或主機狀態'))
    } finally {
      setConnecting(false)
    }
  }

  // 解除配對並清除 Token
  const handleUnpair = () => {
    if (window.confirm(t('確定要解除配對並清除 Token 嗎？'))) {
      clearRemoteToken()
      setPaired(false)
    }
  }

  // 快速派工送出
  const handleDispatch = async () => {
    const task = taskDraft.trim()
    if (!task || dispatching) return
    setDispatching(true)
    setDispatchNotice(null)

    try {
      const res = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: selectedTool, task }),
      })
      const data = await res.json()
      if (res.ok && data?.ok) {
        const msg = data.note || t('派工成功')
        setDispatchNotice({ message: msg, ok: true })
        setTaskDraft('')
        void pullDispatches()
      } else {
        setDispatchNotice({ message: data?.error || t('派工失敗'), ok: false })
      }
    } catch {
      setDispatchNotice({ message: t('派工失敗'), ok: false })
    } finally {
      setDispatching(false)
    }
  }

  // 停止正在執行的派工
  const handleStop = async (d: ConsoleDispatch) => {
    if (!window.confirm(t('確定要停止這件派工嗎？'))) return
    try {
      const res = await fetch('/api/dispatch/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: d.id }),
      })
      const data = await res.json()
      if (data?.ok) {
        void pullDispatches()
      } else {
        alert(data?.error || t('停止失敗'))
      }
    } catch {
      alert(t('停止失敗'))
    }
  }

  // 取消尚未被啟動的等待派工
  const handleCancel = async (d: ConsoleDispatch) => {
    try {
      const res = await fetch('/api/dispatch/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: d.id }),
      })
      const data = await res.json()
      if (data?.ok) {
        void pullDispatches()
      } else {
        alert(data?.error || t('取消失敗'))
      }
    } catch {
      alert(t('取消失敗'))
    }
  }

  // 重新派發工作
  const handleRetry = async (d: ConsoleDispatch) => {
    try {
      const res = await fetch('/api/dispatch/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: d.id }),
      })
      const data = await res.json()
      if (data?.ok) {
        void pullDispatches()
      } else {
        alert(data?.error || t('重派失敗'))
      }
    } catch {
      alert(t('重派失敗'))
    }
  }

  // 送出補一句（Followup）
  const handleSendFollowup = async (id: string) => {
    const text = replyText.trim()
    if (!text || replySending) return
    setReplySending(true)
    try {
      const res = await fetch('/api/dispatch/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text }),
      })
      const data = await res.json()
      if (data?.ok) {
        setReplyText('')
        setReplyingId(null)
        void pullDispatches()
      } else {
        alert(data?.error || t('送出失敗'))
      }
    } catch {
      alert(t('送出失敗'))
    } finally {
      setReplySending(false)
    }
  }

  // 展開或收合單一派工的日誌輸出（讀取最後 3000 字元）
  const toggleLog = async (id: string) => {
    if (expandedLogId === id) {
      setExpandedLogId(null)
      return
    }
    setExpandedLogId(id)
    if (!logTextMap[id]) {
      setLogLoadingMap((prev) => ({ ...prev, [id]: true }))
      try {
        const res = await fetch(`/api/dispatch/log?id=${encodeURIComponent(id)}`)
        const data = await res.json()
        if (data?.ok && typeof data.text === 'string') {
          // 僅保留最後 3000 字元以節省手機端渲染記憶體
          const trimmed = data.text.length > 3000 ? data.text.slice(-3000) : data.text
          setLogTextMap((prev) => ({ ...prev, [id]: trimmed }))
        } else {
          setLogTextMap((prev) => ({ ...prev, [id]: data?.error || t('（還沒有輸出）') }))
        }
      } catch {
        setLogTextMap((prev) => ({ ...prev, [id]: t('（還沒有輸出）') }))
      } finally {
        setLogLoadingMap((prev) => ({ ...prev, [id]: false }))
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 配對畫面（當未帶 Token 或 Token 錯誤 401 時顯示）
  // ─────────────────────────────────────────────────────────────
  if (!paired) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center bg-app px-4 text-ink font-sans"
        style={{
          paddingTop: 'env(safe-area-inset-top, 0px)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          paddingLeft: 'env(safe-area-inset-left, 0px)',
          paddingRight: 'env(safe-area-inset-right, 0px)',
        }}
      >
        <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6 shadow-sm">
          <h2 className="mb-2 text-base font-bold text-ink">
            📱 {t('AI 控制台 遙控')}
          </h2>
          <p className="mb-5 text-xs leading-relaxed text-mute">
            {t('用桌面版的「📱 手機遙控」掃 QR 會自動配對')}
          </p>

          <div className="space-y-3">
            <label htmlFor="remote-token-input" className="sr-only">
              {t('請輸入存取權限 Token')}
            </label>
            <input
              id="remote-token-input"
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={t('請輸入存取權限 Token')}
              className="min-h-[44px] w-full rounded-lg border border-line bg-app px-3.5 text-sm text-ink outline-none placeholder:text-mute3 focus-visible:border-line3"
            />

            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting || !tokenInput.trim()}
              className="min-h-[44px] w-full rounded-lg bg-ink px-4 py-2 text-sm font-medium text-invink hover:bg-ink2 disabled:opacity-40"
            >
              {connecting ? t('連線中…') : t('連線')}
            </button>

            {pairError && (
              <div className="text-xs text-red-700 dark:text-red-300">
                {pairError}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────
  // 遙控主畫面（手機直式、單欄、留安全邊距）
  // ─────────────────────────────────────────────────────────────
  return (
    <div
      className="flex min-h-screen flex-col bg-app text-ink font-sans"
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
      }}
    >
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col space-y-4 p-4">
        {/* 1. 頂部列：標題、連線狀態指示與解除配對按鈕 */}
        <header className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-ink">
              {t('AI 控制台 遙控')}
            </h1>
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                connected ? 'bg-emerald-500' : 'bg-red-500'
              }`}
              title={connected ? t('連線正常') : t('連不上主機')}
              aria-label={connected ? t('連線正常') : t('連不上主機')}
            />
          </div>

          <div className="flex items-center gap-2">
            {!connected && (
              <span className="text-xs font-medium text-red-700 dark:text-red-300">
                {t('連不上主機')}
              </span>
            )}
            <button
              type="button"
              onClick={handleUnpair}
              className="min-h-[44px] rounded px-2.5 text-xs text-mute3 hover:text-ink2"
            >
              {t('解除配對')}
            </button>
          </div>
        </header>

        {/* 2. 額度狀態列：掛載既有 QuotaStrip 元件（精簡版 compact） */}
        <section aria-label={t('額度與今日用量')}>
          <QuotaStrip compact />
        </section>

        {/* 3. 快速派工面板 */}
        <section className="rounded-xl border border-line bg-panel p-3.5 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-mute">
            ⚡ {t('交給 AI 執行')}
          </h2>

          {/* 工具下拉選單 */}
          <div>
            <label htmlFor="mobile-dispatch-tool" className="sr-only">
              {t('派給哪個工具')}
            </label>
            <select
              id="mobile-dispatch-tool"
              value={selectedTool}
              onChange={(e) => setSelectedTool(e.target.value)}
              className="min-h-[44px] w-full rounded-lg border border-line bg-app px-3 text-xs text-ink2 outline-none focus-visible:border-line3"
            >
              <option value="auto">
                {autoTool ? t('自動會挑：{auto}', { auto: autoTool }) : t('自動')}
              </option>
              {tools.map((x) => (
                <option key={x.id} value={x.id} disabled={x.limited}>
                  {x.label}
                  {x.limited
                    ? ` (${t('限流')}：${x.reason || t('額度狀態無法確認')})`
                    : ''}
                </option>
              ))}
            </select>
          </div>

          {/* 任務內容文字區域 */}
          <div>
            <textarea
              value={taskDraft}
              onChange={(e) => setTaskDraft(e.target.value)}
              placeholder={t('要 AI 完成什麼？')}
              rows={3}
              className="w-full rounded-lg border border-line bg-app p-3 text-sm text-ink outline-none placeholder:text-mute3 focus-visible:border-line3"
            />
          </div>

          {/* 送出按鈕 */}
          <button
            type="button"
            onClick={handleDispatch}
            disabled={dispatching || !taskDraft.trim()}
            className="min-h-[44px] w-full rounded-lg bg-ink px-4 py-2 text-sm font-medium text-invink hover:bg-ink2 disabled:opacity-40"
          >
            {dispatching ? t('派工中…') : t('派出去')}
          </button>

          {/* 派工結果提示 */}
          {dispatchNotice && (
            <div
              role="status"
              aria-live="polite"
              className={`text-xs ${
                dispatchNotice.ok
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-red-700 dark:text-red-300'
              }`}
            >
              {dispatchNotice.message}
            </div>
          )}
        </section>

        {/* 4. 派工清單（每 8 秒定時刷新） */}
        <section className="flex-1 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-mute">
              📋 {t('派工清單')}
            </h2>
            <span className="text-xs text-mute3">
              {dispatches.length}
            </span>
          </div>

          {dispatches.length === 0 ? (
            <div className="rounded-xl border border-line bg-panel p-6 text-center text-xs text-mute3">
              {t('目前沒有任何派工紀錄')}
            </div>
          ) : (
            <div className="space-y-3">
              {dispatches.map((d) => {
                const s = stateOf(d)
                const st = look(s)
                const live = isLive(d)
                const isRunning = live && s === 'running'
                const isWaiting = s === 'waiting'
                const isHeadless = d.mode !== 'terminal'
                const canRetry =
                  d.outcome === 'error' ||
                  d.outcome === 'no_changes' ||
                  d.outcome === 'stopped' ||
                  s === 'stopped' ||
                  s === 'failed'
                const canFollowup = isHeadless && !live
                const isLogOpen = expandedLogId === d.id

                return (
                  <div
                    key={d.id}
                    className="flex flex-col rounded-xl border border-line bg-panel p-3.5 space-y-2 text-ink2"
                  >
                    {/* 頂部資訊列：工具、距今時間、狀態與結果 */}
                    <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-line/60 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-elev px-2 py-0.5 text-xs font-semibold text-ink">
                          {d.tool}
                        </span>
                        <span className="text-[11px] text-mute3">
                          {startedAgo(d.started)}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        {/* 狀態指示 */}
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${st.tone}`}>
                          <span className={`inline-block h-2 w-2 rounded-full ${st.dot}`} />
                          <span>{st.label}</span>
                        </span>

                        {/* outcome 額外標示 */}
                        {d.outcome && (
                          <span className={`text-[11px] font-medium ${outcomeTone(d.outcome)}`}>
                            {outcomeLabel(d.outcome)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 工單內容摘要（前 80 字） */}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleLog(d.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          void toggleLog(d.id)
                        }
                      }}
                      className="cursor-pointer text-xs leading-relaxed text-ink hover:text-mute"
                    >
                      {(d.task || '').slice(0, 80)}
                      {(d.task || '').length > 80 ? '…' : ''}
                    </div>

                    {/* 即時 tail 行輸出 */}
                    {d.tail && (
                      <div className="truncate rounded bg-app px-2 py-1 font-mono text-[11px] text-mute2">
                        {d.tail}
                      </div>
                    )}

                    {/* 接力徽章 */}
                    {(d.handedOffTo || d.handoffFrom) && (
                      <div className="flex flex-wrap gap-1.5 text-[10px]">
                        {d.handedOffTo && (
                          <span className="rounded bg-elev px-1.5 py-0.5 text-mute2">
                            {t('↪ 已自動接力給 {to}', { to: d.handedOffTo })}
                          </span>
                        )}
                        {d.handoffFrom && (
                          <span className="rounded bg-elev px-1.5 py-0.5 text-mute2">
                            {t('↩ 從 {from} 接力而來', { from: d.handoffFrom })}
                          </span>
                        )}
                      </div>
                    )}

                    {/* 動作按鈕群組：每個按鈕皆確保 min-h-[44px] */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {/* 執行中且非終端模式：提供停止功能 */}
                      {isRunning && isHeadless && (
                        <button
                          type="button"
                          onClick={() => handleStop(d)}
                          className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs font-medium text-ink2 hover:bg-elev2"
                        >
                          {t('⏹ 停止')}
                        </button>
                      )}

                      {/* waiting 狀態：提供取消功能 */}
                      {isWaiting && (
                        <button
                          type="button"
                          onClick={() => handleCancel(d)}
                          className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs font-medium text-ink2 hover:bg-elev2"
                        >
                          {t('✕ 取消')}
                        </button>
                      )}

                      {/* 失敗、已停止或無改動：提供重派功能 */}
                      {canRetry && (
                        <button
                          type="button"
                          onClick={() => handleRetry(d)}
                          className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs font-medium text-ink2 hover:bg-elev2"
                        >
                          {t('↻ 重派')}
                        </button>
                      )}

                      {/* 非執行中之無頭工作：提供補一句功能 */}
                      {canFollowup && (
                        <button
                          type="button"
                          onClick={() => {
                            if (replyingId === d.id) {
                              setReplyingId(null)
                            } else {
                              setReplyingId(d.id)
                              setReplyText('')
                            }
                          }}
                          className="min-h-[44px] rounded-lg border border-line bg-elev px-3 text-xs font-medium text-ink2 hover:bg-elev2"
                        >
                          {t('💬 補一句')}
                        </button>
                      )}

                      {/* 查看日誌開關 */}
                      <button
                        type="button"
                        onClick={() => toggleLog(d.id)}
                        className="min-h-[44px] ml-auto rounded-lg border border-line bg-elev px-3 text-xs text-mute hover:bg-elev2 hover:text-ink2"
                      >
                        {isLogOpen ? t('收合日誌') : t('查看日誌')}
                      </button>
                    </div>

                    {/* 展開之「補一句」輸入區 */}
                    {replyingId === d.id && (
                      <div className="mt-2 space-y-2 rounded-lg border border-line2 bg-app p-2.5">
                        <textarea
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder={t('補話內容…')}
                          rows={2}
                          className="w-full rounded border border-line bg-panel p-2 text-xs text-ink outline-none placeholder:text-mute3"
                        />
                        <button
                          type="button"
                          onClick={() => handleSendFollowup(d.id)}
                          disabled={replySending || !replyText.trim()}
                          className="min-h-[44px] w-full rounded bg-ink px-3 py-1.5 text-xs font-medium text-invink hover:bg-ink2 disabled:opacity-40"
                        >
                          {replySending ? t('送出中…') : t('送出')}
                        </button>
                      </div>
                    )}

                    {/* 展開之日誌顯示區塊（最後 3000 字元、等寬字、可捲動） */}
                    {isLogOpen && (
                      <div className="mt-2">
                        <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-app p-2.5 font-mono text-[11px] text-ink3">
                          {logLoadingMap[d.id]
                            ? t('日誌載入中…')
                            : logTextMap[d.id] || t('（還沒有輸出）')}
                        </pre>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
