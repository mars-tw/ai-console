// 畫面渲染：像素層 + 文字層分開畫
//   像素層：畫進 672×448 的底圖緩衝，再用 nearest 放大 → 保持硬邊不糊
//   文字層：直接畫在裝置解析度上 → 中文名牌與對話框清晰可讀

import { PROPS, drawDecals, drawProp, drawShell, hasArt, hasProp, sortYOf } from './props'
import { BOARD, DESKS, screenRect } from './room'
import { FOOT_Y, SKINS, drawAgent } from './sprites'
import { BASE_H, BASE_W, C, TILE } from './theme'
import type { Agent, World } from './world'

const STATUS_ICON: Record<string, string> = {
  desk: '⌨', debate: '💬', toilet: '🚽', read: '📖', pace: '💭',
  coffee: '☕', water: '🌱', sleep: '💤', board: '⚙', meet: '📋', idlestand: '',
}

interface DepthItem { sortY: number; draw: () => void }

export interface DrawOpts {
  scale: number
  ox: number
  oy: number
  hover: string | null
}

export class OfficeRenderer {
  private base: HTMLCanvasElement
  private bctx: CanvasRenderingContext2D
  private staticLayer: HTMLCanvasElement

  constructor(staticLayer: HTMLCanvasElement) {
    this.staticLayer = staticLayer
    this.base = document.createElement('canvas')
    this.base.width = BASE_W
    this.base.height = BASE_H
    this.bctx = this.base.getContext('2d')!
    this.bctx.imageSmoothingEnabled = false
  }

  draw(ctx: CanvasRenderingContext2D, world: World, o: DrawOpts) {
    const b = this.bctx
    // 底圖與家具都齊了才切換；只有底圖就切會變成一間空房間
    const art = hasArt()
    b.clearRect(0, 0, BASE_W, BASE_H)

    if (art) {
      drawShell(b)      // AI 生成的空房間底圖
      drawDecals(b)     // 地毯（永遠在最底層）
    } else {
      b.drawImage(this.staticLayer, 0, 0)   // 素材還沒好：程式繪製的房間頂上
    }

    // ── 深度排序：家具與角色一起排，龍才能走到家具後面 ──
    const items: DepthItem[] = []
    if (art) {
      for (const p of PROPS) {
        if (hasProp(p.name)) items.push({ sortY: sortYOf(p), draw: () => drawProp(b, p) })
      }
    }
    const sorted = [...world.agents].filter((a) => !a.hidden).sort((p, q) => p.y - q.y)
    for (const a of sorted) items.push({ sortY: a.y, draw: () => this.drawOneAgent(b, world, a, o) })
    items.sort((p, q) => p.sortY - q.sortY)
    for (const it of items) it.draw()

    // 螢幕與白板的動態光效疊在家具之上
    this.drawScreens(b, world, art)
    this.drawBoardWork(b, world)

    // 放大貼到畫面
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    ctx.drawImage(this.base, o.ox, o.oy, BASE_W * o.scale, BASE_H * o.scale)

    // 文字層
    for (const a of sorted) this.drawOverlay(ctx, world, a, o)
  }

