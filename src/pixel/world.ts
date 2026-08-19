// 世界模擬：尋路 + 角色行為狀態機
//
// 三大類行為（對映真實工具狀態）：
//   工作中  active        → 瘋狂打電腦；偶爾去找同事吵架（辯論模式）
//   偷懶    idle          → 上廁所 / 看書 / 走來走去 / 泡咖啡 / 種花
//   睡覺    rate_limited  → 走去沙發躺下，對話框寫明休息到幾點
//   派工中  有 alive 派工  → 走到白板前執行任務（tool calling）
//   外出    unknown       → 灰階待在門邊

import {
  BOARD_SPOT, COFFEE_SPOT, DESKS, MEETING_SEATS, PLANT_SPOTS, READ_SPOT,
  SOFA_SPOTS, TOILET_SPOT, WANDER_SPOTS, type Dir, type Spot, walkable,
} from './room'
import { AGENT_KEYS, F, SKINS } from './sprites'
import { COLS, ROWS, TILE, mulberry32 } from './theme'

export type Mode = 'working' | 'idle' | 'resting' | 'tool' | 'meeting' | 'away'
export type ActKind =
  | 'desk' | 'debate' | 'toilet' | 'read' | 'pace' | 'coffee' | 'water'
  | 'sleep' | 'board' | 'meet' | 'idlestand'

export interface AgentInput {
  status: string          // active / idle / rate_limited / unknown
  resetAt?: string        // 額度恢復時間（顯示用文字，例如 "08/20 11:28"）
  task?: string           // 目前 alive 的派工任務文字
}

interface Act {
  kind: ActKind
  target: Spot | null
  until: number           // 秒（世界時間）
  partner?: string
}

export interface Agent {
  key: string
  x: number; y: number    // 像素座標（腳底中心）
  dir: Dir
  mode: Mode
  act: Act
  path: { x: number; y: number }[]
  bubble: { text: string; until: number } | null
  hidden: boolean         // 上廁所時人在門後
  deskIndex: number
  seatSpot: Spot
  phase: number           // 動畫相位，讓每隻不同步
  resetAt?: string
  task?: string
}

// ── 尋路（BFS，格子很少，夠用且穩定）──────────────
const NEI = [[0, 1], [0, -1], [1, 0], [-1, 0]]

export function findPath(sx: number, sy: number, tx: number, ty: number) {
  if (sx === tx && sy === ty) return []
  const prev = new Int32Array(COLS * ROWS).fill(-1)
  const seen = new Uint8Array(COLS * ROWS)
  const q = [sy * COLS + sx]
  seen[sy * COLS + sx] = 1
  const goal = ty * COLS + tx
  let head = 0
  while (head < q.length) {
    const cur = q[head++]
    if (cur === goal) break
    const cx = cur % COLS, cy = (cur / COLS) | 0
    for (const [dx, dy] of NEI) {
      const nx = cx + dx, ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue
      const ni = ny * COLS + nx
      if (seen[ni]) continue
      // 目的地允許是家具格（例如坐到沙發上），其餘一律要能走
      if (!walkable(nx, ny) && ni !== goal) continue
      seen[ni] = 1
      prev[ni] = cur
      q.push(ni)
    }
  }
  if (!seen[goal]) return []
  const out: { x: number; y: number }[] = []
  for (let cur = goal; cur !== -1 && cur !== sy * COLS + sx; cur = prev[cur]) {
    out.push({ x: cur % COLS, y: (cur / COLS) | 0 })
    if (prev[cur] === -1) break
  }
  return out.reverse()
}

// ── 對白 ───────────────────────────────────────────
const DEBATE_LINES = [
  '這個要先跑稽核！', '不對，先派工才對', '你那個會撞限流',
  '我覺得要重寫', '先看 log 再說', '這條路我昨天試過了',
  '成本你算過嗎？', '地端跑就好啦', '不要再開新分支了',
]
const IDLE_LINES: Record<string, string[]> = {
  coffee: ['再一杯就好', '這杯是今天第四杯', '咖啡…續命'],
  read: ['原來可以這樣寫', '看個文件先', '這段我沒讀過'],
  water: ['你也要喝水喔', '長大一點', '今天也很綠'],
  toilet: ['去去就回', '失陪一下'],
  pace: ['嗯…', '想一下', '走走比較有靈感'],
}
const WORK_LINES = ['跑起來了', '編譯中…', '這批我扛', '再五分鐘', '寫完這段']

