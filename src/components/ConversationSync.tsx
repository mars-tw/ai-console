/* eslint-disable react-refresh/only-export-components -- 純函式是同步 UI 的可驗證合約 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@/i18n'
import type { ConversationScanReport, ConversationSummary, IndexData } from '@/types/data'

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
/** `optional` = 後端確定「這台電腦沒用過這個 AI」，不是故障。 */
export type ConversationSourceStatus = 'ok' | 'optional' | 'empty' | 'missing' | 'warning' | 'error'

export interface ConversationSourceHealth {
  id: SourceId
  label: string
  status: ConversationSourceStatus
  count: number
  reason?: string
  errorCount?: number
  /** 後端明講的判斷；true 一定要處理，false 不能蓋掉真正的 warning／error。 */
  needsAttention?: boolean
}

const SOURCE_IDS = CONVERSATION_SOURCES.map((source) => source.id) as readonly string[]
const STATUS_VALUES: readonly string[] = ['ok', 'optional', 'empty', 'missing', 'warning', 'error']

const REPAIR_TEXT: Record<SourceId, string> = {
  codex: '先開啟 Codex 並完成一次對話，再回來同步。',
  claude: '先開啟 Claude Desktop 並完成一次對話，再回來同步。',
  qwen: '先開啟 Qwen Code Desktop 並完成一次對話，再回來同步。',
  kimi: '先開啟 Kimi Code 並完成一次對話，再回來同步。',
}

const UNREADABLE_REASON_TEXT = '這個來源回報了無法辨識的狀態說明，請重新同步確認。'
const UNREADABLE_COUNT_TEXT = '這個來源回報的份數無法確認。'
export const MALFORMED_SOURCES_TEXT = '有些來源狀態的格式無法辨識，畫面只顯示可確認的部分；原對話沒有被修改。'

/** 新手指引：只講「用原服務官方匯出 → 本機解壓縮 → 選對話資料夾再搜尋」。 */
export const IMPORT_GUIDE_STEPS = [
  '在原本的 AI 服務裡用它的官方匯出功能，把對話匯出成檔案。',
  '在這台電腦把下載到的 ZIP 壓縮檔解開，成為一般資料夾。',
  '選擇存放這些對話的專用資料夾，然後開始搜尋。',
] as const

/** 只放已驗證的官方說明；不自行編造其他服務的匯出步驟。 */
export const IMPORT_GUIDE_LINKS = [
  { label: 'Claude：官方匯出資料說明', href: 'https://support.claude.com/en/articles/9450526-export-your-claude-data' },
  { label: 'LM Studio：對話檔案存放位置', href: 'https://lmstudio.ai/docs/app/basics/chat' },
] as const

export const IMPORT_GUIDE_FORMAT_TEXT =
  '目前可辨識 JSON、JSONL、NDJSON 或 SQLite 檔案，能不能匯入取決於檔案結構；無法辨識的檔案會列在搜尋結果中，原始檔案不會被修改。'
export const IMPORT_GUIDE_FILTER_TEXT =
  '控制台首頁預設只顯示中文對話。若匯入的英文對話沒有出現，請檢查首頁既有的語言篩選；這裡不會自動改動該設定。'

function isValidCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validCount(value: unknown): number {
  return isValidCount(value) ? value : 0
}

function isHealthRow(value: unknown): value is ConversationSourceHealth {
  return !!value && typeof value === 'object' && typeof (value as ConversationSourceHealth).id === 'string'
}

/** 份數壞掉時不假裝是 0，改用索引裡真正算得出來的數字。 */
export function sourceCount(health: ConversationSourceHealth | undefined, fallback: number): number {
  return health && isValidCount(health.count) ? health.count : fallback
}

function malformedHealth(health: ConversationSourceHealth): boolean {
  const badReason = health.reason !== undefined && health.reason !== null && typeof health.reason !== 'string'
  const badCount = !isValidCount(health.count)
  const badErrorCount = health.errorCount !== undefined && health.errorCount !== null && !isValidCount(health.errorCount)
  return badReason || badCount || badErrorCount
}

/**
 * 唯一的「需要處理」判斷：
 * - warning／error 一律要處理，needsAttention:false 不能蓋掉真正的問題。
 * - missing 只有在後端明講或真的數得到對話時才算問題。
 * - optional／empty／沒有回報且份數為 0，都是正常，不需要修復。
 */
