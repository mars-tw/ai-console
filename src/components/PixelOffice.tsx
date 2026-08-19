// 像素辦公室畫面：canvas + RAF 迴圈 + 點擊命中
import { useEffect, useRef, useState } from 'react'
import { OfficeRenderer } from '@/pixel/render'
import { buildStaticLayer } from '@/pixel/room'
import { loadArt } from '@/pixel/props'
import { AGENT_KEYS, loadSheets } from '@/pixel/sprites'
import { BASE_H, BASE_W } from '@/pixel/theme'
import { World, type AgentInput } from '@/pixel/world'
import type { DispatchRecord, ToolStatus } from '@/types/data'

interface Props {
  tools: Record<string, ToolStatus>
  dispatches: DispatchRecord[]
  onPick: (key: string) => void
}

export default function PixelOffice({ tools, dispatches, onPick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const worldRef = useRef<World | null>(null)
  const viewRef = useRef({ scale: 1, ox: 0, oy: 0 })
  const hoverRef = useRef<string | null>(null)
  const [hoverName, setHoverName] = useState<string | null>(null)

  // 場景只建一次
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const ctx = canvas.getContext('2d')!
    const world = new World()
    worldRef.current = world
    const renderer = new OfficeRenderer(buildStaticLayer())
    loadSheets()
    loadArt()

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      const scale = Math.min(canvas.width / BASE_W, canvas.height / BASE_H)
      viewRef.current = {
        scale,
        ox: (canvas.width - BASE_W * scale) / 2,
        oy: (canvas.height - BASE_H * scale) / 2,
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)

    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      world.tick(dt)
      renderer.draw(ctx, world, { ...viewRef.current, hover: hoverRef.current })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    // 開發用手動推進：瀏覽器把沒顯示的分頁的 rAF 停掉時，畫面會停在空白，
    // 沒有這個鉤子就沒辦法在自動化環境裡檢查算圖結果。
    // import.meta.env.DEV 在 production build 會被常數摺疊掉，整段不會進發行版。
    if (import.meta.env.DEV) {
      ;(window as unknown as { __px?: unknown }).__px = (secs = 0) => {
        // ResizeObserver 跟 rAF 一樣，分頁沒顯示時不會回呼，
        // canvas 會卡在掛載當下量到的 0×0。這裡先重新量一次再畫。
        if (canvas.clientWidth !== wrap.clientWidth) resize()
        world.tick(secs)
        renderer.draw(ctx, world, { ...viewRef.current, hover: null })
        return world.agents.map((a) => {
          const f = world.frameOf(a)
          return `${a.key} dir=${a.dir} ${a.path.length ? 'WALK' : a.act.kind} frame=${f.frame} flip=${f.flip ? 1 : 0}`
        })
      }
    }

    return () => { cancelAnimationFrame(raf); ro.disconnect(); worldRef.current = null }
  }, [])

  // 真實狀態 → 角色行為
  useEffect(() => {
    const world = worldRef.current
    if (!world) return
    const live = new Map<string, string>()
    for (const d of dispatches) if (d.alive && d.task) live.set(d.tool, d.task)
    const inputs: Record<string, AgentInput> = {}
    for (const key of AGENT_KEYS) {
      const t = tools[key]
      inputs[key] = {
        status: t?.status || 'unknown',
        resetAt: (t as ToolStatus & { reset_at?: string })?.reset_at,
        task: live.get(key),
      }
    }
    world.setInputs(inputs)
  }, [tools, dispatches])

  const toBase = (e: React.MouseEvent) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const dpr = canvas.width / rect.width
    const { scale, ox, oy } = viewRef.current
    return {
      x: ((e.clientX - rect.left) * dpr - ox) / scale,
      y: ((e.clientY - rect.top) * dpr - oy) / scale,
    }
  }

  return (
    <div ref={wrapRef} className="relative w-full flex-none bg-[#0b0f18]" style={{ aspectRatio: `${BASE_W}/${BASE_H}` }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block"
        style={{ imageRendering: 'pixelated', cursor: hoverName ? 'pointer' : 'default' }}
        onMouseMove={(e) => {
          const p = toBase(e)
          const hit = worldRef.current?.pickAt(p.x, p.y) ?? null
          hoverRef.current = hit
          if (hit !== hoverName) setHoverName(hit)
        }}
        onMouseLeave={() => { hoverRef.current = null; setHoverName(null) }}
        onClick={(e) => {
          const p = toBase(e)
          const hit = worldRef.current?.pickAt(p.x, p.y)
          if (hit) onPick(hit)
        }}
      />
    </div>
  )
}
