// ⚔️ 冒險分頁：邊工作邊玩的小型 MMORPG
//
// 沒有職業：近戰 / 遠程 / 魔法 / 信仰四條線自己混。
// 裝備、技能、屬性各存一套，隨時整組換掉。
// 戰鬥是 tick 制，所以切到別的分頁去工作時它也會自己打。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BattleScene from '@/components/BattleScene'
import { SKINS } from '@/pixel/sprites'
import { DUNGEONS, RARITY_ORDER, SKILLS_OF_LINE, SKILL_BY_ID, ZONES } from '@/rpg/data'
import {
  activeLoadout, allyCombatant, autoEquipBest, collect, computeStats, isUpgrade,
  itemById, itemScore, linePoints, skillUnlocked, startBattle, stepBattle,
  xpForLevel, type Battle,
} from '@/rpg/engine'
import { loadHero, resetHero, saveHero } from '@/rpg/save'
import {
  AFFIX_NAME, AFFIX_PCT, ATTRS, ATTR_NAME, LINES, LINE_NAME, RARITY_COLOR,
  RARITY_NAME, SLOTS, SLOT_NAME, type Combatant, type Hero, type Item,
  type Line, type Rarity, type Slot,
} from '@/rpg/types'
import type { ToolStatus } from '@/types/data'

const TICK_MS = 1400

const LINE_COLOR: Record<Line, string> = {
  melee: '#f87171', ranged: '#4ade80', magic: '#60a5fa', faith: '#fbbf24',
}
/** 每隻龍擅長的技能線 */
const ALLY_LINE: Record<string, Line> = {
  kimi: 'faith', claude: 'melee', codex: 'faith',
  grok: 'magic', qwen: 'magic', cursor: 'ranged', gemini: 'ranged',
}

/**
 * 隨行 AI 夥伴名單。
 *
 * 這是「單機模式」的關鍵：夥伴是遊戲內建的 AI 機器人，永遠揪得到，
 * 不依賴 ai-hub、不依賴任何外部服務 —— clone 下來就能玩，地城也進得去。
 * 如果剛好接得到本機工具狀態，那只是額外的風味標籤與小幅加成，絕不擋人。
 */
const COMPANIONS = Object.keys(SKINS).map((key) => ({
  key,
  name: SKINS[key].name,
  color: SKINS[key].color,
  line: ALLY_LINE[key] ?? 'melee',
}))