  private drawOneAgent(b: CanvasRenderingContext2D, world: World, a: Agent, o: DrawOpts) {
    const { frame, flip, stepping } = world.frameOf(a)
    const walking = a.path.length > 0
    // 上下浮動一律跟「步伐相位」同步，不另外跑一條頻率，否則兩個節奏會打架
    let bob = 0
    if (walking) bob = stepping ? -1 : 0
    else if (a.act.kind === 'desk' || a.act.kind === 'meet') {
      // 打電腦：低頻 1px 點頭（敲鍵盤的節奏），不做水平抖動 —— 整隻左右震看起來只像壞掉
      bob = Math.floor(world.time * 4 + a.phase * 2) % 2 ? -1 : 0
    } else if (a.act.kind === 'debate') {
      bob = Math.floor(world.time * 2.5 + a.phase) % 2 ? -1 : 0
    }
    // 影子
    b.fillStyle = 'rgba(0,0,0,0.28)'
    b.beginPath()
    b.ellipse(a.x, a.y - 1, 9, 3.5, 0, 0, Math.PI * 2)
    b.fill()
    // 沒有活動跡象的（外出／查不到狀態）只調透明度，**不要**抽彩度。
    //
    // 這裡踩過兩次：
    //   1. 最早是疊一塊 saturation 混色方塊，但混色作用於「方塊底下的所有東西」，
    //      地板家具一起被抽掉彩度，畫面上多出一個硬邊灰方塊
    //   2. 改成 filter: grayscale 之後方塊沒了，但整隻變灰 —— 黃色的傻龍看起來
    //      像壞掉的素材。辦公室的全部意義就是「一眼認出誰是誰」，
    //      抽掉顏色等於把身分也抽掉了
    // 半透明已經足夠表達「不在狀態內」，而且認得出是哪一隻。
    drawAgent(b, a.key, frame, a.x, a.y + bob, flip, a.mode === 'away' ? 0.55 : 1)
    if (o.hover === a.key) {
      b.strokeStyle = SKINS[a.key]?.color ?? '#fff'
      b.lineWidth = 1
      b.strokeRect(Math.round(a.x - 15), Math.round(a.y - FOOT_Y + 4), 30, FOOT_Y - 4)
    }
  }

  /** 桌上螢幕：工作中會亮起跑碼 */
  private drawScreens(b: CanvasRenderingContext2D, world: World, art: boolean) {
    DESKS.forEach((d, i) => {
      const a = world.agents.find((g) => g.deskIndex === i)
      const active = !!a && !a.path.length && a.act.kind === 'desk'
      if (art) {
        // 用生成的桌子時不知道螢幕確切位置，改用桌面上緣的一片呼吸藍光
        if (!active) return
        const px = d.x * TILE, py = d.y * TILE
        const pulse = 0.10 + 0.05 * Math.sin(world.time * 7 + i)
        b.fillStyle = `rgba(90,170,255,${pulse.toFixed(3)})`
        b.fillRect(px, py - TILE, 4 * TILE, 2 * TILE)
        return
      }
      const s = screenRect(d)
      b.fillStyle = active ? C.screenOn : C.screenOff
      b.fillRect(s.x, s.y, s.w, s.h)
      if (!active) return
      // 跑動的程式碼行
      const t = world.time * 9 + i * 3
      for (let ln = 0; ln < 4; ln++) {
        const w = 4 + ((Math.floor(t + ln * 2.7) * 7919 + ln * 13) % 17)
        b.fillStyle = ln === Math.floor(t) % 4 ? C.screenHot : '#5aa2d8'
        b.fillRect(s.x + 2, s.y + 1 + ln * 2, Math.min(w, s.w - 4), 1)
      }
      // 螢幕外溢的藍光
      b.fillStyle = 'rgba(90,170,255,0.13)'
      b.fillRect(s.x - 4, s.y - 2, s.w + 8, s.h + 10)
    })
  }

  /** 白板派工台：有人在 tool call 時亮起並跑進度 */
  private drawBoardWork(b: CanvasRenderingContext2D, world: World) {
    const busy = world.agents.filter((a) => a.act.kind === 'board' && !a.path.length)
    if (!busy.length) return
    const px = BOARD.x * TILE, py = BOARD.y * TILE
    b.fillStyle = 'rgba(255,196,80,0.16)'
    b.fillRect(px - 6, py - 20, BOARD.w * TILE + 12, TILE + 24)
    // 進度條
    const w = BOARD.w * TILE - 12
    const p = (world.time * 0.35) % 1
    b.fillStyle = '#2b3242'
    b.fillRect(px + 6, py + 10, w, 3)
    b.fillStyle = SKINS[busy[0].key]?.color ?? '#f5c928'
    b.fillRect(px + 6, py + 10, Math.round(w * p), 3)
  }

