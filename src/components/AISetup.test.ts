import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionDraftError, connectionPayload, connectionStatusLabel, setupRequest } from './AISetup'
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

  it('translates the backend error and next action independently', async () => {
    vi.stubGlobal('document', { documentElement: { lang: '' } })
    setLang('en')
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: '尚未安裝', nextAction: '請重新提供金鑰' }), { status: 400 })))
      await expect(setupRequest('/api/ai-connections/probe', {})).rejects.toThrow('Not installed Please provide the key again')
    } finally { setLang('zh-TW') }
  })
})
