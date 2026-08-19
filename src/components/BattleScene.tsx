// 像素戰鬥畫面：背景 + 我方（左，面向右）+ 敵方（右，面向左）
//
// 為什麼用 canvas 而不是 DOM：這裡要做的是像素動畫（前衝、揮擊弧、命中火花、
// 畫面震動、死亡溶解），用 canvas 一次畫完最單純，而且跟辦公室共用同一套精靈。
//
// 注意 rAF 在分頁沒有顯示時會被瀏覽器暫停，所以戰鬥的「推進」仍然由
// Adventure 的 setInterval 負責，這裡只負責把當下狀態畫出來。

import { useEffect, useRef } from 'react'
import {
  BG_H, BG_W, bgImage, drawAlly, drawHero, drawMonster, drawPet, drawSkillFx, drawWeapon,
  loadBattleArt, unitHeight,
} from '@/rpg/battleArt'
import {
  FX_LIFE, deathTransform, drawCritFlash, drawHealMotes, drawSlash, drawSparks, lunge, shake,
} from '@/rpg/battleFx'
import type { Battle } from '@/rpg/engine'
import type { Combatant, FxEvent } from '@/rpg/types'

const GROUND_Y = BG_H - 46      // 站立基準線

// 陣型帶：每邊只能站在自己這條帶子裡，人再多也不會被擠出畫面。
// INNER 靠近中央（前鋒），OUTER 靠近畫面邊緣（後排）。
const BAND_INNER = 168
const BAND_OUTER = 38
const MAX_GAP = 40

interface Slot { c: Combatant; x: number; y: number }

/** 第 index 個座位在哪（總共 count 個）。index 0 站最前面 */
function seatAt(index: number, count: number, side: 'left' | 'right') {
  const n = Math.max(1, count)
  const gap = n > 1 ? Math.min(MAX_GAP, (BAND_INNER - BAND_OUTER) / (n - 1)) : 0
  const off = BAND_INNER - index * gap
  return {
    x: side === 'left' ? off : BG_W - off,
    y: GROUND_Y + (index % 2 === 0 ? 0 : 16),
  }
}


