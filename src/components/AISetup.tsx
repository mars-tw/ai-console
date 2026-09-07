/* eslint-disable react-refresh/only-export-components -- setup contracts are independently tested */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'

export interface AIConnection {
  id: string
  label: string
  baseUrl: string
  model: string
  models?: string[]
  status: string
  credentialStatus?: 'memory' | 'environment' | 'missing' | 'not_set'
  verifiedModel?: string
  hasKey: boolean
  apiKeyEnv?: string
}

export interface AISetupData {
  ok: boolean
  tools: {
    id: string; label: string; installed: boolean; authStatus: string
    capabilities: { chat: boolean; dispatch: boolean }; installUrl: string; setupHint: string
  }[]
  local: { models: string[]; available: boolean }
  connections: AIConnection[]
  connectionError?: string
  requirements: { id: string; label: string; ready: boolean; hint: string; url?: string }[]
}

export interface ConnectionDraft {
  id?: string
  label: string
  baseUrl: string
  apiKey?: string
  apiKeyEnv?: string
  model?: string
}

export function connectionPayload(draft: ConnectionDraft): ConnectionDraft {
  // Empty input means keep the current key; sending an empty apiKey explicitly clears it.
  const payload = { ...draft }
  if (!payload.apiKey) delete payload.apiKey
  return payload
}

export function connectionStatusLabel(status: string): string {
  if (status === 'reply_verified') return '已通過回覆測試'
  if (status === 'error' || status === 'failed') return '連線需要處理'
  if (status === 'key-required' || status === 'missing-key' || status === 'needs-key') return '請重新提供金鑰'
  return '已儲存，尚未確認可回答'
}

