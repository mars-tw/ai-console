/* eslint-disable react-refresh/only-export-components -- request shaping is a tested public contract */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t, useLang } from '@/i18n'
import type { Lang } from '@/i18n'

type AskMessage = { role: 'user' | 'assistant'; text: string }

export function askMessages(history: AskMessage[], text: string, lang: Lang = 'zh-TW') {
  return [
    {
      role: 'system',
      content: lang === 'en'
        ? 'Only answer the question. Do not run commands, call tools, or modify files. Reply in clear English.'
        : '你只負責回答問題。不要執行指令、不要呼叫工具、不要修改檔案。請用繁體中文、白話回答。',
    },
    ...history.slice(-12).map((message) => ({ role: message.role, content: message.text })),
    { role: 'user', content: text },
  ]
}

export default function AskAI() {
  const lang = useLang()
  const [models, setModels] = useState<string[]>([])
  const [modelStatus, setModelStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [model, setModel] = useState('auto')
  const [messages, setMessages] = useState<AskMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [routeInfo, setRouteInfo] = useState('')
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const refreshModels = useCallback(async (signal?: AbortSignal) => {
    setModelStatus('loading')
    try {
      const response = await fetch('/api/models', { signal })
      const data = response.ok ? await response.json() : null
      const next = data?.ok && Array.isArray(data.models) ? data.models : []
      setModels(next)
      setModelStatus(next.length ? 'ready' : 'unavailable')
    } catch (failure) {
      if (!(failure instanceof Error && failure.name === 'AbortError')) {
        setModels([])
        setModelStatus('unavailable')
      }
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refreshModels(controller.signal)
    return () => controller.abort()
  }, [refreshModels])

  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [busy])

  useEffect(() => () => abortRef.current?.abort(), [])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    setSeconds(0)
    setError('')
    setRouteInfo('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      let selected = model
      if (selected === 'auto') {
        const response = await fetch('/api/route?task=general', { signal: controller.signal })
        const data = await response.json()
        if (!response.ok || !data?.ok || !data.model) throw new Error(data?.reason || t('自動選擇模型失敗'))
        selected = data.model
        setRouteInfo(t('自動選擇：{model} — {reason}', { model: data.model, reason: data.reason || '' }))
      }
      const next = [...messages, { role: 'user' as const, text }]
      setMessages(next)
      setInput('')
      const response = await fetch('/api/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selected, messages: askMessages(messages, text, lang) }),
      })
      const data = await response.json()
      if (!response.ok || !data?.ok) throw new Error(data?.error || t('回答失敗'))
      const answer = String(data.content || data.reasoning || t('（空回應）'))
      setMessages([...next, { role: 'assistant', text: answer }])
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        setError(t('已停止等待這次回答。'))
      } else {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setBusy(false)
    }
  }

  return (
    <section className="h-full overflow-y-auto bg-app px-4 py-6 sm:px-8" aria-labelledby="ask-ai-title">
      <div className="mx-auto max-w-3xl">
        <p className="text-xs font-medium tracking-widest text-mute2">ASK AI</p>
        <h1 id="ask-ai-title" className="mt-1 text-2xl font-semibold text-ink">💬 {t('直接問 AI')}</h1>
        <p className="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-300">
          {t('這裡只回答問題，不會改檔、不會執行工作，也不會派給其他 AI。')}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label className="text-sm text-ink2" htmlFor="ask-model">{t('使用哪個地端模型')}</label>
          <select id="ask-model" className="rounded-md border border-line2 bg-panel px-2 py-1.5 text-sm" value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="auto">{t('🤖 自動（建議）')}</option>
            {models.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>

        {modelStatus === 'loading' && (
          <p role="status" className="mt-2 text-xs text-mute2">{t('正在檢查地端模型…')}</p>
        )}
        {modelStatus === 'unavailable' && (
          <div role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
            <p className="font-medium">{t('尚未連上可用的地端模型')}</p>
            <p className="mt-1 text-xs leading-5">
              {t('請開啟 LM Studio、載入一個完整模型，再啟動 Local Server。完成後按「重新檢查」。')}
            </p>
            <button
              type="button"
              className="mt-2 rounded-md border border-amber-400 px-3 py-1.5 text-xs font-medium hover:bg-amber-100 dark:hover:bg-amber-900"
              onClick={() => { void refreshModels() }}
            >
              {t('重新檢查地端模型')}
            </button>
          </div>
        )}

        {routeInfo && <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-300">{routeInfo}</p>}
        {error && <p role="alert" className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</p>}

        <div className="mt-4 flex min-h-64 flex-col gap-3 rounded-xl border border-line bg-panel p-4" role="log" aria-live="polite" aria-busy={busy}>
          {messages.length === 0 ? (
            <div className="m-auto text-center text-sm text-mute2">
              <p>{t('例如：這段文字是什麼意思？')}</p>
              <p className="mt-1">{t('例如：我下一步應該先做什麼？')}</p>
            </div>
          ) : messages.map((message, index) => (
            <div key={index} className={`max-w-[90%] rounded-lg px-4 py-3 text-sm leading-6 ${message.role === 'user' ? 'ml-auto bg-elev' : 'mr-auto border border-line'}`}>
              <div className="mb-1 text-xs text-mute3">{message.role === 'user' ? t('你') : t('AI 回答')}</div>
              <div className="whitespace-pre-wrap break-words">{message.text}</div>
            </div>
          ))}
          {busy && <p role="status" className="text-xs text-mute2">{t('正在回答… {n} 秒', { n: seconds })}</p>}
        </div>

        <div className="mt-3 flex gap-2">
          <textarea
            className="min-h-20 flex-1 rounded-lg border border-line2 bg-panel px-3 py-2 text-sm outline-none focus:border-line3"
            placeholder={t('輸入想問的問題…')}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }}
          />
          {busy ? (
            <button className="self-end rounded-lg border border-line2 px-4 py-2 text-sm hover:bg-elev" onClick={() => abortRef.current?.abort()}>{t('停止等待')}</button>
          ) : (
            <button className="self-end rounded-lg bg-ink px-5 py-2 text-sm font-medium text-invink hover:bg-ink2 disabled:opacity-40" disabled={!input.trim()} onClick={() => void send()}>{t('送出問題')}</button>
          )}
        </div>
      </div>
    </section>
  )
}
