/* eslint-disable react-refresh/only-export-components -- request shaping is a tested public contract */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t, useLang } from '@/i18n'
import type { Lang } from '@/i18n'

type AskMessage = {
  role: 'user' | 'assistant'
  text: string
  reasoning?: string      // 只回了推理過程時，收合起來的推理草稿
  retryText?: string      // 換模型重問時要重送的那句話
  retryModel?: string     // 重問改用哪個模型（auto 以外的下一個可用模型）
}

/**
 * content 為空時不要把 reasoning 當答案。推理草稿是模型的思考過程，
 * 不是給人看的回答——實測等兩分鐘出來一整段英文「Thinking Process」，
 * 第一次用的人會以為 AI 壞掉。這裡回一句明確說明，草稿另外收合放著，
 * 想看的人看得到，但它不能冒充答案。
 */
function pickAnswer(content: unknown, reasoning: unknown): { text: string; reasoning?: string } {
  const body = content == null ? '' : String(content).trim()
  if (body) return { text: body }
  const draft = reasoning == null ? '' : String(reasoning).trim()
  if (draft) return { text: t('模型只回了推理過程，沒有給出答案。'), reasoning: draft }
  return { text: t('（空回應）') }
}

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

  // 「換個模型再問一次」要挑的模型：目前這個的下一個。
  // 只有一個可用模型時沒有「下一個」可換，回傳空字串讓按鈕不出現，
  // 別讓人按了重問卻跑同一個模型、得到同樣只有推理過程的結果。
  const nextModelAfter = (used: string) => {
    if (models.length < 2) return ''
    return models[(models.indexOf(used) + 1) % models.length]
  }

  const ask = async (text: string, chosenModel: string, history: AskMessage[]) => {
    if (!text || busy) return
    setBusy(true)
    setSeconds(0)
    setError('')
    setRouteInfo('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      let selected = chosenModel
      if (selected === 'auto') {
        const response = await fetch('/api/route?task=general', { signal: controller.signal })
        const data = await response.json()
        if (!response.ok || !data?.ok || !data.model) throw new Error(data?.reason || t('自動選擇模型失敗'))
        selected = data.model
        setRouteInfo(t('自動選擇：{model} — {reason}', { model: data.model, reason: data.reason || '' }))
      }
      const echoed = [...history, { role: 'user' as const, text }]
      setMessages(echoed)
      const response = await fetch('/api/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selected, messages: askMessages(history, text, lang) }),
      })
      const data = await response.json()
      if (!response.ok || !data?.ok) throw new Error(data?.error || t('回答失敗'))
      const picked = pickAnswer(data.content, data.reasoning)
      const reply: AskMessage = picked.reasoning
        ? { role: 'assistant', text: picked.text, reasoning: picked.reasoning, retryText: text, retryModel: nextModelAfter(selected) }
        : { role: 'assistant', text: picked.text }
      setMessages([...echoed, reply])
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

  const send = () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    void ask(text, model, messages)
  }

  /**
   * 換個模型重問同一句。先把那次只有推理過程、沒給答案的回覆拿掉再重送：
   * 留著它，下一發會把「沒有給出答案」這句標記當成有效上下文送回給模型。
   */
  const retryWithModel = (failedIndex: number) => {
    const failed = messages[failedIndex]
    const text = failed?.retryText
    const chosenModel = failed?.retryModel
    if (!text || !chosenModel || busy) return
    const prev = messages[failedIndex - 1]
    const base = prev && prev.role === 'user' && prev.text === text
      ? messages.slice(0, failedIndex - 1)   // 原問題會由 ask 重新貼上，避免同一句出現兩次
      : messages.slice(0, failedIndex)
    void ask(text, chosenModel, base)
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
              {message.reasoning && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer select-none text-mute3">{t('看它的推理過程')}</summary>
                  <div className="mt-1 whitespace-pre-wrap break-words text-mute2">{message.reasoning}</div>
                </details>
              )}
              {message.retryModel && (
                <button
                  type="button"
                  className="mt-2 rounded-md border border-line2 px-2.5 py-1 text-xs text-ink2 hover:bg-elev disabled:opacity-40"
                  disabled={busy}
                  onClick={() => retryWithModel(index)}
                >
                  {t('換個模型再問一次')}
                </button>
              )}
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
