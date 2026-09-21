import { useEffect, useRef, useState } from 'react'
import { t, useLang } from '@/i18n'
import {
  buildDevSpaceConversationPrompt,
  clearDevSpaceInstructions,
  copyThenOpenDevSpace,
  DEVSPACE_MODELS,
  devSpaceRequest,
  devSpaceWorkbenchState,
  isDevSpaceModel,
  parseDevSpaceStatus,
  pollDevSpace,
  resolveDevSpaceDirectory,
  saveDevSpaceModel,
  updateDevSpaceDraft,
  withinDevSpaceRoots,
} from '@/lib/devspace'
import type { DevSpaceDraft, DevSpaceStatus, DevSpaceWorkbenchReason } from '@/lib/devspace'

const button = 'rounded-md border border-line2 px-4 py-2 text-sm hover:bg-elev disabled:cursor-not-allowed disabled:opacity-40'
const primaryButton = 'rounded-md bg-ink px-4 py-2 text-sm font-medium text-invink hover:bg-ink2 disabled:cursor-not-allowed disabled:opacity-40'
const input = 'w-full rounded-md border border-line2 bg-panel px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60'

type ConversationAction = '' | 'folder' | 'copy' | 'open' | 'copy-open'
type ServiceAction = '' | 'doctor' | 'start' | 'stop'

export interface DevSpaceConsoleProps {
  draft: DevSpaceDraft
  onDraftChange: (draft: DevSpaceDraft) => void
}

function readinessTitle(reason: DevSpaceWorkbenchReason): string {
  switch (reason) {
    case 'loading': return t('正在讀取 DevSpace 狀態')
    case 'unreadable': return t('DevSpace 狀態無法讀取')
    case 'uninstalled': return t('尚未安裝 DevSpace')
    case 'missing-configuration': return t('DevSpace 尚未完成設定')
    case 'invalid-project': return t('專案資料夾不在允許範圍')
    case 'empty-instructions': return t('尚未填寫工作內容')
    case 'mcp-stopped': return t('MCP 尚未啟動')
    case 'mcp-running': return t('MCP 已啟動')
  }
}

function readinessDetail(reason: DevSpaceWorkbenchReason): string {
  switch (reason) {
    case 'loading': return t('正在確認安裝、設定與 MCP 服務；你可以先填寫專案與工作內容。')
    case 'unreadable': return t('目前草稿會保留。請確認背景服務後重新整理狀態。')
    case 'uninstalled': return t('先依官方說明完成安裝；本頁不會自動安裝或變更允許目錄。')
    case 'missing-configuration': return t('請完成 DevSpace 設定與公開 HTTPS MCP 入口，再回來重新整理。')
    case 'invalid-project': return t('請選擇 allowedRoots 內的專案，或直接輸入完整路徑。')
    case 'empty-instructions': return t('先寫下要在 ChatGPT 對話中完成的工作。')
    case 'mcp-stopped': return t('草稿已可複製；實際執行前仍須啟動 MCP，並在 ChatGPT 對話中加入 DevSpace。')
    case 'mcp-running': return t('可複製指示並開啟 ChatGPT；仍需選擇「對話」、加入 DevSpace、確認模型後自行貼上送出。')
  }
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback
}

