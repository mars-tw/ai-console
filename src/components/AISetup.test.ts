import { afterEach, describe, expect, it, vi } from 'vitest'
// 來源契約：這幾條規則是「按鈕與 callback 的接線」，用原始碼比對比渲染整頁便宜也更穩。
import setupSource from './AISetup.tsx?raw'
import {
  CLOUD_KEY_NOTES,
  CLOUD_PRESETS,
  DEFAULT_SETUP_PATH,
  LOCAL_GUIDE_STEPS,
  MANUAL_MODEL_EXAMPLE,
  MANUAL_MODEL_NOTICE,
  SETUP_PATHS,
  acceptSetupResult,
  applyCloudPreset,
  canSaveConnection,
  clearedSetupState,
  connectionDraftError,
  connectionPayload,
  connectionStatusLabel,
  localInventoryText,
  localLoadedText,
  localReasonText,
  localRuntimeText,
  localStartBlockMessage,
  localStartPlan,
  localStateText,
  metadataWarning,
  parseProbeOutcome,
  probeRequest,
  replyVerified,
  savedStartBlockMessage,
  savedStartPlan,
  setupList,
  setupRequest,
} from './AISetup'
import type { AIConnection, AISetupData } from './AISetup'
import type { LocalSetupInfo } from './AskAI'
import { setLang } from '@/i18n'

afterEach(() => vi.unstubAllGlobals())

describe('AI setup connection evidence', () => {
  it('omits empty password fields so saved or environment credentials are retained', () => {
    const draft = { id: 'existing', label: 'Example', baseUrl: 'https://api.example.com/v1', apiKey: '', apiKeyEnv: 'EXAMPLE_KEY' }
    expect(connectionPayload(draft)).not.toHaveProperty('apiKey')
    expect(connectionPayload(draft).apiKeyEnv).toBe('EXAMPLE_KEY')
    expect(connectionPayload({ ...draft, apiKey: 'synthetic-test-value' }).apiKey).toBe('synthetic-test-value')
    expect(draft.apiKey).toBe('')
  })
  it('only identifies a verified reply as a successful response test', () => {
    expect(connectionStatusLabel('reply_verified')).toBe('已通過回覆測試')
    for (const status of ['saved', 'ready', 'installed', 'models_available', 'unknown']) {
      expect(connectionStatusLabel(status)).toBe('已儲存，尚未確認可回答')
    }
  })

  it('separates local loopback HTTP from cloud HTTPS before probing', () => {
    const draft = { label: 'My AI', baseUrl: 'http://127.0.0.1:11434/v1' }
    expect(connectionDraftError(draft, 'local')).toBe('')
    expect(connectionDraftError({ ...draft, baseUrl: 'http://[::1]:8080/v1' }, 'local')).toBe('')
    expect(connectionDraftError(draft, 'cloud')).toContain('HTTPS')
    expect(connectionDraftError({ ...draft, baseUrl: 'http://192.168.1.1/v1' }, 'local')).toContain('本機服務')
    expect(connectionDraftError({ ...draft, baseUrl: 'https://api.example.com/v1' }, 'cloud')).toBe('')
    expect(connectionDraftError({ ...draft, baseUrl: 'https://user:secret@api.example.com/v1' }, 'cloud')).toContain('帳密')
    expect(connectionDraftError({ ...draft, baseUrl: 'https://api.example.com/v1?key=secret' }, 'cloud')).toContain('查詢參數')
  })

  it('uses the same-origin service API and preserves useful failure guidance', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'Model unavailable.', nextAction: 'Choose another model.' }), { status: 400 }))
    vi.stubGlobal('fetch', request)
    await expect(setupRequest('/api/ai-connections/probe', { label: 'Example', baseUrl: 'https://api.example.com/v1' })).rejects.toThrow('Model unavailable. Choose another model.')
    expect(request).toHaveBeenCalledWith('/api/ai-connections/probe', expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } }))
  })

  it('keeps the saved-connection payload shape unchanged and never carries a key by default', () => {
    const payload = connectionPayload({ id: 'kept', label: 'Example', baseUrl: 'https://api.example.com/v1', model: 'demo-1', apiKeyEnv: '' })
    expect(Object.keys(payload).sort()).toEqual(['apiKeyEnv', 'baseUrl', 'id', 'label', 'model'])
    expect(payload).not.toHaveProperty('apiKey')
  })

  it('translates the backend error and next action independently', async () => {
    vi.stubGlobal('document', { documentElement: { lang: '' } })
    setLang('en')
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: '尚未安裝', nextAction: '請重新提供金鑰' }), { status: 400 })))
      await expect(setupRequest('/api/ai-connections/probe', {})).rejects.toThrow('Not installed Please provide the key again')
    } finally { setLang('zh-TW') }
  })
})

