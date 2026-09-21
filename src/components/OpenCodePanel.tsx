import { useEffect, useRef, useState } from 'react'
import { t, useLang } from '@/i18n'
import { DEVSPACE_MODELS, isDevSpaceModel, readDevSpaceModel, saveDevSpaceModel, withinDevSpaceRoots } from '@/lib/devspace'
import type { DevSpaceModel } from '@/lib/devspace'
import type { OpenCodeConnectionIssue, OpenCodeDesktopStatus, OpenCodeReply } from '@/types/opencode'

const button = 'rounded-md border border-line2 px-3 py-2 text-sm font-medium hover:bg-elev disabled:cursor-not-allowed disabled:opacity-40'

function authorizationLabel(status: OpenCodeDesktopStatus): string {
  switch (status.authorization) {
    case 'checking': return '正在檢查授權…'
    case 'waiting_for_owner': return '等待 Owner 在瀏覽器同意'
    case 'authorized': return 'Owner 授權已完成'
    case 'timed_out': return 'Owner 授權已逾時'
    case 'failed': return 'Owner 授權失敗'
    default: return '尚未開始'
  }
}

function mcpLabel(status: OpenCodeDesktopStatus): string {
  switch (status.mcp) {
    case 'connecting': return '正在建立 MCP 連線…'
    case 'connected': return 'MCP 已實際連線'
    case 'failed': return 'MCP 連線失敗'
    default: return '尚未連線'
  }
}

function connectionProblem(issue: OpenCodeConnectionIssue): string {
  switch (issue) {
    case 'service_unreachable': return 'DevSpace 服務無法連線。請先啟動 DevSpace，待狀態顯示可連線後再重新連接。'
    case 'bridge_failed': return 'OpenCode 的 DevSpace 橋接程式無法啟動。請確認 DevSpace 與 Node.js 安裝後重新連接。'
    case 'authorization_timeout': return 'DevSpace Owner 授權已逾時。請重新連接，並在新開啟的瀏覽器頁面完成同意。'
    case 'authorization_failed': return 'DevSpace Owner 授權未完成或已失敗。請確認 Owner 同意頁後重新連接。'
    case 'connection_failed': return '授權後仍無法建立 DevSpace MCP 連線。請確認 DevSpace 服務後重新連接。'
    case 'disconnected': return 'DevSpace MCP 已中斷。請重新連接以建立新的橋接程序。'
    default: return ''
  }
}