export function sourceNeedsAttention(
  health: ConversationSourceHealth | undefined,
  counts: { current?: number; previous?: number } = {},
): boolean {
  if (!health) return false
  if (health.status === 'warning' || health.status === 'error') return true
  if (health.needsAttention === true) return true
  if (malformedHealth(health)) return true
  if (health.status === 'missing') {
    return validCount(health.count) > 0 || validCount(counts.current) > 0 || validCount(counts.previous) > 0
  }
  return false
}

export type SourceTone = 'error' | 'warning' | 'ok' | 'neutral'

export function sourceTone(
  health: ConversationSourceHealth | undefined,
  count: number,
  needsAttention: boolean,
): SourceTone {
  if (health?.status === 'error') return 'error'
  if (needsAttention) return 'warning'
  if (validCount(count) > 0) return 'ok'
  return 'neutral'
}

export function sourceStatusLabel(
  health: ConversationSourceHealth | undefined,
  count: number,
  needsAttention: boolean,
): string {
  if (!health) return t('找到 {n} 份', { n: count })
  if (health.status === 'error') return t('同步失敗')
  if (health.status === 'warning') return t('部分資料無法確認')
  if (health.status === 'missing') return needsAttention ? t('找不到對話來源') : t('尚未使用，可略過')
  if (health.status === 'optional') return t('尚未使用，可略過')
  if (health.status === 'empty') return t('還沒有對話')
  return t('找到 {n} 份', { n: count })
}

/** 來源說明一律是人看得懂的翻譯字串，不會把物件或壞份數印出來。 */
export function sourceReasonText(health: ConversationSourceHealth | undefined): string {
  if (!health) return ''
  const parts: string[] = []
  if (typeof health.reason === 'string' && health.reason.trim()) parts.push(t(health.reason.trim()))
  else if (health.reason !== undefined && health.reason !== null) parts.push(t(UNREADABLE_REASON_TEXT))
  if (!isValidCount(health.count)) parts.push(t(UNREADABLE_COUNT_TEXT))
  else if (isValidCount(health.errorCount) && health.errorCount > 0) parts.push(t('無法確認 {n} 份資料。', { n: health.errorCount }))
  else if (health.errorCount !== undefined && health.errorCount !== null && !isValidCount(health.errorCount)) parts.push(t(UNREADABLE_COUNT_TEXT))
  return parts.join(' ')
}

function conversationRows(index: IndexData | null): ConversationSummary[] {
  const rows = index?.conversations
  return Array.isArray(rows) ? rows.filter((row): row is ConversationSummary => !!row && typeof row === 'object') : []
}

/**
 * 「目前在原 AI 看得到」才是新手理解的對話數。
 * 子代理和重複副本是技術紀錄，不應該讓首次同步的數字膨脹。
 */
export function conversationSourceCounts(index: IndexData | null): Record<SourceId, number> {
  const counts: Record<SourceId, number> = { codex: 0, claude: 0, qwen: 0, kimi: 0 }
  for (const conversation of conversationRows(index)) {
    if (!(conversation.tool in counts)) continue
    if (!conversation.inApp || conversation.subagent || conversation.dup) continue
    counts[conversation.tool as SourceId] += 1
  }
  return counts
}

export function syncCompletionSummary(
  counts: Record<SourceId, number>,
  health: ConversationSourceHealth[] = [],
  options: { additionalTotal?: number; previousCounts?: Partial<Record<SourceId, number>> } = {},
): { total: number; originalTotal: number; additionalTotal: number; needsAttention: number } {
  const originalTotal = CONVERSATION_SOURCES.reduce((sum, source) => sum + validCount(counts?.[source.id]), 0)
  const additionalTotal = validCount(options.additionalTotal)
  const rows = Array.isArray(health) ? health.filter(isHealthRow) : []
  const healthById = new Map(rows.map((item) => [item.id, item]))
  const needsAttention = CONVERSATION_SOURCES.filter((source) => sourceNeedsAttention(healthById.get(source.id), {
    current: counts?.[source.id],
    previous: options.previousCounts?.[source.id],
  })).length
  return { total: originalTotal + additionalTotal, originalTotal, additionalTotal, needsAttention }
}

type SyncFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ConversationSyncResult {
  index: IndexData
  sources: ConversationSourceHealth[]
  /** 後端回了但無法辨識的來源列數；> 0 時畫面不會宣稱一切正常。 */
  malformedSources: number
}

/** 缺欄位／型別不對的來源列直接丟掉並計數，絕不讓畫面 crash，也不假裝成功。 */
export function normalizeSourceHealth(value: unknown): { sources: ConversationSourceHealth[]; malformed: number } {
  if (value === undefined || value === null) return { sources: [], malformed: 0 }
  if (!Array.isArray(value)) return { sources: [], malformed: 1 }
  const sources: ConversationSourceHealth[] = []
  let malformed = 0
  for (const row of value) {
    if (!row || typeof row !== 'object') { malformed += 1; continue }
    const raw = row as Record<string, unknown>
    if (typeof raw.id !== 'string' || !SOURCE_IDS.includes(raw.id)) { malformed += 1; continue }
    if (typeof raw.status !== 'string' || !STATUS_VALUES.includes(raw.status)) { malformed += 1; continue }
    const item = row as ConversationSourceHealth
    if (typeof item.label !== 'string' || !item.label) {
      const fallback = CONVERSATION_SOURCES.find((source) => source.id === item.id)?.label || item.id
      sources.push({ ...item, label: fallback })
    } else sources.push(item)
    if (malformedHealth(item)) malformed += 1
  }
  return { sources, malformed }
}

export function additionalConversationSources(index: IndexData | null): { id: string; label: string; count: number }[] {
  const found = new Map<string, { id: string; label: string; count: number }>()
  for (const conversation of conversationRows(index)) {
    if (conversation.sourceKind !== 'discovered' || conversation.subagent || conversation.dup) continue
    if (typeof conversation.tool !== 'string' || !conversation.tool) continue
    const label = typeof conversation.toolLabel === 'string' && conversation.toolLabel ? conversation.toolLabel : conversation.tool
    const source = found.get(conversation.tool) || { id: conversation.tool, label, count: 0 }
    source.count += 1
    found.set(conversation.tool, source)
  }
  return [...found.values()]
}

export function scanCoverageWarning(scan?: ConversationScanReport): boolean {
  return !!scan && scan.complete !== true
}

export function scanReasons(scan?: ConversationScanReport): string[] {
  return Array.isArray(scan?.reasons) ? scan.reasons.filter((reason): reason is string => typeof reason === 'string' && !!reason.trim()) : []
}