describe('地端開始問問題的條件', () => {
  const ready: LocalSetupInfo = { ready: true, state: 'ready', models: ['qwen', 'llama'] }

  it('只有 ready:true、後端認得的狀態、清單非空又選過模型才放行', () => {
    expect(localStartPlan({ local: ready, loading: false, model: 'llama' })).toEqual({ action: 'start', model: 'llama' })
    expect(localStartPlan({ local: ready, loading: false, model: ' llama ' })).toEqual({ action: 'start', model: 'llama' })
  })

  it('needs_start 也能開始：送出時才準備模型，不要求先手動載入', () => {
    const local: LocalSetupInfo = { ready: true, state: 'needs_start', models: ['qwen'] }
    expect(localStartPlan({ local, loading: false, model: 'qwen' })).toEqual({ action: 'start', model: 'qwen' })
    expect(localStateText('needs_start')).toBe('送出問題時準備模型（現在不會載入任何東西）。')
  })

  /** 只有庫存清單與 available:true —— 那是「有這個檔案」，不是「現在載得動」。 */
  const inventoryOnly: LocalSetupInfo & { available: boolean } = { models: ['qwen'], available: true }

  it.each<[string, LocalSetupInfo | null, string, string]>([
    ['讀不到 /api/setup', null, 'qwen', 'local_unavailable'],
    ['有模型且 available 但 ready 不是 true', inventoryOnly, 'qwen', 'local_not_ready'],
    ['ready 是字串 true', { ready: 'true', state: 'ready', models: ['qwen'] }, 'qwen', 'local_not_ready'],
    ['狀態是 unknown', { ready: true, state: 'unknown', models: ['qwen'] }, 'qwen', 'local_not_ready'],
    ['沒有給狀態', { ready: true, models: ['qwen'] }, 'qwen', 'local_not_ready'],
    ['清單是空的', { ready: true, state: 'ready', models: [] }, 'qwen', 'local_no_models'],
    ['清單型別不對', { ready: true, state: 'ready', models: 'qwen' }, 'qwen', 'local_no_models'],
    ['選到清單以外的模型', { ready: true, state: 'ready', models: ['qwen'] }, 'ghost', 'local_model_missing'],
    ['還沒選模型', { ready: true, state: 'ready', models: ['qwen'] }, '', 'model_missing'],
    ['只選了空白', { ready: true, state: 'ready', models: ['qwen'] }, '   ', 'model_missing'],
  ])('%s 就不能開始', (_label, local, model, reason) => {
    expect(localStartPlan({ local, loading: false, model })).toEqual({ action: 'blocked', reason })
  })

  it('還在檢查或讀取失敗時都不放行', () => {
    expect(localStartPlan({ local: ready, loading: true, model: 'qwen' })).toEqual({ action: 'blocked', reason: 'loading' })
    expect(localStartPlan({ local: ready, loading: false, error: 'HTTP 500', model: 'qwen' })).toEqual({ action: 'blocked', reason: 'setup_error' })
  })

  it('擋下來的說明都是中性的，不會說已經連上或已載入', () => {
    for (const reason of ['loading', 'setup_error', 'model_missing', 'local_not_ready', 'local_no_models', 'local_model_missing'] as const) {
      const message = localStartBlockMessage(reason)
      expect(message.trim()).not.toBe('')
      expect(message).not.toMatch(/已連上|已載入|已通過/)
    }
  })

  it('狀態與原因只照實顯示，未知不會被湊成可用，物件不會被硬轉成文字', () => {
    expect(localStateText('ready')).toContain('已就緒')
    expect(localStateText(undefined)).toBe('目前狀態不明，請按「重新檢查安裝狀態」。')
    expect(localStateText({ state: 'ready' })).toBe('目前狀態不明，請按「重新檢查安裝狀態」。')
    expect(localStateText('starting')).not.toMatch(/已就緒/)
    expect(localReasonText({ reason: '尚未安裝執行環境' })).toBe('尚未安裝執行環境')
    expect(localReasonText({ reason: { code: 'x' } })).toBe('')
    expect(localReasonText({ reason: '   ' })).toBe('')
    expect(localReasonText(null)).toBe('')
  })

  it('開始鈕在來源上就綁著同一條判斷，並把選到的模型當第二個參數回報', () => {
    expect(setupSource).toContain("disabled={startPlan.action !== 'start'}")
    expect(setupSource).toContain('onClick={startLocalChat}')
    expect(setupSource).toContain("if (plan.action !== 'start') return")
    expect(setupSource).toContain('onStartChat(undefined, plan.model)')
    expect(setupSource).toContain('onStartChat: (connection?: AIConnection, localModel?: string) => void')
    // 不再拿 models.length／available 當可用性，也不從這個畫面下載或載入任何東西。
    expect(setupSource).not.toContain('data.local.available')
    expect(setupSource).not.toContain('data.local.models.length')
  })
})

