import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLang } from '@/i18n'
import DragonAvatar from '@/components/DragonAvatar'
import {
  anchorPoint,
  branchPath,
  buildWorkMindMap,
  clampZoom,
  filterProjects,
  filterTools,
  fitZoom,
  scaledSize,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  type WorkMindMapTool,
} from '@/lib/workMindMap'
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

interface Branch { id: string; state: string; d: string }
interface Layout { viewport: number; height: number; branches: Branch[] }

const PAGE_SIZE = 8
/** Narrow screens scroll the graph sideways instead of dropping the branches. */
const MIN_SCENE = 760
const EMPTY_LAYOUT: Layout = { viewport: 0, height: 0, branches: [] }

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
  const [query, setQuery] = useState('')
  const [zoom, setZoom] = useState(1)
  const [layout, setLayout] = useState<Layout>(EMPTY_LAYOUT)
  const [motionPaused, setMotionPaused] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HTMLDivElement>(null)
  const hubRef = useRef<HTMLButtonElement>(null)
  const frame = useRef<number | null>(null)
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

  const visibleTools = useMemo(() => filterTools(model.tools, query), [model.tools, query])
  const visibleProjects = useMemo(() => filterProjects(model.projects, query), [model.projects, query])
  const pagedTools = visibleTools.slice(0, toolLimit)
  const pagedProjects = visibleProjects.slice(0, projectLimit)

  /* Layout measurement only: read the real anchors once per coalesced frame. */
  const applyLayout = useCallback(() => {
    const scene = sceneRef.current
    const viewport = viewportRef.current
    if (!scene || !viewport) return
    const sceneRect = scene.getBoundingClientRect()
    const measured = scene.offsetWidth > 0 ? sceneRect.width / scene.offsetWidth : 0
    const scale = measured > 0.05 ? measured : 1
    const branches: Branch[] = []
    const hub = hubRef.current
    if (hub) {
      const hubRect = hub.getBoundingClientRect()
      const hubLeft = anchorPoint(hubRect, sceneRect, 'left', scale)
      const hubRight = anchorPoint(hubRect, sceneRect, 'right', scale)
      for (const element of Array.from(scene.querySelectorAll<HTMLElement>('[data-wm-node]'))) {
        const id = element.dataset.wmNode
        if (!id) continue
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        const right = element.dataset.wmSide === 'right'
        branches.push({
          id,
          state: element.dataset.wmState || 'idle',
          d: right
            ? branchPath(hubRight, anchorPoint(rect, sceneRect, 'left', scale))
            : branchPath(anchorPoint(rect, sceneRect, 'right', scale), hubLeft),
        })
      }
    }
    const next: Layout = { viewport: Math.round(viewport.clientWidth), height: Math.round(scene.offsetHeight), branches }
    setLayout((prev) => prev.viewport === next.viewport && prev.height === next.height
      && prev.branches.length === next.branches.length
      && prev.branches.every((branch, index) => branch.id === next.branches[index].id
        && branch.d === next.branches[index].d && branch.state === next.branches[index].state)
      ? prev : next)
  }, [])

  const schedule = useCallback(() => {
    if (frame.current !== null) return
    if (typeof requestAnimationFrame !== 'function') { applyLayout(); return }
    frame.current = requestAnimationFrame(() => { frame.current = null; applyLayout() })
  }, [applyLayout])

  // Recalculate on filter, collapse, pagination, model, zoom and element resize.
  useEffect(() => {
    schedule()
    const scene = sceneRef.current
    const viewport = viewportRef.current
    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => schedule()
      window.addEventListener('resize', onResize)
      return () => {
        window.removeEventListener('resize', onResize)
        if (frame.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }
    const observer = new ResizeObserver(() => schedule())
    if (scene) observer.observe(scene)
    if (viewport) observer.observe(viewport)
    if (scene) for (const group of Array.from(scene.querySelectorAll('[data-wm-observe]'))) observer.observe(group)
    return () => {
      observer.disconnect()
      if (frame.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [schedule, model, zoom, query, toolsOpen, projectsOpen, toolLimit, projectLimit, selectedId, lang])

  const sceneWidth = layout.viewport > 0 ? Math.max(MIN_SCENE, layout.viewport) : 0
  const scaled = scaledSize(sceneWidth, layout.height, zoom)

  const selectedTool = model.tools.find((item) => item.id === selectedId)
  const selectedProject = model.projects.find((item) => item.id === selectedId)
  const toolLabel = (item: { tool: string | null; label: string }) => item.tool === null ? text('未歸屬工具', 'Unattributed') : item.label
  const selectedAnnouncement = selectedTool ? text(`已選工具：${toolLabel(selectedTool)}`, `Selected tool: ${toolLabel(selectedTool)}`)
    : selectedProject ? text(`已選專案：${selectedProject.title}`, `Selected project: ${selectedProject.title}`)
      : text('已選工作中樞', 'Work hub selected')
  const runningCount = model.tools.reduce((sum, item) => sum + item.runningCount, 0)
  const waitingCount = model.tools.reduce((sum, item) => sum + item.waitingCount, 0)
  const unknownCount = model.tools.reduce((sum, item) => sum + item.unknownCount, 0)
  const pendingCancellation = dispatches.some((record) => record.cancelOrderPending === true)
  const stale = dispatchReadState !== 'ready' && dispatchLastSuccess !== null
  const noDispatchData = pendingCancellation || (dispatchReadState !== 'ready' && dispatchLastSuccess === null)
  const lastRead = dispatchLastSuccess ? new Date(dispatchLastSuccess).toLocaleString(lang === 'en' ? 'en-US' : 'zh-TW') : ''
  const snapshotSuffix = stale ? text('（上次資料）', ' (last snapshot)') : ''
  const toolsSummary = tools === null ? text('工具資料未取得', 'tool data unavailable') : text(`工具 ${model.tools.length} 個`, `${model.tools.length} tools`)
  const projectsSummary = projects === null ? text('專案資料未取得', 'project data unavailable') : text(`專案 ${model.projects.length} 個`, `${model.projects.length} projects`)
  /** Unconfirmed records hold every animation in the map, not just their own branch. */
  const paused = motionPaused || hidden || reduced || !inView
    || dispatchReadState !== 'ready' || pendingCancellation || unknownCount > 0
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
  const taskStateLabel = (state: 'running' | 'waiting' | 'unknown') => state === 'unknown'
    ? text('未確認', 'Unconfirmed') : labelStatus(state)
  /** Branch and dragon state come from the snapshot counts, never from tool availability. */
  const branchState = (item: WorkMindMapTool) => noDispatchData ? 'unknown'
    : item.runningCount > 0 ? 'running'
      : item.waitingCount > 0 ? 'waiting'
        : item.unknownCount > 0 ? 'unknown' : 'idle'
  const taskStatus = (item: WorkMindMapTool) => {
    if (noDispatchData) return text('任務：未確認（資料尚未確認）', 'Tasks: unconfirmed (data not yet confirmed)')
    const states: string[] = []
    if (item.runningCount) states.push(`${text('執行中', 'Running')} ${item.runningCount}`)
    if (item.waitingCount) states.push(`${text('等待中', 'Waiting')} ${item.waitingCount}`)
    if (item.unknownCount) states.push(`${text('未確認', 'Unconfirmed')} ${item.unknownCount}`)
    return `${text('任務', 'Tasks')}：${states.length ? states.join(' · ') : text('無執行中或等待中任務', 'No running or waiting tasks')}${snapshotSuffix}`
  }
  const toolActivity = (item: WorkMindMapTool) => `${text('工具活動（來源）', 'Tool activity (source)')}：${labelStatus(item.toolStatus)}`
  const connectionStatus = text('連線：未確認', 'Connection: unverified')

  const nodeElement = (id: string) => {
    const scene = sceneRef.current
    if (!scene) return null
    for (const element of Array.from(scene.querySelectorAll<HTMLElement>('[data-wm-node], [data-wm-hub]'))) {
      if (element.dataset.wmNode === id || (id === 'hub' && element.dataset.wmHub === 'hub')) return element
    }
    return null
  }
  /** Optional roving navigation: columns with arrows, Home/End inside a column. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const target = event.target as HTMLElement | null
    const current = target?.dataset?.wmNode ?? (target?.dataset?.wmHub ? 'hub' : null)
    if (!current) return
    const left = toolsOpen ? pagedTools.map((item) => item.id) : []
    const right = projectsOpen ? pagedProjects.map((item) => item.id) : []
    const column = current === 'hub' ? ['hub'] : left.includes(current) ? left : right.includes(current) ? right : null
    if (!column) return
    const index = column.indexOf(current)
    let next: string | undefined
    if (event.key === 'ArrowUp') next = column[index - 1]
    else if (event.key === 'ArrowDown') next = column[index + 1]
    else if (event.key === 'Home') next = column[0]
    else if (event.key === 'End') next = column[column.length - 1]
    else if (event.key === 'ArrowLeft') next = current === 'hub' ? left[0] : right.includes(current) ? 'hub' : undefined
    else next = current === 'hub' ? right[0] : left.includes(current) ? 'hub' : undefined
    if (!next) return
    const element = nodeElement(next)
    if (!element) return
    event.preventDefault()
    element.focus()
  }

  const fit = () => {
    const viewport = viewportRef.current
    const width = viewport ? viewport.clientWidth : layout.viewport
    setZoom(fitZoom(Math.max(MIN_SCENE, sceneWidth || MIN_SCENE), width))
  }

  return (
    <section className="wm" data-paused={paused} aria-label={text('工作心智圖', 'Work mind map')}>
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
          <input
            className="wm-search" type="search" value={query} inputMode="search"
            placeholder={text('搜尋節點', 'Search nodes')} aria-label={text('搜尋節點', 'Search nodes')}
            onChange={(event) => { setQuery(event.target.value); setToolLimit(PAGE_SIZE); setProjectLimit(PAGE_SIZE) }}
          />
          <div className="wm-zoom" aria-label={text('縮放', 'Zoom')}>
            <button type="button" onClick={() => setZoom((n) => clampZoom(n - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} aria-label={text('縮小', 'Zoom out')}>−</button>
            <button type="button" onClick={() => setZoom(1)} aria-label={text('重設縮放', 'Reset zoom')}>{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom((n) => clampZoom(n + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} aria-label={text('放大', 'Zoom in')}>＋</button>
          </div>
          <button type="button" onClick={fit}>{text('整圖檢視', 'Fit map')}</button>
          <button type="button" onClick={() => selectNode(null)} disabled={selectedId === null}>{text('清除選取', 'Clear selection')}</button>
          <button type="button" className="wm-pause" onClick={() => setMotionPaused((value) => !value)} disabled={reduced}>
            {reduced ? text('系統已減少動態', 'Reduced motion enabled') : motionPaused ? text('播放動效', 'Play motion') : text('暫停動效', 'Pause motion')}
          </button>
        </div>
      </header>

      <div className="wm-legend" aria-label={text('狀態圖例', 'Status legend')}>
        <span><i className="wm-dot wm-dot--running" />{text('執行中', 'Running')}</span>
        <span><i className="wm-dot wm-dot--waiting" />{text('等待中', 'Waiting')}</span>
        <span><i className="wm-dot wm-dot--unknown" />{text('未確認', 'Unconfirmed')}</span>
        <span><i className="wm-dot wm-dot--other" />{text('其他狀態', 'Other status')}</span>
        <span className="wm-legend-note">{text('線條只表示分類關係，不代表指派或完成率。', 'Lines show category links only: no assignment or progress is implied.')}</span>
      </div>
      <p className="wm-data-notice">
        <span>{pendingCancellation ? text('部分取消結果待確認，請核對原終端及登錄；任務狀態可能不完整。', 'Some cancellations are unconfirmed. Check the original terminal and records; task status may be incomplete.') : dispatchReadState === 'ready'
          ? (unknownCount > 0
              ? text(`派工資料已更新；其中 ${unknownCount} 件狀態未確認。`, `Dispatch data updated; ${unknownCount} record(s) remain unconfirmed.`)
              : text('派工資料已更新。', 'Dispatch data updated.'))
          : noDispatchData
            ? (dispatchReadState === 'idle'
                ? text('尚未讀取任務資料；按「更新任務資料」可讀取一次。', 'Task data has not been read; select Refresh task data to read it once.')
                : dispatchReadState === 'loading' ? text('正在讀取派工資料，狀態尚未確認。', 'Loading dispatch data; status is not yet known.') : text('無法讀取派工資料，狀態未知。', 'Dispatch data unavailable; status is unknown.'))
            : dispatchReadState === 'loading'
              ? text('正在更新派工；以下顯示上次資料。', 'Updating dispatches; showing the last snapshot.')
              : text('無法更新派工；以下顯示上次資料。', 'Unable to update dispatches; showing the last snapshot.')}</span>
        {dispatchLastSuccess && <time dateTime={dispatchLastSuccess}> {text('更新時間', 'Updated')}: {lastRead}</time>}
      </p>

      <div ref={stageRef} className="wm-stage">
        <div ref={viewportRef} className="wm-viewport">
          <div className="wm-sizer" style={scaled.width > 0 ? { width: scaled.width, height: scaled.height } : undefined}>
            <div
              ref={sceneRef} className="wm-scene" onKeyDown={onKeyDown}
              style={{ transform: `scale(${zoom})`, ...(sceneWidth > 0 ? { width: sceneWidth } : null) }}
            >
              <svg
                className="wm-branches" aria-hidden="true" focusable="false"
                width={scaled.width > 0 ? sceneWidth : undefined} height={layout.height > 0 ? layout.height : undefined}
                viewBox={sceneWidth > 0 && layout.height > 0 ? `0 0 ${sceneWidth} ${layout.height}` : undefined}
              >
                {layout.branches.map((branch) => (
                  <path key={`${branch.id}:${branch.state}`} data-wm-edge={branch.id}
                    className={`wm-branch wm-branch--${branch.state}${branch.state === 'running' ? ' wm-flow' : ''}${selectedId === branch.id ? ' wm-branch--selected' : ''}`} d={branch.d} />
                ))}
              </svg>
              <div className="wm-grid">
                <section className="wm-group wm-tools" data-wm-observe="tools" aria-label={text('AI 工具', 'AI tools')}>
                  <div className="wm-group-head">
                    <div><span className="wm-index">01 / TOOLS</span><h3>{text('AI 工具', 'AI tools')} <small>{tools === null ? '—' : query.trim() ? `${visibleTools.length}/${model.tools.length}` : model.tools.length}</small></h3></div>
                    <button type="button" className="wm-fold" onClick={() => setToolsOpen((value) => !value)} aria-expanded={toolsOpen} aria-controls="wm-tools-list">{toolsOpen ? text('收合', 'Collapse') : text('展開', 'Expand')}</button>
                  </div>
                  {tools === null && <p className="wm-source-note">{text('工具資料未取得；如有節點僅來自派工資料。', 'Tool data unavailable; any nodes shown are from dispatch data.')}</p>}
                  <div id="wm-tools-list" hidden={!toolsOpen} className="wm-list">
                    {pagedTools.map((item) => (
                      <button
                        key={item.id} type="button" data-wm-node={item.id} data-wm-side="left" data-wm-state={branchState(item)}
                        className={`wm-node${branchState(item) === 'running' ? ' wm-node--running' : ''}${selectedId === item.id ? ' wm-node--selected' : ''}`}
                        aria-pressed={selectedId === item.id}
                        title={`${toolLabel(item)} · ${connectionStatus} · ${toolActivity(item)} · ${taskStatus(item)}`}
                        onClick={() => selectNode(item.id)}
                      >
                        <DragonAvatar tool={item.tool} status={branchState(item)} paused={paused} />
                        <span className="wm-node-copy"><strong>{toolLabel(item)}</strong><small>{taskStatus(item)}</small></span>
                        <span className="wm-arrow" aria-hidden="true">↗</span>
                      </button>
                    ))}
                    {visibleTools.length === 0 && <p className="wm-empty">{tools === null ? text('尚未取得工具資料。', 'Tool data has not been loaded.') : query.trim() ? text('沒有符合搜尋的工具。', 'No tools match the search.') : text('目前沒有工具狀態。', 'No tool status available.')}</p>}
                    {toolLimit < visibleTools.length && <button type="button" className="wm-more" onClick={() => setToolLimit((n) => n + PAGE_SIZE)}>{text('顯示更多工具', 'Show more tools')}（{visibleTools.length - toolLimit}）</button>}
                  </div>
                </section>

                <div className="wm-center" data-wm-observe="center">
                  <button ref={hubRef} type="button" data-wm-hub="hub" className={`wm-hub${selectedId === null ? ' wm-hub--selected' : ''}`} aria-pressed={selectedId === null} onClick={() => selectNode(null)}>
                    <span className="wm-hub-orbit" aria-hidden="true"><span>✳</span></span>
                    <strong>{text('工作中樞', 'Work hub')}</strong>
                    <small>AI WORKSPACE</small>
                  </button>
                  <p>{text('工具與專案各自連到中樞，線條不表示兩者已被指派。', 'Tools and projects connect to the hub separately; no assignment is implied.')}</p>
                </div>

                <section className="wm-group wm-projects" data-wm-observe="projects" aria-label={text('專案', 'Projects')}>
                  <div className="wm-group-head">
                    <div><span className="wm-index">02 / PROJECTS</span><h3>{text('專案', 'Projects')} <small>{projects === null ? '—' : query.trim() ? `${visibleProjects.length}/${model.projects.length}` : model.projects.length}</small></h3></div>
                    <button type="button" className="wm-fold" onClick={() => setProjectsOpen((value) => !value)} aria-expanded={projectsOpen} aria-controls="wm-projects-list">{projectsOpen ? text('收合', 'Collapse') : text('展開', 'Expand')}</button>
                  </div>
                  {projects === null && <p className="wm-source-note">{text('專案資料未取得。', 'Project data unavailable.')}</p>}
                  <div id="wm-projects-list" hidden={!projectsOpen} className="wm-list">
                    {pagedProjects.map((item) => (
                      <button
                        key={item.id} type="button" data-wm-node={item.id} data-wm-side="right" data-wm-state="idle"
                        className={`wm-node${selectedId === item.id ? ' wm-node--selected' : ''}`} aria-pressed={selectedId === item.id}
                        title={`${item.title} · ${text('專案狀態（來源）', 'Project status (source)')}：${labelStatus(item.status)}${item.next_step ? ` · ${item.next_step}` : ''}`}
                        onClick={() => selectNode(item.id)}
                      >
                        <span className="wm-project-mark" aria-hidden="true">◇</span>
                        <span className="wm-node-copy"><strong>{item.title}</strong><small>{labelStatus(item.status)}{item.needs_handoff ? ` · ${text('需要接力', 'Handoff needed')}` : ''}</small></span>
                        <span className="wm-arrow" aria-hidden="true">↗</span>
                      </button>
                    ))}
                    {visibleProjects.length === 0 && <p className="wm-empty">{projects === null ? text('尚未取得專案資料。', 'Project data has not been loaded.') : query.trim() ? text('沒有符合搜尋的專案。', 'No projects match the search.') : text('目前沒有專案資料。', 'No projects available.')}</p>}
                    {projectLimit < visibleProjects.length && <button type="button" className="wm-more" onClick={() => setProjectLimit((n) => n + PAGE_SIZE)}>{text('顯示更多專案', 'Show more projects')}（{visibleProjects.length - projectLimit}）</button>}
                  </div>
                </section>
              </div>
            </div>
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
            {selectedTool.tasks.length > 0 ? <ul className="wm-tasks">{selectedTool.tasks.slice(0, taskLimit).map((task, index) => <li key={`${task.id}:${index}`}><span className={`wm-task-state is-${task.state}`}>{taskStateLabel(task.state)}{snapshotSuffix}</span><span>{task.task || text('未提供任務內容', 'No task description')}</span></li>)}</ul> : <p className="wm-empty">{noDispatchData ? text('派工資料尚未確認。', 'Dispatch data is unconfirmed.') : stale ? text('上次資料沒有進行中或等待中的任務。', 'The last snapshot had no running or waiting tasks.') : text('目前沒有進行中或等待中的任務資料。', 'No running or waiting task data.')}</p>}
            {taskLimit < selectedTool.tasks.length && <button type="button" className="wm-more wm-more-tasks" onClick={() => setTaskLimit((n) => n + PAGE_SIZE)}>{text('顯示更多任務', 'Show more tasks')}（{selectedTool.tasks.length - taskLimit}）</button>}
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
              : text(`${toolsSummary}、${projectsSummary}；${stale ? '上次派工資料' : '派工資料'}：${runningCount} 件執行中、${waitingCount} 件等待中、${unknownCount} 件未確認。選取只會顯示詳情。`, `${toolsSummary}, ${projectsSummary}; ${stale ? 'last dispatch snapshot' : 'dispatch data'}: ${runningCount} running, ${waitingCount} waiting and ${unknownCount} unconfirmed. Selecting only shows details.`)}</p>
          </>
        )}
      </aside>
    </section>
  )
}