// ── 世界 ───────────────────────────────────────────
export class World {
  agents: Agent[] = []
  time = 0
  private rand = mulberry32(20260819)
  private meetingUntil = 0
  private nextMeetingCheck = 45
  private lastInputs: Record<string, AgentInput> = {}

  constructor() {
    AGENT_KEYS.forEach((key, i) => {
      const desk = DESKS[i % DESKS.length]
      this.agents.push({
        key,
        x: desk.seat.x * TILE + TILE / 2,
        y: desk.seat.y * TILE + TILE - 2,
        dir: 'up',
        mode: 'idle',
        act: { kind: 'idlestand', target: null, until: 0 },
        path: [],
        bubble: null,
        hidden: false,
        deskIndex: i % DESKS.length,
        seatSpot: desk.seat,
        phase: this.rand() * 10,
      })
    })
  }

  private pick<T>(arr: T[]): T { return arr[Math.floor(this.rand() * arr.length)] }

  /** 挑一個沒人在澆的花盆；都被佔了就隨便挑一盆 */
  private pickPlant(self: Agent): Spot {
    const free = PLANT_SPOTS.filter((sp) => !this.agents.some(
      (o) => o !== self && o.act.kind === 'water' && o.act.target?.x === sp.x,
    ))
    return this.pick(free.length ? free : PLANT_SPOTS)
  }

  private static deriveMode(inp?: AgentInput): Mode {
    if (!inp) return 'away'
    if (inp.task) return 'tool'
    if (inp.status === 'rate_limited') return 'resting'
    if (inp.status === 'active') return 'working'
    if (inp.status === 'idle') return 'idle'
    return 'away'
  }

  /** 從真實工具狀態更新每隻角色的 mode */
  setInputs(inputs: Record<string, AgentInput>) {
    this.lastInputs = inputs
    for (const a of this.agents) {
      const inp = inputs[a.key]
      const prev = a.mode
      const mode = World.deriveMode(inp)
      a.resetAt = inp?.resetAt
      a.task = inp?.task
      if (a.mode === 'meeting' && mode === 'working' && this.time < this.meetingUntil) continue
      if (mode !== prev) {
        a.mode = mode
        a.act = { kind: 'idlestand', target: null, until: 0 }  // 立刻重新決策
        a.path = []
        a.hidden = false
      }
    }
  }

  private tileOf(a: Agent) {
    return { x: Math.floor(a.x / TILE), y: Math.floor((a.y - 1) / TILE) }
  }

  private goto(a: Agent, spot: Spot) {
    const t = this.tileOf(a)
    a.path = findPath(t.x, t.y, spot.x, spot.y)
  }

  private say(a: Agent, text: string, secs = 3.5) {
    a.bubble = { text, until: this.time + secs }
  }