/** Client checks only guide input. The server remains the authority on destinations. */
export function connectionDraftError(draft: ConnectionDraft, source: 'local' | 'cloud'): string {
  if (!draft.label.trim()) return '請為這個 AI 取一個名稱。'
  try {
    const url = new URL(draft.baseUrl)
    if (url.username || url.password || url.search || url.hash) return '服務網址不能包含帳密、查詢參數或片段。'
    if (source === 'cloud' && url.protocol !== 'https:') return '雲端服務請使用 HTTPS 網址。'
    if (source === 'local' && (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return '本機服務請使用 localhost、127.0.0.1 或 [::1] 的 HTTP 網址。'
    return ''
  } catch { return '請填入完整的服務網址。' }
}

export async function setupRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, body === undefined
    ? { cache: 'no-store', signal }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  const data = await response.json()
  if (!response.ok || !data?.ok) throw new Error([data?.error || `HTTP ${response.status}`, data?.nextAction].filter(Boolean).map(message => t(message)).join(' '))
  return data as T
}

function officialLink(url: string): string | undefined {
  try { return new URL(url).protocol === 'https:' ? url : undefined } catch { return undefined }
}

export function SetupWelcome({ onStart }: { onStart: () => void }) {
  return (
    <section aria-labelledby="setup-welcome-title" className="rounded-xl border border-sky-300 bg-sky-50 p-5 dark:border-sky-900 dark:bg-sky-950/30">
      <h2 id="setup-welcome-title" className="text-lg font-semibold text-ink">{t('第一次使用？先接入你的 AI')}</h2>
      <p className="mt-2 text-sm leading-6 text-ink2">{t('照著三個步驟完成設定，就能開始問問題。原本的 AI 工具也能加入派工與對話同步。')}</p>
      <ol className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-ink2">
        <li>{t('1. 選擇 AI 來源')}</li><li>{t('2. 檢查連線與模型')}</li><li>{t('3. 試問一個問題')}</li>
      </ol>
      <button type="button" className="mt-4 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-invink hover:bg-ink2" onClick={onStart}>{t('接入 AI／開始使用')}</button>
    </section>
  )
}

export default function AISetup({ onStartChat }: { onStartChat: (connection?: AIConnection) => void }) {
  const [data, setData] = useState<AISetupData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [source, setSource] = useState<'local' | 'cloud'>('local')
  const [draft, setDraft] = useState<ConnectionDraft>({ label: '', baseUrl: 'http://localhost:11434/v1', apiKey: '', apiKeyEnv: '', model: '' })
  const [models, setModels] = useState<string[]>([])
  const [probed, setProbed] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [testResult, setTestResult] = useState<{ id: string; content: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const refreshEpoch = useRef(0)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const epoch = ++refreshEpoch.current
    setLoading(true)
    try {
      const next = await setupRequest<AISetupData>('/api/setup', undefined, signal)
      if (signal?.aborted || epoch !== refreshEpoch.current) return
      setData(next)
      setError('')
    } catch (failure) {
      if (!signal?.aborted && epoch === refreshEpoch.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally { if (!signal?.aborted && epoch === refreshEpoch.current) setLoading(false) }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort(); abortRef.current?.abort(); refreshEpoch.current += 1 }
  }, [refresh])

  const updateDraft = (update: Partial<ConnectionDraft>) => {
    setDraft(current => ({ ...current, ...update }))
    setProbed(false)
    setModels([])
    setNotice('')
    setError('')
  }

  const run = async (name: string, action: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return
    refreshEpoch.current += 1
    setLoading(false)
    setBusy(name)
    setError('')
    setNotice('')
    const controller = new AbortController()
    abortRef.current = controller
    try { await action(controller.signal) }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { if (!controller.signal.aborted) setBusy(''); if (abortRef.current === controller) abortRef.current = null }
  }

  const probe = () => {
    const invalid = connectionDraftError(draft, source)
    if (invalid) { setError(t(invalid)); return }
    void run('probe', async signal => {
      setProbed(false)
      const result = await setupRequest<{ models: string[] }>('/api/ai-connections/probe', connectionPayload(draft), signal)
      if (signal.aborted) return
      const available = Array.isArray(result.models) ? result.models : []
      setModels(available)
      setDraft(current => ({ ...current, model: available.includes(current.model || '') ? current.model : available[0] || current.model }))
      setProbed(true)
      setNotice(t('服務已連上。請選擇模型並儲存，再測試是否能回答。'))
    })
  }

  const save = () => {
    if (!probed || !draft.model?.trim()) return
    void run('save', async signal => {
      setTestResult(null)
      const result = await setupRequest<{ connection: AIConnection }>('/api/ai-connections/save', connectionPayload(draft), signal)
      if (signal.aborted) return
      setData(current => ({ ...(current || { ok: true, tools: [], requirements: [], local: { models: [], available: false } }), connections: [...(current?.connections || []).filter(item => item.id !== result.connection.id), { ...result.connection, models }] }))
      setDraft(current => ({ ...current, id: result.connection.id, apiKey: undefined }))
      setProbed(false)
      setNotice(t('AI 已加入。可以先測試回覆，或直接開始聊天。'))
    })
  }

  const test = (connection: AIConnection) => void run(`test:${connection.id}`, async signal => {
    setTestResult(null)
    setData(current => current ? { ...current, connections: current.connections.map(item => item.id === connection.id ? { ...item, status: 'saved', verifiedModel: '' } : item) } : current)
    const result = await setupRequest<{ content: string; status?: string }>('/api/ai-connections/test', { id: connection.id, model: connection.model }, signal)
    if (signal.aborted) return
    if (!result.content?.trim()) throw new Error(t('這次沒有收到回答，請檢查模型或金鑰。'))
    setTestResult({ id: connection.id, content: result.content })
    setData(current => current ? { ...current, connections: current.connections.map(item => item.id === connection.id ? { ...item, status: 'reply_verified', verifiedModel: connection.model } : item) } : current)
  })

  return (
    <section aria-labelledby="ai-setup-title" className="min-h-0 flex-1 overflow-y-auto bg-app px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 id="ai-setup-title" className="text-2xl font-semibold text-ink">{t('接入 AI／開始使用')}</h1>
          <p className="mt-2 text-sm leading-6 text-mute2">{t('選擇已有的 AI 工具，或加入支援 OpenAI 相容 API 的模型服務。')}</p>
          <button type="button" disabled={loading || !!busy} className="mt-3 rounded-md border border-line2 px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => void refresh()}>{loading ? t('正在檢查…') : t('重新檢查安裝狀態')}</button>
        </header>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}
        {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">{notice}</p>}
        {data && <>
          <section aria-labelledby="setup-tools-title">
            <h2 id="setup-tools-title" className="text-lg font-semibold">{t('使用電腦上的 AI')}</h2>
            <p className="mt-1 text-sm text-mute2">{t('偵測到安裝不代表已登入或能派工。請先在原工具完成登入，回來後再試用。')}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {data.tools.map(tool => <article key={tool.id} className="rounded-xl border border-line bg-panel p-4">
                <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{tool.label}</h3><span className="text-xs text-mute2">{tool.installed ? t('已安裝；登入狀態未驗證') : t('尚未安裝')}</span></div>
                <p className="mt-2 text-sm leading-6 text-mute2">{t(tool.setupHint)}</p>
                <p className="mt-2 text-xs text-mute2">{tool.capabilities.dispatch ? t('可用於派工；請先在原工具登入') : t('可同步本機已有的對話')}</p>
                {officialLink(tool.installUrl) && <a className="mt-3 inline-block text-sm text-sky-700 underline dark:text-sky-300" href={officialLink(tool.installUrl)} target="_blank" rel="noreferrer">{tool.installed ? t('查看官方設定說明') : t('前往官方下載／安裝說明')}</a>}
              </article>)}
              <article className="rounded-xl border border-line bg-panel p-4">
                <h3 className="font-medium">LM Studio</h3>
                <p className="mt-2 text-sm leading-6 text-mute2">{data.local.models.length ? t('找到 {n} 個已安裝模型；送出問題時會檢查可否安全載入。', { n: data.local.models.length }) : t('先安裝 LM Studio 並下載一個模型，再回來重新檢查。')}</p>
                <p className="mt-2 text-xs text-mute2">{t('已安裝、已載入與服務已啟動是不同狀態。控制台會先檢查地端模型的使用條件。')}</p>
                <div className="mt-3 flex flex-wrap gap-3"><a className="text-sm text-sky-700 underline dark:text-sky-300" href="https://lmstudio.ai/download" target="_blank" rel="noreferrer">{t('前往官方下載／安裝說明')}</a><button type="button" className="text-sm underline" onClick={() => onStartChat()}>{t('用 LM Studio 問問題')}</button></div>
              </article>
            </div>
          </section>
          {data.requirements.length > 0 && <details className="rounded-xl border border-line bg-panel p-4"><summary className="cursor-pointer font-medium">{t('派工需要的輔助工具')}</summary><ul className="mt-3 space-y-3">{data.requirements.map(item => <li key={item.id} className="text-sm"><strong>{t(item.label)}</strong> · {item.ready ? t('已找到') : t('尚未找到')}<p className="mt-1 text-mute2">{t(item.hint)}</p>{item.url && officialLink(item.url) && <a href={officialLink(item.url)} target="_blank" rel="noreferrer" className="mt-1 inline-block underline">{t('查看官方設定說明')}</a>}</li>)}</ul></details>}
        </>}
        <section aria-labelledby="custom-ai-title" className="rounded-xl border border-line bg-panel p-5">
          <h2 id="custom-ai-title" className="text-lg font-semibold">{draft.id ? t('修改 AI 連線') : t('加入其他 AI 服務')}</h2>
          {draft.id && <button type="button" disabled={!!busy} className="mt-2 text-sm underline disabled:opacity-40" onClick={() => { setDraft({ label: '', baseUrl: source === 'local' ? 'http://localhost:11434/v1' : 'https://', model: '', apiKey: '', apiKeyEnv: '' }); setProbed(false); setModels([]); setNotice(''); setError('') }}>{t('新增另一個 AI')}</button>}
          <p className="mt-1 text-sm leading-6 text-mute2">{t('這個連線用來回答問題。API 測試與聊天會傳送到你填入的服務，雲端服務可能計費。')}</p>
          <fieldset disabled={!!busy || loading} className="mt-4 space-y-4 disabled:opacity-60">
            <legend className="sr-only">{t('AI 連線設定')}</legend>
            <label className="block text-sm">{t('1. 選擇 AI 來源')}<select disabled={!!draft.id} className="mt-1 block w-full rounded-md border border-line2 bg-app p-2 disabled:opacity-60" value={source} onChange={event => { const next = event.target.value as 'local' | 'cloud'; setSource(next); updateDraft({ baseUrl: next === 'local' ? 'http://localhost:11434/v1' : 'https://', apiKey: '', apiKeyEnv: '', model: '' }) }}><option value="local">{t('本機服務（例如 Ollama）')}</option><option value="cloud">{t('雲端服務（OpenAI 相容 API）')}</option></select></label>
            <label className="block text-sm">{t('AI 名稱')}<input className="mt-1 block w-full rounded-md border border-line2 bg-app p-2" value={draft.label} maxLength={80} placeholder={t('例如：我的 AI')} onChange={event => updateDraft({ label: event.target.value })} /></label>
            <label className="block text-sm">{t('服務網址（Base URL）')}<input type="url" readOnly={!!draft.id} className="mt-1 block w-full rounded-md border border-line2 bg-app p-2 read-only:opacity-60" value={draft.baseUrl} autoComplete="off" onChange={event => updateDraft({ baseUrl: event.target.value })} /><span className="mt-1 block text-xs text-mute2">{draft.id ? t('要更換服務網址，請按「新增另一個 AI」並重新提供該服務的金鑰。') : t('請填服務商提供的 API 網址，通常以 /v1 結尾；不是聊天網站網址。')}</span></label>
            <label className="block text-sm">{t('API 金鑰（服務需要時才填）')}<input type="password" className="mt-1 block w-full rounded-md border border-line2 bg-app p-2" value={draft.apiKey || ''} autoComplete="off" spellCheck={false} aria-describedby="setup-key-hint" onChange={event => updateDraft({ apiKey: event.target.value, apiKeyEnv: '' })} /></label>
            <p id="setup-key-hint" className="text-xs leading-5 text-mute2">{t('金鑰只放在本機背景服務的記憶體，不會存入設定檔；關閉視窗不會清除。重新啟動背景服務或移除此連線後，需重新提供金鑰。請勿在聊天訊息中貼上金鑰。')}</p>
            <details><summary className="cursor-pointer text-sm text-mute2">{t('進階：使用環境變數中的金鑰')}</summary><label className="mt-2 block text-sm">{t('環境變數名稱')}<input className="mt-1 block w-full rounded-md border border-line2 bg-app p-2" value={draft.apiKeyEnv} placeholder="MY_AI_API_KEY" autoComplete="off" onChange={event => updateDraft({ apiKeyEnv: event.target.value, apiKey: '' })} /></label></details>
            <button type="button" className="rounded-lg border border-line2 px-4 py-2 text-sm hover:bg-elev" onClick={probe}>{busy === 'probe' ? t('正在檢查…') : t('2. 檢查連線並取得模型')}</button>
            {probed && <div className="space-y-3 rounded-lg bg-elev p-4">
              {models.length ? <label className="block text-sm">{t('選擇模型')}<select className="mt-1 block w-full rounded-md border border-line2 bg-panel p-2" value={draft.model} onChange={event => setDraft(current => ({ ...current, model: event.target.value }))}>{models.map(model => <option key={model}>{model}</option>)}</select></label> : <label className="block text-sm">{t('模型名稱')}<input className="mt-1 block w-full rounded-md border border-line2 bg-panel p-2" value={draft.model} onChange={event => setDraft(current => ({ ...current, model: event.target.value }))} /><span className="mt-1 block text-xs text-mute2">{t('服務沒有提供模型清單，請填入服務商提供的模型名稱。')}</span></label>}
              <button type="button" disabled={!draft.model?.trim()} className="rounded-lg bg-ink px-4 py-2 text-sm text-invink disabled:opacity-40" onClick={save}>{t('3. 儲存這個 AI')}</button>
            </div>}
          </fieldset>
        </section>
        <section aria-labelledby="saved-ai-title">
          <h2 id="saved-ai-title" className="text-lg font-semibold">{t('已加入的 AI')}</h2>
          {data?.connectionError && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{t('無法讀取已加入的 AI：{err}', { err: data.connectionError })}</p>}
          {!data?.connectionError && !data?.connections.length && <p className="mt-2 text-sm text-mute2">{t('尚未加入其他服務；你也可以直接使用上方的 LM Studio。')}</p>}
          <div className="mt-3 space-y-3">{data?.connections.map(connection => <article key={connection.id} className="rounded-xl border border-line bg-panel p-4">
            <div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">{connection.label}</h3><span className="text-xs text-mute2">{t(connection.credentialStatus === 'missing' ? '請重新提供金鑰' : connectionStatusLabel(connection.status))}</span></div>
            <p className="mt-1 break-all text-sm text-mute2">{connection.model} · {connection.baseUrl}</p>
            {connection.hasKey && <p className="mt-1 text-xs text-mute2">{t('金鑰：已提供（不顯示內容）')}</p>}
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" disabled={!!busy} className="rounded-md border border-line2 px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => test(connection)}>{busy === `test:${connection.id}` ? t('正在回答…') : t('測試回覆')}</button>
              <button type="button" className="rounded-md bg-ink px-3 py-1.5 text-sm text-invink" onClick={() => onStartChat(connection)}>{t('開始問問題')}</button>
              <button type="button" disabled={!!busy} className="rounded-md border border-line2 px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => { setSource(connection.baseUrl.startsWith('https:') ? 'cloud' : 'local'); setDraft({ id: connection.id, label: connection.label, baseUrl: connection.baseUrl, model: connection.model, apiKey: '', apiKeyEnv: connection.apiKeyEnv || '' }); setProbed(false); setModels([]); setError(''); setNotice(t('正在修改 {name}。檢查連線後儲存即可更新。', { name: connection.label })); document.getElementById('custom-ai-title')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}>{t('修改連線／更新金鑰')}</button>
              <button type="button" disabled={!!busy} className="rounded-md px-3 py-1.5 text-sm text-mute2 disabled:opacity-40" onClick={() => void run(`delete:${connection.id}`, async signal => { await setupRequest('/api/ai-connections/delete', { id: connection.id }, signal); if (!signal.aborted) setData(current => current ? { ...current, connections: current.connections.filter(item => item.id !== connection.id) } : current) })}>{t('移除此連線')}</button>
            </div>
            {testResult?.id === connection.id && <p role="status" className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-elev p-3 text-sm">{testResult.content}</p>}
          </article>)}</div>
        </section>
      </div>
    </section>
  )
}