export default function DevSpaceConsole({ draft, onDraftChange }: DevSpaceConsoleProps) {
  useLang()
  const [status, setStatus] = useState<DevSpaceStatus | null>(null)
  const [error, setError] = useState('')
  const [statusError, setStatusError] = useState('')
  const [notice, setNotice] = useState('')
  const [serviceBusy, setServiceBusy] = useState<ServiceAction>('')
  const [actionBusy, setActionBusy] = useState<ConversationAction>('')
  const [revision, setRevision] = useState(0)
  const [diagnostic, setDiagnostic] = useState('')
  const serviceRunning = useRef(false)
  const actionRunning = useRef(false)
  const cwd = draft.workspace ?? status?.allowedRoots[0] ?? ''
  const readiness = devSpaceWorkbenchState(status, statusError, cwd, draft.instructions)
  const projectValid = !statusError && !!status?.installed && status.configured
    && withinDevSpaceRoots(cwd, status.allowedRoots)
  const hasFolderPicker = typeof window !== 'undefined'
    && typeof window.acSetup?.chooseDirectory === 'function'
  const prompt = buildDevSpaceConversationPrompt(draft, t)

  useEffect(() => pollDevSpace(
    async signal => parseDevSpaceStatus(await devSpaceRequest('status', undefined, signal)),
    value => { setStatus(value); setStatusError('') },
    reason => { setStatusError(reason instanceof Error ? reason.message : String(reason)) },
    10000,
  ), [revision])

  function changeDraft(patch: Partial<DevSpaceDraft>) {
    onDraftChange(updateDevSpaceDraft(draft, patch))
  }

  function refreshStatus() {
    setStatus(null)
    setStatusError('')
    setError('')
    setNotice('')
    setRevision(value => value + 1)
  }

  async function service(action: Exclude<ServiceAction, ''>) {
    if (serviceRunning.current) return
    serviceRunning.current = true
    setServiceBusy(action)
    setError('')
    setNotice('')
    try {
      const result = await devSpaceRequest(action, {})
      if (action === 'doctor') {
        setDiagnostic(String(result.output || ''))
        setNotice('DevSpace 檢查完成。')
      } else {
        setStatus(parseDevSpaceStatus(result.status))
        setNotice(action === 'start' ? 'MCP 服務已啟動或連上既有服務。' : '本控制台啟動的 MCP 服務已停止。')
      }
    } catch (reason) {
      setError(errorMessage(reason, 'DevSpace 操作未完成，請重新整理後再試。'))
    } finally {
      serviceRunning.current = false
      setServiceBusy('')
      setRevision(value => value + 1)
    }
  }

  async function runAction(action: Exclude<ConversationAction, ''>, operation: () => Promise<void>) {
    if (actionRunning.current) return
    actionRunning.current = true
    setActionBusy(action)
    setError('')
    setNotice('')
    try { await operation() } finally {
      actionRunning.current = false
      setActionBusy('')
    }
  }

  async function openChatGPTWindow() {
    if (typeof window === 'undefined') throw new Error('無法開啟 ChatGPT。')
    if (window.acChatGPT) {
      const result = await window.acChatGPT.open()
      if (!result.ok) throw new Error(result.error || '無法開啟 ChatGPT。')
      return
    }
    const opened = window.open('https://chatgpt.com/', '_blank')
    if (!opened) throw new Error('瀏覽器未開啟 ChatGPT 新分頁，請手動開啟 chatgpt.com。')
    try { opened.opener = null } catch { /* Cross-origin browsers may not expose opener. */ }
  }

  async function writePromptToClipboard() {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(prompt)
  }

  async function chooseDirectory() {
    await runAction('folder', async () => {
      if (typeof window === 'undefined' || !window.acSetup?.chooseDirectory) {
        setError('無法開啟資料夾選擇器，請直接輸入完整路徑。')
        return
      }
      try {
        const selected = await window.acSetup.chooseDirectory()
        const next = resolveDevSpaceDirectory(draft.workspace, selected)
        if (!selected?.trim()) {
          setNotice('未變更專案資料夾。')
          return
        }
        changeDraft({ workspace: next })
        setNotice('已選擇專案資料夾。')
      } catch {
        setError('無法開啟資料夾選擇器，請直接輸入完整路徑。')
      }
    })
  }

  async function copyPrompt() {
    await runAction('copy', async () => {
      try {
        await writePromptToClipboard()
        setNotice('已複製對話指示。請貼入已加入 DevSpace 的 ChatGPT 對話；本頁尚未送出任何訊息。')
      } catch {
        setError('無法使用剪貼簿。請展開「檢視將要複製的指示」，全選並手動複製；草稿仍保留。')
      }
    })
  }

  async function openChatGPT() {
    await runAction('open', async () => {
      try {
        await openChatGPTWindow()
        setNotice('ChatGPT 已開啟。請選擇「對話」、加入 DevSpace 並確認模型；本頁沒有貼上或送出任何訊息。')
      } catch (reason) {
        setError(errorMessage(reason, '無法開啟 ChatGPT。'))
        setNotice('請手動開啟已登入的 ChatGPT；目前草稿仍保留。')
      }
    })
  }

  async function copyAndOpenChatGPT() {
    await runAction('copy-open', async () => {
      const result = await copyThenOpenDevSpace(writePromptToClipboard, openChatGPTWindow)
      if (result.ok) {
        setNotice('指示已複製，ChatGPT 已開啟。請選擇「對話」、加入 DevSpace、確認模型後貼上；尚未送出任何訊息。')
      } else if (result.stage === 'copy') {
        setError('無法使用剪貼簿。請展開「檢視將要複製的指示」，全選並手動複製；草稿仍保留，ChatGPT 尚未開啟。')
      } else {
        setError(errorMessage(result.error, '無法開啟 ChatGPT。'))
        setNotice('指示已複製，但 ChatGPT 未開啟。請手動開啟已登入的 ChatGPT 後貼上；草稿仍保留，且尚未送出任何訊息。')
      }
    })
  }

  function clearDraft() {
    onDraftChange(clearDevSpaceInstructions(draft))
    setError('')
    setNotice('已清除工作內容；專案資料夾與偏好模型仍保留。')
  }

  const installationState = statusError ? t('無法確認') : !status ? t('正在讀取…')
    : status.installed ? `${t('已安裝')}${status.version ? ` · ${status.version}` : ''}` : t('尚未安裝')
  const configurationState = statusError ? t('無法確認') : !status ? t('正在讀取…')
    : status.configured ? t('已設定') : t('尚未設定')
  const projectState = statusError || !status ? t('待確認') : !cwd ? t('尚未選擇')
    : projectValid ? t('有效') : t('不在允許範圍')
  const instructionsState = draft.instructions.trim() ? t('已填寫') : t('尚未填寫')
  const mcpState = statusError ? t('無法確認') : !status ? t('正在讀取…')
    : status.service.running ? t('執行中') : t('未啟動')

  return <section
    className="min-h-0 flex-1 overflow-y-auto bg-app"
    aria-labelledby="devspace-heading"
    data-workflow="chatgpt-conversation-devspace-v1"
    data-primary-action="copy-before-open"
  >
    <div className="mx-auto max-w-5xl space-y-6 px-5 py-6">
      <header>
        <p className="font-mono text-xs text-mute2">ChatGPT → DevSpace MCP → {t('本機交接')}</p>
        <h1 id="devspace-heading" className="mt-2 text-2xl font-semibold">{t('DevSpace 對話入口')}</h1>
        <p className="mt-2 text-sm text-mute2">{t('由 ChatGPT 對話中的模型直接操作 MCP，成果留在本機，再由原派工者接手。')}</p>
      </header>

      {(error || statusError) && <p role="alert" className="rounded-lg border border-red-500/40 p-3 text-sm text-red-600 dark:text-red-300">{t(error || statusError)}</p>}
      {notice && <p role="status" aria-live="polite" className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink2">{t(notice)}</p>}

      <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1" aria-live="polite">
            <p className="text-xs font-medium text-mute2">{t('DevSpace 準備狀態')}</p>
            <h2 className="mt-1 font-semibold">{readinessTitle(readiness.reason)}</h2>
            <p className="mt-1 text-sm leading-6 text-mute2">{readinessDetail(readiness.reason)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {readiness.canStartMcp && <button type="button" className={primaryButton} disabled={!!serviceBusy} onClick={() => { void service('start') }}>
              {t(serviceBusy === 'start' ? '正在啟動 MCP…' : '啟動 MCP')}
            </button>}
            {!!status?.installed && !statusError && <button type="button" className={button} disabled={!!serviceBusy} onClick={() => { void service('doctor') }}>
              {t(serviceBusy === 'doctor' ? '正在檢查…' : '檢查 DevSpace 設定')}
            </button>}
            <button type="button" className={button} disabled={!!serviceBusy} onClick={refreshStatus}>{t('重新整理狀態')}</button>
            {(readiness.reason === 'uninstalled' || readiness.reason === 'missing-configuration') && <a className={`${button} inline-block`} href="https://github.com/Waishnav/devspace" target="_blank" rel="noreferrer">
              {t(readiness.reason === 'uninstalled' ? '開啟 DevSpace 安裝說明' : '開啟 DevSpace 設定說明')}
            </a>}
          </div>
        </div>

        <dl aria-label={t('DevSpace 準備狀態')} className="grid gap-3 border-t border-line pt-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
          <div><dt className="text-xs text-mute2">{t('DevSpace 安裝')}</dt><dd className="mt-1 font-medium">{installationState}</dd></div>
          <div><dt className="text-xs text-mute2">{t('設定')}</dt><dd className="mt-1 font-medium">{configurationState}</dd></div>
          <div><dt className="text-xs text-mute2">{t('專案')}</dt><dd className="mt-1 font-medium">{projectState}</dd></div>
          <div><dt className="text-xs text-mute2">{t('工作內容')}</dt><dd className="mt-1 font-medium">{instructionsState}</dd></div>
          <div><dt className="text-xs text-mute2">{t('MCP 執行')}</dt><dd className="mt-1 font-medium">{mcpState}</dd></div>
        </dl>
      </div>

      <div className="rounded-xl border border-line bg-panel p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t('在 ChatGPT 開始對話')}</h2>
          <span className="text-xs text-mute2">{status?.service.running && !statusError ? t('本機 MCP 執行中') : t('執行前仍需確認 MCP')}</span>
        </div>
        <p className="text-sm leading-6 text-mute2">{t('先在 ChatGPT 選擇「對話」，從新增內容選單加入 DevSpace，再選擇你要用的模型。此處不建立工作或背景 agent。')}</p>
        <p className="text-xs leading-5 text-mute2">{t('模型名稱與可用性以 ChatGPT 對話選單為準；不把 Codex 模型識別碼當成 ChatGPT 的切換指令。')}</p>
      </div>

      <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">{t('準備對話指示')}</h2>
          <button type="button" className={button} disabled={!!actionBusy || !draft.instructions} onClick={clearDraft}>{t('清除對話草稿')}</button>
        </div>
        <p className="text-xs leading-5 text-mute2">{t('清除對話草稿只會清除工作內容；專案資料夾與偏好模型會保留。工作內容不會寫入永久儲存。')}</p>

        <label className="block text-xs text-mute2" htmlFor="devspace-project">{t('專案資料夾')}</label>
        <div className="flex flex-wrap gap-2">
          <input
            id="devspace-project"
            className={`${input} min-w-0 flex-1 font-mono`}
            list="devspace-roots"
            value={cwd}
            disabled={!!actionBusy}
            onChange={event => changeDraft({ workspace: event.target.value })}
            placeholder="C:\\Projects\\my-project"
            spellCheck={false}
          />
          <button
            type="button"
            className={button}
            disabled={!hasFolderPicker || !!actionBusy}
            aria-label={t('選擇資料夾')}
            title={hasFolderPicker ? undefined : t('資料夾選擇器僅在桌面版可用，請直接輸入完整路徑。')}
            onClick={() => { void chooseDirectory() }}
          >
            {t(actionBusy === 'folder' ? '正在開啟…' : '選擇資料夾')}
          </button>
        </div>
        <datalist id="devspace-roots">{status?.allowedRoots.map(root => <option key={root} value={root} />)}</datalist>
        {!hasFolderPicker && <p className="text-xs text-mute2">{t('資料夾選擇器僅在桌面版可用，請直接輸入完整路徑。')}</p>}
        {!!status && !statusError && status.configured && !projectValid && <p className="text-xs text-amber-700 dark:text-amber-300">{t('請選擇 DevSpace 允許範圍內的專案。')}</p>}

        <label className="block text-xs text-mute2" htmlFor="devspace-model">{t('偏好對話模型')}</label>
        <select id="devspace-model" className={`${input} sm:max-w-xs`} value={draft.model} disabled={!!actionBusy} onChange={event => {
          if (isDevSpaceModel(event.target.value)) {
            changeDraft({ model: event.target.value })
            saveDevSpaceModel(event.target.value)
          }
        }}>{DEVSPACE_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        <p className="text-xs leading-5 text-mute2">{t('此選項只記住偏好並加入指示；實際使用模型仍需在 ChatGPT 對話中選擇。')}</p>

        <label className="block text-xs text-mute2" htmlFor="devspace-instructions">{t('要在對話中完成的內容')}</label>
        <textarea id="devspace-instructions" rows={6} className={input} value={draft.instructions} disabled={!!actionBusy} onChange={event => changeDraft({ instructions: event.target.value })} />

        <div className="flex flex-wrap gap-2" aria-describedby="devspace-action-help">
          <button type="button" className={primaryButton} disabled={!readiness.canCopy || !!actionBusy} onClick={() => { void copyAndOpenChatGPT() }}>
            {t(actionBusy === 'copy-open' ? '正在複製並開啟…' : '複製指示並開啟 ChatGPT')}
          </button>
          <button type="button" className={button} disabled={!readiness.canCopy || !!actionBusy} onClick={() => { void copyPrompt() }}>
            {t(actionBusy === 'copy' ? '正在複製…' : '複製對話指示')}
          </button>
          <button type="button" className={button} disabled={!!actionBusy} onClick={() => { void openChatGPT() }}>
            {t(actionBusy === 'open' ? '正在開啟…' : '開啟 ChatGPT 對話')}
          </button>
        </div>
        <p id="devspace-action-help" className="text-xs leading-5 text-mute2">{t('主按鈕只會先複製再開啟 ChatGPT，不會替你貼上、送出訊息或選擇模型。')}</p>
        {!readiness.canCopy && <p className="text-xs text-mute2">{t('完成上方準備項目後即可複製；MCP 可稍後啟動，但執行前必須啟動。')}</p>}

        <details>
          <summary className="cursor-pointer text-xs text-mute2">{t('檢視將要複製的指示')}</summary>
          <pre className="mt-3 whitespace-pre-wrap break-words rounded-md bg-app p-3 text-xs leading-6">{prompt}</pre>
        </details>
      </div>

      <details className="rounded-xl border border-line bg-panel p-5">
        <summary className="cursor-pointer text-sm font-medium">{t('本機 MCP 服務')}</summary>
        <p className="mt-3 break-all font-mono text-xs text-mute2">{status?.endpoint || '—'}</p>
        <p className="mt-2 text-xs text-mute2">{t('ChatGPT 使用已設定的公開 HTTPS MCP 入口；這個本機位址是服務狀態，不能直接當成雲端對話的連線網址。')}</p>
        {!!status?.configPath && <p className="mt-2 break-all text-xs text-mute2">{t('設定檔位置')}：<span className="font-mono">{status.configPath}</span></p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={button} disabled={!!serviceBusy || !!statusError || !status?.installed || !status.configured || status.service.running} onClick={() => { void service('start') }}>{t(serviceBusy === 'start' ? '正在啟動 MCP…' : '啟動 MCP')}</button>
          <button type="button" className={button} disabled={!!serviceBusy || !!statusError || !status?.service.managed} onClick={() => { void service('stop') }}>{t(serviceBusy === 'stop' ? '正在停止…' : '停止 MCP')}</button>
          <button type="button" className={button} disabled={!!serviceBusy || !!statusError || !status?.installed} onClick={() => { void service('doctor') }}>{t(serviceBusy === 'doctor' ? '正在檢查…' : '檢查 DevSpace 設定')}</button>
        </div>
        {!!status?.service.running && !status.service.managed && <p className="mt-3 text-xs text-mute2">{t('外部服務，本控制台不會停止它')}</p>}
        {!!status?.allowedRoots.length && <details className="mt-4 text-xs text-mute2"><summary className="cursor-pointer">{t('允許的工作目錄')}</summary><ul className="mt-2 space-y-1">{status.allowedRoots.map(root => <li key={root} className="break-all font-mono">{root}</li>)}</ul></details>}
        {diagnostic && <pre className="mt-4 whitespace-pre-wrap break-words text-xs leading-6">{diagnostic}</pre>}
      </details>
    </div>
  </section>
}
