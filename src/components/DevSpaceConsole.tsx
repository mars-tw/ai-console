import { useEffect, useRef, useState } from 'react'
import { t, useLang } from '@/i18n'
import {
  DEVSPACE_TARGETS, devSpaceRequest, devSpaceRunProblem, devSpaceTaskLabel,
  parseDevSpaceStatus, parseDevSpaceTask, parseDevSpaceTasks, pollDevSpace, withinDevSpaceRoots,
} from '@/lib/devspace'
import type { DevSpaceStatus, DevSpaceTask } from '@/lib/devspace'

const button = 'rounded-md border border-line2 px-3 py-2 text-xs font-medium hover:bg-elev disabled:cursor-not-allowed disabled:opacity-40'
const input = 'w-full rounded-md border border-line2 bg-panel px-3 py-2 text-sm text-ink'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export default function DevSpaceConsole() {
  useLang()
  const [status, setStatus] = useState<DevSpaceStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [revision, setRevision] = useState(0)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [diagnostic, setDiagnostic] = useState('')
  const [history, setHistory] = useState<{ cwd: string; resolvedCwd: string; tasks: DevSpaceTask[]; error: string } | null>(null)
  const [selected, setSelected] = useState<{ cwd: string; id: string } | null>(null)
  const [detail, setDetail] = useState<{ cwd: string; id: string; task?: DevSpaceTask; error?: string } | null>(null)
  const [continuations, setContinuations] = useState<Record<string, string>>({})
  const actionRef = useRef<AbortController | null>(null)
  const mounted = useRef(false)

  const cwd = workspace ?? status?.allowedRoots[0] ?? ''
  const currentTarget = target || status?.targets[0]?.name || ''
  const online = !!status && !statusError
  const workspaceAllowed = !!status && withinDevSpaceRoots(cwd, status.allowedRoots)
  const canRead = online && !!status?.configured && workspaceAllowed
  const currentHistory = history?.cwd === cwd ? history : null
  const executionCwd = currentHistory?.resolvedCwd || cwd
  const selectedId = selected?.cwd === cwd ? selected.id : ''
  const currentDetail = detail?.cwd === cwd && detail.id === selectedId ? detail : null
  const task = currentDetail?.task
  const followKey = JSON.stringify([cwd, selectedId])
  const continuation = continuations[followKey] ?? ''
  const problem = statusError || devSpaceRunProblem(status, cwd, currentTarget, draft)
  const listedTask = currentHistory?.tasks.find(item => item.id === selectedId)
  const knownTarget = task?.provider ?? listedTask?.provider ?? task?.target ?? listedTask?.target
  const continueEnabled = !!task && task.status !== 'running' && !!knownTarget
    && !!status?.targets.some(item => item.name === knownTarget) && canRead
  const hasPicker = typeof window !== 'undefined' && typeof window.acSetup?.chooseDirectory === 'function'

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; actionRef.current?.abort() }
  }, [])

  useEffect(() => pollDevSpace(
    async signal => parseDevSpaceStatus(await devSpaceRequest('status', undefined, signal)),
    data => { setStatus(data); setStatusError('') },
    error => { setStatusError(message(error)); setStatus(null) },
    7000,
  ), [revision])

  useEffect(() => {
    if (!canRead) return
    return pollDevSpace(
      async signal => {
        const result = await devSpaceRequest('tasks', { cwd }, signal)
        return { tasks: parseDevSpaceTasks(result.tasks), resolvedCwd: typeof result.cwd === 'string' ? result.cwd : cwd }
      },
      result => setHistory({ cwd, ...result, error: '' }),
      error => setHistory({ cwd, resolvedCwd: '', tasks: [], error: message(error) }),
    )
  }, [cwd, canRead, revision])

  useEffect(() => {
    if (!selectedId || !canRead) return
    return pollDevSpace(
      async signal => parseDevSpaceTask((await devSpaceRequest('show', { cwd, id: selectedId }, signal)).task),
      result => setDetail({ cwd, id: selectedId, task: result }),
      error => setDetail({ cwd, id: selectedId, error: message(error) }),
    )
  }, [cwd, selectedId, canRead, revision])

  async function action(name: string, work: (signal: AbortSignal) => Promise<void>) {
    if (actionRef.current) return
    const controller = new AbortController()
    actionRef.current = controller
    setBusy(name)
    setActionError('')
    setNotice('')
    try { await work(controller.signal) } catch (error) {
      if (!controller.signal.aborted) setActionError(message(error))
    } finally {
      if (mounted.current && !controller.signal.aborted) {
        setBusy('')
        setRevision(value => value + 1)
      }
      if (actionRef.current === controller) actionRef.current = null
    }
  }

  function serviceAction(name: 'start' | 'stop' | 'doctor') {
    void action(name, async signal => {
      const result = await devSpaceRequest(name, {}, signal)
      if (signal.aborted) return
      if (name === 'doctor') {
        setDiagnostic(typeof result.output === 'string' ? result.output : '')
        setNotice('DevSpace 檢查完成。')
      } else {
        setStatus(parseDevSpaceStatus(result.status))
        setStatusError('')
        setNotice(name === 'start' ? 'MCP 服務已啟動或連上既有服務。' : '本控制台啟動的 MCP 服務已停止。')
      }
    })
  }

  function submit(follow = false) {
    if (follow ? !continueEnabled || !continuation.trim() : !!problem) return
    const prompt = follow ? continuation : draft
    void action(follow ? 'continue' : 'run', async signal => {
      const result = await devSpaceRequest(follow ? 'continue' : 'run', follow
        ? { cwd: executionCwd, id: selectedId, prompt: prompt.trim() }
        : { cwd: executionCwd, target: currentTarget, prompt: prompt.trim() }, signal)
      if (signal.aborted) return
      const receipt = parseDevSpaceTask(result.task)
      setSelected({ cwd, id: receipt.id })
      setDetail({ cwd, id: receipt.id, task: receipt })
      if (follow) setContinuations(current => ({ ...current, [followKey]: current[followKey] === prompt ? '' : current[followKey] }))
      else setDraft(current => current === prompt ? '' : current)
      setNotice('工作已送出，結果會自動更新。')
    })
  }

  async function chooseDirectory() {
    try {
      const path = await window.acSetup?.chooseDirectory()
      if (path && mounted.current) { setWorkspace(path); setActionError(''); setNotice('') }
    } catch (error) { if (mounted.current) setActionError(message(error)) }
  }

  async function copyEndpoint() {
    try {
      if (!status?.endpoint) return
      await navigator.clipboard.writeText(status.endpoint)
      if (mounted.current) setNotice('已複製 MCP 網址。')
    } catch { if (mounted.current) setActionError('無法使用剪貼簿，請選取 MCP 網址後複製。') }
  }

  return (
    <section aria-labelledby="devspace-heading" className="min-h-0 flex-1 overflow-y-auto bg-app">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="mb-1 font-mono text-xs tracking-widest text-mute2">MCP / AGENTS</p>
            <h1 id="devspace-heading" className="text-2xl font-semibold tracking-tight">DevSpace</h1>
            <p className="mt-2 text-sm text-mute2">{t('在自己的工作目錄派工、接續任務，並查看執行結果。')}</p>
          </div>
          <button type="button" className={button} disabled={!!busy} onClick={() => setRevision(value => value + 1)}>{t('重新整理狀態')}</button>
        </header>

        {(actionError || statusError) && <div role="alert" className="mb-4 rounded-lg border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {t(actionError || statusError)}
          {actionError && <p className="mt-1 text-xs">{t('輸入內容已保留。若送出時連線中斷，先查看任務紀錄，再決定是否重送。')}</p>}
        </div>}
        {notice && <p role="status" className="mb-4 text-sm text-ink2">{t(notice)}</p>}

        <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside aria-label={t('DevSpace 連線狀態')} className="space-y-5 rounded-xl border border-line bg-panel p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{t('本機連線')}</h2>
              <span className="font-mono text-xs text-mute2">{status?.version ? `v${status.version}` : 'DevSpace'}</span>
            </div>
            <dl className="space-y-4 text-sm">
              <div><dt className="text-xs text-mute2">{t('CLI 安裝')}</dt><dd className="mt-1 font-medium">{status ? t(status.installed ? '已安裝' : '尚未安裝') : t(statusError ? '狀態無法讀取' : '正在讀取…')}</dd></div>
              <div><dt className="text-xs text-mute2">{t('工作目錄設定')}</dt><dd className="mt-1 font-medium">{status ? t(status.configured ? '已設定' : '尚未設定') : '—'}</dd></div>
              <div className="border-l-2 border-line2 pl-3"><dt className="text-xs text-mute2">{t('MCP 服務')}</dt><dd className="mt-1 flex items-center gap-2 font-medium"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${status?.service.running ? 'bg-emerald-500' : 'bg-line3'}`} />{status ? t(status.service.running ? '已連線' : '未連線') : '—'}</dd>
                {status?.service.running && <dd className="mt-1 text-xs text-mute2">{t(status.service.managed ? '由本控制台管理' : '外部服務，本控制台不會停止它')}</dd>}
              </div>
              <div className="border-l-2 border-line2 pl-3"><dt className="text-xs text-mute2">{t('任務服務')}</dt><dd className="mt-1 font-medium">{status ? t(status.daemon.running ? '執行中' : '未連線') : '—'}</dd>
                <dd className="mt-1 text-xs text-mute2">{status?.daemon.running ? t('目前有 {n} 個工作正在執行', { n: status.daemon.activeTurns }) : t('送出工作時由 DevSpace 啟動。')}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              <button type="button" className={button} disabled={!!busy || !online || !status?.installed || !status.configured || status.service.running} onClick={() => serviceAction('start')}>{t(busy === 'start' ? '啟動中…' : '啟動 MCP')}</button>
              <button type="button" className={button} disabled={!!busy || !online || !status?.service.managed} onClick={() => serviceAction('stop')}>{t(busy === 'stop' ? '停止中…' : '停止 MCP')}</button>
              <button type="button" className={`${button} w-full`} disabled={!!busy || !online || !status?.installed} onClick={() => serviceAction('doctor')}>{t(busy === 'doctor' ? '檢查中…' : '檢查 DevSpace 設定')}</button>
            </div>
            {status?.endpoint && <div className="border-t border-line pt-4">
              <label htmlFor="devspace-endpoint" className="text-xs text-mute2">{t('MCP 網址')}</label>
              <input id="devspace-endpoint" className="mt-2 w-full rounded border border-line bg-app p-2 font-mono text-xs" value={status.endpoint} readOnly />
              <button type="button" className="mt-2 text-xs underline underline-offset-4" onClick={() => { void copyEndpoint() }}>{t('複製 MCP 網址')}</button>
            </div>}
            {status && (!status.installed || !status.configured) && <div className="border-t border-line pt-4 text-xs leading-6 text-mute2">
              <p>{t('依 DevSpace 官方說明安裝，並設定允許的工作目錄與執行者。')}</p>
              <a className="underline underline-offset-4" href="https://github.com/Waishnav/devspace" target="_blank" rel="noreferrer">{t('開啟 DevSpace 安裝說明')}</a>
            </div>}
            {status?.configPath && <details className="text-xs text-mute2"><summary className="cursor-pointer">{t('設定檔位置')}</summary><p className="mt-2 break-all font-mono">{status.configPath}</p></details>}
          </aside>

          <div className="min-w-0 space-y-6">
            <section className="rounded-xl border border-line bg-panel p-5 sm:p-6" aria-labelledby="devspace-new-work">
              <h2 id="devspace-new-work" className="text-base font-semibold">{t('新增 DevSpace 工作')}</h2>
              <form className="mt-5 space-y-5" onSubmit={event => { event.preventDefault(); submit() }}>
                <div>
                  <label className="mb-2 block text-xs font-medium text-mute2" htmlFor="devspace-root">{t('允許的工作目錄')}</label>
                  <select id="devspace-root" className={input} value={status?.allowedRoots.includes(cwd) ? cwd : ''} disabled={!!busy || !status?.allowedRoots.length} onChange={event => setWorkspace(event.target.value)}>
                    <option value="">{t(status?.allowedRoots.length ? '選擇目錄，或在下方填入子目錄' : '尚未設定允許的工作目錄')}</option>
                    {status?.allowedRoots.map(root => <option key={root} value={root}>{root}</option>)}
                  </select>
                  <label className="mb-2 mt-3 block text-xs text-mute2" htmlFor="devspace-cwd">{t('專案或子目錄')}</label>
                  <div className="flex items-start gap-2">
                    <input id="devspace-cwd" className={`${input} min-w-0 font-mono text-xs`} value={cwd} disabled={!!busy} onChange={event => setWorkspace(event.target.value)} placeholder={t('填入完整目錄路徑')} autoComplete="off" spellCheck={false} />
                    {hasPicker && <button type="button" className={`${button} flex-none`} disabled={!!busy} onClick={() => { void chooseDirectory() }}>{t('選擇資料夾')}</button>}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-mute2">{t('工作能讀寫所選專案內的檔案。子目錄也必須位於允許的範圍內。')}</p>
                  <p className="mt-1 text-xs leading-5 text-mute2">{t('Git 專案會使用專案根目錄執行。')}</p>
                  {currentHistory?.resolvedCwd && <p className="mt-2 break-all rounded-md bg-app px-3 py-2 text-xs text-mute2">{t('實際執行目錄')}<span className="mt-1 block font-mono text-ink2">{currentHistory.resolvedCwd}</span></p>}
                </div>
                <fieldset disabled={!!busy}>
                  <legend className="mb-2 text-xs font-medium text-mute2">{t('執行者')}</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {DEVSPACE_TARGETS.map(name => {
                      const provider = status?.targets.find(item => item.name === name)
                      return <label key={name} className={`min-w-0 rounded-lg border px-3 py-3 ${currentTarget === name && provider ? 'border-ink bg-elev' : 'border-line'} ${provider && online ? 'cursor-pointer' : 'opacity-40'}`}>
                        <span className="flex items-center gap-2"><input type="radio" name="devspace-target" value={name} checked={currentTarget === name} disabled={!provider || !online} onChange={() => setTarget(name)} /><span className="text-sm font-medium">{name === 'local' ? t('本機 AI') : name === 'codex' ? 'Codex' : 'Claude'}</span></span>
                        <span className="mt-2 block break-all font-mono text-[11px] text-mute2">{provider ? (provider.model || t('使用 DevSpace 預設模型')) : t('未啟用')}</span>
                      </label>
                    })}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-mute2">{t('清單只表示設定已啟用；登入、額度與模型是否可用，會在執行時確認。')}</p>
                </fieldset>
                <div>
                  <label htmlFor="devspace-prompt" className="mb-2 block text-xs font-medium text-mute2">{t('要執行的工作')}</label>
                  <textarea id="devspace-prompt" rows={5} className={`${input} resize-y leading-6`} value={draft} onChange={event => setDraft(event.target.value)} placeholder={t('例如：檢查這個專案的建置錯誤，修正後執行測試，並列出修改的檔案。')} />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="max-w-lg text-xs leading-5 text-mute2">{t(problem || '送出後可在下方追蹤進度，並查看完整回覆。')}</p>
                  <button type="submit" className="rounded-md bg-ink px-5 py-2.5 text-sm font-medium text-invink disabled:cursor-not-allowed disabled:opacity-40" disabled={!!busy || !!problem}>{t(busy === 'run' ? '正在送出…' : '送出工作')}</button>
                </div>
              </form>
            </section>

            <section className="overflow-hidden rounded-xl border border-line bg-panel" aria-labelledby="devspace-history">
              <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4"><h2 id="devspace-history" className="text-base font-semibold">{t('工作紀錄')}</h2><span className="text-xs text-mute2">{t('依執行目錄顯示')}</span></div>
              <div className="grid min-w-0 xl:grid-cols-[14rem_minmax(0,1fr)]">
                <div className="max-h-72 overflow-y-auto border-b border-line xl:max-h-[36rem] xl:border-b-0 xl:border-r">
                  {!canRead ? <p className="p-5 text-sm text-mute2">{t('選好允許的工作目錄後，這裡會顯示任務紀錄。')}</p>
                    : !currentHistory ? <p role="status" className="p-5 text-sm text-mute2">{t('正在讀取工作紀錄…')}</p>
                    : currentHistory.error ? <p role="alert" className="break-words p-5 text-sm text-red-700 dark:text-red-300">{t(currentHistory.error)}</p>
                    : !currentHistory.tasks.length ? <p className="p-5 text-sm text-mute2">{t('這個目錄還沒有 DevSpace 工作。')}</p>
                    : currentHistory.tasks.map(item => <button key={item.id} type="button" className={`block w-full border-b border-line px-5 py-4 text-left last:border-b-0 hover:bg-elev ${selectedId === item.id ? 'bg-elev' : ''}`} aria-pressed={selectedId === item.id} disabled={!!busy} onClick={() => setSelected({ cwd, id: item.id })}>
                      <span className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-medium">{item.target || 'DevSpace'}</span><span className={item.status === 'failed' ? 'text-red-700 dark:text-red-300' : 'text-mute2'}>{t(item.stale ? '待確認' : devSpaceTaskLabel(item.status))}</span></span>
                      <span className="mt-2 block break-all font-mono text-xs text-mute2">{item.id}</span>
                    </button>)}
                </div>
                <div className="min-w-0 p-5">
                  {!selectedId ? <div className="flex min-h-48 items-center justify-center"><p className="text-sm text-mute2">{t('選擇一個工作，查看回覆或接續執行。')}</p></div>
                    : !currentDetail ? <p role="status" className="py-8 text-sm text-mute2">{t('正在讀取執行結果…')}</p>
                    : currentDetail.error ? <p role="alert" className="break-words text-sm text-red-700 dark:text-red-300">{t(currentDetail.error)}</p>
                    : task && <>
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t('執行結果')}</h3><span className="text-xs text-mute2">{t(task.stale ? '待確認' : devSpaceTaskLabel(task.status))}</span></div>
                      <p className="mb-4 break-all font-mono text-xs text-mute2">{task.id}</p>
                      {task.stale && <p className="mb-3 text-xs text-amber-700 dark:text-amber-300">{t('任務服務未執行，這筆紀錄的最新狀態尚未確認。')}</p>}
                      {task.error && <div role="alert" className="mb-4 break-words rounded-md border border-red-500/30 p-3 text-sm text-red-700 dark:text-red-300">{task.error.code && <span className="mr-2 font-mono text-xs">{task.error.code}</span>}{t(task.error.message)}</div>}
                      {task.response ? <pre className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-app p-4 font-mono text-xs leading-6">{task.response}</pre>
                        : <p className="rounded-lg bg-app p-4 text-sm text-mute2">{t(task.status === 'running' ? '正在執行，收到結果後會自動顯示。' : '這筆工作沒有文字回覆。')}</p>}
                      <form className="mt-5 space-y-3 border-t border-line pt-5" onSubmit={event => { event.preventDefault(); submit(true) }}>
                        <label htmlFor="devspace-continue" className="block text-xs font-medium text-mute2">{t('接續這個工作')}</label>
                        <textarea id="devspace-continue" rows={3} className={`${input} resize-y`} value={continuation} onChange={event => setContinuations(current => ({ ...current, [followKey]: event.target.value }))} placeholder={t('補上下一步要做的事…')} />
                        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-mute2">{t(task.status === 'running' ? '等目前工作結束後，就能接續。' : '沿用這個工作的執行者與上下文。')}</p><button type="submit" className={button} disabled={!!busy || !continueEnabled || !continuation.trim()}>{t(busy === 'continue' ? '正在接續…' : '接續執行')}</button></div>
                      </form>
                    </>}
                </div>
              </div>
            </section>
            {diagnostic && <details open className="rounded-xl border border-line bg-panel p-5"><summary className="cursor-pointer text-sm font-medium">{t('DevSpace 檢查結果')}</summary><pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6">{diagnostic}</pre></details>}
          </div>
        </div>
      </div>
    </section>
  )
}
