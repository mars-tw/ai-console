import { useEffect, useState } from 'react'
import { t, useLang } from '@/i18n'
import { DEVSPACE_MODELS, devSpaceModelLabel, devSpaceRequest, isDevSpaceModel, parseDevSpaceStatus, pollDevSpace, readDevSpaceModel, saveDevSpaceModel, withinDevSpaceRoots } from '@/lib/devspace'
import type { DevSpaceModel, DevSpaceStatus } from '@/lib/devspace'

const button = 'rounded-md border border-line2 px-4 py-2 text-sm hover:bg-elev disabled:opacity-40'
const input = 'w-full rounded-md border border-line2 bg-panel px-3 py-2 text-sm text-ink'

export default function DevSpaceConsole() {
  useLang()
  const [status, setStatus] = useState<DevSpaceStatus | null>(null)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [notice, setNotice] = useState('')
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [model, setModel] = useState<DevSpaceModel>(readDevSpaceModel)
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [diagnostic, setDiagnostic] = useState('')
  const cwd = workspace ?? status?.allowedRoots[0] ?? ''
  const allowed = !statusError && !!status?.installed && status.configured && withinDevSpaceRoots(cwd, status.allowedRoots)
  const prompt = `${t('請在 ChatGPT「對話」模式完成以下工作，使用已連接的 DevSpace MCP；不要切到「工作」模式，也不要呼叫 agents run／continue。')}\n\n${t('專案資料夾')}：${cwd}\n${t('偏好模型（送出前請在 ChatGPT 選單確認）：{model}', { model: devSpaceModelLabel(model) })}\n\n${instructions.trim()}\n\n${t('先呼叫 open_workspace 開啟指定專案，再使用 MCP 讀改檔案與執行必要指令。成果直接寫入本機專案，最後回覆成果路徑、驗證結果及未完成事項，供原派工者接手。')}`

  useEffect(() => pollDevSpace(
    async signal => parseDevSpaceStatus(await devSpaceRequest('status', undefined, signal)),
    value => { setStatus(value); setStatusError('') },
    reason => { setStatusError(reason instanceof Error ? reason.message : String(reason)) },
    10000,
  ), [revision])

  async function service(action: 'doctor' | 'start' | 'stop') {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await devSpaceRequest(action, {})
      if (action === 'doctor') setDiagnostic(String(result.output || ''))
      else setStatus(parseDevSpaceStatus(result.status))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false); setRevision(value => value + 1) }
  }

  async function openChatGPT() {
    try {
      if (window.acChatGPT) {
        const result = await window.acChatGPT.open()
        if (!result.ok) throw new Error(result.error || t('無法開啟 ChatGPT。'))
      } else window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer')
      setNotice('請確認 ChatGPT 上方選中「對話」，並在訊息中加入 DevSpace。')
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  async function copyPrompt() {
    try { await navigator.clipboard.writeText(prompt); setNotice('已複製對話指示，請貼入已加入 DevSpace 的 ChatGPT 對話。') }
    catch { setError('無法使用剪貼簿，請選取下方指示手動複製。') }
  }

  return <section className="min-h-0 flex-1 overflow-y-auto bg-app">
    <div className="mx-auto max-w-5xl space-y-6 px-5 py-6">
      <header>
        <p className="font-mono text-xs text-mute2">ChatGPT → DevSpace MCP → {t('本機交接')}</p>
        <h1 className="mt-2 text-2xl font-semibold">{t('DevSpace 對話入口')}</h1>
        <p className="mt-2 text-sm text-mute2">{t('由 ChatGPT 對話中的模型直接操作 MCP，成果留在本機，再由原派工者接手。')}</p>
      </header>
      {(error || statusError) && <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-600 dark:text-red-300">{t(error || statusError)}</p>}
      {notice && <p role="status" className="text-sm text-ink2">{t(notice)}</p>}
      <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t('在 ChatGPT 開始對話')}</h2>
          <span className="text-xs text-mute2">{!statusError && status?.service.running ? t('本機 MCP 執行中') : t('MCP 狀態待確認')}</span>
        </div>
        <p className="text-sm leading-6 text-mute2">{t('先在 ChatGPT 選擇「對話」，從新增內容選單加入 DevSpace，再選擇你要用的模型。此處不建立工作或背景 agent。')}</p>
        <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-invink" onClick={() => { void openChatGPT() }}>{t('開啟 ChatGPT 對話')}</button>
        <p className="text-xs leading-5 text-mute2">{t('模型名稱與可用性以 ChatGPT 對話選單為準；不把 Codex 模型識別碼當成 ChatGPT 的切換指令。')}</p>
      </div>
      <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
        <h2 className="font-semibold">{t('準備對話指示')}</h2>
        <label className="block text-xs text-mute2" htmlFor="devspace-project">{t('專案資料夾')}</label>
        <input id="devspace-project" className={input} list="devspace-roots" value={cwd} onChange={event => setWorkspace(event.target.value)} spellCheck={false} />
        <datalist id="devspace-roots">{status?.allowedRoots.map(root => <option key={root} value={root} />)}</datalist>
        <label className="block text-xs text-mute2" htmlFor="devspace-model">{t('偏好對話模型')}</label>
        <select id="devspace-model" className={`${input} sm:max-w-xs`} value={model} onChange={event => {
          if (isDevSpaceModel(event.target.value)) { setModel(event.target.value); saveDevSpaceModel(event.target.value) }
        }}>{DEVSPACE_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        <p className="text-xs leading-5 text-mute2">{t('此選項只記住偏好並加入指示；實際使用模型仍需在 ChatGPT 對話中選擇。')}</p>
        <label className="block text-xs text-mute2" htmlFor="devspace-instructions">{t('要在對話中完成的內容')}</label>
        <textarea id="devspace-instructions" rows={5} className={input} value={instructions} onChange={event => setInstructions(event.target.value)} />
        <button className={button} disabled={!allowed || !instructions.trim()} onClick={() => { void copyPrompt() }}>{t('複製對話指示')}</button>
        {!allowed && <p className="text-xs text-mute2">{t('請選擇 DevSpace 允許範圍內的專案。')}</p>}
        <details><summary className="cursor-pointer text-xs text-mute2">{t('檢視將要複製的指示')}</summary><pre className="mt-3 whitespace-pre-wrap break-words rounded-md bg-app p-3 text-xs leading-6">{prompt}</pre></details>
      </div>
      <details className="rounded-xl border border-line bg-panel p-5">
        <summary className="cursor-pointer text-sm font-medium">{t('本機 MCP 服務')}</summary>
        <p className="mt-3 break-all font-mono text-xs text-mute2">{status?.endpoint || '—'}</p>
        <p className="mt-2 text-xs text-mute2">{t('ChatGPT 使用已設定的公開 HTTPS MCP 入口；這個本機位址是服務狀態，不能直接當成雲端對話的連線網址。')}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className={button} disabled={busy || !!statusError || !status?.installed || !status.configured || status.service.running} onClick={() => { void service('start') }}>{t('啟動 MCP')}</button>
          <button className={button} disabled={busy || !!statusError || !status?.service.managed} onClick={() => { void service('stop') }}>{t('停止 MCP')}</button>
          <button className={button} disabled={busy || !!statusError || !status?.installed} onClick={() => { void service('doctor') }}>{t('檢查 DevSpace 設定')}</button>
        </div>
        {diagnostic && <pre className="mt-4 whitespace-pre-wrap break-words text-xs leading-6">{diagnostic}</pre>}
      </details>
    </div>
  </section>
}