describe('三條路：預設地端，一次只畫一條', () => {
  it('預設是地端，三個選項的名稱固定', () => {
    expect(DEFAULT_SETUP_PATH).toBe('local')
    expect(SETUP_PATHS.map(item => item.id)).toEqual(['local', 'cloud', 'installed'])
    expect(SETUP_PATHS.map(item => item.label)).toEqual(['這台電腦（地端 AI）', '雲端 AI 帳號', '我已安裝 AI 工具'])
    expect(setupSource).toContain('useState<SetupPath>(DEFAULT_SETUP_PATH)')
  })

  it('一開始不畫七張 CLI 卡片，通用 API 表單只在進階摺疊裡', () => {
    const localAt = setupSource.indexOf("{path === 'local' &&")
    const cloudAt = setupSource.indexOf("{path === 'cloud' &&")
    const installedAt = setupSource.indexOf("{path === 'installed' &&")
    expect(localAt).toBeGreaterThan(-1)
    expect(cloudAt).toBeGreaterThan(localAt)
    expect(installedAt).toBeGreaterThan(cloudAt)
    // CLI 目錄與派工輔助工具都只在「我已安裝 AI 工具」那條路裡。
    expect(setupSource.indexOf('tools.map(')).toBeGreaterThan(installedAt)
    expect(setupSource.indexOf('requirements.map(')).toBeGreaterThan(installedAt)
    // 地端的通用 API 表單一定包在 details 裡，雲端才直接顯示。
    expect(setupSource).toMatch(/data-testid="local-advanced"[\s\S]{0,400}connectionForm\('local'\)/)
    expect(setupSource.indexOf("connectionForm('cloud')")).toBeGreaterThan(cloudAt)
  })

  it('地端指引照官方順序，執行環境講明是 CPU 2.24.0 不是 GPU／latest', () => {
    expect(LOCAL_GUIDE_STEPS.map(step => step.id)).toEqual(['download', 'model', 'runtime', 'recheck', 'start'])
    expect(LOCAL_GUIDE_STEPS[0].url).toBe('https://lmstudio.ai/download')
    expect(LOCAL_GUIDE_STEPS[1].url).toBe('https://lmstudio.ai/docs/app/basics/download-model')
    expect(LOCAL_GUIDE_STEPS[1].title).toContain('Ctrl+2')
    expect(LOCAL_GUIDE_STEPS[1].detail).toContain('下載完成')
    expect(LOCAL_GUIDE_STEPS[2].url).toBe('https://lmstudio.ai/docs/app')
    expect(LOCAL_GUIDE_STEPS[2].title).toContain('Ctrl+Shift+R')
    expect(LOCAL_GUIDE_STEPS[2].title).toContain('CPU llama.cpp（Windows）2.24.0')
    expect(LOCAL_GUIDE_STEPS[2].detail).toMatch(/不是 GPU／CUDA 版/)
    expect(LOCAL_GUIDE_STEPS[2].detail).toMatch(/latest/)
    expect(LOCAL_GUIDE_STEPS[3].title).toContain('重新檢查安裝狀態')
    expect(LOCAL_GUIDE_STEPS[4].title).toContain('選擇找到的模型')
  })

  it('已下載、執行環境、已載入是三種不同狀態，未知就說未知', () => {
    expect(localInventoryText({ models: ['a', 'b'] })).toContain('2 個')
    expect(localInventoryText({ models: ['a'] })).toContain('已下載不等於已載入')
    expect(localInventoryText(null)).toContain('找不到')
    expect(localRuntimeText({ runtime: { verified: true } } as unknown as LocalSetupInfo)).toContain('已驗證')
    expect(localRuntimeText({ runtime: { verified: false } } as unknown as LocalSetupInfo)).toContain('2.24.0')
    expect(localRuntimeText({ runtime: 'ok' } as unknown as LocalSetupInfo)).toContain('狀態不明')
    expect(localRuntimeText(null)).toContain('狀態不明')
    expect(localLoadedText({ model: 'qwen' })).toContain('qwen')
    expect(localLoadedText({ model: 123 })).toContain('沒有回報已載入')
    expect(localLoadedText(null)).toContain('沒有回報已載入')
    // needs_start 要中性，不能寫成「還沒好」。
    expect(localStateText('needs_start')).toContain('送出問題時準備')
  })

  it('已安裝的工具只說登入狀態未知，而且不是綠色的已完成', () => {
    expect(setupSource).toContain("t('已安裝；登入狀態未知')")
    expect(setupSource).toContain('偵測到安裝不代表已登入或能派工')
    // 綠色在這個畫面代表「已驗證」，登入未知與剛儲存都不能穿綠衣。
    expect(setupSource).not.toContain('emerald')
  })
})