  /** 挑一個新的微行為 */
  private chooseAct(a: Agent) {
    const t = this.time
    switch (a.mode) {
      case 'resting': {
        const spot = SOFA_SPOTS[this.agents.filter((o) => o.mode === 'resting').indexOf(a) % SOFA_SPOTS.length]
        a.act = { kind: 'sleep', target: spot, until: t + 9999 }
        break
      }
      case 'tool': {
        // 多人同時派工時錯開站位，才不會疊在一起
        const i = this.agents.filter((o) => o.mode === 'tool').indexOf(a)
        a.act = {
          kind: 'board',
          target: { ...BOARD_SPOT, x: BOARD_SPOT.x + (i % 3) - 1 },
          until: t + 9999,
        }
        break
      }
      case 'meeting': {
        const i = this.agents.filter((o) => o.mode === 'meeting').indexOf(a)
        a.act = { kind: 'meet', target: MEETING_SEATS[i % MEETING_SEATS.length], until: this.meetingUntil }
        break
      }
      case 'working': {
        // 八成在打電腦，兩成去找人吵架
        const others = this.agents.filter((o) => o !== a && o.mode === 'working' && !o.hidden)
        if (others.length && this.rand() < 0.22) {
          const p = this.pick(others)
          const pt = this.tileOf(p)
          // 精靈寬約 3 格，站位要拉開才不會疊在一起
          const side = pt.x > 21 ? -3 : 3
          const spot: Spot = { x: Math.max(1, Math.min(COLS - 2, pt.x + side)), y: pt.y, face: side > 0 ? 'left' : 'right' }
          a.act = { kind: 'debate', target: spot, until: t + 7 + this.rand() * 5, partner: p.key }
        } else {
          a.act = { kind: 'desk', target: a.seatSpot, until: t + 10 + this.rand() * 14 }
        }
        break
      }
      case 'idle': {
        // 廁所、閱讀椅、咖啡機都只有一個位子：別人佔著就換一件事做
        const taken = new Set(
          this.agents.filter((o) => o !== a).map((o) => o.act.kind),
        )
        const menu = (['toilet', 'read', 'coffee'] as ActKind[]).filter((k) => !taken.has(k))
        // 走來走去與種花可以多人同時做，權重也高一點
        const kind = this.pick<ActKind>([...menu, 'pace', 'water', 'pace'])
        const target =
          kind === 'toilet' ? TOILET_SPOT
          : kind === 'read' ? READ_SPOT
          : kind === 'coffee' ? COFFEE_SPOT
          : kind === 'water' ? this.pickPlant(a)
          : { ...this.pick(WANDER_SPOTS), face: 'down' as Dir }
        const dur = kind === 'pace' ? 2 + this.rand() * 3 : 8 + this.rand() * 8
        a.act = { kind, target, until: t + dur }
        break
      }
      default: {
        // 外出：在門口一帶散開站著，不要疊成一團
        const i = this.agents.filter((o) => o.mode === 'away').indexOf(a)
        a.act = { kind: 'idlestand', target: { x: 18 + i * 3, y: 22, face: 'down' }, until: t + 20 }
      }
    }
    if (a.act.target) this.goto(a, a.act.target)
  }

  /** 會議：三人以上在工作時，定期把大家叫到會議桌 */
  private updateMeeting() {
    if (this.time > this.meetingUntil && this.time > this.nextMeetingCheck) {
      const workers = this.agents.filter((a) => a.mode === 'working')
      if (workers.length >= 3) {
        this.meetingUntil = this.time + 32
        workers.slice(0, MEETING_SEATS.length).forEach((a) => {
          a.mode = 'meeting'
          a.act = { kind: 'idlestand', target: null, until: 0 }
          a.path = []
        })
        this.say(workers[0], '大家過來開個會', 5)
      }
      this.nextMeetingCheck = this.time + 75 + this.rand() * 60
    }
    if (this.time > this.meetingUntil) {
      // 散會後回到「真實狀態」，而不是一律當成工作中
      for (const a of this.agents) if (a.mode === 'meeting') {
        a.mode = World.deriveMode(this.lastInputs[a.key])
        a.act = { kind: 'idlestand', target: null, until: 0 }
        a.path = []
      }
    }
  }

