/* eslint-disable react-refresh/only-export-components -- setup contracts are independently tested */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { askBlockMessage, askPreflight, localModels } from './AskAI'
import type { AskBlockReason, LocalSetupInfo } from './AskAI'

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
  /**
   * /api/setup 的 local 區塊。models／available 是既有欄位（既有匯入不受影響），
   * 其餘 ready／state／reason 一律以 unknown 保留原始回報 —— 後端說不清楚的狀態
   * 不能在畫面上被湊成「可以送出」。
   */
  local: LocalSetupInfo & { models: string[]; available: boolean }
  connections: AIConnection[]
  connectionError?: string
  requirements: { id: string; label: string; ready: boolean; hint: string; url?: string }[]
}

export type SetupTool = AISetupData['tools'][number]
export type SetupRequirement = AISetupData['requirements'][number]

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

/** 後端 metadata 只認陣列；null／物件／字串一律當成「這一段讀不到」，不是空清單。 */
export function setupList<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((item): item is T => !!item && typeof item === 'object') : []
}

/** 讀不到的區塊要說出來，不能靜靜地畫成「什麼都沒有」。 */
export function metadataWarning(data: AISetupData | null): string {
  if (!data || typeof data !== 'object') return ''
  const broken = [
    Array.isArray(data.tools) ? '' : 'AI 工具清單',
    Array.isArray(data.connections) ? '' : '已加入的 AI',
    Array.isArray(data.requirements) ? '' : '輔助工具清單',
    data.local && typeof data.local === 'object' && !Array.isArray(data.local) ? '' : '地端狀態',
  ].filter(Boolean)
  return broken.length ? `讀不到完整的設定資料（${broken.join('、')}），請按「重新檢查安裝狀態」。` : ''
}

// ---------------------------------------------------------------------------
// 三條路：預設是地端，畫面一次只出現一條。
// ---------------------------------------------------------------------------

export type SetupPath = 'local' | 'cloud' | 'installed'
export const DEFAULT_SETUP_PATH: SetupPath = 'local'

export const SETUP_PATHS: readonly { id: SetupPath; label: string; hint: string }[] = [
  { id: 'local', label: '這台電腦（地端 AI）', hint: '用 LM Studio 在自己的電腦上跑模型，不需要帳號，也不會計費。' },
  { id: 'cloud', label: '雲端 AI 帳號', hint: '用服務商的 API 金鑰連線；依用量計費，金鑰只留在記憶體。' },
  { id: 'installed', label: '我已安裝 AI 工具', hint: '接上電腦上已安裝的 AI 指令列工具；安裝不等於已登入。' },
]

/** 地端安裝步驟，順序就是使用者要照做的順序；每一步都指向官方頁面。 */
export const LOCAL_GUIDE_STEPS: readonly { id: string; title: string; detail: string; url?: string }[] = [
  { id: 'download', title: '1. 下載並安裝 LM Studio', detail: '到官方下載頁取得安裝檔，安裝完成後開啟它。', url: 'https://lmstudio.ai/download' },
  { id: 'model', title: '2. 在 Discover（Ctrl+2）下載一個支援的模型', detail: '要等下載完成，進度沒跑完就回來，這裡會找不到模型。', url: 'https://lmstudio.ai/docs/app/basics/download-model' },
  { id: 'runtime', title: '3. 在 Runtime Manager（Ctrl+Shift+R）安裝 CPU llama.cpp（Windows）2.24.0', detail: '請選 CPU 版本 2.24.0，不是 GPU／CUDA 版，也不要直接選 latest。', url: 'https://lmstudio.ai/docs/app' },
  { id: 'recheck', title: '4. 回到這裡按「重新檢查安裝狀態」', detail: '這個畫面不會自動下載、載入或送出任何東西，一切都要你按。' },
  { id: 'start', title: '5. 選擇找到的模型，再開始問問題', detail: '沒有選到清單裡的模型，開始鈕就不會放行。' },
]

export type CloudPreset = { id: string; label: string; baseUrl: string; keyUrl?: string; modelsUrl?: string; helpUrl?: string; note?: string }

/** 服務商網址一律照官方文件抄；沒有公開頁面的欄位就留空，不自己編一個。 */
export const CLOUD_PRESETS: readonly CloudPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', helpUrl: 'https://api-docs.deepseek.com/', note: '金鑰請在 DeepSeek 官方文件指引的 API 後台建立。' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/settings/keys', modelsUrl: 'https://openrouter.ai/models', helpUrl: 'https://openrouter.ai/docs/quickstart' },
  { id: 'zhipu', label: '智譜（通用 API）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', helpUrl: 'https://docs.bigmodel.cn/cn/guide/develop/http/introduction', note: '這是通用 API 端點，不是 Coding 專用端點。' },
  { id: 'custom', label: '其他 OpenAI 相容服務（自己填）', baseUrl: '' },
]

/** 文件上看得到的名稱示範。沒有驗證過，也不保證你的帳號有存取權。 */
export const MANUAL_MODEL_EXAMPLE = {
  model: 'glm-5.2',
  url: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2',
  note: '示範：智譜文件列出 glm-5.2。這只是文件上的名稱，未經本機驗證，也不保證你的帳號有存取權，請以官方文件為準。',
}