export function scanRoots(scan?: ConversationScanReport): string[] {
  return Array.isArray(scan?.roots) ? scan.roots.filter((root): root is string => typeof root === 'string' && !!root.trim()) : []
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
  const reply = await response.json().catch(() => null) as {
    ok?: boolean
    error?: string
    out?: string
    sources?: unknown
  } | null
  const failure = typeof reply?.error === 'string' ? reply.error : typeof reply?.out === 'string' ? reply.out : ''
  if (!response.ok || !reply || reply.ok !== true) throw new Error(failure || `HTTP ${response.status}`)

  const indexResponse = await fetcher(`/data/index.json?sync=${Date.now()}`, { cache: 'no-store', signal })
  if (!indexResponse.ok) throw new Error(`同步完成，但讀不到新索引（HTTP ${indexResponse.status}）`)
  const index = await indexResponse.json().catch(() => null) as IndexData | null
  if (!index || typeof index !== 'object' || (index.conversations !== undefined && !Array.isArray(index.conversations))) {
    throw new Error('同步完成，但讀回的索引格式無法辨識，畫面先保留舊清單。')
  }
  const health = normalizeSourceHealth(reply.sources)
  return { index, sources: health.sources, malformedSources: health.malformed }
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
  const [malformedSources, setMalformedSources] = useState(0)
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
    () => new Map(sourceHealth.filter(isHealthRow).map((item) => [item.id, item])),
    [sourceHealth],
  )
  const completion = useMemo(
    () => syncCompletionSummary(shownCounts, sourceHealth, { additionalTotal, previousCounts: beforeCounts }),
    [shownCounts, sourceHealth, additionalTotal, beforeCounts],
  )
  const hasFolderPicker = typeof window !== 'undefined' && typeof window.acSetup?.chooseDirectory === 'function'
  const scan = shownIndex?.scan
  const scanIncomplete = scanCoverageWarning(scan)

  useEffect(() => {
    if (state !== 'scanning') return
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [state])

  useEffect(() => () => abortRef.current?.abort(), [])

  const chooseFolder = () => {
    void window.acSetup?.chooseDirectory()
      .then(path => { if (path) setExtraRoots(current => extraScanRoots(`${current}\n${path}`).join('\n')) })
      .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))
  }

  const sync = async () => {
    if (state === 'scanning' || !apiOk) return
    startedAt.current = Date.now()
    setBeforeCounts(conversationSourceCounts(index))
    setElapsed(0)
    setError('')
    setResultIndex(null)
    setSourceHealth([])
    setMalformedSources(0)
    setState('scanning')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await requestConversationSync(fetch, controller.signal, { deep, extraRoots: extraScanRoots(extraRoots) })
      const nextIndex = result.index
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)))
      setResultIndex(nextIndex)
      setSourceHealth(result.sources)
      setMalformedSources(result.malformedSources)
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
          {hasFolderPicker && <button type="button" className="mt-2 rounded-md border border-line2 px-3 py-1.5 text-sm" onClick={chooseFolder}>{t('選擇資料夾')}</button>}
          <p className="mt-2 text-xs leading-5 text-mute2">{t('只加入存放對話的資料夾，避免選取整顆磁碟。')}</p>
        </details>
      </fieldset>

      <section aria-labelledby="import-guide-title" className="rounded-xl border border-line bg-panel p-4">
        <h2 id="import-guide-title" className="text-sm font-semibold text-ink">{t('我只用聊天網站／已有匯出檔？')}</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-5 text-mute2">
          {IMPORT_GUIDE_STEPS.map(step => <li key={step}>{t(step)}</li>)}
        </ol>
        <p className="mt-2 text-xs leading-5 text-mute2">
          {hasFolderPicker
            ? t('桌面版：按「選擇對話資料夾」即可加入，路徑會填進上面的其他對話資料夾。')
            : t('瀏覽器版沒有資料夾選擇器：請改在上面「進階：其他對話資料夾」貼上完整資料夾路徑。')}
        </p>
        {hasFolderPicker && (
          <button
            type="button"
            className="mt-2 rounded-md border border-line2 px-3 py-1.5 text-sm hover:bg-elev disabled:cursor-not-allowed disabled:opacity-40"
            disabled={state === 'scanning'}
            onClick={chooseFolder}
          >
            {t('選擇對話資料夾')}
          </button>
        )}
        <p className="mt-2 text-xs leading-5 text-mute2">{t(IMPORT_GUIDE_FORMAT_TEXT)}</p>
        <p className="mt-2 text-xs leading-5 text-mute2">{t(IMPORT_GUIDE_FILTER_TEXT)}</p>
        <ul className="mt-2 space-y-1 text-xs leading-5">
          {IMPORT_GUIDE_LINKS.map(link => (
            <li key={link.href}>
              <a className="underline" href={link.href} target="_blank" rel="noreferrer">{t(link.label)}</a>
            </li>
          ))}
        </ul>
      </section>

      <div
        className="grid gap-3 sm:grid-cols-2"
        aria-label={t('各 AI 對話同步狀態')}
        aria-live="polite"
        aria-busy={state === 'scanning'}
      >
        {CONVERSATION_SOURCES.map((source) => {
          const health = state === 'complete' ? healthById.get(source.id) : undefined
          const count = sourceCount(health, shownCounts[source.id])
          const delta = state === 'complete' ? count - beforeCounts[source.id] : 0
          const attention = sourceNeedsAttention(health, { current: count, previous: beforeCounts[source.id] })
          const tone = sourceTone(health, count, attention)
          const reason = state === 'complete' ? sourceReasonText(health) : ''
          const dot = state === 'scanning'
            ? 'animate-pulse bg-amber-500'
            : state === 'error' || tone === 'error'
              ? 'bg-red-500'
              : tone === 'warning'
                ? 'bg-amber-500'
                : tone === 'ok'
                  ? 'bg-emerald-500'
                  : 'bg-mute'
          return (
            <article key={source.id} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dot}`} />
                <h2 className="font-medium text-ink">{source.label}</h2>
                <span className="ml-auto text-sm text-mute2">
                  {state === 'scanning'
                    ? t('掃描中…')
                    : state === 'error'
                      ? t('同步失敗')
                    : state === 'stopped'
                      ? t('已停止等待')
                    : state === 'complete'
                      ? sourceStatusLabel(health, count, attention)
                      : t('目前 {n} 份', { n: count })}
                </span>
              </div>
              {state === 'complete' && delta !== 0 && (
                <p className="mt-2 text-xs text-mute2">
                  {delta > 0 ? t('比同步前多 {n} 份', { n: delta }) : t('比同步前少 {n} 份', { n: Math.abs(delta) })}
                </p>
              )}
              {reason && (
                <p className={`mt-2 text-xs leading-5 ${tone === 'error' ? 'text-red-700 dark:text-red-300' : tone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-mute2'}`}>
                  {reason}
                </p>
              )}
              {state === 'complete' && attention && tone !== 'error'
                && (health?.status === 'missing' || health?.status === 'empty') && (
                <p className="mt-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                  {t(REPAIR_TEXT[source.id])}
                </p>
              )}
            </article>
          )
        })}
      </div>

      {state === 'complete' && malformedSources > 0 && (
        <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          {t(MALFORMED_SOURCES_TEXT)}
        </p>
      )}

      {additionalSources.length > 0 && <section aria-labelledby="additional-conversation-sources">
        <h2 id="additional-conversation-sources" className="text-sm font-semibold">{t('其他找到的對話來源')}</h2>
        <p className="mt-1 text-xs leading-5 text-mute2">{t('這些對話以唯讀方式匯入，可以在控制台查看，但不會在原 AI 中開啟。')}</p>
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
          <p className={`font-medium ${scanIncomplete || completion.needsAttention > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
            {scanIncomplete
              ? t('已更新找到的 {n} 份對話；部分位置尚未完成搜尋。', { n: completion.total })
              : completion.needsAttention > 0
                ? t('同步完成，共找到 {total} 份對話；有 {count} 個 AI 需要處理。', {
                  total: completion.total,
                  count: completion.needsAttention,
                })
              : completion.additionalTotal > 0
                ? t('同步完成，共找到 {total} 份對話：{original} 份可在原 AI 開啟，{extra} 份為唯讀匯入。', {
                  total: completion.total,
                  original: completion.originalTotal,
                  extra: completion.additionalTotal,
                })
                : t('同步完成，共找到 {n} 份可在原 AI 開啟的對話。', { n: completion.originalTotal })}{' '}{t('耗時 {n} 秒。', { n: elapsed })}
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
          <p>{scan ? t('目前清單來自上次搜尋；可以再次搜尋更新。') : t('選擇搜尋範圍後開始，找到的對話會加入控制台清單。')}</p>
        )}
      </div>

      {scan && <div role={scanIncomplete ? 'status' : undefined} className={`rounded-xl border p-4 text-sm ${scanIncomplete ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300' : 'border-line text-mute2'}`}>
        <p className="font-medium">{scanIncomplete ? t('這次搜尋有未完成的部分') : t('已完成這次指定範圍的搜尋')}</p>
        <p className="mt-1 text-xs leading-5">{t('這是所選範圍內的搜尋結果，不代表電腦上所有位置都已搜尋。')}</p>
        {scanReasons(scan).length > 0 && <ul className="mt-2 list-inside list-disc text-xs leading-6">{scanReasons(scan).map((reason, i) => <li key={`${i}:${reason}`}>{scanReasonText(reason)}</li>)}</ul>}
        <details className="mt-2 text-xs"><summary className="cursor-pointer">{t('查看搜尋範圍與數量')}</summary>{isValidCount(scan.filesInspected) && isValidCount(scan.directories) && isValidCount(scan.skippedFiles) && isValidCount(scan.skippedDirectories)
          ? <p className="mt-2">{t('已檢查 {files} 個檔案、{dirs} 個資料夾；跳過 {skipped} 項。', { files: scan.filesInspected, dirs: scan.directories, skipped: scan.skippedFiles + scan.skippedDirectories })}</p>
          : <p className="mt-2">{t('這次搜尋的統計數字無法確認。')}</p>}<ul className="mt-2 space-y-1 break-all">{scanRoots(scan).map(root => <li key={root}>{root}</li>)}</ul>{scan.cached && <p className="mt-2">{t('目前顯示上次搜尋的紀錄；重新搜尋可更新。')}</p>}</details>
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
