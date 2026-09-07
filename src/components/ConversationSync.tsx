/* eslint-disable react-refresh/only-export-components -- 純函式是同步 UI 的可驗證合約 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@/i18n'
import type { ConversationScanReport, IndexData } from '@/types/data'

declare global {
  interface Window { acSetup?: { chooseDirectory: () => Promise<string | null> } }
}

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

export function additionalConversationSources(index: IndexData | null): { id: string; label: string; count: number }[] {
  const found = new Map<string, { id: string; label: string; count: number }>()
  for (const conversation of index?.conversations || []) {
    if (conversation.sourceKind !== 'discovered' || conversation.subagent || conversation.dup) continue
    const source = found.get(conversation.tool) || { id: conversation.tool, label: conversation.toolLabel, count: 0 }
    source.count += 1
    found.set(conversation.tool, source)
  }
  return [...found.values()]
}

export function scanCoverageWarning(scan?: ConversationScanReport): boolean {
  return !!scan && !scan.complete
}

const SCAN_REASON_TEXT: Record<string, string> = {
  'not-scanned': '尚未搜尋這些位置，請開始一次搜尋。',
  'legacy-cache': '目前使用舊版搜尋紀錄，重新搜尋才能確認涵蓋範圍。',
  'scan-failed': '搜尋程序沒有完成，請重新搜尋或縮小範圍。',
  'unsupported': '找到目前不支援的對話格式，這些檔案尚未匯入。',
  'unreadable': '有些檔案無法讀取，請確認檔案權限或是否仍存在。',
  'excluded': '有些檔案不符合可匯入條件，因此未加入對話清單。',
  'time-limit': '搜尋時間已達上限，可以縮小範圍後再搜尋。',
  'depth-limit': '部分資料夾層級太深，請把該資料夾加入其他搜尋位置。',
  'directory-limit': '資料夾數量已達上限，請分批加入其他搜尋位置。',
  'file-limit': '檔案數量已達上限，請縮小搜尋範圍。',
  'candidate-limit': '對話來源數量已達上限，請分批搜尋。',
  'root-limit': '搜尋起點數量已達上限，請分批加入其他資料夾。',
  'directory-read-error': '有些資料夾無法讀取，可能沒有權限或已不存在。',
  'file-read-error': '有些檔案無法讀取，請確認檔案權限或是否仍存在。',
  'sqlite-read-error': '有些對話資料庫無法讀取，可能正在使用中或格式不支援。',
  'unsupported-format': '找到目前不支援的對話格式，這些檔案尚未匯入。',
  'record-limit': '部分檔案的對話筆數超過上限，尚未完整讀取。',
  'byte-limit': '部分對話檔過大，尚未完整讀取。',
}

export function scanReasonText(reason: string): string {
  return t(SCAN_REASON_TEXT[reason.replace(/^index-/, '')] || reason)
}

export function extraScanRoots(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(root => root.trim()).filter(Boolean))]
}

/** 實際的同步合約：先 POST 跑完 indexer，再讀回新索引，不由畫面猜數字。 */
export async function requestConversationSync(
  fetcher: SyncFetch = fetch,
  signal?: AbortSignal,
  options: { deep?: boolean; extraRoots?: string[] } = {},
): Promise<ConversationSyncResult> {
  const response = await fetcher('/api/refresh', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rescan: true, deep: options.deep === true, ...(options.extraRoots?.length ? { extraRoots: options.extraRoots } : {}) }),
  })
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
  const [deep, setDeep] = useState(false)
  const [extraRoots, setExtraRoots] = useState('')
  const startedAt = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const [beforeCounts, setBeforeCounts] = useState(() => conversationSourceCounts(index))
  const shownIndex = state === 'complete' ? resultIndex : index
  const shownCounts = useMemo(() => conversationSourceCounts(shownIndex), [shownIndex])
  const additionalSources = useMemo(() => additionalConversationSources(shownIndex), [shownIndex])
  const additionalTotal = additionalSources.reduce((total, source) => total + source.count, 0)
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
      const result = await requestConversationSync(fetch, controller.signal, { deep, extraRoots: extraScanRoots(extraRoots) })
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
            {t('搜尋這台電腦常見位置中的 Codex、Claude、Qwen 和 Kimi 對話。不會刪除或修改原對話。')}
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

      <fieldset disabled={state === 'scanning'} className="rounded-xl border border-line bg-panel p-4 disabled:opacity-60">
        <legend className="px-1 text-sm font-medium">{t('搜尋範圍')}</legend>
        <label className="flex items-start gap-2 text-sm"><input type="radio" name="sync-scope" className="mt-1" checked={!deep} onChange={() => setDeep(false)} /><span>{t('搜尋常見位置（建議）')}<span className="mt-1 block text-xs leading-5 text-mute2">{t('先搜尋這個使用者帳號的 AI 工具資料夾。')}</span></span></label>
        <label className="mt-3 flex items-start gap-2 text-sm"><input type="radio" name="sync-scope" className="mt-1" checked={deep} onChange={() => setDeep(true)} /><span>{t('擴大搜尋')}<span className="mt-1 block text-xs leading-5 text-mute2">{t('搜尋更多可讀取的位置；遇到權限、格式或搜尋上限時，會列出尚未完成的部分。')}</span></span></label>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-mute2">{t('進階：其他對話資料夾')}</summary>
          <label className="mt-3 block">{t('其他對話資料夾（選填，每行一個）')}<textarea rows={2} className="mt-1 block w-full rounded-md border border-line2 bg-app p-2 text-sm" value={extraRoots} onChange={event => setExtraRoots(event.target.value)} placeholder={t('貼上存放 AI 對話的完整資料夾路徑')} /></label>
          {typeof window !== 'undefined' && window.acSetup?.chooseDirectory && <button type="button" className="mt-2 rounded-md border border-line2 px-3 py-1.5 text-sm" onClick={() => { void window.acSetup?.chooseDirectory().then(path => { if (path) setExtraRoots(current => extraScanRoots(`${current}\n${path}`).join('\n')) }).catch(failure => setError(failure instanceof Error ? failure.message : String(failure))) }}>{t('選擇資料夾')}</button>}
          <p className="mt-2 text-xs leading-5 text-mute2">{t('只加入存放對話的資料夾，避免選取整顆磁碟。')}</p>
        </details>
      </fieldset>

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

      {additionalSources.length > 0 && <section aria-labelledby="additional-conversation-sources">
        <h2 id="additional-conversation-sources" className="text-sm font-semibold">{t('其他找到的對話來源')}</h2>
        <p className="mt-1 text-xs leading-5 text-mute2">{t('這些對話以唯讀方式匯入，可以在控制台查看。')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">{additionalSources.map(source => <article key={source.id} className="rounded-xl border border-line bg-panel p-4"><h3 className="font-medium">{source.label}</h3><p className="mt-1 text-sm text-mute2">{t('找到 {n} 份', { n: source.count })} · {t('唯讀匯入')}</p></article>)}</div>
      </section>}

      <div
        role={state === 'error' ? 'alert' : 'status'}
        aria-live="polite"
        aria-atomic="true"
        className={`rounded-xl px-4 py-3 text-sm ${state === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-elev text-ink2'}`}
      >
        {state === 'scanning' ? (
          <>
            <p className="font-medium">{t('正在搜尋 AI 對話…已等待 {n} 秒', { n: elapsed })}</p>
            <p className="mt-1 text-xs text-mute2">{t('所需時間取決於搜尋範圍與檔案數，請保持此頁開啟。')}</p>
          </>
        ) : state === 'complete' ? (
          <p className={`font-medium ${scanCoverageWarning(shownIndex?.scan) ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
            {scanCoverageWarning(shownIndex?.scan)
              ? t('已更新找到的 {n} 份對話；部分位置尚未完成搜尋。', { n: completion.total + additionalTotal })
              : completion.needsAttention === 0
              ? t('同步完成，共找到 {n} 份可在原 AI 開啟的對話。', { n: completion.total })
              : t('同步完成，共找到 {total} 份對話；有 {count} 個 AI 需要處理。', {
                total: completion.total + additionalTotal,
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
          <p>{shownIndex?.scan ? t('目前清單來自上次搜尋；可以再次搜尋更新。') : t('選擇搜尋範圍後開始，找到的對話會加入控制台清單。')}</p>
        )}
      </div>

      {shownIndex?.scan && <div role={scanCoverageWarning(shownIndex.scan) ? 'status' : undefined} className={`rounded-xl border p-4 text-sm ${scanCoverageWarning(shownIndex.scan) ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300' : 'border-line text-mute2'}`}>
        <p className="font-medium">{scanCoverageWarning(shownIndex.scan) ? t('這次搜尋有未完成的部分') : t('已完成這次指定範圍的搜尋')}</p>
        <p className="mt-1 text-xs leading-5">{t('這是所選範圍內的搜尋結果，不代表電腦上所有位置都已搜尋。')}</p>
        {shownIndex.scan.reasons.length > 0 && <ul className="mt-2 list-inside list-disc text-xs leading-6">{shownIndex.scan.reasons.map((reason, i) => <li key={`${i}:${reason}`}>{scanReasonText(reason)}</li>)}</ul>}
        <details className="mt-2 text-xs"><summary className="cursor-pointer">{t('查看搜尋範圍與數量')}</summary><p className="mt-2">{t('已檢查 {files} 個檔案、{dirs} 個資料夾；跳過 {skipped} 項。', { files: shownIndex.scan.filesInspected, dirs: shownIndex.scan.directories, skipped: shownIndex.scan.skippedFiles + shownIndex.scan.skippedDirectories })}</p><ul className="mt-2 space-y-1 break-all">{shownIndex.scan.roots.map(root => <li key={root}>{root}</li>)}</ul>{shownIndex.scan.cached && <p className="mt-2">{t('目前顯示上次搜尋的紀錄；重新搜尋可更新。')}</p>}</details>
      </div>}

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
              ? t('重新搜尋對話')
              : deep ? t('開始擴大搜尋') : t('開始搜尋常見位置')}
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