export const CLOUD_KEY_NOTES: readonly string[] = [
  'API 金鑰不是聊天網站的登入密碼，要另外到服務商的 API 後台建立。',
  '聊天訂閱方案不一定包含 API 用量，兩者常常分開計費。',
  '金鑰只放在本機背景服務的記憶體，不會寫入設定檔、也不會寫進紀錄；重新啟動背景服務後要重新提供。',
  '只有你自己按「測試回覆」時才會真的送出一次請求，這一次可能會計費。',
]

export const MANUAL_MODEL_NOTICE = '未驗證：服務沒有模型清單，請依官方說明填入模型名稱，儲存後測試回覆。'

export function blankDraft(source: 'local' | 'cloud'): ConnectionDraft {
  return { label: '', baseUrl: source === 'local' ? 'http://localhost:11434/v1' : 'https://', apiKey: '', apiKeyEnv: '', model: '' }
}

/** 換路徑、換服務商都要把上一家的東西丟乾淨：id、金鑰、環境變數、模型、探測與測試結果。 */
export function clearedSetupState(source: 'local' | 'cloud'): { draft: ConnectionDraft; probe: null; testResult: null; notice: string } {
  return { draft: blankDraft(source), probe: null, testResult: null, notice: '' }
}

/** 選了服務商就只填名稱與網址；絕不把上一家的金鑰或模型帶到新目的地。 */
export function applyCloudPreset(presetId: string): ConnectionDraft {
  const preset = CLOUD_PRESETS.find(item => item.id === presetId)
  const blank = blankDraft('cloud')
  if (!preset || preset.id === 'custom') return blank
  return { ...blank, label: preset.label, baseUrl: preset.baseUrl }
}

// ---------------------------------------------------------------------------
// 探測結果：手動填模型只在後端明講「這個服務沒有模型清單」時才開放。
// ---------------------------------------------------------------------------

export type ProbeOutcome =
  | { kind: 'models'; models: string[] }
  | { kind: 'manual' }
  | { kind: 'error'; message: string }

function probeStatusHint(status: number): string {
  if (status === 401 || status === 403) return '這個服務不接受這把金鑰，請確認金鑰正確、而且已開通 API。'
  if (status === 429) return '請求太頻繁或額度已用完，請稍後再試。'
  if (status === 500 || status === 502 || status === 503 || status === 504) return '服務暫時無法回應，請稍後再檢查一次。'
  if (status === 404 || status === 405) return '這個服務網址查不到模型清單，請確認網址（通常以 /v1 結尾）。'
  return ''
}

function probeErrorMessage(status: number, data: Record<string, unknown> | null): string {
  const error = typeof data?.error === 'string' && data.error.trim() ? data.error : `HTTP ${status}`
  const nextAction = typeof data?.nextAction === 'string' && data.nextAction.trim() ? data.nextAction : ''
  return [error, nextAction, probeStatusHint(status)].filter(Boolean).map(message => t(message)).join(' ')
}

/**
 * 探測回應要自己解析，不能沿用 setupRequest 的「非 2xx 就丟例外」——
 * 那樣會把後端唯一一個「可以手動填模型」的信封整包吃掉。
 *
 * 只認這一個完整信封（HTTP 400）：
 *   { ok:false, status:'model_list_unavailable', models:[], manualModelAllowed:true, verified:false }
 * 它的意思是「這家服務的 GET /models 是 404／405」，不是金鑰被拒。
 * 401／403／429／503、隨便一個 404、少欄位、型別不對、旗標互相矛盾，一律當錯誤。
 */
export function parseProbeOutcome(status: number, body: unknown): ProbeOutcome {
  const data = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  if (status >= 200 && status < 300 && data?.ok === true) {
    const raw = Array.isArray(data.models) ? data.models : null
    const models = (raw || []).filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
    // 空清單或混了非字串＝沒有可用的模型名稱，這不算探測成功，也不因此開放手動填寫。
    if (!raw || !models.length || models.length !== raw.length) {
      return { kind: 'error', message: t('這個服務沒有回報可用的模型名稱，請確認金鑰與服務網址後再檢查一次。') }
    }
    return { kind: 'models', models }
  }
  if (status === 400 && data
    && data.ok === false
    && data.status === 'model_list_unavailable'
    && Array.isArray(data.models) && data.models.length === 0
    && data.manualModelAllowed === true
    && data.verified === false) {
    return { kind: 'manual' }
  }
  return { kind: 'error', message: probeErrorMessage(status, data) }
}

/** 探測：HTTP 錯誤交給 parseProbeOutcome，連不上就是連不上，只有 abort 往外丟。 */
export async function probeRequest(body: ConnectionDraft, signal?: AbortSignal): Promise<ProbeOutcome> {
  let response: Response
  try {
    response = await fetch('/api/ai-connections/probe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    })
  } catch (failure) {
    if (failure instanceof Error && failure.name === 'AbortError') throw failure
    return { kind: 'error', message: t('連不到這個服務。請確認網路、服務網址，以及服務是否已啟動。') }
  }
  let payload: unknown = null
  try { payload = await response.json() } catch { payload = null }
  return parseProbeOutcome(response.status, payload)
}

/** 能不能存：清單模式要選清單裡的，手動模式只在後端說沒有清單時才成立。 */
export function canSaveConnection(input: { probe: ProbeOutcome | null; model?: string; busy?: boolean }): boolean {
  if (input.busy) return false
  if (!input.probe || input.probe.kind === 'error') return false
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model) return false
  if (input.probe.kind === 'models') return input.probe.models.includes(model)
  return true
}