  tick(dt: number) {
    this.time += dt
    this.updateMeeting()

    for (const a of this.agents) {
      if (a.bubble && this.time > a.bubble.until) a.bubble = null

      // 走路
      if (a.path.length) {
        a.hidden = false                       // 離開廁所就要重新看得見
        const next = a.path[0]
        const tx = next.x * TILE + TILE / 2
        const ty = next.y * TILE + TILE - 2
        const dx = tx - a.x, dy = ty - a.y
        const dist = Math.hypot(dx, dy)
        const speed = a.mode === 'resting' ? 26 : a.mode === 'tool' ? 46 : 36
        if (dist < speed * dt) {
          a.x = tx; a.y = ty
          a.path.shift()
        } else {
          a.x += (dx / dist) * speed * dt
          a.y += (dy / dist) * speed * dt
          a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
        }
        continue
      }

      // 抵達目的地
      if (a.act.target) {
        a.dir = a.act.target.face
        a.hidden = a.act.kind === 'toilet'
      }

      // 行為到期 → 重新決策
      if (this.time >= a.act.until) {
        this.chooseAct(a)
        // 到了才講話
        const lines = IDLE_LINES[a.act.kind]
        if (lines && this.rand() < 0.5) this.say(a, this.pick(lines))
        if (a.act.kind === 'debate') this.say(a, this.pick(DEBATE_LINES), 6)
        if (a.act.kind === 'desk' && this.rand() < 0.3) this.say(a, this.pick(WORK_LINES))
        continue
      }

      // 辯論：對手轉頭回嘴
      if (a.act.kind === 'debate' && a.act.partner) {
        const p = this.agents.find((o) => o.key === a.act.partner)
        if (p && !p.bubble && this.rand() < 0.02) this.say(p, this.pick(DEBATE_LINES), 5)
      }
      // 睡覺：對話框寫明休息到幾點
      if (a.act.kind === 'sleep' && !a.bubble && this.rand() < 0.02) {
        this.say(a, a.resetAt ? `休息到 ${a.resetAt}` : '額度用完了…', 6)
      }
      // 派工中：唸出任務
      if (a.act.kind === 'board' && !a.bubble && a.task && this.rand() < 0.02) {
        this.say(a, a.task.slice(0, 18), 6)
      }
    }
  }

  /**
   * 目前該畫哪一格 sprite。
   *
   * 走路一律用「站 → 踏」兩幀交替，**絕對不能靠水平鏡射湊第二隻腳**：
   * 這些龍是不對稱的（尾巴、識別證、連帽衫都偏一邊），鏡射等於把整隻左右翻面，
   * 看起來就是角色一直在轉向。stepPhase 同時回傳給渲染層，讓上下浮動跟步伐同步。
   */
  frameOf(a: Agent): { frame: number; flip: boolean; stepping: boolean } {
    const walking = a.path.length > 0
    const stepping = walking && Math.floor(this.time * 5 + a.phase * 3) % 2 === 1

    if (walking) {
      if (a.dir === 'left' || a.dir === 'right') {
        // 側面素材一律朝右（打包時已翻正），往左走才鏡射
        return { frame: stepping ? F.sideStep : F.sideStand, flip: a.dir === 'left', stepping }
      }
      if (a.dir === 'up') return { frame: stepping ? F.backStep : F.backStand, flip: false, stepping }
      return { frame: stepping ? F.frontStep : F.frontStand, flip: false, stepping }
    }

    switch (a.act.kind) {
      case 'sleep': return { frame: F.sleep, flip: false, stepping }
      // 打電腦：螢幕在桌子的遠端，所以角色要背對鏡頭才是「面向螢幕」。
      // 用正面的打字圖會變成背對螢幕在敲鍵盤。
      case 'desk': return { frame: F.backStand, flip: false, stepping }
      // 開會：坐在桌子近側的人面向桌子（背對鏡頭），遠側的人面向鏡頭
      case 'meet': return {
        frame: a.dir === 'up' ? F.backStand : F.sitType, flip: false, stepping,
      }
      case 'debate': return { frame: F.argue, flip: a.dir === 'left', stepping }
      case 'board': return { frame: F.argue, flip: false, stepping }
      case 'coffee': return { frame: F.coffee, flip: false, stepping }
      case 'read': return { frame: F.read, flip: false, stepping }
      case 'water': return { frame: F.water, flip: false, stepping }
      default:
        if (a.dir === 'up') return { frame: F.backStand, flip: false, stepping }
        if (a.dir === 'left') return { frame: F.sideStand, flip: true, stepping }
        if (a.dir === 'right') return { frame: F.sideStand, flip: false, stepping }
        return { frame: F.frontStand, flip: false, stepping }
    }
  }

  /** 點擊命中測試：回傳被點到的角色 key */
  pickAt(px: number, py: number): string | null {
    let best: string | null = null
    let bestD = 26
    for (const a of this.agents) {
      if (a.hidden) continue
      const d = Math.hypot(a.x - px, a.y - py - 14)
      if (d < bestD) { bestD = d; best = a.key }
    }
    return best
  }

  label(a: Agent) { return SKINS[a.key]?.name ?? a.key }
}
