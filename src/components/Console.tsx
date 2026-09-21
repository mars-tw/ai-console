/* eslint-disable react-refresh/only-export-components -- small formatters are covered by focused tests */
import { useEffect, useRef, useState } from 'react'
import { t, useLang } from '@/i18n'
import { canDispatch, type ReadinessSnapshot } from '@/lib/aiReadiness'
import { isLive, look, stateOf } from '@/lib/dispatchState'
import type { DevSpaceConversationPreparation } from '@/lib/devspace'
import type { DispatchRecord } from '@/types/data'

export type ConsoleDispatch = DispatchRecord & {
  outcome?: 'ok' | 'no_changes' | 'blocked' | 'error' | 'stopped' | null
  issue?: string
  canDiff?: boolean
  cost?: { usd?: number }
  stopped?: boolean
  cancelled?: boolean
}

interface DispatchDiffFile {
  path?: string
  added?: number
  removed?: number
  patch?: string
}

interface DispatchDiff {
  ok?: boolean
  cwd?: string
  isGit?: boolean
  files?: DispatchDiffFile[]
  error?: string
}

interface ScheduledRecord {
  id: string
  name?: string
  task?: string
  tool?: string
  enabled?: boolean
  desc?: string
  nextRun?: number
}

export interface ConsoleProps {
  onSetup?: () => void
  draft?: string
  onDraftChange?: (value: string) => void
  onPrepareConversation?: (request: DevSpaceConversationPreparation) => void
}

/** Kept for compatibility with status parsing tests; execution UI no longer uses this gate. */
export function canDispatchAll(targets: string[], snapshot?: ReadinessSnapshot | null): boolean {
  if (!snapshot?.ok || !targets.length) return false
  const ids = snapshot.tools.map(row => row.id)
  if (new Set(ids).size !== ids.length) return false
  return targets.every(target => canDispatch(target, snapshot.tools, snapshot.auto))
}

export function planReplyMessage(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  const data = body as Record<string, unknown>
  return ['error', 'note', 'nextAction']
    .map(key => typeof data[key] === 'string' ? data[key].trim() : '')
    .filter(Boolean)
    .join('・')
}

export function isLocalAnswerRecord(record: { tool?: string; mode?: string } | null | undefined): boolean {
  return !!record && (record.tool === 'local' || record.mode === 'sync')
}

function recordContext(record: ConsoleDispatch) {
  const context = [
    record.result ? { role: 'assistant', text: record.result, label: '舊派工結果' } : null,
    record.tail ? { role: 'assistant', text: record.tail, label: '舊派工最後輸出' } : null,
    record.issue ? { role: 'assistant', text: record.issue, label: '舊派工問題' } : null,
  ].filter((item): item is { role: string; text: string; label: string } => !!item)
  return context
}

const button = 'rounded-md border border-line2 px-3 py-2 text-xs hover:bg-elev disabled:cursor-not-allowed disabled:opacity-40'

/**
 * Legacy job records remain visible and stoppable, but every new/retry/follow-up coding action is
 * converted into a ChatGPT Conversation + DevSpace draft. This component never posts dispatch,
 * batch, retry, follow-up, schedule-run, schedule-save, launch, or terminal-start requests.
 */