export default function BattleScene({ battle, tick }: { battle: Battle; tick: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  // 特效以「牆鐘時間」播放，跟戰鬥回合脫鉤，動畫才會順
  const startedAt = useRef(new Map<string, number>())
  // 已經死掉但動畫還沒播完的單位：資料層早就把它們移出目標清單了，
  // 這裡自己留一份，否則怪會在最後一刀落下的瞬間憑空消失。
  const dying = useRef(new Map<string, { c: Combatant; slot: Slot; at: number }>())
  // 看過的每個單位。死亡動畫需要它 —— 引擎在單位死掉的**同一個 tick**
  // 就把它從 battle.foes 移除了，只掃當前清單的話永遠抓不到死亡事件，
  // 死亡動畫等於從來沒播過（實測才發現）。
  const seen = useRef(new Map<string, { c: Combatant; seat: number; side: 'left' | 'right' }>())

  useEffect(() => {
    loadBattleArt(
      battle.foes.map((f) => f.art),
      `bg-${battle.placeId}`,
      battle.allies.map((a) => a.art),
      battle.pet?.art,
    )
  }, [battle.placeId, battle.foes, battle.allies, battle.pet])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let raf = 0

    const now = () => performance.now() / 1000
    const key = (e: FxEvent) => `${e.uid}:${e.kind}:${e.tick}`

    // 新出現的特效記下開始時間
    for (const e of battle.fx) {
      if (!startedAt.current.has(key(e))) startedAt.current.set(key(e), now())
    }
    if (startedAt.current.size > 200) startedAt.current.clear()

    /** 找某人身上還在播的某類特效，回傳進度 0..1 */
    const activeFx = (uid: string, kind: FxEvent['kind']) => {
      let best: { e: FxEvent; age: number; t: number } | null = null
      for (const e of battle.fx) {
        if (e.uid !== uid || e.kind !== kind) continue
        const t0 = startedAt.current.get(key(e))
        if (t0 === undefined) continue
        const age = now() - t0
        const life = FX_LIFE[kind] ?? 1
        if (age > life) continue
        if (!best || age < best.age) best = { e, age, t: age / life }
      }
      return best
    }

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cw = canvas.clientWidth
      const ch = Math.round(cw * BG_H / BG_W)
      if (canvas.width !== Math.round(cw * dpr)) {
        canvas.width = Math.round(cw * dpr)
        canvas.height = Math.round(ch * dpr)
        canvas.style.height = `${ch}px`
      }
      const scale = canvas.width / BG_W
      ctx.imageSmoothingEnabled = false

      const ours = [battle.hero, ...(battle.pet ? [battle.pet] : []), ...battle.allies]

      /**
       * 座位號在「第一次看到這個單位」時就決定，之後不再變。
       *
       * 每幀重新排位會出兩種重疊：死掉的怪被擺到陣型帶最前面（因為
       * 單一元素的排版永遠算出同一格），以及活著的怪被重新編號後
       * 剛好滑進屍體的位置。固定座位號兩個都不會發生。
       */
      const seat = (c: Combatant, i: number, side: 'left' | 'right') => {
        const prev = seen.current.get(c.uid)
        const s2 = prev?.seat ?? i
        seen.current.set(c.uid, { c, seat: s2, side })
        return s2
      }
      ours.forEach((c, i) => seat(c, i, 'left'))
      battle.foes.forEach((c, i) => seat(c, i, 'right'))

      // 每邊的座位總數要含屍體，不然剩下的人會被擠到中間
      const seatsOf = (side: 'left' | 'right') => {
        let max = 0
        for (const r of seen.current.values()) if (r.side === side) max = Math.max(max, r.seat + 1)
        return Math.max(1, max)
      }
      const nLeft = seatsOf('left')
      const nRight = seatsOf('right')
      const place = (c: Combatant, side: 'left' | 'right'): Slot => {
        const r = seen.current.get(c.uid)
        return { c, ...seatAt(r?.seat ?? 0, side === 'left' ? nLeft : nRight, side) }
      }
      const mine = ours.filter((c) => c.hp > 0).map((c) => place(c, 'left'))
      const foes = battle.foes.filter((c) => c.hp > 0).map((c) => place(c, 'right'))

      // 死亡事件從 fx 讀，不是從當前清單找 —— 死掉的怪已經被引擎移除了
      for (const e of battle.fx) {
        if (e.kind !== 'die' || dying.current.has(e.uid)) continue
        const t0 = startedAt.current.get(key(e))
        if (t0 === undefined || now() - t0 > (FX_LIFE.die ?? 1)) continue
        const rec = seen.current.get(e.uid)
        if (!rec) continue
        dying.current.set(e.uid, { c: rec.c, slot: place(rec.c, rec.side), at: t0 })
      }
      for (const [uid, d] of dying.current) {
        if (now() - d.at > (FX_LIFE.die ?? 1)) {
          dying.current.delete(uid)
          seen.current.delete(uid)     // 動畫播完才放掉座位
        }
      }
      // 清掉已經不在場上、也沒在播動畫的舊紀錄（換波、換場）
      const live = new Set([...ours, ...battle.foes].map((c) => c.uid))
      for (const uid of [...seen.current.keys()]) {
        if (!live.has(uid) && !dying.current.has(uid)) seen.current.delete(uid)
      }

      // 全場震動：任何人受擊都會晃，暴擊晃更兇
      let sx = 0, sy = 0
      for (const c of [...ours, ...battle.foes]) {
        for (const [kind, power] of [['hurt', 3], ['crit', 7]] as const) {
          const e = activeFx(c.uid, kind)
          if (!e) continue
          const [dx, dy] = shake(e.age, power)
          sx += dx; sy += dy
        }
      }
      sx = Math.max(-9, Math.min(9, sx))
      sy = Math.max(-6, Math.min(6, sy))
      ctx.setTransform(scale, 0, 0, scale, Math.round(sx * scale), Math.round(sy * scale))

      // 背景（畫大一點，震動時邊緣才不會露出黑邊）
      const bg = bgImage(`bg-${battle.placeId}`)
      if (bg) ctx.drawImage(bg, -12, -8, BG_W + 24, BG_H + 16)
      else {
        const g = ctx.createLinearGradient(0, 0, 0, BG_H)
        g.addColorStop(0, '#1b2440'); g.addColorStop(1, '#0d1220')
        ctx.fillStyle = g; ctx.fillRect(-12, -8, BG_W + 24, BG_H + 16)
        ctx.fillStyle = '#2a3550'; ctx.fillRect(-12, GROUND_Y, BG_W + 24, BG_H - GROUND_Y + 8)
      }

      // 死者先畫（躺在活人腳下）
      for (const { c, slot } of dying.current.values()) {
        const t = (now() - (dying.current.get(c.uid)?.at ?? 0)) / (FX_LIFE.die ?? 1)
        const { alpha, tilt, sink, dissolve } = deathTransform(t)
        const TOP = 96                      // 精靈最高不會超過腳底上方這麼多
        const eaten = TOP * dissolve        // 由下往上被吃掉的高度

        ctx.save()
        // 溶解用「裁切掉下半部」做，不能用 destination-out ——
        // 那會連背景一起挖掉，地上會出現一個破洞。
        ctx.beginPath()
        ctx.rect(slot.x - 60, slot.y - TOP, 120, Math.max(0, TOP - eaten))
        ctx.clip()
        ctx.globalAlpha = Math.max(0, alpha)
        ctx.translate(slot.x, slot.y + sink)
        ctx.rotate(tilt * (c.side === 'foe' ? -1 : 1))
        ctx.translate(-slot.x, -slot.y)
        drawUnit(ctx, c, slot.x, slot.y, false, false)
        ctx.restore()

        // 溶解邊緣的一條亮線，讓「被吸走」看得出來
        if (dissolve > 0 && dissolve < 1) {
          ctx.save()
          ctx.globalAlpha = (1 - dissolve) * 0.8
          ctx.fillStyle = c.side === 'foe' ? '#fca5a5' : '#93c5fd'
          ctx.fillRect(slot.x - 22, slot.y - eaten, 44, 1)
          ctx.restore()
        }
      }

      /** 畫一個單位的精靈本體（含主角手上的武器）*/
      function drawUnit(
        c: CanvasRenderingContext2D, u: Combatant, x: number, y: number,
        attacking: boolean, hurting: boolean,
      ) {
        if (u.side === 'hero') {
          const who = battle.heroLook
          const pose = attacking ? `${who}-attack` : hurting ? `${who}-hurt` : `${who}-stand`
          drawHero(c, pose, x, y)
          drawWeapon(c, battle.heroWeapon, pose.replace(who, 'hero'), x, y)
        } else if (u.side === 'pet') {
          drawPet(c, u.art, x, y)
        } else if (u.side === 'ally') {
          drawAlly(c, u.art, x, y, attacking, 1)
        } else {
          drawMonster(c, u.art, x, y)
        }
      }

      // 後排先畫，前排後畫
      for (const s of [...mine, ...foes].sort((a, b) => a.y - b.y)) {
        const atk = activeFx(s.c.uid, 'attack')
        const critFx = activeFx(s.c.uid, 'crit')
        const hurt = critFx ?? activeFx(s.c.uid, 'hurt')
        const heal = activeFx(s.c.uid, 'heal')
        const facing = s.c.side === 'foe' ? -1 : 1

        // 出手：往敵方方向前衝再收回
        let dx = atk ? lunge(atk.t) * 15 * facing : 0
        // 受擊：往後彈
        if (hurt && hurt.age < 0.18) dx -= facing * 5

        const x = s.x + dx
        ctx.save()
        // 受擊瞬間閃白
        if (hurt && hurt.age < 0.12) ctx.globalAlpha = 0.5
        drawUnit(ctx, s.c, x, s.y,
          !!atk && atk.t < 0.7, !!hurt && hurt.age < 0.3)
        ctx.restore()

        // 揮擊弧線：出手到一半才出現，跟前衝對得上
        if (atk && atk.t > 0.15) {
          drawSlash(ctx, x, s.y, (atk.t - 0.15) / 0.85, facing, !!critFx)
        }
        // 技能專屬特效（疊在目標身上，畫在命中火花之前）
        const skillFx = activeFx(s.c.uid, 'skill')
        if (skillFx?.e.skill) drawSkillFx(ctx, skillFx.e.skill, x, s.y, skillFx.t)

        // 命中特效
        if (hurt) {
          drawSparks(ctx, x, s.y - 24, hurt.t, hurt === critFx)
          if (hurt === critFx) drawCritFlash(ctx, x, s.y - 24, hurt.age)
        }
        if (heal) drawHealMotes(ctx, x, s.y, heal.t)

        // 血條貼在頭頂上方。固定高度不行 —— 史萊姆 30px、古龍 104px，
        // 用同一個數字會讓小怪的血條飄在半空、大王的血條插在身上。
        const top = unitHeight(s.c.side, s.c.art, `${battle.heroLook}-stand`)
        const barY = s.y - top - 8
        const bw = Math.max(24, Math.min(48, top * 0.7))
        ctx.fillStyle = 'rgba(0,0,0,0.55)'
        ctx.fillRect(x - bw / 2 - 1, barY, bw + 2, 5)
        ctx.fillStyle = s.c.elite ? '#fbbf24' : s.c.side === 'foe' ? '#ef4444' : '#22c55e'
        ctx.fillRect(x - bw / 2, barY + 1, Math.max(0, bw * (s.c.hp / s.c.hpMax)), 3)

        // 跳字（暴擊字更大、往上彈更高）
        for (const [kind, color] of [['hurt', '#fca5a5'], ['crit', '#fbbf24'], ['heal', '#86efac']] as const) {
          const e = activeFx(s.c.uid, kind)
          if (!e || e.e.amount === undefined) continue
          const big = kind === 'crit'
          ctx.globalAlpha = Math.max(0, 1 - e.t)
          ctx.fillStyle = color
          ctx.font = `${big ? 'bold 15px' : '11px'} ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.lineWidth = 3
          ctx.strokeStyle = 'rgba(0,0,0,0.65)'
          const label = `${kind === 'heal' ? '+' : ''}${e.e.amount}`
          const ty = barY - 4 - e.t * (big ? 34 : 22)
          ctx.strokeText(label, x, ty)
          ctx.fillText(label, x, ty)
          ctx.globalAlpha = 1
        }
      }

      // 全滅時壓暗
      if (battle.over) {
        ctx.fillStyle = battle.result === 'win' ? 'rgba(20,60,30,0.45)' : 'rgba(60,15,15,0.5)'
        ctx.fillRect(-12, -8, BG_W + 24, BG_H + 16)
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    // 同 PixelOffice：分頁沒顯示時 rAF 會停，開發時靠這個手動畫一張來檢查。
    // production build 會整段被摺掉。
    if (import.meta.env.DEV) {
      ;(window as unknown as { __bs?: unknown }).__bs = () => { draw(); return 'drawn' }
    }
    return () => cancelAnimationFrame(raf)
  }, [battle, tick])

  return (
    <canvas
      ref={ref}
      className="block w-full rounded border border-zinc-800"
      style={{ imageRendering: 'pixelated', background: '#0d1220' }}
    />
  )
}