function Bar({ v, max, color, h = 6 }: { v: number; max: number; color: string; h?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0
  return (
    <div className="w-full overflow-hidden rounded-sm bg-zinc-950" style={{ height: h }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width .25s' }} />
    </div>
  )
}

/**
 * 依部位與技能線挑一張道具圖示。
 * 名稱是隨機組出來的（「秘銀長弓」），所以先看武器名詞，
 * 對不上就退回該部位的通用圖示。
 */
const NOUN_ICON: [string, string][] = [
  ['短劍', 'sword'], ['巨劍', 'sword'], ['闊斧', 'axe'], ['長槍', 'spear'], ['戰鎚', 'hammer'],
  ['短弓', 'bow'], ['長弓', 'bow'], ['十字弓', 'crossbow'], ['飛刀', 'dagger'], ['獵槍', 'crossbow'],
  ['木杖', 'staff'], ['法杖', 'staff'], ['權杖', 'staff'], ['魔導書', 'tome'], ['水晶球', 'orb'],
  ['聖徽', 'holy'], ['祈禱書', 'tome'], ['聖錘', 'hammer'], ['聖印', 'holy'], ['神諭杖', 'staff'],
  ['長袍', 'robe'], ['皮甲', 'armor'], ['鎖子甲', 'armor'], ['胸甲', 'armor'],
  ['皮帽', 'helm'], ['鐵盔', 'helm'], ['兜帽', 'helm'], ['冠冕', 'helm'],
  ['圓盾', 'shield'], ['塔盾', 'shield'], ['副刃', 'sword'], ['護符', 'ring'],
  ['皮靴', 'boots'], ['戰靴', 'boots'], ['軟鞋', 'boots'], ['脛甲', 'boots'],
  ['皮手套', 'gloves'], ['護腕', 'gloves'], ['指套', 'gloves'], ['重手甲', 'gloves'],
  ['素戒', 'ring'], ['寶石戒', 'ring'], ['徽章', 'ring'],
]
const SLOT_ICON: Record<Slot, string> = {
  main: 'sword', off: 'shield', head: 'helm', body: 'armor',
  hands: 'gloves', feet: 'boots', ring1: 'ring', ring2: 'ring',
}
function iconFor(it: Item): string {
  const hit = NOUN_ICON.find(([n]) => it.name.includes(n))
  return `icon-${hit ? hit[1] : SLOT_ICON[it.slot]}`
}

function ItemIcon({ it, size = 22 }: { it: Item; size?: number }) {
  return (
    <span
      className="inline-block flex-none rounded-sm"
      style={{
        width: size, height: size,
        backgroundImage: `url(/office/rpg/icons/${iconFor(it)}.png)`,
        backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center',
        imageRendering: 'pixelated',
        boxShadow: `inset 0 0 0 1px ${RARITY_COLOR[it.rarity]}55`,
      }}
    />
  )
}

function ItemLine({ it, dim }: { it: Item; dim?: boolean }) {
  return (
    <div className={dim ? 'opacity-60' : ''}>
      <span style={{ color: RARITY_COLOR[it.rarity] }}>{it.name}</span>
      <span className="ml-1 text-zinc-500">
        ({RARITY_NAME[it.rarity]} · iLv{it.ilvl}
        {it.atk ? ` · 攻${it.atk}` : ''}{it.def ? ` · 防${it.def}` : ''})
      </span>
      {it.affixes.length > 0 && (
        <span className="ml-1 text-emerald-400/80">
          {it.affixes.map((a) => `${AFFIX_NAME[a.key]}+${AFFIX_PCT.includes(a.key) ? `${(a.value * 100).toFixed(1)}%` : a.value}`).join(' ')}
        </span>
      )}
    </div>
  )
}

interface Props {
  tools: Record<string, ToolStatus>
}

export default function Adventure({ tools }: Props) {
  const [hero, setHero] = useState<Hero>(() => loadHero())
  const [battle, setBattle] = useState<Battle | null>(null)
  const [auto, setAuto] = useState(true)
  const [party, setParty] = useState<string[]>([])
  const [tab, setTab] = useState<'skills' | 'gear' | 'bag'>('skills')
  // 背包篩選
  const [fSlot, setFSlot] = useState<Slot | 'all'>('all')
  const [fRarity, setFRarity] = useState<Rarity | 'all'>('all')
  const [fUpgrade, setFUpgrade] = useState(false)
  const [fSort, setFSort] = useState<'score' | 'ilvl' | 'rarity'>('score')
  const [notice, setNotice] = useState('')
  const heroRef = useRef(hero)
  const battleRef = useRef(battle)
  /** 手動模式排隊的技能：放在 ref，不去改動 state 物件 */
  const queuedRef = useRef<string | null>(null)
  // ref 只在 effect 裡更新，不在 render 期間寫
  useEffect(() => { heroRef.current = hero }, [hero])
  useEffect(() => { battleRef.current = battle }, [battle])

  const stats = useMemo(() => computeStats(hero), [hero])
  const lo = activeLoadout(hero)

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(''), 3500) }
  const update = useCallback((fn: (h: Hero) => void) => {
    setHero((prev) => {
      const next: Hero = JSON.parse(JSON.stringify(prev))
      fn(next)
      saveHero(next)
      return next
    })
  }, [])

  /**
   * 夥伴的風味狀態。單機模式下一律揪得到（ok 恆為 true），
   * 接得到本機工具狀態時只是換個說法，順便給精神飽滿的夥伴一點加成。
   */
  const allyState = (key: string) => {
    switch (tools[key]?.status) {
      case 'idle': return { why: '精神飽滿', bonus: 1.15 }
      case 'active': return { why: '邊工作邊陪你', bonus: 1 }
      case 'rate_limited': return { why: '睡眼惺忪', bonus: 0.85 }
      default: return { why: '待命中', bonus: 1 }
    }
  }

  // ── 戰鬥 tick ──
  useEffect(() => {
    const t = setInterval(() => {
      const b = battleRef.current
      const h = heroRef.current
      if (!b || b.over) return
      if (queuedRef.current) { b.queued = queuedRef.current; queuedRef.current = null }
      stepBattle(b, h)
      // 每回合把獎勵收進角色，這樣掛著離開也不會白打
      if (b.xp || b.gold || b.loot.length) {
        const gained = collect(h, b)
        if (gained.levels > 0) flash(`升到 Lv.${h.level}！獲得技能點與屬性點`)
        saveHero(h)
        setHero({ ...h })
      }
      setBattle({ ...b })
    }, TICK_MS)
    return () => clearInterval(t)
  }, [])

  const enterZone = (id: string) => {
    setBattle(startBattle(hero, 'field', id, buildParty()))
    update((h) => { h.zone = id })
  }

  const buildParty = (members: string[] = party): Combatant[] =>
    members.map((k) => {
      const lv = Math.max(1, Math.round((hero.level - 1 + Math.random() * 3) * allyState(k).bonus))
      return allyCombatant(k, SKINS[k]?.name ?? k, SKINS[k]?.color ?? '#888', lv, ALLY_LINE[k] ?? 'melee')
    })

  /** 自動組隊：把隊伍補到指定人數（含自己），單機也進得去地城 */
  const autoParty = (need: number): string[] => {
    const picked = [...party]
    for (const c of COMPANIONS) {
      if (picked.length + 1 >= need) break
      if (!picked.includes(c.key)) picked.push(c.key)
    }
    return picked
  }

  const enterDungeon = (id: string) => {
    const dg = DUNGEONS.find((d) => d.id === id)!
    if (hero.level < dg.minLevel) return flash(`等級不足，${dg.name} 需要 Lv.${dg.minLevel}`)
    // 人不夠不擋你，直接叫 AI 夥伴補位
    const members = party.length + 1 < dg.partySize ? autoParty(dg.partySize) : party
    if (members.length !== party.length) {
      setParty(members)
      const added = members.filter((k) => !party.includes(k)).map((k) => SKINS[k].name).join('、')
      flash(`人手不夠，${added} 自動加入隊伍`)
    }
    setBattle(startBattle(hero, 'dungeon', id, buildParty(members)))
  }

  const castSkill = (id: string) => {
    if (!battle || battle.over) return
    queuedRef.current = id
  }

  // ── 配點 ──
  const addAttr = (a: typeof ATTRS[number]) => update((h) => {
    if (h.attrPoints <= 0) return
    h.attrPoints--
    h.loadouts[h.active].attrs[a] = (h.loadouts[h.active].attrs[a] ?? 0) + 1
  })
  const addSkill = (id: string) => update((h) => {
    const l = h.loadouts[h.active]
    const sk = SKILL_BY_ID[id]
    if (h.skillPoints <= 0 || !sk) return
    if ((l.skills[id] ?? 0) >= sk.maxLv) return
    if (linePoints(l, sk.line) < sk.req) return
    h.skillPoints--
    l.skills[id] = (l.skills[id] ?? 0) + 1
  })
  const equip = (it: Item) => update((h) => { h.loadouts[h.active].equipped[it.slot] = it.id })
  const unequip = (s: Slot) => update((h) => { delete h.loadouts[h.active].equipped[s] })
  const sell = (it: Item) => update((h) => {
    h.bag = h.bag.filter((x) => x.id !== it.id)
    for (const l of h.loadouts) for (const s of SLOTS) if (l.equipped[s] === it.id) delete l.equipped[s]
    h.gold += Math.max(1, Math.round(itemScore(it) / 4))
  })

  /** 一鍵擇優：每個部位換上分數最高的 */
  const equipBest = () => update((h) => {
    const changed = autoEquipBest(h)
    setTimeout(() => flash(changed.length
      ? `已換上 ${changed.length} 件：${changed.map((c) => `${SLOT_NAME[c.slot]}→${c.to}`).join('、')}`
      : '目前已經是最佳配置'), 0)
  })

  /** 賣掉所有「不是最佳、也沒裝著」的裝備，換錢清背包 */
  const sellJunk = () => update((h) => {
    const keep = new Set<string>()
    for (const l of h.loadouts) for (const s of SLOTS) if (l.equipped[s]) keep.add(l.equipped[s]!)
    // 每個部位保留分數最高的三件當備用
    for (const s of SLOTS) {
      h.bag.filter((i) => i.slot === s).sort((a, b) => itemScore(b) - itemScore(a))
        .slice(0, 3).forEach((i) => keep.add(i.id))
    }
    const sold = h.bag.filter((i) => !keep.has(i.id))
    h.gold += sold.reduce((n, i) => n + Math.max(1, Math.round(itemScore(i) / 4)), 0)
    h.bag = h.bag.filter((i) => keep.has(i.id))
    setTimeout(() => flash(sold.length ? `賣掉 ${sold.length} 件雜物` : '沒有可賣的雜物'), 0)
  })

  /** 套用篩選與排序後的背包內容 */
  const bagView = useMemo(() => {
    const rank: Record<string, number> = { score: 0, ilvl: 1, rarity: 2 }
    void rank
    return hero.bag
      .filter((it) => fSlot === 'all' || it.slot === fSlot)
      .filter((it) => fRarity === 'all' || it.rarity === fRarity)
      .filter((it) => !fUpgrade || isUpgrade(hero, it))
      .sort((a, b) => fSort === 'ilvl' ? b.ilvl - a.ilvl
        : fSort === 'rarity' ? RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity)
        : itemScore(b) - itemScore(a))
  }, [hero, fSlot, fRarity, fUpgrade, fSort])

  const xpNeed = xpForLevel(hero.level)
  const allSides: Combatant[] = battle ? [battle.hero, ...battle.allies] : []

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-zinc-950 p-3 text-zinc-200">
      {notice && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-200">{notice}</div>
      )}

      <div className="flex flex-wrap gap-3">
        {/* ── 角色 ── */}
        <div className="min-w-64 flex-1 rounded border border-zinc-800 bg-zinc-900 p-3">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-sm font-bold">{hero.name}</span>
            <span className="text-xs text-zinc-400">Lv.{hero.level}</span>
            <span className="ml-auto text-xs text-amber-300">🪙 {hero.gold}</span>
          </div>
          <div className="mb-1 text-[10px] text-zinc-500">經驗 {hero.xp} / {xpNeed}</div>
          <Bar v={hero.xp} max={xpNeed} color="#a78bfa" />
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-zinc-400">
            <div>生命 <span className="text-zinc-200">{stats.hpMax}</span></div>
            <div>魔力 <span className="text-zinc-200">{stats.mpMax}</span></div>
            <div>攻擊 <span className="text-zinc-200">{stats.atk}</span></div>
            <div>防禦 <span className="text-zinc-200">{stats.def}</span></div>
            <div>暴擊 <span className="text-zinc-200">{(stats.crit * 100).toFixed(1)}%</span></div>
            <div>急速 <span className="text-zinc-200">{(stats.haste * 100).toFixed(1)}%</span></div>
          </div>
          <div className="mt-2 border-t border-zinc-800 pt-2">
            <div className="mb-1 text-[10px] text-zinc-500">屬性點：{hero.attrPoints}</div>
            <div className="flex flex-wrap gap-1.5">
              {ATTRS.map((a) => (
                <button
                  key={a}
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs hover:bg-zinc-800 disabled:opacity-40"
                  disabled={hero.attrPoints <= 0}
                  onClick={() => addAttr(a)}
                >
                  {ATTR_NAME[a]} {stats.attrs[a]} <span className="text-emerald-400">+</span>
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 border-t border-zinc-800 pt-2">
            <div className="mb-1 text-[10px] text-zinc-500">套裝（裝備 + 技能 + 屬性整組切換）</div>
            <div className="flex gap-1.5">
              {hero.loadouts.map((l, i) => (
                <button
                  key={i}
                  className={`flex-1 rounded px-2 py-1 text-xs ${i === hero.active ? 'bg-zinc-100 text-zinc-900' : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}
                  onClick={() => update((h) => { h.active = i })}
                >
                  {l.name}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-600">
            <span>擊殺 {hero.kills} · 陣亡 {hero.deaths}</span>
            <button className="hover:text-zinc-300" onClick={() => { if (confirm('重置角色與存檔？')) { setHero(resetHero()); setBattle(null) } }}>重置</button>
          </div>
        </div>

        {/* ── 戰鬥 ── */}
        <div className="min-w-80 flex-[2] rounded border border-zinc-800 bg-zinc-900 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium tracking-widest text-zinc-400">⚔️ 戰鬥</span>
            <button
              className={`rounded px-2 py-0.5 text-xs ${auto ? 'bg-emerald-600 text-white' : 'border border-zinc-700 text-zinc-400'}`}
              onClick={() => setAuto((v) => !v)}
            >
              {auto ? '沉浸自動' : '手動操作'}
            </button>
            {battle && !battle.over && (
              <button className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800" onClick={() => setBattle(null)}>
                撤退
              </button>
            )}
            {battle && (
              <span className="ml-auto text-[10px] text-zinc-500">
                {battle.kind === 'dungeon' ? `第 ${battle.room}/${battle.rooms} 間` : '野外'} · 回合 {battle.tick}
              </span>
            )}
          </div>

          {!battle && (
            <div className="py-6 text-center text-xs text-zinc-500">選一個地方出發，或先去配點與換裝</div>
          )}

          {battle && (
            <>
              <div className="mb-2">
                <BattleScene battle={battle} tick={battle.tick} />
              </div>
              {/* 我方數值細節：畫面上只有血條，魔力與名字放這裡 */}
              <div className="mb-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
                {allSides.map((c) => (
                  <span key={c.uid} className="flex items-center gap-1">
                    <span style={{ color: c.color }}>{c.name}</span>
                    <span className="text-zinc-500">{c.hp}/{c.hpMax}</span>
                    {c.mpMax > 0 && <span className="text-sky-400/80">MP {c.mp}</span>}
                  </span>
                ))}
              </div>
              {!auto && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {battle.hero.skills.map((id) => {
                    const sk = SKILL_BY_ID[id]
                    const cd = battle.hero.cds[id] ?? 0
                    return (
                      <button
                        key={id}
                        title={sk?.desc}
                        className="rounded border px-2 py-1 text-xs disabled:opacity-40"
                        style={{ borderColor: LINE_COLOR[sk.line] }}
                        disabled={cd > 0 || sk.mpCost > battle.hero.mp || battle.over}
                        onClick={() => castSkill(id)}
                      >
                        {sk?.name}{cd > 0 ? `（${cd}）` : ''}
                      </button>
                    )
                  })}
                </div>
              )}

              <div className="max-h-40 overflow-y-auto rounded bg-zinc-950 p-2 font-mono text-[11px] leading-5">
                {[...battle.log].reverse().map((l, i) => (
                  <div key={i} className={
                    l.kind === 'crit' ? 'text-amber-300'
                      : l.kind === 'loot' ? 'text-emerald-400'
                      : l.kind === 'heal' ? 'text-sky-300'
                      : l.kind === 'death' ? 'text-red-400'
                      : l.kind === 'info' ? 'text-zinc-400'
                      : 'text-zinc-300'
                  }>{l.text}</div>
                ))}
              </div>
              {battle.over && (
                <div className="mt-2 text-center text-xs text-zinc-400">
                  {battle.result === 'win' ? '🏆 通關！' : '💀 全滅'}
                  <button className="ml-2 rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800" onClick={() => setBattle(null)}>返回</button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── 隊伍 ── */}
        <div className="min-w-56 flex-1 rounded border border-zinc-800 bg-zinc-900 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium tracking-widest text-zinc-400">🤝 AI 夥伴</span>
            <button
              className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
              onClick={() => setParty(autoParty(4))}
            >
              自動組隊
            </button>
            {party.length > 0 && (
              <button className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800" onClick={() => setParty([])}>
                解散
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1">
            {COMPANIONS.map((c) => {
              const st = allyState(c.key)
              const joined = party.includes(c.key)
              return (
                <button
                  key={c.key}
                  className={`flex items-center gap-2 rounded border px-2 py-1 text-left text-xs ${joined ? 'border-emerald-600 bg-emerald-950/40' : 'border-zinc-800 hover:bg-zinc-800'}`}
                  onClick={() => setParty((p) => (joined ? p.filter((x) => x !== c.key) : [...p, c.key]))}
                >
                  <span className="h-2 w-2 flex-none rounded-full" style={{ background: c.color }} />
                  <span className="flex-none font-medium">{c.name}</span>
                  <span className="flex-none text-[10px]" style={{ color: LINE_COLOR[c.line] }}>{LINE_NAME[c.line]}</span>
                  <span className="ml-auto truncate text-[10px] text-zinc-500">{joined ? '已入隊' : st.why}</span>
                </button>
              )
            })}
          </div>
          <div className="mt-2 text-[10px] text-zinc-600">隊伍 {party.length + 1} 人（含你）</div>
        </div>
      </div>

      {/* ── 出發地點 ── */}
      <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
        <div className="mb-2 text-xs font-medium tracking-widest text-zinc-400">🗺️ 出發</div>
        <div className="flex flex-wrap gap-2">
          {ZONES.map((z) => (
            <button
              key={z.id}
              title={z.desc}
              className="rounded border border-zinc-700 px-2.5 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40"
              disabled={hero.level < z.minLevel}
              onClick={() => enterZone(z.id)}
            >
              {z.name} <span className="text-zinc-500">Lv.{z.minLevel}+</span>
            </button>
          ))}
          <span className="mx-1 w-px bg-zinc-700" />
          {DUNGEONS.map((d) => (
            <button
              key={d.id}
              title={`${d.desc}（需要 ${d.partySize} 人）`}
              className="rounded border border-amber-700/60 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-950/40 disabled:opacity-40"
              onClick={() => enterDungeon(d.id)}
            >
              🏰 {d.name} <span className="text-amber-500/70">Lv.{d.minLevel}+ · {d.partySize}人</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── 技能 / 裝備 / 背包 ── */}
      <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
        <div className="mb-2 flex gap-2">
          {([['skills', `技能（${hero.skillPoints} 點）`], ['gear', '裝備'], ['bag', `背包（${hero.bag.length}）`]] as const).map(([k, label]) => (
            <button
              key={k}
              className={`rounded px-2.5 py-1 text-xs ${tab === k ? 'bg-zinc-100 text-zinc-900' : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}
              onClick={() => setTab(k)}
            >{label}</button>
          ))}
        </div>

        {tab === 'skills' && (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {LINES.map((line) => (
              <div key={line}>
                <div className="mb-1 text-xs font-bold" style={{ color: LINE_COLOR[line] }}>
                  {LINE_NAME[line]} <span className="text-zinc-500">已投 {linePoints(lo, line)} 點</span>
                </div>
                <div className="flex flex-col gap-1">
                  {SKILLS_OF_LINE(line).map((sk) => {
                    const lv = lo.skills[sk.id] ?? 0
                    const open = skillUnlocked(lo, sk.id)
                    return (
                      <button
                        key={sk.id}
                        title={`${sk.desc}${open ? '' : `（需要 ${LINE_NAME[line]} 投入 ${sk.req} 點）`}`}
                        className="flex items-center gap-1.5 rounded border border-zinc-800 px-2 py-1 text-left text-xs hover:bg-zinc-800 disabled:opacity-40"
                        disabled={!open || hero.skillPoints <= 0 || lv >= sk.maxLv}
                        onClick={() => addSkill(sk.id)}
                      >
                        <span className={open ? '' : 'text-zinc-600'}>{sk.name}</span>
                        <span className="ml-auto text-zinc-500">{lv}/{sk.maxLv}</span>
                        {open && hero.skillPoints > 0 && lv < sk.maxLv && <span className="text-emerald-400">+</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'gear' && (
          <div className="grid gap-1.5 md:grid-cols-2">
            {SLOTS.map((s) => {
              const it = itemById(hero, lo.equipped[s])
              return (
                <div key={s} className="flex items-center gap-2 rounded border border-zinc-800 px-2 py-1 text-xs">
                  {it ? <ItemIcon it={it} /> : <span className="inline-block h-[22px] w-[22px] flex-none rounded-sm bg-zinc-950" />}
                  <span className="w-12 flex-none text-zinc-500">{SLOT_NAME[s]}</span>
                  <div className="min-w-0 flex-1 truncate">
                    {it ? <ItemLine it={it} /> : <span className="text-zinc-600">（空）</span>}
                  </div>
                  {it && <button className="flex-none text-zinc-500 hover:text-zinc-200" onClick={() => unequip(s)}>卸下</button>}
                </div>
              )
            })}
          </div>
        )}

        {tab === 'bag' && (
          <>
            {/* 篩選列 */}
            <div className="mb-2 flex flex-wrap items-center gap-2 border-b border-zinc-800 pb-2 text-xs">
              <select
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5"
                value={fSlot} onChange={(e) => setFSlot(e.target.value as Slot | 'all')}
              >
                <option value="all">全部部位</option>
                {SLOTS.map((s2) => <option key={s2} value={s2}>{SLOT_NAME[s2]}</option>)}
              </select>
              <select
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5"
                value={fRarity} onChange={(e) => setFRarity(e.target.value as Rarity | 'all')}
              >
                <option value="all">全部品質</option>
                {RARITY_ORDER.map((r) => <option key={r} value={r}>{RARITY_NAME[r]}</option>)}
              </select>
              <select
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5"
                value={fSort} onChange={(e) => setFSort(e.target.value as 'score' | 'ilvl' | 'rarity')}
              >
                <option value="score">依分數</option>
                <option value="ilvl">依等級</option>
                <option value="rarity">依品質</option>
              </select>
              <label className="flex items-center gap-1 text-zinc-400">
                <input type="checkbox" checked={fUpgrade} onChange={(e) => setFUpgrade(e.target.checked)} />
                只看可升級
              </label>
              <span className="text-zinc-600">{bagView.length} / {hero.bag.length}</span>
              <button
                className="ml-auto rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600"
                onClick={equipBest}
              >
                ⚡ 一鍵擇優裝備
              </button>
              <button
                className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:bg-zinc-800"
                title="每個部位保留最好的三件與裝備中的，其餘賣掉"
                onClick={sellJunk}
              >
                🧹 清雜物
              </button>
            </div>

            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {hero.bag.length === 0 && <div className="text-xs text-zinc-500">背包空空的，去打點怪吧</div>}
              {hero.bag.length > 0 && bagView.length === 0 && (
                <div className="text-xs text-zinc-500">沒有符合篩選條件的裝備</div>
              )}
              {bagView.map((it) => {
                const equipped = Object.values(lo.equipped).includes(it.id)
                const better = !equipped && isUpgrade(hero, it)
                return (
                  <div key={it.id} className="flex items-center gap-2 rounded border border-zinc-800 px-2 py-1 text-xs">
                    <ItemIcon it={it} />
                    <span className="w-12 flex-none text-zinc-500">{SLOT_NAME[it.slot]}</span>
                    <div className="min-w-0 flex-1 truncate"><ItemLine it={it} dim={equipped} /></div>
                    {better && <span className="flex-none text-emerald-400" title="比目前裝著的好">▲</span>}
                    <span className="flex-none text-zinc-600">{itemScore(it)}</span>
                    {!equipped && <button className="flex-none text-emerald-400 hover:text-emerald-300" onClick={() => equip(it)}>裝備</button>}
                    {!equipped && <button className="flex-none text-zinc-500 hover:text-red-400" onClick={() => sell(it)}>賣</button>}
                    {equipped && <span className="flex-none text-zinc-600">使用中</span>}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
