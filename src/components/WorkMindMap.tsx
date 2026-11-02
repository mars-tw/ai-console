import { useEffect, useMemo, useRef, useState } from 'react'
import { useLang } from '@/i18n'
import DragonAvatar from '@/components/DragonAvatar'
import { buildWorkMindMap, type WorkMindMapTool } from '@/lib/workMindMap'
import type { DispatchRecord, HubProject, ToolStatus } from '@/types/data'
import './work-mind-map.css'

interface Props {
  tools: Record<string, ToolStatus> | null
  projects: HubProject[] | null
  dispatches: DispatchRecord[]
  dispatchReadState: 'idle' | 'loading' | 'ready' | 'error'
  dispatchLastSuccess: string | null
  onRefresh: () => void
}

const PAGE_SIZE = 8

export default function WorkMindMap({ tools, projects, dispatches, dispatchReadState, dispatchLastSuccess, onRefresh }: Props) {
  const lang = useLang()
  const text = (zh: string, en: string) => lang === 'en' ? en : zh
  const model = useMemo(() => buildWorkMindMap(tools ?? {}, projects ?? [], dispatches), [tools, projects, dispatches])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toolsOpen, setToolsOpen] = useState(true)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [toolLimit, setToolLimit] = useState(PAGE_SIZE)
  const [projectLimit, setProjectLimit] = useState(PAGE_SIZE)
  const [taskLimit, setTaskLimit] = useState(PAGE_SIZE)
  const [zoom, setZoom] = useState(1)
  const [motionPaused, setMotionPaused] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(() => {
    const change = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  useEffect(() => {
    const element = stageRef.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => setInView(entries.some((entry) => entry.isIntersecting)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])

  const selectedTool = model.tools.find((item) => item.id === selectedId)
  const selectedProject = model.projects.find((item) => item.id === selectedId)
  const toolLabel = (item: { tool: string | null; label: string }) => item.tool === null ? text('未歸屬工具', 'Unattributed') : item.label
  const selectedAnnouncement = selectedTool ? text(`已選工具：${toolLabel(selectedTool)}`, `Selected tool: ${toolLabel(selectedTool)}`)
    : selectedProject ? text(`已選專案：${selectedProject.title}`, `Selected project: ${selectedProject.title}`)
      : text('已選工作中樞', 'Work hub selected')
  const runningCount = model.tools.reduce((sum, item) => sum + item.runningCount, 0)
  const waitingCount = model.tools.reduce((sum, item) => sum + item.waitingCount, 0)
  const pendingCancellation = dispatches.some((record) => record.cancelOrderPending === true)
  const stale = dispatchReadState !== 'ready' && dispatchLastSuccess !== null
  const noDispatchData = pendingCancellation || (dispatchReadState !== 'ready' && dispatchLastSuccess === null)
  const lastRead = dispatchLastSuccess ? new Date(dispatchLastSuccess).toLocaleString(lang === 'en' ? 'en-US' : 'zh-TW') : ''
  const snapshotSuffix = stale ? text('（上次資料）', ' (last snapshot)') : ''
  const toolsSummary = tools === null ? text('工具資料未取得', 'tool data unavailable') : text(`工具 ${model.tools.length} 個`, `${model.tools.length} tools`)
  const projectsSummary = projects === null ? text('專案資料未取得', 'project data unavailable') : text(`專案 ${model.projects.length} 個`, `${model.projects.length} projects`)
  const selectNode = (id: string | null) => { setSelectedId(id); setTaskLimit(PAGE_SIZE) }
  const labelStatus = (status: string) => {
    const names: Record<string, [string, string]> = {
      running: ['執行中', 'Running'], waiting: ['等待中', 'Waiting'],
      active: ['活躍', 'Active'], idle: ['閒置', 'Idle'],
      rate_limited: ['限流中', 'Rate limited'], blocked: ['阻塞', 'Blocked'],
      done: ['完成', 'Done'], unknown: ['未知', 'Unknown'],
    }
    const pair = names[status]
    return pair ? text(pair[0], pair[1]) : status
  }
  const taskStatus = (item: WorkMindMapTool) => {
    if (noDispatchData) return text('任務：未知（資料尚未確認）', 'Tasks: unknown (data unconfirmed)')
    const states: string[] = []
    if (item.runningCount) states.push(`${text('執行中', 'Running')} ${item.runningCount}`)
    if (item.waitingCount) states.push(`${text('等待中', 'Waiting')} ${item.waitingCount}`)
    return `${text('任務', 'Tasks')}：${states.length ? states.join(' · ') : text('無執行中或等待中任務', 'No running or waiting tasks')}${snapshotSuffix}`
  }
  const toolActivity = (item: WorkMindMapTool) => `${text('工具活動（來源）', 'Tool activity (source)')}：${labelStatus(item.toolStatus)}`
  const connectionStatus = text('連線：未確認', 'Connection: unverified')

  return (
    <section className="wm" data-paused={motionPaused || hidden || reduced || !inView || dispatchReadState !== 'ready' || pendingCancellation} aria-label={text('工作心智圖', 'Work mind map')}>
      <header className="wm-header">
        <div>
          <p className="wm-eyebrow">AI WORKSPACE / WORK MAP</p>
          <h2>{text('工作心智圖', 'Work mind map')}</h2>
          <p className="wm-subtitle">{text('選取節點查看詳情。工具與專案為控制台最近讀取資料，可能過期。', 'Select a node for details. Tools and projects are the latest data read by the console and may be stale.')}</p>
        </div>
        <div className="wm-controls" aria-label={text('心智圖控制', 'Map controls')}>
          <button type="button" onClick={onRefresh} disabled={dispatchReadState === 'loading'}>
            {dispatchReadState === 'loading' ? text('正在更新…', 'Updating…') : text('更新任務資料', 'Refresh task data')}
          </button>
          <div className="wm-zoom" aria-label={text('縮放', 'Zoom')}>
            <button type="button" onClick={() => setZoom((n) => Math.max(0.7, Math.round((n - 0.1) * 10) / 10))} disabled={zoom <= 0.7} aria-label={text('縮小', 'Zoom out')}>−</button>
            <button type="button" onClick={() => setZoom(1)} aria-label={text('重設縮放', 'Reset zoom')}>{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom((n) => Math.min(1.4, Math.round((n + 0.1) * 10) / 10))} disabled={zoom >= 1.4} aria-label={text('放大', 'Zoom in')}>＋</button>
          </div>
          <button type="button" className="wm-pause" onClick={() => setMotionPaused((value) => !value)} disabled={reduced}>
            {reduced ? text('系統已減少動態', 'Reduced motion enabled') : motionPaused ? text('播放動效', 'Play motion') : text('暫停動效', 'Pause motion')}
          </button>
        </div>
      </header>

      <div className="wm-legend" aria-label={text('狀態圖例', 'Status legend')}>
        <span><i className="wm-dot wm-dot--running" />{text('執行中', 'Running')}</span>
        <span><i className="wm-dot wm-dot--waiting" />{text('等待中', 'Waiting')}</span>
        <span><i className="wm-dot wm-dot--other" />{text('其他狀態', 'Other status')}</span>
        <span className="wm-legend-note">{text('流動線條表示執行中，不代表完成率。', 'Moving lines indicate running work, not progress.')}</span>
      </div>
      <p className="wm-data-notice">
        <span>{pendingCancellation ? text('部分取消結果待確認，請核對原終端及登錄；任務狀態可能不完整。', 'Some cancellations are unconfirmed. Check the original terminal and records; task status may be incomplete.') : dispatchReadState === 'ready'
          ? text('派工資料已更新。', 'Dispatch data updated.')
          : noDispatchData
            ? (dispatchReadState === 'idle'
                ? text('尚未讀取任務資料；按「更新任務資料」可讀取一次。', 'Task data has not been read; select Refresh task data to read it once.')
                : dispatchReadState === 'loading' ? text('正在讀取派工資料，狀態尚未確認。', 'Loading dispatch data; status is not yet known.') : text('無法讀取派工資料，狀態未知。', 'Dispatch data unavailable; status is unknown.'))
            : dispatchReadState === 'loading'
              ? text('正在更新派工；以下顯示上次資料。', 'Updating dispatches; showing the last snapshot.')
              : text('無法更新派工；以下顯示上次資料。', 'Unable to update dispatches; showing the last snapshot.')}</span>
        {dispatchLastSuccess && <time dateTime={dispatchLastSuccess}> {text('更新時間', 'Updated')}: {lastRead}</time>}
      </p>

      <div className="wm-scroll">
        <div ref={stageRef} className="wm-stage" style={{ zoom }}>
          <svg className="wm-branches" viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <path d="M500 250 C410 250 370 250 280 250" />
            <path d="M500 250 C590 250 630 250 720 250" />
            {runningCount > 0 && toolsOpen && <path className="wm-flow" d="M280 250 C370 250 410 250 500 250" />}
          </svg>
          <div className="wm-grid">
            <section className="wm-group wm-tools" aria-label={text('AI 工具', 'AI tools')}>
              <div className="wm-group-head">
                <div><span className="wm-index">01 / TOOLS</span><h3>{text('AI 工具', 'AI tools')} <small>{tools === null ? '—' : model.tools.length}</small></h3></div>
                <button type="button" className="wm-fold" onClick={() => setToolsOpen((value) => !value)} aria-expanded={toolsOpen} aria-controls="wm-tools-list">{toolsOpen ? text('收合', 'Collapse') : text('展開', 'Expand')}</button>
              </div>
              {tools === null && <p className="wm-source-note">{text('工具資料未取得；如有節點僅來自派工資料。', 'Tool data unavailable; any nodes shown are from dispatch data.')}</p>}
              <div id="wm-tools-list" hidden={!toolsOpen} className="wm-list">
                {model.tools.slice(0, toolLimit).map((item) => (
                  <button key={item.id} type="button" className={`wm-node${item.runningCount > 0 ? ' wm-node--running' : ''}${selectedId === item.id ? ' wm-node--selected' : ''}`} aria-pressed={selectedId === item.id} title={`${toolLabel(item)} · ${connectionStatus} · ${toolActivity(item)} · ${taskStatus(item)}`} onClick={() => selectNode(item.id)}>
                    <DragonAvatar tool={item.tool} status={item.status} />
                    <span className="wm-node-copy"><strong>{toolLabel(item)}</strong><small>{connectionStatus} · {toolActivity(item)}</small><small>{taskStatus(item)}</small></span>
                    <span className="wm-arrow" aria-hidden="true">↗</span>
                  </button>
                ))}
                {model.tools.length === 0 && <p className="wm-empty">{tools === null ? text('尚未取得工具資料。', 'Tool data has not been loaded.') : text('目前沒有工具狀態。', 'No tool status available.')}</p>}
                {toolLimit < model.tools.length && <button type="button" className="wm-more" onClick={() => setToolLimit((n) => n + PAGE_SIZE)}>{text('顯示更多工具', 'Show more tools')}</button>}
              </div>
            </section>

            <div className="wm-center">
              <button type="button" className={`wm-hub${selectedId === null ? ' wm-hub--selected' : ''}`} aria-pressed={selectedId === null} onClick={() => selectNode(null)}>
                <span className="wm-hub-orbit" aria-hidden="true"><span>✳</span></span>
                <strong>{text('工作中樞', 'Work hub')}</strong>
                <small>AI WORKSPACE</small>
              </button>
              <p>{text('工具與專案各自連到中樞，線條不表示兩者已被指派。', 'Tools and projects connect to the hub separately; no assignment is implied.')}</p>
            </div>

            <section className="wm-group wm-projects" aria-label={text('專案', 'Projects')}>
              <div className="wm-group-head">
                <div><span className="wm-index">02 / PROJECTS</span><h3>{text('專案', 'Projects')} <small>{projects === null ? '—' : model.projects.length}</small></h3></div>
                <button type="button" className="wm-fold" onClick={() => setProjectsOpen((value) => !value)} aria-expanded={projectsOpen} aria-controls="wm-projects-list">{projectsOpen ? text('收合', 'Collapse') : text('展開', 'Expand')}</button>
              </div>
              <div id="wm-projects-list" hidden={!projectsOpen} className="wm-list">
                {model.projects.slice(0, projectLimit).map((item) => (
                  <button key={item.id} type="button" className={`wm-node${selectedId === item.id ? ' wm-node--selected' : ''}`} aria-pressed={selectedId === item.id} onClick={() => selectNode(item.id)}>
                    <span className="wm-project-mark" aria-hidden="true">◇</span>
                    <span className="wm-node-copy"><strong>{item.title}</strong><small>{labelStatus(item.status)}</small></span>
                    <span className="wm-arrow" aria-hidden="true">↗</span>
                  </button>
                ))}
                {model.projects.length === 0 && <p className="wm-empty">{projects === null ? text('尚未取得專案資料。', 'Project data has not been loaded.') : text('目前沒有專案資料。', 'No projects available.')}</p>}
                {projectLimit < model.projects.length && <button type="button" className="wm-more" onClick={() => setProjectLimit((n) => n + PAGE_SIZE)}>{text('顯示更多專案', 'Show more projects')}</button>}
              </div>
            </section>
          </div>
        </div>
      </div>

      <span className="sr-only" role="status">{selectedAnnouncement}</span>
      <aside className="wm-detail" aria-label={text('節點詳情', 'Node details')}>
        {selectedTool ? (
          <>
            <div className="wm-detail-title"><span className="wm-index">TOOL</span><h3>{toolLabel(selectedTool)}</h3></div>
            <p className="wm-detail-meta">{connectionStatus} · {toolActivity(selectedTool)}</p>
            <p className="wm-detail-meta">{taskStatus(selectedTool)}</p>
            {selectedTool.tasks.length > 0 ? <ul className="wm-tasks">{selectedTool.tasks.slice(0, taskLimit).map((task, index) => <li key={`${task.id}:${index}`}><span className={`wm-task-state is-${task.state}`}>{labelStatus(task.state)}{snapshotSuffix}</span><span>{task.task || text('未提供任務內容', 'No task description')}</span></li>)}</ul> : <p className="wm-empty">{noDispatchData ? text('派工資料尚未確認。', 'Dispatch data is unconfirmed.') : stale ? text('上次資料沒有進行中或等待中的任務。', 'The last snapshot had no running or waiting tasks.') : text('目前沒有進行中或等待中的任務資料。', 'No running or waiting task data.')}</p>}
            {taskLimit < selectedTool.tasks.length && <button type="button" className="wm-more wm-more-tasks" onClick={() => setTaskLimit((n) => n + PAGE_SIZE)}>{text('顯示更多任務', 'Show more tasks')}</button>}
          </>
        ) : selectedProject ? (
          <>
            <div className="wm-detail-title"><span className="wm-index">PROJECT / {labelStatus(selectedProject.status)}</span><h3>{selectedProject.title}</h3></div>
            <p className="wm-detail-meta">{text('專案 ID', 'Project ID')}：{selectedProject.projectId}{selectedProject.needs_handoff ? ` · ${text('需要接力', 'Handoff needed')}` : ''}</p>
            <p className="wm-detail-body">{selectedProject.next_step || text('尚未提供下一步。', 'No next step provided.')}</p>
          </>
        ) : (
          <>
            <div className="wm-detail-title"><span className="wm-index">OVERVIEW</span><h3>{text('從一個節點開始', 'Start with a node')}</h3></div>
            <p className="wm-detail-body">{noDispatchData
              ? text(`${toolsSummary}、${projectsSummary}；派工數量尚未確認。選取只會顯示詳情。`, `${toolsSummary}, ${projectsSummary}; dispatch counts are unconfirmed. Selecting only shows details.`)
              : text(`${toolsSummary}、${projectsSummary}；${stale ? '上次派工資料' : '派工資料'}：${runningCount} 件執行中、${waitingCount} 件等待中。選取只會顯示詳情。`, `${toolsSummary}, ${projectsSummary}; ${stale ? 'last dispatch snapshot' : 'dispatch data'}: ${runningCount} running and ${waitingCount} waiting. Selecting only shows details.`)}</p>
          </>
        )}
      </aside>
    </section>
  )
}
