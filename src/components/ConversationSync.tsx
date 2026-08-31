/* eslint-disable react-refresh/only-export-components -- 純函式是同步 UI 的可驗證合約 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@/i18n'
import type { IndexData } from '@/types/data'

export const CONVERSATION_SOURCES = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'qwen', label: 'Qwen' },
  { id: 'kimi', label: 'Kimi' },
] as const

type SourceId = (typeof CONVERSATION_SOURCES)[number]['id']
type SyncState = 'idle' | 'scanning' | 'complete' | 'stopped' | 'error'
export type ConversationSourceStatus = 'ok' | 'empty' | 'missing' | 'warning' | 'error'

export interface ConversationSourceHealth {
  id: SourceId
  label: string
  status: ConversationSourceStatus
  count: number
  reason?: string
  errorCount?: number
}

const REPAIR_TEXT: Record<SourceId, string> = {
  codex: '先開啟 Codex 並完成一次對話，再回來同步。',
  claude: '先開啟 Claude Desktop 並完成一次對話，再回來同步。',
  qwen: '先開啟 Qwen Code Desktop 並完成一次對話，再回來同步。',
  kimi: '先開啟 Kimi Code 並完成一次對話，再回來同步。',
}

/**
 * 「目前在原 AI 看得到」才是新手理解的對話數。
 * 子代理和重複副本是技術紀錄，不應該讓首次同步的數字膨脹。
 */
export function conversationSourceCounts(index: IndexData | null): Record<SourceId, number> {
  const counts: Record<SourceId, number> = { codex: 0, claude: 0, qwen: 0, kimi: 0 }
  for (const conversation of index?.conversations ?? []) {
    if (!(conversation.tool in counts)) continue
    if (!conversation.inApp || conversation.subagent || conversation.dup) continue
    counts[conversation.tool as SourceId] += 1
  }
  return counts
}

export function syncCompletionSummary(
  counts: Record<SourceId, number>,
  health: ConversationSourceHealth[] = [],
): { total: number; needsAttention: number } {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const healthById = new Map(health.map((item) => [item.id, item]))
  const needsAttention = CONVERSATION_SOURCES.filter((source) => {
    const item = healthById.get(source.id)
    return item ? item.status !== 'ok' : counts[source.id] === 0
  }).length
  return { total, needsAttention }
}

type SyncFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ConversationSyncResult {
  index: IndexData
  sources: ConversationSourceHealth[]
}

/** 實際的同步合約：先 POST 跑完 indexer，再讀回新索引，不由畫面猜數字。 */
export async function requestConversationSync(
  fetcher: SyncFetch = fetch,
  signal?: AbortSignal,
): Promise<ConversationSyncResult> {
  const response = await fetcher('/api/refresh', { method: 'POST', signal })
  const reply = await response.json() as {
    ok?: boolean
    error?: string
    out?: string
    sources?: ConversationSourceHealth[]
  }
  if (!response.ok || !reply.ok) throw new Error(reply.error || reply.out || `HTTP ${response.status}`)

  const indexResponse = await fetcher(`/data/index.json?sync=${Date.now()}`, { cache: 'no-store', signal })
  if (!indexResponse.ok) throw new Error(`同步完成，但讀不到新索引（HTTP ${indexResponse.status}）`)
  return {
    index: await indexResponse.json() as IndexData,
    sources: Array.isArray(reply.sources) ? reply.sources : [],
  }
}

interface ConversationSyncProps {
  index: IndexData | null
  apiOk: boolean
  onComplete: (index: IndexData) => void
  onClose?: () => void
}