describe('雲端服務商預設值', () => {
  const byId = Object.fromEntries(CLOUD_PRESETS.map(preset => [preset.id, preset] as const))

  it('網址完全照官方文件，沒有自己編一個金鑰頁', () => {
    expect(byId.deepseek.baseUrl).toBe('https://api.deepseek.com')
    expect(byId.deepseek.helpUrl).toBe('https://api-docs.deepseek.com/')
    expect(byId.deepseek.keyUrl).toBeUndefined()
    expect(byId.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(byId.openrouter.keyUrl).toBe('https://openrouter.ai/settings/keys')
    expect(byId.openrouter.modelsUrl).toBe('https://openrouter.ai/models')
    expect(byId.openrouter.helpUrl).toBe('https://openrouter.ai/docs/quickstart')
    expect(byId.zhipu.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(byId.zhipu.keyUrl).toBe('https://bigmodel.cn/usercenter/proj-mgmt/apikeys')
    expect(byId.zhipu.helpUrl).toBe('https://docs.bigmodel.cn/cn/guide/develop/http/introduction')
    // 智譜用通用 API 端點，不是 Coding 專用端點。
    expect(byId.zhipu.baseUrl).not.toMatch(/coding/i)
    expect(byId.zhipu.note).toContain('不是 Coding')
    expect(byId.custom.baseUrl).toBe('')
    for (const preset of CLOUD_PRESETS) {
      for (const url of [preset.keyUrl, preset.modelsUrl, preset.helpUrl, preset.baseUrl || undefined]) {
        if (url) expect(url).toMatch(/^https:\/\//)
      }
    }
  })

  it('選服務商只填名稱與網址，金鑰／模型／id 一律清空', () => {
    expect(applyCloudPreset('openrouter')).toEqual({ label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', apiKeyEnv: '', model: '' })
    expect(applyCloudPreset('openrouter')).not.toHaveProperty('id')
    expect(applyCloudPreset('zhipu').baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(applyCloudPreset('custom')).toEqual({ label: '', baseUrl: 'https://', apiKey: '', apiKeyEnv: '', model: '' })
    expect(applyCloudPreset('does-not-exist').label).toBe('')
    // 自訂服務仍走同一套安全檢查。
    expect(connectionDraftError({ ...applyCloudPreset('custom'), label: 'My AI' }, 'cloud')).toContain('完整的服務網址')
  })

  it('金鑰說明講清楚它不是聊天密碼、訂閱不一定含 API、測試可能計費', () => {
    const notes = CLOUD_KEY_NOTES.join(' ')
    expect(notes).toContain('不是聊天網站的登入密碼')
    expect(notes).toContain('訂閱')
    expect(notes).toContain('計費')
    expect(notes).toContain('記憶體')
    expect(notes).toContain('不會寫入設定檔')
    expect(setupSource).toContain('CLOUD_KEY_NOTES.map')
  })

  it('手動模型示範講明未驗證、不保證帳號有存取權', () => {
    expect(MANUAL_MODEL_EXAMPLE.model).toBe('glm-5.2')
    expect(MANUAL_MODEL_EXAMPLE.url).toBe('https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2')
    expect(MANUAL_MODEL_EXAMPLE.note).toContain('未經本機驗證')
    expect(MANUAL_MODEL_EXAMPLE.note).toContain('不保證你的帳號有存取權')
  })
})

describe('探測：手動填模型只認後端那一個信封', () => {
  const envelope = { ok: false, status: 'model_list_unavailable', models: [], manualModelAllowed: true, verified: false }
  const draft = { label: 'Example', baseUrl: 'https://api.example.com/v1' }

  it('HTTP 400 的完整信封＝可以手動填模型', () => {
    expect(parseProbeOutcome(400, envelope)).toEqual({ kind: 'manual' })
    expect(MANUAL_MODEL_NOTICE).toBe('未驗證：服務沒有模型清單，請依官方說明填入模型名稱，儲存後測試回覆。')
  })

  it.each<[string, number, unknown]>([
    ['金鑰被拒 401', 401, { ok: false, error: 'Unauthorized' }],
    ['被禁止 403', 403, { ok: false, error: 'Forbidden' }],
    ['額度用完 429', 429, { ok: false, error: 'Too many requests' }],
    ['服務不可用 503', 503, { ok: false, error: 'Unavailable' }],
    ['隨便一個 404', 404, { ok: false, error: 'Not found' }],
    ['401 卻帶著那個信封', 401, { ...envelope }],
    ['manualModelAllowed 是字串 true', 400, { ...envelope, manualModelAllowed: 'true' }],
    ['verified 竟然是 true', 400, { ...envelope, verified: true }],
    ['少了 status', 400, { ok: false, models: [], manualModelAllowed: true, verified: false }],
    ['status 名稱不同', 400, { ...envelope, status: 'models_unavailable' }],
    ['說沒有清單卻又給了模型', 400, { ...envelope, models: ['glm-5.2'] }],
    ['ok 竟然是 true', 400, { ...envelope, ok: true }],
    ['body 是字串', 400, 'model_list_unavailable'],
    ['body 是陣列', 400, [envelope]],
    ['沒有 body', 400, null],
  ])('%s 不能開放手動填模型', (_label, status, body) => {
    expect(parseProbeOutcome(status, body).kind).toBe('error')
  })

  it('成功的模型清單一定要是非空的字串名稱', () => {
    expect(parseProbeOutcome(200, { ok: true, models: ['a', 'b'] })).toEqual({ kind: 'models', models: ['a', 'b'] })
    expect(parseProbeOutcome(200, { ok: true, models: [' a '] })).toEqual({ kind: 'models', models: ['a'] })
    for (const models of [[], ['', '  '], [{ id: 'a' }], ['a', 123], null, 'a']) {
      expect(parseProbeOutcome(200, { ok: true, models }).kind).toBe('error')
    }
    expect(parseProbeOutcome(200, { ok: false, models: ['a'] }).kind).toBe('error')
    expect(parseProbeOutcome(200, null).kind).toBe('error')
  })

  it('連不上或回傳不是 JSON，一律是錯誤而不是手動模式', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect((await probeRequest(draft)).kind).toBe('error')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>not json</html>', { status: 400 })))
    expect((await probeRequest(draft)).kind).toBe('error')
  })

  it('400 信封在 HTTP 層不會被吃掉', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 400 })))
    expect(await probeRequest(draft)).toEqual({ kind: 'manual' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, models: ['a'] }), { status: 200 })))
    expect(await probeRequest(draft)).toEqual({ kind: 'models', models: ['a'] })
  })

  it('只有這兩種探測結果才能儲存，而且不替使用者挑模型', () => {
    expect(canSaveConnection({ probe: null, model: 'a' })).toBe(false)
    expect(canSaveConnection({ probe: { kind: 'error', message: 'x' }, model: 'a' })).toBe(false)
    expect(canSaveConnection({ probe: { kind: 'models', models: ['a'] }, model: 'a' })).toBe(true)
    expect(canSaveConnection({ probe: { kind: 'models', models: ['a'] }, model: 'b' })).toBe(false)
    expect(canSaveConnection({ probe: { kind: 'models', models: ['a'] }, model: '  ' })).toBe(false)
    expect(canSaveConnection({ probe: { kind: 'manual' }, model: 'glm-5.2' })).toBe(true)
    expect(canSaveConnection({ probe: { kind: 'manual' }, model: '' })).toBe(false)
    expect(canSaveConnection({ probe: { kind: 'manual' }, model: 'glm-5.2', busy: true })).toBe(false)
    // 清單模式不自動選第一個，手動模式存下去仍標示未驗證。
    expect(setupSource).not.toContain('available[0]')
    expect(setupSource).toContain("models.includes(current.model || '') ? current.model : ''")
    expect(setupSource).toContain('t(manual ? MANUAL_MODEL_NOTICE')
  })

  it('只有真的收到非空字串回答才算通過回覆測試', () => {
    expect(replyVerified('你好')).toBe(true)
    for (const content of ['', '   ', null, undefined, 0, true, {}, ['你好']]) expect(replyVerified(content)).toBe(false)
    expect(setupSource).toContain('if (!replyVerified(result.content)) throw new Error')
    expect(setupSource).toContain("status: 'reply_verified'")
    // 儲存只標中性狀態，綠色的驗證徽章只能由測試回覆產生。
    expect(setupSource).toContain("connectionStatusLabel(connection.status)")
  })
})

