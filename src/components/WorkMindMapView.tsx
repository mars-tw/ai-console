import { useEffect, useRef, useState } from 'react'
import { useLang } from '@/i18n'
import WorkMindMap from '@/components/WorkMindMap'
import { createWorkStateObserver, isWorkStateFresh, type ObservationState, type WorkState } from '@/lib/workState'

/** One initial visible read. Short observation requires explicit selection. */
export default function WorkMindMapView() {
  const lang = useLang()
  const text = (zh: string, en: string) => lang === 'en' ? en : zh
  const [snapshot, setSnapshot] = useState<WorkState | null>(null)
  const [readState, setReadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [observation, setObservation] = useState<ObservationState>('off')
  const [clock, setClock] = useState(Date.now)
  const reader = useRef<ReturnType<typeof createWorkStateObserver> | null>(null)
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const controller = createWorkStateObserver({ onData: (data) => { setSnapshot(data); setClock(Date.now()) }, onReadState: setReadState, onObservation: setObservation })
    reader.current = controller
    let intersecting = false, initialRead = false
    const sync = () => {
      const visible = intersecting && !document.hidden
      controller.setVisible(visible, document.hidden ? 'hidden' : 'offscreen')
      if (visible && !initialRead) { initialRead = true; void controller.refresh() }
    }
    const element = host.current
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
      intersecting = entries.some((entry) => entry.isIntersecting); sync()
    }) : null
    if (element && observer) observer.observe(element)
    else if (element) { const rect = element.getBoundingClientRect(); intersecting = rect.width > 0 && rect.height > 0; sync() }
    document.addEventListener('visibilitychange', sync)
    return () => { reader.current = null; observer?.disconnect(); document.removeEventListener('visibilitychange', sync); controller.dispose() }
  }, [])
  useEffect(() => {
    if (!snapshot) return
    const wait = Math.max(0, Date.parse(snapshot.checkedAt) + snapshot.validForMs - Date.now())
    const timer = setTimeout(() => setClock(Date.now()), wait + 1)
    return () => clearTimeout(timer)
  }, [snapshot])
  const fresh = isWorkStateFresh(snapshot, clock) && readState !== 'error'
  const observing = observation === 'observing'
  const labels: Record<ObservationState, string> = {
    off: text('短期觀察已關閉', 'Observation off'), observing: text('觀察中：每 5 秒讀取，最多 2 分鐘', 'Observing: every 5 seconds, for up to 2 minutes'),
    hidden: text('視窗隱藏，觀察已停止', 'Window hidden; observation stopped'), offscreen: text('心智圖離開畫面，觀察已停止', 'Map offscreen; observation stopped'),
    limit: text('2 分鐘已到，觀察已停止', '2-minute limit reached; observation stopped'), unmounted: '',
  }
  const registry = snapshot?.sources.registry
  const records = snapshot?.dispatches

  return (
    <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-work-state-view>
      <div className="wm-observation" role="status">
        <button type="button" onClick={() => observing ? reader.current?.stop() : reader.current?.start()} aria-pressed={observing}>{observing ? text('停止即時觀察', 'Stop observation') : text('即時觀察 2 分鐘', 'Observe for 2 minutes')}</button>
        <span data-observation-state={observation}>{labels[observation]}</span>
        <span>{snapshot ? text(`涵蓋最近 ${registry?.selectedCount ?? '—'}／${registry?.rowCount ?? '—'} 件登錄工作與 Claude 工作階段；不是全機所有工作。`, `Covers the latest ${registry?.selectedCount ?? '—'}/${registry?.rowCount ?? '—'} registered tasks and Claude sessions; not every task on this computer.`) : text('正在確認唯讀工作來源；未取得前不顯示為零件。', 'Checking read-only work sources; unavailable counts are not zero.')}</span>
        {snapshot && <span>{text('登錄來源', 'Registry source')}: {registry?.state} · {text('專案來源', 'Project source')}: {snapshot.sources.projects.state} · {text('工作階段來源', 'Session source')}: {snapshot.sources.runtimeSessions.state}</span>}
        {records && <span data-registry-summary>{text(`登錄紀錄：${records.filter((row) => row.state === 'failed').length} 失敗、${records.filter((row) => row.state === 'stopped').length} 有停止紀錄、${records.filter((row) => row.taskOutcome === 'unknown').length} 結果未確認；完成證據 0。`, `Registry: ${records.filter((row) => row.state === 'failed').length} failed, ${records.filter((row) => row.state === 'stopped').length} stop records, ${records.filter((row) => row.taskOutcome === 'unknown').length} outcomes unconfirmed; 0 verified completions.`)}</span>}
        {snapshot && <span data-runtime-summary>{['ready', 'partial'].includes(snapshot.sources.runtimeSessions.state) ? text(`工作階段另計：${snapshot.runtimeSessions.length} 份回報、${snapshot.runtimeSessions.filter((row) => row.state === 'running').length} 份近期活動；自述忙碌只在來源更新後 120 秒內有效。`, `Sessions counted separately: ${snapshot.runtimeSessions.length} reports, ${snapshot.runtimeSessions.filter((row) => row.state === 'running').length} recent activities; reported activity expires 120 seconds after its producer update.`) : text('工作階段來源未取得；數量未確認。', 'Runtime session source unavailable; count unconfirmed.')}</span>}
      </div>
      <WorkMindMap tools={snapshot?.tools ?? null} projects={snapshot?.projects ?? null} dispatches={snapshot?.dispatches ?? []}
        runtimeSessions={snapshot?.runtimeSessions ?? []} dispatchReadState={readState} dispatchLastSuccess={snapshot?.checkedAt ?? null}
        snapshotFresh={fresh} sourceAvailable={snapshot?.taskDataAvailable ?? false} registryAvailable={registry?.state === 'ready'} onRefresh={() => void reader.current?.refresh()} />
    </div>
  )
}
