// 像素辦公室畫面：canvas + RAF 迴圈 + 點擊命中
import { useEffect, useRef, useState } from 'react'
import { OfficeRenderer } from '@/pixel/render'
import { buildStaticLayer } from '@/pixel/room'
import { loadArt } from '@/pixel/props'
import { AGENT_KEYS, loadSheets } from '@/pixel/sprites'
import { BASE_H, BASE_W } from '@/pixel/theme'
import { World, type AgentInput } from '@/pixel/world'
import type { DispatchRecord, ToolStatus } from '@/types/data'

// pickAt 的命中半徑只有 26px，而龍會到處走、兩隻疊在一起（ANTIGRAVITY
// 與 QWEN）時等於叫使用者追著移動靶點；點偏一點又什麼都不發生。
// world.ts 是別的工單的範圍不能動，所以判定在本層放寬：
//   · 直接命中：半徑放到約一個角色寬（sprite 格 48px），疊在一起取最近的
//   · 點到空地：兩個角色寬以內改開離點擊點最近的那隻；再遠就不動作 ——
//     點房間另一頭也跳對話出來，會比沒反應更讓人困惑
const HIT_RADIUS = 48
const NEAR_RADIUS = 96

/** 點擊命中：可見角色裡離 (px, py) 最近、且在可接受範圍內的那隻 */
function pickAgent(world: World, px: number, py: number, radius: number): string | null {
  let best: string | null = null
  let bestD = radius
  for (const a of world.agents) {
    if (a.hidden) continue
    // 跟 world.pickAt 同一個基準：角色中心在腳底上方 14px
    const d = Math.hypot(a.x - px, a.y - py - 14)
    if (d < bestD) { bestD = d; best = a.key }
  }
  return best
}

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
          // hover 用較小的半徑就好 —— 游標提示只要在「點下去會中」的範圍內一致即可，
          // 用 NEAR_RADIUS 會讓大半個房間都變成 pointer，反而看不出誰才是目標
          const world = worldRef.current
          const hit = world ? pickAgent(world, p.x, p.y, HIT_RADIUS) : null
          hoverRef.current = hit
          if (hit !== hoverName) setHoverName(hit)
        }}
        onMouseLeave={() => { hoverRef.current = null; setHoverName(null) }}
        onClick={(e) => {
          const p = toBase(e)
          const world = worldRef.current
          const hit = world ? pickAgent(world, p.x, p.y, NEAR_RADIUS) : null
          if (hit) onPick(hit)
        }}
      />
    </div>
  )
}
