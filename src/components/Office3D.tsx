import { useEffect, useMemo, useRef } from 'react'
import { createOfficeScene, type OfficeSceneControls } from '@/scene/officeScene.js'
import type { ConversationSummary, HubProject, ToolStatus } from '@/types/data'

const STATUS_LABEL: Record<string, string> = { active: '工作中', idle: '偷懶中', rate_limited: '額度用畢・睡覺中', unknown: '外出' }
const STATUS_CLS: Record<string, string> = {
  active: 'bg-emerald-500',
  idle: 'bg-amber-400',
  rate_limited: 'bg-indigo-400',
  unknown: 'bg-zinc-500',
}

interface Props {
  tools: Record<string, ToolStatus>
  projects: HubProject[]
  conversations: ConversationSummary[]
  onDispatch: (c: ConversationSummary) => void
  busyId: string
}

export default function Office3D({ tools, projects, conversations, onDispatch, busyId }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<OfficeSceneControls | null>(null)

  // 建場景（只建一次）
  useEffect(() => {
    if (!mountRef.current) return
    const controls = createOfficeScene(mountRef.current, {})
    sceneRef.current = controls
    return () => { controls.destroy(); sceneRef.current = null }
  }, [])

  // 即時狀態 → 場景角色
  useEffect(() => {
    if (!sceneRef.current) return
    const m: Record<string, string> = {}
    Object.entries(tools).forEach(([k, v]) => { m[k] = v.status })
    sceneRef.current.setAgentStates(m)
  }, [tools])

  const queue = useMemo(() => projects.filter((p) => p.status !== 'done'), [projects])
  const findConvFor = (projectId: string) =>
    conversations.find((c) => c.project === projectId && c.resume && !c.subagent && !c.dup)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-950">
      {/* 3D 場景 */}
      <div ref={mountRef} className="relative min-h-[420px] flex-none" style={{ height: '56vh' }} />

      {/* 狀態圖例 */}
      <div className="flex flex-none flex-wrap items-center gap-4 border-t border-zinc-800 bg-zinc-950 px-4 py-2 text-xs text-zinc-400">
        {Object.entries(tools).map(([k, t]) => (
          <span key={k} className="flex items-center gap-1.5" title={t.evidence || t.role}>
            <span className={`inline-block h-2 w-2 rounded-full ${STATUS_CLS[t.status] || STATUS_CLS.unknown}`} />
            {t.label} · {STATUS_LABEL[t.status] || t.status}
          </span>
        ))}
        <span className="ml-auto">拖曳旋轉 · 滾輪縮放</span>
      </div>

      {/* 任務排程區（Codex 式） */}
      <div className="flex-none border-t border-zinc-800 bg-zinc-900 px-4 py-3">
        <div className="mb-2 text-xs font-medium tracking-widest text-zinc-400">任務排程區</div>
        {queue.length === 0 && <div className="text-xs text-zinc-500">目前沒有進行中的工作 🎉</div>}
        <div className="flex flex-col gap-1.5">
          {queue.map((p) => {
            const conv = findConvFor(p.project_id)
            return (
              <div key={p.project_id} className="flex items-center gap-3 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm">
                <span className="font-medium text-zinc-100">{p.title}</span>
                {p.needs_handoff && <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-xs text-amber-300">待接力</span>}
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-400" title={p.next_step}>{p.next_step || '（無下一步紀錄）'}</span>
                {conv && (
                  <button
                    className="flex-none rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
                    disabled={busyId === conv.id}
                    onClick={() => onDispatch(conv)}
                  >
                    {busyId === conv.id ? '…' : '▶ 繼續工作'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