/** 只有真的收到「非空字串」的回答，才算通過回覆測試。 */
export function replyVerified(content: unknown): boolean {
  return typeof content === 'string' && content.trim() !== ''
}

/** 舊的非同步結果還能不能寫回畫面：換路徑、換服務商、卸載都會讓它失效。 */
export function acceptSetupResult(input: { epoch: number; current: number; aborted?: boolean }): boolean {
  return !input.aborted && input.epoch === input.current
}

export type SavedStartReason = 'loading' | 'busy' | 'connection_missing' | 'missing_key' | 'missing_model'
export type SavedStartPlan = { action: 'start' } | { action: 'blocked'; reason: SavedStartReason }

/** 已儲存的 AI 要不要放行開始問問題。未驗證可以問，缺金鑰或缺模型不行。 */
export function savedStartPlan(input: { connection: AIConnection | null | undefined; loading: boolean; busy: boolean }): SavedStartPlan {
  if (input.loading) return { action: 'blocked', reason: 'loading' }
  if (input.busy) return { action: 'blocked', reason: 'busy' }
  const connection = input.connection
  if (!connection || typeof connection !== 'object' || typeof connection.id !== 'string' || !connection.id) return { action: 'blocked', reason: 'connection_missing' }
  if (connection.credentialStatus === 'missing') return { action: 'blocked', reason: 'missing_key' }
  if (typeof connection.model !== 'string' || !connection.model.trim()) return { action: 'blocked', reason: 'missing_model' }
  return { action: 'start' }
}

export function savedStartBlockMessage(reason: SavedStartReason): string {
  if (reason === 'loading') return '正在檢查設定，請稍候。'
  if (reason === 'busy') return '正在處理上一個動作，請稍候。'
  if (reason === 'connection_missing') return '找不到這個連線，請重新檢查安裝狀態。'
  if (reason === 'missing_key') return '這個 AI 少了金鑰，請按「修改連線／更新金鑰」補上。'
  return '這個 AI 還沒選模型，請先修改連線並選一個模型。'
}

export type LocalStartReason = AskBlockReason | 'setup_error' | 'model_missing'
export type LocalStartPlan = { action: 'start'; model: string } | { action: 'blocked'; reason: LocalStartReason }

/**
 * 「用地端模型開始問問題」按不按得下去。
 *
 * 只認 /api/setup 的既有判準（askPreflight：ready === true 且狀態是後端認得的
 * ready／needs_start，清單非空）—— 有模型檔案、available:true 或 models.length
 * 都不算準備好。而且不替使用者猜模型：一定要他自己選過清單裡的那一個，
 * 按下去才發現載不動的話，問題已經被吃掉了。
 */
export function localStartPlan(input: {
  local: LocalSetupInfo | null
  loading: boolean
  error?: string
  model: string
}): LocalStartPlan {
  if (input.loading) return { action: 'blocked', reason: 'loading' }
  if (input.error) return { action: 'blocked', reason: 'setup_error' }
  const chosen = typeof input.model === 'string' ? input.model.trim() : ''
  const preflight = askPreflight({
    model: chosen || 'auto',
    local: input.local,
    localLoading: false,
    connections: [],
    connectionsLoading: false,
    connectionsError: '',
  })
  if (!preflight.ok) return { action: 'blocked', reason: preflight.reason }
  if (!chosen || !localModels(input.local).includes(chosen)) return { action: 'blocked', reason: 'model_missing' }
  return { action: 'start', model: chosen }
}

/** 擋下來的原因要說人話；地端共用的原因沿用 AskAI 的同一份文案。 */
export function localStartBlockMessage(reason: LocalStartReason): string {
  if (reason === 'setup_error') return '讀不到這台電腦的 AI 狀態，請按「重新檢查安裝狀態」後再試。'
  if (reason === 'model_missing') return '請先選一個已下載的模型，再開始問問題。'
  return askBlockMessage(reason)
}

/** 後端回報的狀態轉成一句人看得懂的下一步；不認得就說不知道，不猜成可用。 */
export function localStateText(state: unknown): string {
  if (typeof state !== 'string' || !state.trim()) return '目前狀態不明，請按「重新檢查安裝狀態」。'
  if (state === 'ready') return '地端服務已就緒，選一個模型就能開始問問題。'
  if (state === 'needs_start') return '送出問題時準備模型（現在不會載入任何東西）。'
  return '地端服務還沒就緒，請照官方說明安裝並下載模型後重新檢查。'
}

/** 後端給的原因字串照原文翻譯顯示；不是字串就不顯示，絕不把物件硬轉成文字。 */
export function localReasonText(local: LocalSetupInfo | null): string {
  const reason = local && typeof local === 'object' ? local.reason : null
  return typeof reason === 'string' && reason.trim() ? reason : ''
}

/** 已下載幾個模型。已下載不等於已載入，文字要講清楚。 */
export function localInventoryText(local: LocalSetupInfo | null): string {
  const count = localModels(local).length
  return count ? `已下載的模型：${count} 個（已下載不等於已載入）。` : '已下載的模型：目前找不到，請完成第 2 步再重新檢查。'
}