describe('切換與忙碌鎖', () => {
  it('換路徑／換服務商會清掉 id、金鑰、環境變數、模型、探測與測試結果', () => {
    const cleared = clearedSetupState('cloud')
    expect(cleared.draft).toEqual({ label: '', baseUrl: 'https://', apiKey: '', apiKeyEnv: '', model: '' })
    expect(cleared.draft).not.toHaveProperty('id')
    expect(cleared.probe).toBeNull()
    expect(cleared.testResult).toBeNull()
    expect(cleared.notice).toBe('')
    expect(clearedSetupState('local').draft.baseUrl).toBe('http://localhost:11434/v1')
    expect(setupSource).toContain("resetConnection(next === 'cloud' ? 'cloud' : 'local')")
    expect(setupSource).toContain('setDraft(applyCloudPreset(id))')
  })

  it('切換時先讓晚到的回應失效，再取消請求並放掉忙碌鎖', () => {
    expect(acceptSetupResult({ epoch: 2, current: 2 })).toBe(true)
    expect(acceptSetupResult({ epoch: 1, current: 2 })).toBe(false)
    expect(acceptSetupResult({ epoch: 2, current: 2, aborted: true })).toBe(false)
    expect(setupSource).toContain('if (!accept()) return')
    expect(setupSource).toContain('if (busyRef.current) return')
    expect(setupSource).toContain('busyRef.current = controller')
    expect(setupSource).toContain("if (busyRef.current === controller) { busyRef.current = null; if (mountedRef.current) setBusy('') }")
    expect(setupSource).toContain('mountedRef.current = true')
  })

  it('編輯既有連線時 id 與服務網址不可變，金鑰留白＝沿用後端那一把', () => {
    expect(setupSource).toContain('readOnly={!!draft.id}')
    expect(connectionPayload({ id: 'kept', label: 'A', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: '' })).not.toHaveProperty('apiKey')
  })
})

