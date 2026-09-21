import { useEffect, useRef, useState } from 'react'
import { t, useLang } from '@/i18n'
import { DEVSPACE_MODELS, isDevSpaceModel, readDevSpaceModel, saveDevSpaceModel, withinDevSpaceRoots } from '@/lib/devspace'
import type { DevSpaceModel } from '@/lib/devspace'
import type { OpenCodeDesktopStatus, OpenCodeReply } from '@/types/opencode'

const button = 'rounded-md border border-line2 px-3 py-2 text-sm font-medium hover:bg-elev disabled:cursor-not-allowed disabled:opacity-40'

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
  const cwd = workspace ?? status?.cwd ?? status?.allowedRoots[0] ?? ''
  const active = !!status?.running || !!status?.starting
  const selectedModel = active ? status.model : model
  const allowed = !!status && withinDevSpaceRoots(cwd, status.allowedRoots)
  const ready = !!api && !statusError && !!status?.installed && !!status.configured && status.bridgeReady && allowed

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
        if (!cancelled) { setStatus(null); setStatusError(reason instanceof Error ? reason.message : 'OpenCode 狀態無法讀取，請重新整理。') }
      } finally {
        if (!cancelled) timer = setTimeout(() => { void read() }, 5000)
      }
    }
    void read()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [api, revision])

  async function act(name: string, operation: () => Promise<OpenCodeReply>) {
    if (actionRunning.current) return
    actionRunning.current = true
    setBusy(name); setError(''); setNotice('')
    try {
      const reply = await operation()
      if (!mounted.current) return
      if (!reply.ok) throw new Error(reply.error)
      setStatus(reply.status)
      setNotice(name === 'stop' ? 'OpenCode 服務已停止，對話紀錄仍保留。' : 'OpenCode 對話視窗已開啟。')
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
      {notice && <p role="status" className="mb-5 text-sm text-ink2">{t(notice)}</p>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="rounded-xl border border-line bg-panel p-5 sm:p-6">
          <label htmlFor="opencode-workspace" className="mb-2 block text-sm font-semibold">{t('專案資料夾')}</label>
          <div className="flex flex-wrap gap-2">
            <input id="opencode-workspace" value={cwd} disabled={active || !!busy} onChange={event => setWorkspace(event.target.value)} spellCheck={false} placeholder="C:\\Projects\\my-project" className="min-w-0 flex-1 rounded-md border border-line2 bg-app px-3 py-2 font-mono text-sm disabled:opacity-60" />
            <button type="button" className={button} disabled={!window.acSetup?.chooseDirectory || active || !!busy} onClick={() => { void chooseDirectory() }}>{t('選擇資料夾')}</button>
          </div>
          {status && cwd && !allowed && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t('請選擇 DevSpace 允許目錄內已存在的專案資料夾。')}</p>}
          <label htmlFor="opencode-model" className="mb-2 mt-5 block text-sm font-semibold">{t('對話模型')}</label>
          <select id="opencode-model" value={selectedModel} disabled={active || !!busy} onChange={event => {
            if (isDevSpaceModel(event.target.value)) { setModel(event.target.value); saveDevSpaceModel(event.target.value) }
          }} className="w-full rounded-md border border-line2 bg-app px-3 py-2 text-sm disabled:opacity-60">
            {DEVSPACE_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <p className="mt-2 text-xs leading-relaxed text-mute2">{t('第一次使用，請在 OpenCode 視窗連接 OpenAI 帳號。所選模型須由該帳號支援。')}</p>
          <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-5">
            <button type="button" className={`${button} bg-ink text-invink hover:bg-ink2`} disabled={!ready || !!busy || !!status?.starting} onClick={() => {
              if (api) void act('open', () => api.open({ cwd, model: selectedModel }))
            }}>{t(busy === 'open' || status?.starting ? '正在開啟…' : status?.running ? '返回 OpenCode 對話' : '開啟 OpenCode 對話')}</button>
            <button type="button" className={button} disabled={!api || !active || !!busy} onClick={() => {
              if (api) void act('stop', () => api.stop())
            }}>{t(busy === 'stop' ? '正在停止…' : '停止 OpenCode')}</button>
          </div>
          {active && <p className="mt-3 text-xs text-mute2">{t('切換專案或預設模型前，請先停止 OpenCode 服務。')}</p>}
        </div>

        <aside aria-label={t('OpenCode 連線狀態')} className="space-y-5 py-1">
          <dl className="space-y-4 text-sm">
            <div><dt className="text-xs text-mute2">{t('OpenCode 安裝')}</dt><dd className="mt-1 font-medium">{status ? status.installed ? `OpenCode ${status.version || ''}` : t('尚未安裝') : t(api ? '正在讀取…' : '僅桌面版可用')}</dd></div>
            <div><dt className="text-xs text-mute2">{t('對話服務')}</dt><dd className="mt-1 flex items-center gap-2 font-medium"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${status?.running ? 'bg-emerald-500' : 'bg-line3'}`} />{t(status?.running ? '已啟動' : status?.starting ? '正在啟動…' : '未啟動')}</dd></div>
            <div><dt className="text-xs text-mute2">DevSpace MCP</dt><dd className="mt-1 font-medium">{status ? t(status.bridgeReady && status.configured ? '已準備對話連線' : '請先完成 DevSpace 設定') : '—'}</dd></div>
          </dl>
          <p className="border-t border-line pt-4 text-xs leading-relaxed text-mute2">{t('讀寫檔案與執行指令時，OpenCode 會在對話內顯示確認。關閉對話視窗後，可從這裡再次開啟。')}</p>
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