/** 執行環境（llama.cpp）只照後端的 runtime.verified 講；沒說就是不知道。 */
export function localRuntimeText(local: LocalSetupInfo | null): string {
  const runtime = local && typeof local === 'object' ? (local as { runtime?: unknown }).runtime : null
  const verified = runtime && typeof runtime === 'object' && !Array.isArray(runtime) ? (runtime as { verified?: unknown }).verified : undefined
  if (verified === true) return '執行環境：後端回報已驗證。'
  if (verified === false) return '執行環境：後端回報尚未驗證，請照第 3 步安裝 CPU llama.cpp（Windows）2.24.0。'
  return '執行環境：狀態不明，請按「重新檢查安裝狀態」。'
}

/** 已載入哪一個模型。後端沒回報就說沒回報，不要當成已載入。 */
export function localLoadedText(local: LocalSetupInfo | null): string {
  const model = local && typeof local === 'object' ? local.model : null
  return typeof model === 'string' && model.trim() ? `目前已載入：${model}。` : '目前沒有回報已載入的模型（已下載 ≠ 已載入 ≠ 已就緒）。'
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

export default function AISetup({ onStartChat }: { onStartChat: (connection?: AIConnection, localModel?: string) => void }) {
  const [data, setData] = useState<AISetupData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [path, setPath] = useState<SetupPath>(DEFAULT_SETUP_PATH)
  const [preset, setPreset] = useState('')
  const [draft, setDraft] = useState<ConnectionDraft>(blankDraft('local'))
  const [probeResult, setProbeResult] = useState<ProbeOutcome | null>(null)
  /** 使用者在地端卡片上選的模型。空字串代表還沒選，按鈕就不能按。 */
  const [localModel, setLocalModel] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [testResult, setTestResult] = useState<{ id: string; content: string } | null>(null)
  /** 同步的忙碌鎖：連按兩下之間沒有重繪那一幀，不能只靠 busy state 擋。 */
  const busyRef = useRef<AbortController | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const epochRef = useRef(0)
  const mountedRef = useRef(true)

  const accepted = (epoch: number, signal?: AbortSignal) =>
    mountedRef.current && acceptSetupResult({ epoch, current: epochRef.current, aborted: !!signal?.aborted })

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const epoch = ++epochRef.current
    const live = () => mountedRef.current && acceptSetupResult({ epoch, current: epochRef.current, aborted: !!signal?.aborted })
    setLoading(true)
    try {
      const next = await setupRequest<AISetupData>('/api/setup', undefined, signal)
      if (!live()) return
      setData(next)
      setError('')
    } catch (failure) {
      if (live()) setError(failure instanceof Error ? failure.message : String(failure))
    } finally { if (live()) setLoading(false) }
  }, [])

  /**
   * StrictMode 會 setup → cleanup → setup 演一次，所以掛載時要把 mounted 設回 true。
   * 卸載時：先讓還在飛的回應失效，再放掉忙碌鎖與 abort，避免留下按不動的按鈕。
   */
  useEffect(() => {
    mountedRef.current = true
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => {
      mountedRef.current = false
      epochRef.current += 1
      controller.abort()
      abortRef.current?.abort()
      abortRef.current = null
      busyRef.current = null
    }
  }, [refresh])

  /** 改名稱、網址、金鑰、環境變數＝這份設定變了：探測與測試結果一律作廢。 */
  const updateDraft = (update: Partial<ConnectionDraft>) => {
    setDraft(current => ({ ...current, ...update }))
    setProbeResult(null)
    setTestResult(null)
    setNotice('')
    setError('')
  }

  /** 選模型不需要重新探測，但已經拿到的回覆測試結果不能再算數。 */
  const chooseModel = (model: string) => {
    setDraft(current => ({ ...current, model }))
    setTestResult(null)
    setNotice('')
  }

  /** 換路徑或換服務商：取消進行中的請求、讓晚到的回應失效，並清掉上一家的所有痕跡。 */
  const resetConnection = (source: 'local' | 'cloud') => {
    epochRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    busyRef.current = null
    setBusy('')
    const cleared = clearedSetupState(source)
    setDraft(cleared.draft)
    setProbeResult(cleared.probe)
    setTestResult(cleared.testResult)
    setNotice(cleared.notice)
    setError('')
  }

  const switchPath = (next: SetupPath) => {
    if (next === path) return
    setPath(next)
    setPreset('')
    resetConnection(next === 'cloud' ? 'cloud' : 'local')
  }

  const choosePreset = (id: string) => {
    resetConnection('cloud')
    setPreset(id)
    setDraft(applyCloudPreset(id))
  }

  const run = async (name: string, action: (signal: AbortSignal, accept: () => boolean) => Promise<void>) => {
    if (busyRef.current) return
    const controller = new AbortController()
    const epoch = ++epochRef.current
    busyRef.current = controller
    abortRef.current = controller
    const accept = () => accepted(epoch, controller.signal)
    setLoading(false)
    setBusy(name)
    setError('')
    setNotice('')
    try { await action(controller.signal, accept) }
    catch (failure) { if (accept()) setError(failure instanceof Error ? failure.message : String(failure)) }
    finally {
      if (abortRef.current === controller) abortRef.current = null
      // 忙碌鎖一定要放掉（含被取消時），否則按鈕會永遠停在 disabled。
      if (busyRef.current === controller) { busyRef.current = null; if (mountedRef.current) setBusy('') }
    }
  }

  const source: 'local' | 'cloud' = path === 'cloud' ? 'cloud' : 'local'
  const activePreset = CLOUD_PRESETS.find(item => item.id === preset)

  const runProbe = () => {
    const invalid = connectionDraftError(draft, source)
    if (invalid) { setError(t(invalid)); return }
    void run('probe', async (signal, accept) => {
      setProbeResult(null)
      const outcome = await probeRequest(connectionPayload(draft), signal)
      if (!accept()) return
      if (outcome.kind === 'error') { setError(outcome.message); return }
      setProbeResult(outcome)
      if (outcome.kind === 'models') {
        // 不替使用者挑模型：雲端服務可能計費，一定要他自己選。
        setDraft(current => ({ ...current, model: outcome.models.includes(current.model || '') ? current.model : '' }))
        setNotice(t('服務已連上並取得模型清單。請選擇模型並儲存，再測試是否能回答。'))
      } else {
        setDraft(current => ({ ...current, model: current.model || '' }))
        setNotice(t(MANUAL_MODEL_NOTICE))
      }
    })
  }

  const save = () => {
    if (!canSaveConnection({ probe: probeResult, model: draft.model, busy: !!busy })) return
    const manual = probeResult?.kind === 'manual'
    const listed = probeResult?.kind === 'models' ? probeResult.models : []
    void run('save', async (signal, accept) => {
      setTestResult(null)
      const result = await setupRequest<{ connection: AIConnection }>('/api/ai-connections/save', connectionPayload(draft), signal)
      if (!accept()) return
      setData(current => ({
        ...(current || { ok: true, tools: [], requirements: [], local: { models: [], available: false } }),
        connections: [...setupList<AIConnection>(current?.connections).filter(item => item.id !== result.connection.id), { ...result.connection, models: listed }],
      }))
      setDraft(current => ({ ...current, id: result.connection.id, apiKey: undefined }))
      setProbeResult(null)
      // 存起來只代表「填好了」。要不要說得出話，得等使用者自己按測試回覆。
      setNotice(t(manual ? MANUAL_MODEL_NOTICE : '已儲存，尚未確認可回答。要確認的話請按「測試回覆」（會實際送出一次請求，雲端服務可能計費）。'))
    })
  }

  const test = (connection: AIConnection) => void run(`test:${connection.id}`, async (signal, accept) => {
    setTestResult(null)
    setData(current => current ? { ...current, connections: setupList<AIConnection>(current.connections).map(item => item.id === connection.id ? { ...item, status: 'saved', verifiedModel: '' } : item) } : current)
    const result = await setupRequest<{ content?: unknown; status?: string }>('/api/ai-connections/test', { id: connection.id, model: connection.model }, signal)
    if (!accept()) return
    if (!replyVerified(result.content)) throw new Error(t('這次沒有收到回答，請檢查模型或金鑰。'))
    setTestResult({ id: connection.id, content: String(result.content) })
    setData(current => current ? { ...current, connections: setupList<AIConnection>(current.connections).map(item => item.id === connection.id ? { ...item, status: 'reply_verified', verifiedModel: connection.model } : item) } : current)
  })

  // 陣列或缺欄位的 local 一律當成「讀不到」，不是「可以用」。
  const localInfo: LocalSetupInfo | null = data && data.local && typeof data.local === 'object' && !Array.isArray(data.local) ? data.local : null
  const availableLocalModels = localModels(localInfo)
  const localReason = localReasonText(localInfo)
  const tools = setupList<SetupTool>(data?.tools)
  const requirements = setupList<SetupRequirement>(data?.requirements)
  const connections = setupList<AIConnection>(data?.connections)
  const dataWarning = metadataWarning(data)
  const startPlan = localStartPlan({ local: localInfo, loading, error, model: localModel })
  const startLocalChat = () => {
    // 按鈕已經 disabled，這裡再擋一次：鍵盤、舊畫面或未來的呼叫端都走同一條判斷。
    const plan = localStartPlan({ local: localInfo, loading, error, model: localModel })
    if (plan.action !== 'start') return
    onStartChat(undefined, plan.model)
  }
  const startSavedChat = (connection: AIConnection) => {
    const plan = savedStartPlan({ connection, loading, busy: !!busy })
    if (plan.action !== 'start') return
    onStartChat(connection)
  }

  const editConnection = (connection: AIConnection) => {
    const editSource: 'local' | 'cloud' = typeof connection.baseUrl === 'string' && connection.baseUrl.startsWith('https:') ? 'cloud' : 'local'
    resetConnection(editSource)
    setPath(editSource)
    setPreset('')
    // 既有連線的 id 與服務網址不可變；金鑰留白＝沿用背景服務裡的那一把。
    setDraft({ id: connection.id, label: connection.label || '', baseUrl: connection.baseUrl || '', model: connection.model || '', apiKey: '', apiKeyEnv: connection.apiKeyEnv || '' })
    setNotice(t('正在修改 {name}。檢查連線後儲存即可更新。', { name: connection.label }))
  }

  /** 地端進階與雲端共用的同一張表單。地端只會出現在「進階」摺疊裡。 */
  const connectionForm = (formSource: 'local' | 'cloud') => (
    <fieldset disabled={!!busy || loading} className="mt-3 space-y-4 disabled:opacity-60">
      <legend className="sr-only">{t('AI 連線設定')}</legend>
      {draft.id && <p className="text-xs text-mute2">{t('正在修改既有連線：服務網址不可更改，留白的金鑰會沿用原本那一把。')}</p>}
      <label className="block text-sm">{t('AI 名稱')}
        <input className="mt-1 block w-full rounded-md border border-line2 bg-app p-2" value={draft.label} maxLength={80} placeholder={t('例如：我的 AI')} onChange={event => updateDraft({ label: event.target.value })} />
      </label>
      {formSource === 'cloud' ? <>
        <label className="block text-sm">{t('API 金鑰')}
          <input type="password" className="mt-1 block w-full rounded-md border border-line2 bg-app p-2" value={draft.apiKey || ''} autoComplete="off" spellCheck={false} aria-describedby="setup-key-hint" onChange={event => updateDraft({ apiKey: event.target.value, apiKeyEnv: '' })} />
        </label>
        <ul id="setup-key-hint" className="list-disc space-y-1 pl-5 text-xs leading-5 text-mute2">
          {CLOUD_KEY_NOTES.map(note => <li key={note}>{t(note)}</li>)}
        </ul>
        <details><summary className="cursor-pointer text-sm text-mute2">{t('進階：自訂服務網址或改用環境變數金鑰')}</summary>
          <label className="mt-2 block text-sm">{t('服務網址（Base URL）')}
            <input type="url" readOnly={!!draft.id} className="mt-1 block w-full rounded-md border border-line2 bg-app p-2 read-only:opacity-60" value={draft.baseUrl} autoComplete="off" onChange={event => updateDraft({ baseUrl: event.target.value })} />
            <span className="mt-1 block text-xs text-mute2">{draft.id ? t('要更換服務網址，請新增一個連線並重新提供該服務的金鑰。') : t('請填服務商提供的 API 網址，通常以 /v1 結尾；不是聊天網站網址。')}</span>
          </label>
          <label className="mt-2 block text-sm">{t('環境變數名稱')}
            <input className="mt-1 block w-full rounded-md border border-line2 bg-app p-2" value={draft.apiKeyEnv || ''} placeholder="MY_AI_API_KEY" autoComplete="off" onChange={event => updateDraft({ apiKeyEnv: event.target.value, apiKey: '' })} />
          </label>
        </details>
      </> : <>
        <label className="block text-sm">{t('服務網址（Base URL）')}
          <input type="url" readOnly={!!draft.id} className="mt-1 block w-full rounded-md border border-line2 bg-app p-2 read-only:opacity-60" value={draft.baseUrl} autoComplete="off" onChange={event => updateDraft({ baseUrl: event.target.value })} />
          <span className="mt-1 block text-xs text-mute2">{t('本機服務請使用 localhost、127.0.0.1 或 [::1] 的 HTTP 網址，通常以 /v1 結尾。')}</span>
        </label>
        <details><summary className="cursor-pointer text-sm text-mute2">{t('進階：這個本機服務需要金鑰時才填')}</summary>
          <label className="mt-2 block text-sm">{t('API 金鑰（服務需要時才填）')}
            <input type="password" className="mt-1 block w-full rounded-md border border-line2 bg-app p-2" value={draft.apiKey || ''} autoComplete="off" spellCheck={false} onChange={event => updateDraft({ apiKey: event.target.value, apiKeyEnv: '' })} />
          </label>
          <label className="mt-2 block text-sm">{t('環境變數名稱')}
            <input className="mt-1 block w-full rounded-md border border-line2 bg-app p-2" value={draft.apiKeyEnv || ''} placeholder="MY_AI_API_KEY" autoComplete="off" onChange={event => updateDraft({ apiKeyEnv: event.target.value, apiKey: '' })} />
          </label>
        </details>
      </>}
      <button type="button" className="rounded-lg border border-line2 px-4 py-2 text-sm hover:bg-elev" onClick={runProbe}>{busy === 'probe' ? t('正在檢查…') : t('檢查連線並取得模型')}</button>
      {probeResult && <div className="space-y-3 rounded-lg bg-elev p-4">
        {probeResult.kind === 'models' ? <label className="block text-sm">{t('選擇模型')}
          <select className="mt-1 block w-full rounded-md border border-line2 bg-panel p-2" value={draft.model || ''} onChange={event => chooseModel(event.target.value)}>
            <option value="">{t('請選擇模型')}</option>
            {probeResult.models.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
          <span className="mt-1 block text-xs text-mute2">{t('取得清單只代表服務連得上，還不代表能回答；儲存後請自己按「測試回覆」。')}</span>
        </label> : <label className="block text-sm">{t('模型名稱（依官方說明手動填寫）')}
          <input className="mt-1 block w-full rounded-md border border-line2 bg-panel p-2" value={draft.model || ''} autoComplete="off" onChange={event => chooseModel(event.target.value)} />
          <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">{t(MANUAL_MODEL_NOTICE)}</span>
          {formSource === 'cloud' && <span className="mt-1 block text-xs text-mute2">{t(MANUAL_MODEL_EXAMPLE.note)} <a className="underline" href={MANUAL_MODEL_EXAMPLE.url} target="_blank" rel="noreferrer">{t('查看官方模型說明')}</a></span>}
        </label>}
        <button type="button" disabled={!canSaveConnection({ probe: probeResult, model: draft.model, busy: !!busy })} className="rounded-lg bg-ink px-4 py-2 text-sm text-invink disabled:opacity-40" onClick={save}>{busy === 'save' ? t('正在儲存…') : t('儲存這個 AI')}</button>
      </div>}
    </fieldset>
  )

  return (
    <section aria-labelledby="ai-setup-title" className="min-h-0 flex-1 overflow-y-auto bg-app px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 id="ai-setup-title" className="text-2xl font-semibold text-ink">{t('接入 AI／開始使用')}</h1>
          <p className="mt-2 text-sm leading-6 text-mute2">{t('先選一條路。畫面只會顯示你選的那一條，其他的先收起來。')}</p>
          <button type="button" disabled={loading || !!busy} className="mt-3 rounded-md border border-line2 px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => void refresh()}>{loading ? t('正在檢查…') : t('重新檢查安裝狀態')}</button>
        </header>

        <fieldset className="rounded-xl border border-line bg-panel p-4">
          <legend className="px-1 text-sm font-medium">{t('你想怎麼開始？')}</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {SETUP_PATHS.map(item => <label key={item.id} className={`block cursor-pointer rounded-lg border p-3 text-sm ${path === item.id ? 'border-line3 bg-elev' : 'border-line2'}`}>
              <span className="flex items-center gap-2 font-medium">
                <input type="radio" name="ai-setup-path" value={item.id} checked={path === item.id} onChange={() => switchPath(item.id)} />
                {t(item.label)}
              </span>
              <span className="mt-1 block text-xs leading-5 text-mute2">{t(item.hint)}</span>
            </label>)}
          </div>
        </fieldset>

        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}
        {notice && <p role="status" className="rounded-lg border border-line2 bg-elev p-3 text-sm text-ink2">{notice}</p>}
        {dataWarning && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">{t(dataWarning)}</p>}

        {path === 'local' && <section aria-labelledby="setup-local-title" className="rounded-xl border border-line bg-panel p-5">
          <h2 id="setup-local-title" className="text-lg font-semibold">{t('這台電腦（地端 AI）')}</h2>
          <p className="mt-1 text-sm leading-6 text-mute2">{t('照下面的順序做完再回來檢查。這個畫面不會自動下載模型、載入模型或送出任何問題。')}</p>
          <ol className="mt-3 space-y-3">
            {LOCAL_GUIDE_STEPS.map(step => <li key={step.id} className="text-sm">
              <strong className="font-medium">{t(step.title)}</strong>
              <p className="mt-1 text-mute2">{t(step.detail)}</p>
              {step.url && officialLink(step.url) && <a className="mt-1 inline-block text-sky-700 underline dark:text-sky-300" href={officialLink(step.url)} target="_blank" rel="noreferrer">{t('查看官方說明')}</a>}
            </li>)}
          </ol>
          <div className="mt-4 rounded-lg border border-line2 p-3 text-xs leading-5 text-mute2">
            <p>{t('已安裝、已下載模型、執行環境已驗證、已載入、已就緒是五種不同狀態。')}</p>
            <p className="mt-1">{t(localInventoryText(localInfo))}</p>
            <p className="mt-1">{t(localRuntimeText(localInfo))}</p>
            <p className="mt-1">{t(localLoadedText(localInfo))}</p>
            <p className="mt-1">{t(localStateText(localInfo?.state))}</p>
            {localReason && <p className="mt-1">{t(localReason)}</p>}
          </div>
          {availableLocalModels.length > 0 && <label className="mt-4 block text-sm">{t('選擇要用的地端模型')}
            <select className="mt-1 block w-full rounded-md border border-line2 bg-app p-2" value={availableLocalModels.includes(localModel) ? localModel : ''} onChange={event => setLocalModel(event.target.value)}>
              <option value="">{t('請選擇模型')}</option>
              {availableLocalModels.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>}
          {startPlan.action === 'blocked' && <p role="status" className="mt-2 text-xs text-mute2">{t(localStartBlockMessage(startPlan.reason))}</p>}
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" disabled={startPlan.action !== 'start'} className="rounded-lg bg-ink px-4 py-2 text-sm text-invink disabled:opacity-40" onClick={startLocalChat}>{t('用這台電腦的模型開始問問題')}</button>
            <button type="button" disabled={loading || !!busy} className="rounded-lg border border-line2 px-4 py-2 text-sm disabled:opacity-40" onClick={() => void refresh()}>{t('重新檢查安裝狀態')}</button>
          </div>
          <details className="mt-4 rounded-lg border border-line2 p-3" data-testid="local-advanced">
            <summary className="cursor-pointer text-sm text-mute2">{t('進階：改用其他本機 OpenAI 相容服務（例如 Ollama）')}</summary>
            {connectionForm('local')}
          </details>
        </section>}

        {path === 'cloud' && <section aria-labelledby="setup-cloud-title" className="rounded-xl border border-line bg-panel p-5">
          <h2 id="setup-cloud-title" className="text-lg font-semibold">{t('雲端 AI 帳號')}</h2>
          <p className="mt-1 text-sm leading-6 text-mute2">{t('選一家服務商，我們只幫你填名稱與服務網址；金鑰要自己到官方後台建立。')}</p>
          <label className="mt-3 block text-sm">{t('服務商')}
            <select className="mt-1 block w-full rounded-md border border-line2 bg-app p-2" value={preset} onChange={event => choosePreset(event.target.value)}>
              <option value="">{t('請選擇服務商')}</option>
              {CLOUD_PRESETS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          {activePreset && <div className="mt-3 space-y-1 text-xs leading-5 text-mute2">
            <p>{t('服務網址')}：<code className="break-all">{activePreset.baseUrl || t('（請自行填寫）')}</code></p>
            {activePreset.note && <p>{t(activePreset.note)}</p>}
            <p className="flex flex-wrap gap-3">
              {activePreset.keyUrl && officialLink(activePreset.keyUrl) && <a className="underline" href={officialLink(activePreset.keyUrl)} target="_blank" rel="noreferrer">{t('前往建立 API 金鑰')}</a>}
              {activePreset.modelsUrl && officialLink(activePreset.modelsUrl) && <a className="underline" href={officialLink(activePreset.modelsUrl)} target="_blank" rel="noreferrer">{t('查看可用模型')}</a>}
              {activePreset.helpUrl && officialLink(activePreset.helpUrl) && <a className="underline" href={officialLink(activePreset.helpUrl)} target="_blank" rel="noreferrer">{t('查看官方說明')}</a>}
            </p>
          </div>}
          {connectionForm('cloud')}
        </section>}

        {path === 'installed' && <section aria-labelledby="setup-tools-title" className="rounded-xl border border-line bg-panel p-5">
          <h2 id="setup-tools-title" className="text-lg font-semibold">{t('我已安裝 AI 工具')}</h2>
          <p className="mt-1 text-sm text-mute2">{t('偵測到安裝不代表已登入或能派工。請先在原工具完成登入，回來後再試用。')}</p>
          {!tools.length && <p className="mt-3 text-sm text-mute2">{t('目前沒有可顯示的工具資料，請按「重新檢查安裝狀態」。')}</p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {tools.map(tool => <article key={tool.id} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{tool.label}</h3><span className="text-xs text-mute2">{tool.installed ? t('已安裝；登入狀態未知') : t('尚未安裝')}</span></div>
              <p className="mt-2 text-sm leading-6 text-mute2">{t(tool.setupHint)}</p>
              <p className="mt-2 text-xs text-mute2">{tool.capabilities?.dispatch ? t('可用於派工；請先在原工具登入') : t('可同步本機已有的對話')}</p>
              {officialLink(tool.installUrl) && <a className="mt-3 inline-block text-sm text-sky-700 underline dark:text-sky-300" href={officialLink(tool.installUrl)} target="_blank" rel="noreferrer">{tool.installed ? t('查看官方設定說明') : t('前往官方下載／安裝說明')}</a>}
            </article>)}
          </div>
          {requirements.length > 0 && <details className="mt-4 rounded-xl border border-line p-4"><summary className="cursor-pointer font-medium">{t('派工需要的輔助工具')}</summary><ul className="mt-3 space-y-3">{requirements.map(item => <li key={item.id} className="text-sm"><strong>{t(item.label)}</strong> · {item.ready ? t('已找到') : t('尚未找到')}<p className="mt-1 text-mute2">{t(item.hint)}</p>{item.url && officialLink(item.url) && <a href={officialLink(item.url)} target="_blank" rel="noreferrer" className="mt-1 inline-block underline">{t('查看官方設定說明')}</a>}</li>)}</ul></details>}
        </section>}

        {(connections.length > 0 || data?.connectionError) && <section aria-labelledby="saved-ai-title">
          <h2 id="saved-ai-title" className="text-lg font-semibold">{t('已加入的 AI')}</h2>
          {data?.connectionError && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{t('無法讀取已加入的 AI：{err}', { err: data.connectionError })}</p>}
          <div className="mt-3 space-y-3">{connections.map(connection => {
            const plan = savedStartPlan({ connection, loading, busy: !!busy })
            return <article key={connection.id} className="rounded-xl border border-line bg-panel p-4">
              <div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">{connection.label}</h3><span className="text-xs text-mute2">{t(connection.credentialStatus === 'missing' ? '請重新提供金鑰' : connectionStatusLabel(connection.status))}</span></div>
              <p className="mt-1 break-all text-sm text-mute2">{connection.model || t('尚未選模型')} · {connection.baseUrl}</p>
              {connection.hasKey && <p className="mt-1 text-xs text-mute2">{t('金鑰：已提供（不顯示內容）')}</p>}
              {plan.action === 'blocked' && plan.reason !== 'loading' && plan.reason !== 'busy' && <p role="status" className="mt-1 text-xs text-mute2">{t(savedStartBlockMessage(plan.reason))}</p>}
              <div className="mt-3 flex flex-wrap gap-3">
                <button type="button" disabled={!!busy} className="rounded-md border border-line2 px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => test(connection)}>{busy === `test:${connection.id}` ? t('正在回答…') : t('測試回覆')}</button>
                <button type="button" disabled={plan.action !== 'start'} className="rounded-md bg-ink px-3 py-1.5 text-sm text-invink disabled:opacity-40" onClick={() => startSavedChat(connection)}>{connection.status === 'reply_verified' ? t('開始問問題') : t('開始問問題（尚未驗證）')}</button>
                <button type="button" disabled={!!busy} className="rounded-md border border-line2 px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => editConnection(connection)}>{t('修改連線／更新金鑰')}</button>
                <button type="button" disabled={!!busy} className="rounded-md px-3 py-1.5 text-sm text-mute2 disabled:opacity-40" onClick={() => void run(`delete:${connection.id}`, async (signal, accept) => { await setupRequest('/api/ai-connections/delete', { id: connection.id }, signal); if (accept()) setData(current => current ? { ...current, connections: setupList<AIConnection>(current.connections).filter(item => item.id !== connection.id) } : current) })}>{t('移除此連線')}</button>
              </div>
              {testResult?.id === connection.id && <p role="status" className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-elev p-3 text-sm">{testResult.content}</p>}
            </article>
          })}</div>
        </section>}
      </div>
    </section>
  )
}