export default function OpenCodePanel() {
  useLang()
  const api = window.acOpenCode
  const [status, setStatus] = useState<OpenCodeDesktopStatus | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [model, setModel] = useState<DevSpaceModel>(readDevSpaceModel)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [revision, setRevision] = useState(0)
  const mounted = useRef(false)
  const actionRunning = useRef(false)
  const active = !!status?.running || !!status?.starting
  const cwd = (active ? status?.cwd : null) ?? workspace ?? status?.allowedRoots[0] ?? ''
  const selectedModel = active ? status!.model : model
  const allowed = !!status && withinDevSpaceRoots(cwd, status.allowedRoots)
  const prepared = !!api && !statusError && !!status?.installed && status.configured && status.bridgeReady
    && status.devspaceService === 'reachable' && allowed
  const canOpen = active ? !!status?.running : prepared
  const reconnectNeeded = active && status?.mcp === 'failed'
  const canReconnect = !!api && !!status?.running && status.devspaceService === 'reachable' && !busy

  let openDisabledReason = ''
  if (!api) openDisabledReason = '請改用桌面版工作臺。'
  else if (busy) openDisabledReason = '請等目前的 OpenCode 操作完成。'
  else if (!status) openDisabledReason = statusError ? '狀態讀取失敗，請先重新整理狀態。' : '正在讀取 OpenCode 狀態。'
  else if (status.starting) openDisabledReason = 'OpenCode 正在啟動，請稍候。'
  else if (!status.installed) openDisabledReason = '請先安裝 OpenCode，再重新整理狀態。'
  else if (!status.configured) openDisabledReason = '請先完成 DevSpace 設定與允許目錄。'
  else if (!status.bridgeReady) openDisabledReason = '請先安裝 DevSpace、Node.js 與 OpenCode 連線橋接程式。'
  else if (statusError) openDisabledReason = '狀態讀取失敗，請先重新整理狀態。'
  else if (status.devspaceService !== 'reachable' && !status.running) openDisabledReason = '請先啟動 DevSpace 服務，再重新整理狀態。'
  else if (!allowed && !status.running) openDisabledReason = '請選擇 DevSpace 允許目錄內已存在的專案資料夾。'

  const reconnectDisabledReason = !status?.running
    ? 'OpenCode 尚未啟動，請使用開啟按鈕。'
    : status.devspaceService !== 'reachable'
      ? '請先啟動 DevSpace 服務；狀態顯示可連線後才能重新連接。'
      : busy ? '請等目前的 OpenCode 操作完成。' : ''

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!api) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const reply = await api.status()
        if (cancelled) return
        if (!reply.ok) throw new Error(reply.error)
        setStatus(reply.status)
        setStatusError(reply.status.error || '')
      } catch (reason) {
        if (!cancelled) {
          setStatus(null)
          setStatusError(reason instanceof Error ? reason.message : 'OpenCode 狀態無法讀取，請重新整理。')
        }
      } finally {
        if (!cancelled) timer = setTimeout(() => { void read() }, 3000)
      }
    }
    void read()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [api, revision])

  async function act(name: 'open' | 'stop' | 'reconnect', operation: () => Promise<OpenCodeReply>) {
    if (actionRunning.current) return
    actionRunning.current = true
    if (name === 'stop' && status?.cwd) setWorkspace(status.cwd)
    setBusy(name); setError(''); setNotice('')
    try {
      const reply = await operation()
      if (!mounted.current) return
      if (!reply.ok) throw new Error(reply.error)
      setStatus(reply.status)
      setStatusError(reply.status.error || '')
      setNotice(name === 'stop' ? 'OpenCode 服務已停止，對話紀錄仍保留。'
        : name === 'reconnect' ? 'OpenCode 已使用原專案與模型重新啟動；若瀏覽器顯示 DevSpace Owner 同意頁，請完成後回到 OpenCode。'
          : 'OpenCode 對話視窗已開啟。第一次使用時，請依序完成 DevSpace Owner 同意與 OpenAI Connect。')
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'OpenCode 操作未完成，請再試一次。')
    } finally {
      actionRunning.current = false
      if (mounted.current) { setBusy(''); setRevision(value => value + 1) }
    }
  }

  async function chooseDirectory() {
    try {
      const directory = await window.acSetup?.chooseDirectory()
      if (directory && mounted.current) { setWorkspace(directory); setError(''); setNotice('') }
    } catch { if (mounted.current) setError('無法開啟資料夾選擇器，請直接輸入完整路徑。') }
  }

  return <section aria-labelledby="opencode-heading" className="min-h-0 flex-1 overflow-y-auto bg-app">
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 font-mono text-xs tracking-widest text-mute2">OpenCode / MCP</div>
          <h1 id="opencode-heading" className="text-2xl font-semibold tracking-tight">{t('OpenCode 對話')}</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-mute2">{t('選擇專案後開啟 OpenCode，一邊對話，一邊透過 DevSpace 讀寫檔案。')}</p>
        </div>
        <button type="button" className={button} disabled={!api || !!busy} onClick={() => setRevision(value => value + 1)}>{t('重新整理狀態')}</button>
      </header>

      {!api && <p role="status" className="mb-5 rounded-lg border border-line2 bg-panel p-4 text-sm">{t('請在桌面版工作臺使用 OpenCode。瀏覽器中的這個頁面只提供說明。')}</p>}
      {(error || statusError) && <p role="alert" className="mb-5 rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">{t(error || statusError)}</p>}
      {notice && <p role="status" className="mb-5 rounded-lg border border-line2 bg-panel p-4 text-sm text-ink2">{t(notice)}</p>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-6">
          <div className="rounded-xl border border-line bg-panel p-5 sm:p-6">
            <label htmlFor="opencode-workspace" className="mb-2 block text-sm font-semibold">{t('專案資料夾')}</label>
            <div className="flex flex-wrap gap-2">
              <input id="opencode-workspace" value={cwd} disabled={active || !!busy} onChange={event => setWorkspace(event.target.value)} spellCheck={false} placeholder="C:\\Projects\\my-project" className="min-w-0 flex-1 rounded-md border border-line2 bg-app px-3 py-2 font-mono text-sm disabled:opacity-60" />
              <button type="button" className={button} title={active ? t('切換專案前，請先停止 OpenCode 服務。') : undefined} disabled={!window.acSetup?.chooseDirectory || active || !!busy} onClick={() => { void chooseDirectory() }}>{t('選擇資料夾')}</button>
            </div>
            {status && cwd && !allowed && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t('請選擇 DevSpace 允許目錄內已存在的專案資料夾。')}</p>}

            <label htmlFor="opencode-model" className="mb-2 mt-5 block text-sm font-semibold">{t('對話模型')}</label>
            <select id="opencode-model" value={selectedModel} disabled={active || !!busy} onChange={event => {
              if (isDevSpaceModel(event.target.value)) { setModel(event.target.value); saveDevSpaceModel(event.target.value) }
            }} className="w-full rounded-md border border-line2 bg-app px-3 py-2 text-sm disabled:opacity-60">
              {DEVSPACE_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <p className="mt-2 text-xs leading-relaxed text-mute2">{t('所選模型不會自動替換；OpenAI 帳號必須支援該模型。')}</p>

            <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-5">
              <button type="button" className={`${button} bg-ink text-invink hover:bg-ink2`} title={openDisabledReason ? t(openDisabledReason) : undefined} disabled={!canOpen || !!busy || !!status?.starting} onClick={() => {
                if (api) void act('open', () => api.open({ cwd, model: selectedModel }))
              }}>{t(busy === 'open' || status?.starting ? '正在開啟…' : status?.running ? '返回 OpenCode 對話' : '開啟 OpenCode 對話')}</button>
              <button type="button" className={button} disabled={!api || !active || !!busy} onClick={() => {
                if (api) void act('stop', () => api.stop())
              }}>{t(busy === 'stop' ? '正在停止…' : '停止 OpenCode')}</button>
            </div>
            {!canOpen && openDisabledReason && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{t(openDisabledReason)}</p>}
            {active && <p className="mt-3 text-xs text-mute2">{t('切換專案或預設模型前，請先停止 OpenCode 服務。')}</p>}
          </div>

          <div className="rounded-xl border border-line bg-panel p-5 sm:p-6">
            <h2 className="text-base font-semibold">{t('第一次使用：兩個不同的授權步驟')}</h2>
            <ol className="mt-4 space-y-4 text-sm leading-relaxed">
              <li><strong>{t('1. DevSpace Owner 瀏覽器同意')}</strong><p className="mt-1 text-mute2">{t('按下開啟後，瀏覽器會顯示 DevSpace 的同意頁。請在瀏覽器自行輸入 Owner 密碼並同意；AI 控制台不會讀取或儲存該密碼。')}</p></li>
              <li><strong>{t('2. OpenAI Connect')}</strong><p className="mt-1 text-mute2">{t('回到 OpenCode 視窗，再使用 OpenAI Connect 登入模型帳號。這與 DevSpace Owner 同意是分開的步驟。')}</p></li>
            </ol>
          </div>

          {status?.authorization === 'waiting_for_owner' && <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-5 text-sm">
            <h2 className="font-semibold">{t('正在等待 DevSpace Owner 同意')}</h2>
            <p className="mt-2 leading-relaxed text-mute2">{t('請完成瀏覽器中的 DevSpace 同意頁。不要把 Owner 密碼貼到 OpenCode 或 AI 控制台。')}</p>
          </div>}

          {reconnectNeeded && status && <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-5 text-sm">
            <h2 className="font-semibold text-red-700 dark:text-red-300">{t('需要重新連接 DevSpace MCP')}</h2>
            <p className="mt-2 leading-relaxed text-mute2">{t(connectionProblem(status.connectionIssue) || 'DevSpace MCP 尚未連線，請重新連接。')}</p>
            <p className="mt-3 leading-relaxed text-mute2">{t('此操作會停止目前由 AI 控制台啟動的 OpenCode 服務，可能中斷正在產生的回覆；專案與模型會沿用目前選擇。只有按下按鈕才會執行。')}</p>
            <button type="button" className={`${button} mt-4 bg-ink text-invink hover:bg-ink2`} title={reconnectDisabledReason ? t(reconnectDisabledReason) : undefined} disabled={!canReconnect} onClick={() => {
              if (api) void act('reconnect', () => api.reconnect({ cwd, model: selectedModel, confirmInterrupt: true }))
            }}>{t(busy === 'reconnect' ? '正在重新連接…' : '重新連接 DevSpace MCP')}</button>
            {!canReconnect && reconnectDisabledReason && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">{t(reconnectDisabledReason)}</p>}
          </div>}
        </div>

        <aside aria-label={t('OpenCode 連線狀態')} className="space-y-5 py-1">
          <dl className="space-y-4 text-sm">
            <div><dt className="text-xs text-mute2">{t('OpenCode 安裝')}</dt><dd className="mt-1 font-medium">{status ? status.installed ? `OpenCode ${status.version || ''}` : t('尚未安裝') : t(api ? '正在讀取…' : '僅桌面版可用')}</dd></div>
            <div><dt className="text-xs text-mute2">{t('DevSpace 工具與設定')}</dt><dd className="mt-1 font-medium">{status ? t(status.configured && status.bridgeReady ? '工具已安裝並完成設定' : '尚未完成安裝或設定') : '—'}</dd></div>
            <div><dt className="text-xs text-mute2">{t('DevSpace 服務')}</dt><dd className="mt-1 flex items-center gap-2 font-medium"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${status?.devspaceService === 'reachable' ? 'bg-emerald-500' : 'bg-line3'}`} />{status ? t(status.devspaceService === 'reachable' ? '服務可連線' : status.devspaceService === 'unreachable' ? '服務無法連線' : '尚未完成設定') : '—'}</dd></div>
            <div><dt className="text-xs text-mute2">{t('DevSpace Owner 授權')}</dt><dd className="mt-1 font-medium">{status ? t(authorizationLabel(status)) : '—'}</dd></div>
            <div><dt className="text-xs text-mute2">DevSpace MCP</dt><dd className="mt-1 flex items-center gap-2 font-medium"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${status?.mcp === 'connected' ? 'bg-emerald-500' : status?.mcp === 'failed' ? 'bg-red-500' : 'bg-line3'}`} />{status ? t(mcpLabel(status)) : '—'}</dd></div>
            <div><dt className="text-xs text-mute2">OpenAI Connect</dt><dd className="mt-1 font-medium">{t(status?.running ? '請在 OpenCode 視窗確認' : '尚未開啟 OpenCode')}</dd></div>
            <div><dt className="text-xs text-mute2">{t('對話服務')}</dt><dd className="mt-1 flex items-center gap-2 font-medium"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${status?.running ? 'bg-emerald-500' : 'bg-line3'}`} />{t(status?.running ? '已啟動' : status?.starting ? '正在啟動…' : '未啟動')}</dd></div>
          </dl>
          <p className="border-t border-line pt-4 text-xs leading-relaxed text-mute2">{t('只有「MCP 已實際連線」代表 OpenCode 已接上 DevSpace；工具已安裝或 OpenCode 已啟動都不等於 MCP 已連線。')}</p>
          <p className="text-xs leading-relaxed text-mute2">{t('AI 控制台不會推測 OpenAI 帳號登入狀態，請在 OpenCode 視窗中確認。')}</p>
          <a className="inline-block text-sm underline underline-offset-4" href="https://opencode.ai/zht" target="_blank" rel="noreferrer">{t('OpenCode 官方網站')}</a>
        </aside>
      </div>

      {status && !status.installed && <div className="mt-6 rounded-lg border border-line bg-panel p-5 text-sm">
        <h2 className="font-semibold">{t('安裝 OpenCode')}</h2>
        <p className="mb-3 mt-2 text-mute2">{t('在 PowerShell 執行以下指令，完成後重新整理狀態。')}</p>
        <code className="block overflow-x-auto rounded-md bg-app p-3 font-mono text-xs">npm install -g opencode-ai@1.18.31</code>
      </div>}
      {!!status?.allowedRoots.length && <details className="mt-6 text-xs text-mute2"><summary className="cursor-pointer">{t('DevSpace 允許目錄')}</summary><ul className="mt-3 space-y-2">{status.allowedRoots.map(root => <li key={root} className="break-all font-mono">{root}</li>)}</ul></details>}
    </div>
  </section>
}
