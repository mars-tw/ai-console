import { useEffect, useRef, useState } from 'react'
import { Routes, Route } from 'react-router'
import { t } from './i18n'
import { completionTransitions } from './lib/dispatchLifecycle'
import { stateOf } from './lib/dispatchState'
import { notifyDone } from './lib/notify'
import Home from './pages/Home'
import type { DispatchRecord } from './types/data'

type WatchedDispatch = DispatchRecord & {
  outcome?: 'ok' | 'no_changes' | 'error' | null
  issue?: string
}

/**
 * 吐司摘要的前處理。工單與錯誤訊息都是原始文字：帶 markdown
 * （**粗體**、行首 #／-／>、反引號）、還常常是好幾行的長文，
 * 直接塞進吐司會看到星號原樣顯示、整段擠成一行橫溢出畫面。
 * 所以在這裡剝掉 markdown 符號、壓成一行、截到 60 字 ——
 * 吐司只要讓人認出是哪一件派工，完整內容本來就該回主控台看。
 */
function cleanSummary(text: string, max = 60): string {
  const flat = text
    .split('\n')
    .map((line) => line.replace(/^[\s#>*-]+/, ''))
    .join(' ')
    .replace(/\*\*|__/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function completionMessage(record: WatchedDispatch): { ok: boolean; summary: string; announcement: string } {
  const failed = record.outcome === 'error' || (record.outcome == null && stateOf(record) === 'failed')
  const summary = failed
    ? (cleanSummary(record.issue ?? '') || t('執行失敗'))
    : record.outcome === 'no_changes'
      ? t('跑完了但沒有改到任何檔案')
      : (cleanSummary(record.task ?? '') || t('任務已完成'))
  return {
    ok: !failed,
    summary,
    announcement: failed
      ? t('{tool} 派工失敗：{summary}', { tool: record.tool || t('AI'), summary })
      : t('{tool} 派工完成：{summary}', { tool: record.tool || t('AI'), summary }),
  }
}

export default function App() {
  /**
   * 派工完成觀察器必須掛在 App，不能掛在 Console。
   * Home 裡的分頁會讓 Console unmount，Office 也能發起派工；掛在這裡才能
   * 在使用者切頁後繼續追蹤，並抓到兩次輪詢間就已跑完的快任務。
  */
  const completionSeen = useRef<Map<string, boolean> | null>(null)
  const [completionAnnouncement, setCompletionAnnouncement] = useState({ text: '', error: false })

  useEffect(() => {
    let stopped = false
    let pulling = false
    const abort = new AbortController()

    const pull = async () => {
      if (pulling || stopped) return
      pulling = true
      try {
        const response = await fetch('/api/dispatches', { signal: abort.signal })
        if (!response.ok) return
        const data = await response.json()
        if (stopped || !Array.isArray(data?.dispatches)) return

        const transition = completionTransitions(
          completionSeen.current,
          data.dispatches as WatchedDispatch[],
        )
        completionSeen.current = transition.seen

        const announcements: string[] = []
        let hasError = false
        for (const record of transition.finished) {
          const message = completionMessage(record)
          announcements.push(message.announcement)
          hasError ||= !message.ok
          void notifyDone({
            id: record.id,
            tool: record.tool,
            ok: message.ok,
            summary: message.summary,
          })
        }
        if (announcements.length) {
          setCompletionAnnouncement({ text: announcements.join('；'), error: hasError })
        }
      } catch {
        // 通知輪詢是輔助功能；中止或 API 暫時失聯都不能影響主介面。
      } finally {
        pulling = false
      }
    }

    void pull()
    const timer = window.setInterval(() => { void pull() }, 3000)
    return () => {
      stopped = true
      abort.abort()
      window.clearInterval(timer)
    }
  }, [])

  return (
    <>
      <div
        className="sr-only"
        role={completionAnnouncement.error ? 'alert' : 'status'}
        aria-live={completionAnnouncement.error ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        {completionAnnouncement.text}
      </div>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </>
  )
}