describe('已儲存連線與壞掉的設定資料', () => {
  const connection: AIConnection = { id: 'c1', label: 'A', baseUrl: 'https://api.example.com/v1', model: 'demo-1', status: 'saved', hasKey: true }

  it('缺金鑰、缺模型、還在忙或還在讀都不能開始', () => {
    expect(savedStartPlan({ connection, loading: false, busy: false })).toEqual({ action: 'start' })
    expect(savedStartPlan({ connection, loading: true, busy: false })).toEqual({ action: 'blocked', reason: 'loading' })
    expect(savedStartPlan({ connection, loading: false, busy: true })).toEqual({ action: 'blocked', reason: 'busy' })
    expect(savedStartPlan({ connection: null, loading: false, busy: false })).toEqual({ action: 'blocked', reason: 'connection_missing' })
    expect(savedStartPlan({ connection: { ...connection, credentialStatus: 'missing' }, loading: false, busy: false })).toEqual({ action: 'blocked', reason: 'missing_key' })
    expect(savedStartPlan({ connection: { ...connection, model: '  ' }, loading: false, busy: false })).toEqual({ action: 'blocked', reason: 'missing_model' })
    // 不需要金鑰的地端連線不能被誤擋。
    expect(savedStartPlan({ connection: { ...connection, credentialStatus: 'not_set' }, loading: false, busy: false })).toEqual({ action: 'start' })
    // 尚未驗證仍可明確發問，但按鈕上不能宣稱已驗證。
    expect(setupSource).toContain("t('開始問問題（尚未驗證）')")
    for (const reason of ['loading', 'busy', 'connection_missing', 'missing_key', 'missing_model'] as const) {
      expect(savedStartBlockMessage(reason).trim()).not.toBe('')
    }
  })

  it('壞掉的 metadata 是看得見的失敗，不會炸掉 map，也不會樂觀放行', () => {
    expect(setupList(null)).toEqual([])
    expect(setupList('nope')).toEqual([])
    expect(setupList([{ id: 'a' }, null, 'x'])).toEqual([{ id: 'a' }])
    const broken = { ok: true, tools: null, connections: 'x', requirements: undefined, local: [] } as unknown as AISetupData
    const warning = metadataWarning(broken)
    expect(warning).toContain('AI 工具清單')
    expect(warning).toContain('已加入的 AI')
    expect(warning).toContain('輔助工具清單')
    expect(warning).toContain('地端狀態')
    expect(metadataWarning({ ok: true, tools: [], connections: [], requirements: [], local: { models: [], available: false } } as AISetupData)).toBe('')
    expect(metadataWarning(null)).toBe('')
    expect(localStartPlan({ local: null, loading: false, model: 'qwen' })).toEqual({ action: 'blocked', reason: 'local_unavailable' })
  })
})