export default function ConversationSync({ index, apiOk, onComplete, onClose }: ConversationSyncProps) {
  const [state, setState] = useState<SyncState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [resultIndex, setResultIndex] = useState<IndexData | null>(null)
  const [sourceHealth, setSourceHealth] = useState<ConversationSourceHealth[]>([])
  const [error, setError] = useState('')
  const startedAt = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const [beforeCounts, setBeforeCounts] = useState(() => conversationSourceCounts(index))
  const shownIndex = state === 'complete' ? resultIndex : index
  const shownCounts = useMemo(() => conversationSourceCounts(shownIndex), [shownIndex])
  const healthById = useMemo(
    () => new Map(sourceHealth.map((item) => [item.id, item])),
    [sourceHealth],
  )
  const completion = useMemo(
    () => syncCompletionSummary(shownCounts, sourceHealth),
    [shownCounts, sourceHealth],
  )

  useEffect(() => {
    if (state !== 'scanning') return
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [state])

  useEffect(() => () => abortRef.current?.abort(), [])

  const sync = async () => {
    if (state === 'scanning' || !apiOk) return
    startedAt.current = Date.now()
    setBeforeCounts(conversationSourceCounts(index))
    setElapsed(0)
    setError('')
    setResultIndex(null)
    setSourceHealth([])
    setState('scanning')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await requestConversationSync(fetch, controller.signal)
      const nextIndex = result.index
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)))
      setResultIndex(nextIndex)
      setSourceHealth(result.sources)
      setState('complete')
      onComplete(nextIndex)
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        // HTTP 等待可以中止，但已啟動的後端 indexer 可能仍在背景完成。
        setState('stopped')
        return
      }
      setError(failure instanceof Error ? failure.message : String(failure))
      setState('error')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  return (
    <section
      aria-labelledby="conversation-sync-title"
      className="mx-auto flex w-full max-w-4xl flex-col gap-5 overflow-y-auto px-4 py-6 sm:px-6"
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 id="conversation-sync-title" className="text-xl font-semibold text-ink">
            {t('匯入／同步 AI 對話')}
          </h1>
          <p className="mt-1 text-sm leading-6 text-mute2">
            {t('會從這台電腦的 Codex、Claude、Qwen 和 Kimi 找回對話。不會刪除或修改原對話。')}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            className="flex-none rounded-md border border-line px-3 py-1.5 text-sm hover:bg-elev disabled:cursor-not-allowed disabled:opacity-40"
            disabled={state === 'scanning'}
            onClick={onClose}
          >
            {t('關閉')}
          </button>
        )}
      </div>

      <div
        className="grid gap-3 sm:grid-cols-2"
        aria-label={t('各 AI 對話同步狀態')}
        aria-live="polite"
        aria-busy={state === 'scanning'}
      >
        {CONVERSATION_SOURCES.map((source) => {
          const health = state === 'complete' ? healthById.get(source.id) : undefined
          const count = health?.count ?? shownCounts[source.id]
          const delta = state === 'complete' ? count - beforeCounts[source.id] : 0
          const sourceFailed = health?.status === 'error'
          const sourceWarning = health?.status === 'warning' || health?.status === 'empty'
          return (
            <article key={source.id} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className={`h-2.5 w-2.5 rounded-full ${state === 'scanning' ? 'animate-pulse bg-amber-500' : state === 'error' || sourceFailed ? 'bg-red-500' : sourceWarning ? 'bg-amber-500' : count > 0 ? 'bg-emerald-500' : 'bg-mute'}`}
                />
                <h2 className="font-medium text-ink">{source.label}</h2>
                <span className="ml-auto text-sm text-mute2">
                  {state === 'scanning'
                    ? t('掃描中…')
                    : state === 'error'
                      ? t('同步失敗')
                    : state === 'stopped'
                      ? t('已停止等待')
                    : state === 'complete'
                      ? sourceFailed
                        ? t('同步失敗')
                        : health?.status === 'missing'
                          ? t('找不到對話來源')
                          : health?.status === 'warning'
                            ? t('部分資料無法確認')
                            : t('找到 {n} 份', { n: count })
                      : t('目前 {n} 份', { n: count })}
                </span>
              </div>
              {state === 'complete' && delta !== 0 && (
                <p className="mt-2 text-xs text-mute2">
                  {delta > 0 ? t('比同步前多 {n} 份', { n: delta }) : t('比同步前少 {n} 份', { n: Math.abs(delta) })}
                </p>
              )}
              {state === 'complete' && health?.reason && (
                <p className={`mt-2 text-xs leading-5 ${sourceFailed ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}`}>
                  {t(health.reason)}
                  {health.errorCount ? ` ${t('無法確認 {n} 份資料。', { n: health.errorCount })}` : ''}
                </p>
              )}
              {state === 'complete' && !sourceFailed && (health?.status === 'missing' || health?.status === 'empty') && (
                <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                  {t(REPAIR_TEXT[source.id])}
                </p>
              )}
            </article>
          )
        })}
      </div>

      <div
        role={state === 'error' ? 'alert' : 'status'}
        aria-live="polite"
        aria-atomic="true"
        className={`rounded-xl px-4 py-3 text-sm ${state === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-elev text-ink2'}`}
      >
        {state === 'scanning' ? (
          <>
            <p className="font-medium">{t('正在掃描四個 AI…已等待 {n} 秒', { n: elapsed })}</p>
            <p className="mt-1 text-xs text-mute2">{t('通常需要 20–30 秒，請保持此頁開啟。')}</p>
          </>
        ) : state === 'complete' ? (
          <p className="font-medium text-emerald-700 dark:text-emerald-300">
            {completion.needsAttention === 0
              ? t('同步完成，共找到 {n} 份可在原 AI 開啟的對話。', { n: completion.total })
              : t('同步完成，共找到 {total} 份對話；有 {count} 個 AI 需要處理。', {
                total: completion.total,
                count: completion.needsAttention,
              })}{' '}{t('耗時 {n} 秒。', { n: elapsed })}
          </p>
        ) : state === 'error' ? (
          <>
            <p className="font-medium">{t('同步沒有完成')}</p>
            <p className="mt-1 break-words text-xs">{error}</p>
            <p className="mt-1 text-xs">{t('原對話沒有被修改；請確認 AI 已開啟後再試一次。')}</p>
          </>
        ) : state === 'stopped' ? (
          <p>{t('已停止等待；後端可能仍在背景同步。畫面先保留舊清單，下次重新整理會讀到最新結果。')}</p>
        ) : (
          <p>{t('按下開始後，四個 AI 會一起掃描。整個過程不會顯示虛假百分比。')}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="rounded-lg bg-ink px-5 py-2.5 text-sm font-medium text-invink hover:bg-ink2 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!apiOk || state === 'scanning'}
          onClick={() => { void sync() }}
        >
          {state === 'scanning'
            ? t('同步中… {n} 秒', { n: elapsed })
            : state === 'complete'
              ? t('再同步一次')
              : t('開始匯入／同步')}
        </button>
        {state === 'scanning' && (
          <button
            type="button"
            className="rounded-lg border border-line2 px-4 py-2.5 text-sm hover:bg-elev"
            onClick={() => abortRef.current?.abort()}
          >
            {t('停止等待')}
          </button>
        )}
        {!apiOk && (
          <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
            {t('控制 API 離線；請重新開啟 AI 控制台後再同步。')}
          </p>
        )}
      </div>
    </section>
  )
}
