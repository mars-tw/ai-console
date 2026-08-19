// 戰鬥的「手感」層：揮擊軌跡、命中火花、畫面震動、死亡溶解
//
// 這一層刻意跟戰鬥邏輯完全分離。引擎只丟出「誰、發生了什麼、第幾回合」，
// 這裡負責把它變成看得爽的東西。時間一律用牆鐘（秒），跟回合脫鉤，
// 所以戰鬥速度調快調慢，動畫都不會變成慢動作或快轉。

/** 一個特效活多久（秒）。死亡最長，因為要播完倒下再溶解。 */
export const FX_LIFE: Record<string, number> = {
  attack: 0.42,
  hurt: 0.9,
  crit: 1.1,
  heal: 1.0,
  die: 0.85,
  skill: 1.1,
}

/** 緩動：一開始快、結尾慢，砍下去才有重量 */
export const easeOut = (t: number) => 1 - (1 - t) * (1 - t)
/** 先衝出去再收回來 */
export const lunge = (t: number) => Math.sin(Math.min(1, Math.max(0, t)) * Math.PI)

/**
 * 命中頓幀：受擊後極短時間內把畫面「凍住」一下。
 * 這是 2D 動作遊戲打擊感最便宜也最有效的一招 —— 少了它，
 * 傷害數字再大都像在看試算表。
 */
export const HITSTOP = 0.06

/** 依受擊強度算畫面震動位移（像素） */
export function shake(age: number, power: number): [number, number] {
  const t = age / 0.22
  if (t >= 1) return [0, 0]
  const decay = (1 - t) ** 2
  // 用 age 當種子做偽亂數，同一幀重畫結果一致，不會抖成雜訊
  const a = Math.sin(age * 137.3) * 43758.5453
  const b = Math.sin(age * 91.7) * 24634.6345
  const amp = power * decay
  return [(a - Math.floor(a) - 0.5) * amp, (b - Math.floor(b) - 0.5) * amp * 0.6]
}

/**
 * 畫一道揮擊弧線。
 * dir = 1 由左往右砍（我方），-1 由右往左砍（敵方）。
 */
export function drawSlash(
  c: CanvasRenderingContext2D, x: number, y: number, t: number, dir: number, crit: boolean,
) {
  if (t >= 1) return
  const p = easeOut(t)
  const alpha = t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75
  const r = 26 + p * 12
  const a0 = (-0.85 + p * 1.5) * dir
  const a1 = a0 + 0.75 * dir

  c.save()
  c.translate(x + dir * 14, y - 22)
  c.globalAlpha = Math.max(0, alpha) * 0.9
  c.lineCap = 'round'
  // 外層粗弧＋內層細弧，做出刀光的厚度
  for (const [w, col] of [[7, crit ? '#fde68a' : '#e2e8f0'], [3, '#ffffff']] as const) {
    c.lineWidth = w
    c.strokeStyle = col
    c.beginPath()
    c.arc(0, 0, r, Math.min(a0, a1), Math.max(a0, a1))
    c.stroke()
  }
  c.restore()
}

/** 命中火花：從命中點往外炸的短線 */
export function drawSparks(
  c: CanvasRenderingContext2D, x: number, y: number, t: number, crit: boolean,
) {
  if (t >= 1) return
  const n = crit ? 10 : 6
  const reach = (crit ? 26 : 17) * easeOut(t)
  c.save()
  c.globalAlpha = Math.max(0, 1 - t)
  c.strokeStyle = crit ? '#fbbf24' : '#fca5a5'
  c.lineWidth = crit ? 2 : 1.5
  c.lineCap = 'round'
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (crit ? 0.3 : 0)
    const dx = Math.cos(a), dy = Math.sin(a) * 0.75
    c.beginPath()
    c.moveTo(x + dx * reach * 0.45, y + dy * reach * 0.45)
    c.lineTo(x + dx * reach, y + dy * reach)
    c.stroke()
  }
  c.restore()
}

/** 暴擊時在命中點閃一下的白光 */
export function drawCritFlash(c: CanvasRenderingContext2D, x: number, y: number, t: number) {
  if (t >= 0.35) return
  const p = t / 0.35
  c.save()
  c.globalAlpha = (1 - p) * 0.75
  const r = 10 + p * 34
  const g = c.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.5, 'rgba(253,224,71,0.55)')
  g.addColorStop(1, 'rgba(253,224,71,0)')
  c.fillStyle = g
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fill()
  c.restore()
}

/** 治療：往上飄的綠色光點 */
export function drawHealMotes(
  c: CanvasRenderingContext2D, x: number, y: number, t: number,
) {
  if (t >= 1) return
  c.save()
  c.globalAlpha = Math.max(0, 1 - t) * 0.9
  c.fillStyle = '#86efac'
  for (let i = 0; i < 5; i++) {
    const ph = (t + i * 0.19) % 1
    const dx = Math.sin((i * 2.1 + t * 4)) * 11
    c.fillRect(Math.round(x + dx - 1), Math.round(y - 8 - ph * 40), 2, 2)
  }
  c.restore()
}

/**
 * 死亡：先往後倒、再由下往上溶解。
 * 回傳這一幀要套的變形與裁切比例，讓呼叫端自己畫精靈。
 */
export function deathTransform(t: number): {
  alpha: number; tilt: number; sink: number; dissolve: number
} {
  const fall = Math.min(1, t / 0.35)          // 前段：倒下
  const fade = Math.max(0, (t - 0.3) / 0.7)   // 後段：溶解
  return {
    alpha: 1 - fade * 0.95,
    tilt: easeOut(fall) * 0.9,                // 弧度
    sink: easeOut(fall) * 6,
    dissolve: fade,
  }
}