  /** 名牌、狀態圖示、對話框（畫在裝置解析度，字才清楚）*/
  private drawOverlay(ctx: CanvasRenderingContext2D, world: World, a: Agent, o: DrawOpts) {
    const skin = SKINS[a.key]
    const sx = o.ox + a.x * o.scale
    const headY = o.oy + (a.y - (a.act.kind === 'sleep' ? 22 : FOOT_Y - 2)) * o.scale
    const dim = a.mode === 'away'

    // 名牌
    const fs = Math.max(9, Math.round(4.5 * o.scale))
    ctx.font = `700 ${fs}px ui-sans-serif, system-ui, "Noto Sans TC", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const name = world.label(a)
    const tw = ctx.measureText(name).width
    const padX = fs * 0.45
    const bw = tw + padX * 2
    const bh = fs + 5
    ctx.globalAlpha = dim ? 0.4 : 1
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(sx - bw / 2, headY - bh, bw, bh)
    ctx.fillStyle = skin?.color ?? '#888'
    ctx.fillRect(sx - bw / 2, headY - bh, bw, 2)
    ctx.fillStyle = '#fff'
    ctx.fillText(name, sx, headY - bh / 2 + 1)

    // 狀態小圖示
    const icon = STATUS_ICON[a.act.kind]
    if (icon && !a.path.length) {
      ctx.font = `${Math.round(fs * 1.15)}px ui-sans-serif, system-ui, sans-serif`
      ctx.fillText(icon, sx + bw / 2 + fs * 0.55, headY - bh / 2)
    }

    // 辯論：頭上冒怒氣
    if (a.act.kind === 'debate' && !a.path.length) {
      ctx.font = `700 ${Math.round(fs * 1.3)}px ui-sans-serif, system-ui, sans-serif`
      ctx.fillStyle = '#f87171'
      const pulse = 1 + 0.25 * Math.sin(world.time * 9 + a.phase)
      ctx.save()
      ctx.translate(sx - bw / 2 - fs * 0.6, headY - bh * 0.6)
      ctx.scale(pulse, pulse)
      ctx.fillText('💢', 0, 0)
      ctx.restore()
    }

    // 睡覺的 Zzz
    if (a.act.kind === 'sleep' && !a.path.length) {
      ctx.font = `700 ${fs}px ui-sans-serif, system-ui, sans-serif`
      ctx.fillStyle = '#a5b4fc'
      for (let i = 0; i < 3; i++) {
        const t = (world.time * 0.7 + i * 0.33) % 1
        ctx.globalAlpha = (1 - t) * 0.9
        ctx.fillText('z', sx + 10 * o.scale + t * 8 * o.scale, headY - bh - t * 16 * o.scale)
      }
      ctx.globalAlpha = 1
    }

    // 對話框
    if (a.bubble) {
      const bfs = Math.max(9, Math.round(4.2 * o.scale))
      ctx.font = `500 ${bfs}px ui-sans-serif, system-ui, "Noto Sans TC", sans-serif`
      const text = a.bubble.text
      const twb = ctx.measureText(text).width
      const pw = twb + bfs * 1.2
      const ph = bfs + bfs * 0.9
      const bx = sx - pw / 2
      const by = headY - bh - ph - 4
      ctx.fillStyle = 'rgba(250,250,252,0.96)'
      ctx.beginPath()
      const rr = bfs * 0.45
      ctx.moveTo(bx + rr, by)
      ctx.arcTo(bx + pw, by, bx + pw, by + ph, rr)
      ctx.arcTo(bx + pw, by + ph, bx, by + ph, rr)
      ctx.arcTo(bx, by + ph, bx, by, rr)
      ctx.arcTo(bx, by, bx + pw, by, rr)
      ctx.closePath()
      ctx.fill()
      // 小尾巴
      ctx.beginPath()
      ctx.moveTo(sx - bfs * 0.35, by + ph)
      ctx.lineTo(sx, by + ph + bfs * 0.6)
      ctx.lineTo(sx + bfs * 0.35, by + ph)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = '#1f2430'
      ctx.fillText(text, sx, by + ph / 2)
    }
    ctx.globalAlpha = 1
  }
}