export default function Console({ draft: controlledDraft, onDraftChange, onPrepareConversation }: ConsoleProps) {
  useLang()
  const [ownDraft, setOwnDraft] = useState('')
  const draft = typeof controlledDraft === 'string' ? controlledDraft : ownDraft
  const setDraft = (value: string) => {
    if (typeof controlledDraft !== 'string') setOwnDraft(value)
    onDraftChange?.(value)
  }
  const [workDir, setWorkDir] = useState(() => {
    try { return localStorage.getItem('ac_workdir') || '' } catch { return '' }
  })
  useEffect(() => {
    try { localStorage.setItem('ac_workdir', workDir) } catch { /* path preference is optional */ }
  }, [workDir])

  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [records, setRecords] = useState<ConsoleDispatch[]>([])
  const [schedules, setSchedules] = useState<ScheduledRecord[]>([])
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [busy, setBusy] = useState('')
  const [openLog, setOpenLog] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, string>>({})
  const [diffFor, setDiffFor] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, DispatchDiff>>({})
  const mounted = useRef(true)

  const pull = () => {
    fetch('/api/dispatches', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (mounted.current && Array.isArray(data?.dispatches)) setRecords(data.dispatches) })
      .catch(() => {})
    fetch('/api/schedules', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (mounted.current && Array.isArray(data?.jobs)) setSchedules(data.jobs) })
      .catch(() => {})
  }

  useEffect(() => {
    mounted.current = true
    pull()
    const timer = setInterval(pull, 8000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [])

  const prepare = (request: DevSpaceConversationPreparation) => {
    if (!onPrepareConversation) {
      setError(t('請改用 DevSpace 分頁準備 ChatGPT 執行對話。'))
      return
    }
    setError('')
    setNotice(t('已準備 ChatGPT 對話草稿；沒有建立或接續任何 CLI 工單。'))
    onPrepareConversation(request)
  }

  const prepareNew = () => {
    const task = draft.trim()
    if (!task) return
    prepare({
      task,
      ...(workDir.trim() ? { workspace: workDir.trim() } : {}),
      title: t('派工主控台的新工作'),
      source: 'new-work',
    })
  }

  const prepareRetry = (record: ConsoleDispatch) => prepare({
    task: `請重新檢查並完成這項舊工作：\n${record.task}`,
    ...(record.cwd ? { workspace: record.cwd } : {}),
    title: `舊派工 ${record.id}`,
    originalTool: record.tool,
    source: 'legacy-retry',
    context: recordContext(record),
  })

  const prepareFollowup = (record: ConsoleDispatch) => {
    const text = replyText.trim()
    if (!text) return
    prepare({
      task: `請根據舊工作與目前補充繼續處理。\n\n【舊工作】\n${record.task}\n\n【本次補充】\n${text}`,
      ...(record.cwd ? { workspace: record.cwd } : {}),
      title: `舊派工 ${record.id} 的續作`,
      originalTool: record.tool,
      source: 'legacy-followup',
      context: recordContext(record),
    })
  }

  const prepareSchedule = (job: ScheduledRecord) => prepare({
    task: job.task || job.name || t('檢查這項舊排程工作'),
    title: job.name || `排程 ${job.id}`,
    originalTool: job.tool,
    source: 'schedule',
  })

  const control = async (action: 'stop' | 'cancel', record: ConsoleDispatch) => {
    if (busy) return
    if (action === 'stop' && !window.confirm(t('確定要停止這件舊派工嗎？'))) return
    setBusy(`${action}:${record.id}`)
    setError('')
    try {
      const response = await fetch(`/api/dispatch/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: record.id }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || data?.ok !== true) throw new Error(data?.error || t('操作未完成'))
      setNotice(data.note || t(action === 'stop' ? '已要求停止舊派工。' : '已取消尚未開始的舊派工。'))
      pull()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('操作未完成'))
    } finally { if (mounted.current) setBusy('') }
  }

  const toggleLog = async (record: ConsoleDispatch) => {
    if (openLog === record.id) { setOpenLog(null); return }
    setOpenLog(record.id)
    if (logs[record.id] !== undefined) return
    try {
      const response = await fetch(`/api/dispatch/log?id=${encodeURIComponent(record.id)}`)
      const data = await response.json()
      setLogs(current => ({ ...current, [record.id]: response.ok && data?.ok ? String(data.text || '') : String(data?.error || t('日誌讀取失敗')) }))
    } catch { setLogs(current => ({ ...current, [record.id]: t('日誌讀取失敗') })) }
  }

  const toggleDiff = async (record: ConsoleDispatch) => {
    if (diffFor === record.id) { setDiffFor(null); return }
    setDiffFor(record.id)
    if (diffs[record.id] !== undefined) return
    try {
      const response = await fetch(`/api/dispatch/diff?id=${encodeURIComponent(record.id)}`)
      const data = await response.json() as DispatchDiff
      setDiffs(current => ({ ...current, [record.id]: data }))
    } catch { setDiffs(current => ({ ...current, [record.id]: { ok: false, error: t('差異讀取失敗') } })) }
  }

  const live = records.filter(isLive)
  const done = records.filter(record => !isLive(record))

  return (
    <section className="min-h-0 flex-1 overflow-y-auto bg-app" aria-labelledby="console-heading">
      <div className="mx-auto max-w-5xl space-y-6 px-5 py-6">
        <header>
          <p className="font-mono text-xs text-mute2">ChatGPT Conversation / DevSpace MCP</p>
          <h1 id="console-heading" className="mt-2 text-2xl font-semibold">{t('執行準備與舊派工紀錄')}</h1>
          <p className="mt-2 text-sm leading-6 text-mute2">
            {t('新的編碼工作、重做與續作都會前往 DevSpace 分頁，讓你貼入 ChatGPT「對話」。下方舊派工只供查看、停止或取消。')}
          </p>
        </header>

        {(error || notice) && <p role={error ? 'alert' : 'status'} className={`rounded-lg border p-3 text-sm ${error ? 'border-red-500/40 text-red-700 dark:text-red-300' : 'border-line bg-panel text-ink2'}`}>{error || notice}</p>}

        <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
          <h2 className="font-semibold">{t('準備新的 ChatGPT 執行對話')}</h2>
          <label htmlFor="console-workdir" className="block text-xs text-mute2">{t('專案資料夾')}</label>
          <input id="console-workdir" className="w-full rounded-md border border-line2 bg-app px-3 py-2 font-mono text-sm" value={workDir} onChange={event => setWorkDir(event.target.value)} placeholder="C:\\Projects\\my-project" />
          <label htmlFor="console-task" className="block text-xs text-mute2">{t('工作內容')}</label>
          <textarea id="console-task" rows={6} className="w-full rounded-md border border-line2 bg-app px-3 py-2 text-sm" value={draft} onChange={event => setDraft(event.target.value)} placeholder={t('寫清楚目標、可修改範圍、驗收方式與禁止事項。')} />
          <button type="button" className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-invink disabled:opacity-40" disabled={!draft.trim() || !onPrepareConversation} onClick={prepareNew}>{t('準備 ChatGPT 對話')}</button>
          <p className="text-xs leading-5 text-mute2">{t('此按鈕不會送出工作；它只把內容帶到 DevSpace 分頁，保留給你確認、複製與開啟 ChatGPT。')}</p>
        </div>

        <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">{t('舊派工紀錄（唯讀）')}</h2>
            <button type="button" className={button} onClick={pull}>{t('重新整理狀態')}</button>
          </div>
          <p className="text-xs leading-5 text-mute2">{t('讀取這份清單不會送出補話、重派或自動接力。只有「停止」與「取消」仍會操作已存在的舊工作。')}</p>
          {!records.length && <p className="text-sm text-mute3">{t('目前沒有任何派工紀錄')}</p>}
          {[...live, ...done].map(record => {
            const state = stateOf(record)
            const status = look(state)
            const running = state === 'running'
            const waiting = state === 'waiting'
            return (
              <article key={record.id} className="rounded-lg border border-line2 bg-app p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{record.tool}</span>
                  <span className={`text-xs ${status.tone}`}>{status.label}</span>
                  <span className="ml-auto font-mono text-[11px] text-mute3">{record.id}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink2">{record.task}</p>
                {record.cwd && <p className="mt-2 break-all font-mono text-xs text-mute3">{record.cwd}</p>}
                {record.tail && <p className="mt-2 truncate rounded bg-panel px-2 py-1 font-mono text-xs text-mute2">{record.tail}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {running && record.mode !== 'terminal' && <button type="button" className={button} disabled={!!busy} onClick={() => void control('stop', record)}>{busy === `stop:${record.id}` ? t('正在停止…') : t('⏹ 停止')}</button>}
                  {waiting && <button type="button" className={button} disabled={!!busy} onClick={() => void control('cancel', record)}>{busy === `cancel:${record.id}` ? t('正在取消…') : t('✕ 取消')}</button>}
                  <button type="button" className={button} onClick={() => prepareRetry(record)}>{t('在 ChatGPT 對話重做')}</button>
                  {!isLocalAnswerRecord(record) && <button type="button" className={button} onClick={() => { setReplyTo(replyTo === record.id ? null : record.id); setReplyText('') }}>{t('在 ChatGPT 對話續作')}</button>}
                  <button type="button" className={button} onClick={() => void toggleLog(record)}>{openLog === record.id ? t('收合日誌') : t('查看日誌')}</button>
                  {record.canDiff && !isLocalAnswerRecord(record) && <button type="button" className={button} onClick={() => void toggleDiff(record)}>{diffFor === record.id ? t('收合差異') : t('查看目前差異')}</button>}
                </div>
                {replyTo === record.id && <div className="mt-3 rounded-md border border-line2 bg-panel p-3">
                  <label htmlFor={`followup-${record.id}`} className="text-xs text-mute2">{t('要帶到新 ChatGPT 對話的補充')}</label>
                  <textarea id={`followup-${record.id}`} rows={3} className="mt-1 w-full rounded-md border border-line2 bg-app px-3 py-2 text-sm" value={replyText} onChange={event => setReplyText(event.target.value)} />
                  <button type="button" className="mt-2 rounded-md bg-ink px-3 py-2 text-xs text-invink disabled:opacity-40" disabled={!replyText.trim()} onClick={() => prepareFollowup(record)}>{t('準備續作對話')}</button>
                </div>}
                {openLog === record.id && <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-3 text-xs">{logs[record.id] ?? t('日誌載入中…')}</pre>}
                {diffFor === record.id && <div className="mt-3 rounded-md bg-panel p-3 text-xs">
                  {diffs[record.id]?.error ? <p>{diffs[record.id].error}</p> : (diffs[record.id]?.files || []).map(file => <div key={file.path} className="mb-2"><p className="font-mono">{file.path} +{file.added || 0} −{file.removed || 0}</p>{file.patch && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{file.patch}</pre>}</div>)}
                  {diffs[record.id] && !diffs[record.id].error && !(diffs[record.id].files || []).length && <p>{t('目前沒有可顯示的 Git 差異')}</p>}
                  {!diffs[record.id] && <p>{t('差異載入中…')}</p>}
                </div>}
              </article>
            )
          })}
        </div>

        {!!schedules.length && <div className="rounded-xl border border-line bg-panel p-5 space-y-3">
          <h2 className="font-semibold">{t('舊排程紀錄（不再自動執行）')}</h2>
          <p className="text-xs leading-5 text-mute2">{t('控制台不會再由背景排程啟動編碼工作。可把內容帶到 ChatGPT 對話後自行確認執行。')}</p>
          {schedules.map(job => <div key={job.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line2 px-3 py-2 text-sm">
            <span className="font-medium">{job.name || job.id}</span>
            <span className="min-w-0 flex-1 truncate text-mute2">{job.task}</span>
            <button type="button" className={button} onClick={() => prepareSchedule(job)}>{t('準備 ChatGPT 對話')}</button>
          </div>)}
        </div>}
      </div>
    </section>
  )
}
