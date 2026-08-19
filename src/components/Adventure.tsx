// ⚔️ 冒險分頁：邊工作邊玩的小型 MMORPG
//
// 沒有職業：近戰 / 遠程 / 魔法 / 信仰四條線自己混。
// 裝備、技能、屬性各存一套，隨時整組換掉。
// 戰鬥是 tick 制，所以切到別的分頁去工作時它也會自己打。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BattleScene from '@/components/BattleScene'
import { SKINS } from '@/pixel/sprites'
import { itemLabel, t, useLang } from '@/i18n'
import { DUNGEONS, RARITY_ORDER, SKILLS_OF_LINE, SKILL_BY_ID, ZONES } from '@/rpg/data'
import {
  activeLoadout, allyCombatant, autoEquipBest, collect, computeStats, isUpgrade,
  itemById, itemScore, linePoints, skillUnlocked, startBattle, stepBattle,
  xpForLevel, type Battle,
} from '@/rpg/engine'
import { loadHero, resetHero, saveHero } from '@/rpg/save'
import { commitOrder, guard, setFocus, stepTurn, drinkPotion, petXpForLevel } from '@/rpg/engine'
import {
  AFFIX_NAME, AFFIX_PCT, ATTRS, ATTR_NAME, LINES, LINE_NAME, RARITY_COLOR,
  RARITY_NAME, SLOTS, SLOT_NAME, type Combatant, type Hero, type Item,
  type Line, type Rarity, type Slot,
} from '@/rpg/types'
import type { ToolStatus } from '@/types/data'

const TICK_MS = 1400        // 自動模式：一次心跳跑完一個回合
const ACTION_MS = 620       // 回合制：每個人出手之間的間隔，留時間播動畫

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
      <span style={{ color: RARITY_COLOR[it.rarity] }}>{itemLabel(it.name)}</span>
      <span className="ml-1 text-zinc-500">
        ({t(RARITY_NAME[it.rarity])} · iLv{it.ilvl}
        {it.atk ? ` · ${t('攻')}${it.atk}` : ''}{it.def ? ` · ${t('防')}${it.def}` : ''})
      </span>
      {it.affixes.length > 0 && (
        <span className="ml-1 text-emerald-400/80">
          {it.affixes.map((a) => `${t(AFFIX_NAME[a.key])}+${AFFIX_PCT.includes(a.key) ? `${(a.value * 100).toFixed(1)}%` : a.value}`).join(' ')}
        </span>
      )}
    </div>
  )
}

interface Props {
  tools: Record<string, ToolStatus>
}

/** 寵物小圖示：直接用打包好的寵物圖，縮到一行文字的高度 */
function PetIcon({ art }: { art: string }) {
  return (
    <img
      src={`/office/rpg/pets/${art}.png`}
      alt=""
      className="h-5 w-5 flex-none object-contain"
      style={{ imageRendering: 'pixelated' }}
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
    />
  )
}

export default function Adventure({ tools }: Props) {
  useLang()   // 語言一換就重繪
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
  // ref 只在 effect 裡更新，不在 render 期間寫
  const autoRef = useRef(auto)
  useEffect(() => { autoRef.current = auto }, [auto])
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
      case 'idle': return { why: t('精神飽滿'), bonus: 1.15 }
      case 'active': return { why: t('邊工作邊陪你'), bonus: 1 }
      case 'rate_limited': return { why: t('睡眼惺忪'), bonus: 0.85 }
      default: return { why: t('待命中'), bonus: 1 }
    }
  }

  /**
   * 戰鬥心跳。
   *
   * 兩種節奏共用同一顆計時器：
   *   自動模式 → 每次心跳跑完一整個回合（掛機用）
   *   手動模式 → 只在「結算中」才放出下一個行動；「等下令」時完全不動，
   *              停在那裡等你按技能。這就是回合制的手感。
   * 結算中的間隔刻意比較短，讓一個回合裡每個人出手看得清楚又不拖。
   */
  useEffect(() => {
    let timer = 0
    const beat = () => {
      const b = battleRef.current
      const h = heroRef.current
      if (!b || b.over) { timer = window.setTimeout(beat, TICK_MS); return }
      let gap = TICK_MS
      if (autoRef.current) {
        stepBattle(b, h)
      } else if (b.phase === 'resolve') {
        // 佇列空了卻還停在結算中 = 有東西沒收尾，直接把它推回等待下令，
        // 免得玩家卡在一個按不了任何鍵的畫面
        if (!b.queue.length) { b.phase = 'input' } else { stepTurn(b, h) }
        gap = ACTION_MS
      } else {
        timer = window.setTimeout(beat, 120)   // 等下令：只是輪詢，不推進戰鬥
        return
      }
      // 每回合把獎勵收進角色，這樣掛著離開也不會白打
      if (b.xp || b.gold || b.loot.length) {
        const gained = collect(h, b)
        if (gained.levels > 0) flash(t('升到 Lv.{lv}！獲得技能點與屬性點', { lv: h.level }))
        saveHero(h)
        setHero({ ...h })
      }
      const next = { ...b }
      battleRef.current = next        // 立刻同步，不等 React 的 effect
      setBattle(next)
      timer = window.setTimeout(beat, gap)
    }
    timer = window.setTimeout(beat, TICK_MS)
    return () => clearTimeout(timer)
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
    if (hero.level < dg.minLevel) return flash(t('等級不足，{name} 需要 Lv.{lv}', { name: t(dg.name), lv: dg.minLevel }))
    // 人不夠不擋你，直接叫 AI 夥伴補位
    const members = party.length + 1 < dg.partySize ? autoParty(dg.partySize) : party
    if (members.length !== party.length) {
      setParty(members)
      const added = members.filter((k) => !party.includes(k)).map((k) => SKINS[k].name).join('、')
      flash(t('人手不夠，{who} 自動加入隊伍', { who: added }))
    }
    setBattle(startBattle(hero, 'dungeon', id, buildParty(members)))
  }

  /**
   * 玩家的即時操作。全部走「立刻生效 + 立刻重繪」，
   * 排隊到下一回合的話按下去沒有回饋，會以為壞掉。
   */
  /**
   * 玩家操作一律作用在 battleRef.current 上，不是 state 裡的 battle。
   *
   * 心跳也是改 battleRef.current 再 setBattle({...}) 觸發重繪。兩邊如果
   * 各自拿自己那份複本去改，就會分岔 —— 實測踩過：玩家下令把階段設成
   * 「結算中」，心跳用舊複本蓋回去，戰鬥就永遠卡在結算中出不來。
   */
  const act = (fn: (b: Battle, h: Hero) => boolean | void) => {
    const b = battleRef.current
    const h = heroRef.current
    if (!b || b.over) return
    fn(b, h)
    const next = { ...b }
    battleRef.current = next
    setBattle(next)
    saveHero(h)
  }
  /** 下令：手動模式按技能就等於「這回合我用這招」，按下去整個回合開始結算 */
  const castSkill = (id: string | null) => act((b) => commitOrder(b, id, b.focus))
  const drink = (kind: 'hp' | 'mp') => act((b, h) => drinkPotion(b, h, kind))
  const doGuard = () => act((b) => guard(b))
  const focusOn = (uid: string) => act((b) => setFocus(b, uid))

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
      ? t('已換上 {n} 件：{list}', {
        n: changed.length,
        list: changed.map((c) => `${t(SLOT_NAME[c.slot])}→${itemLabel(c.to)}`).join('、'),
      })
      : t('目前已經是最佳配置')), 0)
  })

  /** 賣掉所有「不是最佳、也沒裝著」的裝備，換錢清背包 */
  /** 這次會被賣掉的東西（先算出來，才能在確認框裡講清楚） */
  const junkPreview = (h: Hero) => {
    const keep = new Set<string>()
    for (const l of h.loadouts) for (const s of SLOTS) if (l.equipped[s]) keep.add(l.equipped[s]!)
    // 每個部位保留分數最高的三件當備用
    for (const s of SLOTS) {
      h.bag.filter((i) => i.slot === s).sort((a, b) => itemScore(b) - itemScore(a))
        .slice(0, 3).forEach((i) => keep.add(i.id))
    }
    const sold = h.bag.filter((i) => !keep.has(i.id))
    return { keep, sold, gold: sold.reduce((n, i) => n + Math.max(1, Math.round(itemScore(i) / 4)), 0) }
  }

  /**
   * 清雜物。先確認再賣，理由有兩個：
   *   1. 遊戲裡沒有回收區，賣掉就真的沒了
   *   2. 它作用在**整個背包**，不是眼前篩選出來的那些 ——
   *      使用者在篩選視圖裡按下去，很容易以為只清掉看得到的東西
   */
  const sellJunk = () => {
    const { sold, gold } = junkPreview(hero)
    if (!sold.length) { flash(t('沒有可賣的雜物')); return }
    const sample = sold.slice(0, 3).map((i) => itemLabel(i.name)).join('、')
    if (!confirm(t('賣掉整個背包裡的 {n} 件雜物（例如 {sample}…），換 {gold} 金？賣掉就拿不回來了。',
      { n: sold.length, sample, gold }))) return
    update((h) => {
      const r = junkPreview(h)
      h.gold += r.gold
      h.bag = h.bag.filter((i) => r.keep.has(i.id))
      setTimeout(() => flash(t('賣掉 {n} 件雜物，得到 {gold} 金', { n: r.sold.length, gold: r.gold })), 0)
    })
  }

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
            <span className="text-sm font-bold">{t(hero.name)}</span>
            <span className="text-xs text-zinc-400">Lv.{hero.level}</span>
            <span className="ml-auto text-xs text-amber-300">🪙 {hero.gold}</span>
          </div>
          {/* 外觀只影響用哪組圖，不動任何數值，所以隨時可以換 */}
          <div className="mb-2 flex items-center gap-1 text-[10px]">
            <span className="text-zinc-500">{t('外觀')}</span>
            {([['hero', t('男')], ['heroine', t('女')]] as const).map(([look, label]) => (
              <button
                key={look}
                className={`rounded px-2 py-0.5 ${hero.look === look
                  ? 'bg-zinc-100 text-zinc-900' : 'border border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}
                onClick={() => update((h) => { h.look = look })}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mb-1 text-[10px] text-zinc-500">{t('經驗')} {hero.xp} / {xpNeed}</div>
          <Bar v={hero.xp} max={xpNeed} color="#a78bfa" />
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-zinc-400">
            <div>{t('生命')} <span className="text-zinc-200">{stats.hpMax}</span></div>
            <div>{t('魔力')} <span className="text-zinc-200">{stats.mpMax}</span></div>
            <div>{t('攻擊')} <span className="text-zinc-200">{stats.atk}</span></div>
            <div>{t('防禦')} <span className="text-zinc-200">{stats.def}</span></div>
            <div>{t('暴擊')} <span className="text-zinc-200">{(stats.crit * 100).toFixed(1)}%</span></div>
            <div>{t('急速')} <span className="text-zinc-200">{(stats.haste * 100).toFixed(1)}%</span></div>
          </div>
          <div className="mt-2 border-t border-zinc-800 pt-2">
            <div className="mb-1 text-[10px] text-zinc-500">{t('屬性點：{n}', { n: hero.attrPoints })}</div>
            <div className="flex flex-wrap gap-1.5">
              {ATTRS.map((a) => (
                <button
                  key={a}
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs hover:bg-zinc-800 disabled:opacity-40"
                  disabled={hero.attrPoints <= 0}
                  onClick={() => addAttr(a)}
                >
                  {t(ATTR_NAME[a])} {stats.attrs[a]} <span className="text-emerald-400">+</span>
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 border-t border-zinc-800 pt-2">
            <div className="mb-1 text-[10px] text-zinc-500">{t('套裝（裝備 + 技能 + 屬性整組切換）')}</div>
            <div className="flex gap-1.5">
              {hero.loadouts.map((l, i) => (
                <button
                  key={i}
                  className={`flex-1 rounded px-2 py-1 text-xs ${i === hero.active ? 'bg-zinc-100 text-zinc-900' : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}
                  onClick={() => update((h) => { h.active = i })}
                >
                  {t(l.name)}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-600">
            <span>{t('擊殺')} {hero.kills} · {t('陣亡')} {hero.deaths}</span>
            <button className="hover:text-zinc-300" onClick={() => { if (confirm(t('重置角色與存檔？'))) { setHero(resetHero()); setBattle(null) } }}>{t('重置')}</button>
          </div>
        </div>

        {/* ── 戰鬥 ── */}
        <div className="min-w-80 flex-[2] rounded border border-zinc-800 bg-zinc-900 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium tracking-widest text-zinc-400">{t('⚔️ 戰鬥')}</span>
            <button
              className={`rounded px-2 py-0.5 text-xs ${auto ? 'bg-emerald-600 text-white' : 'border border-zinc-700 text-zinc-400'}`}
              onClick={() => setAuto((v) => !v)}
            >
              {auto ? t('沉浸自動') : t('手動操作')}
            </button>
            {battle && !battle.over && (
              <button className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800" onClick={() => setBattle(null)}>
                {t('撤退')}
              </button>
            )}
            {battle && (
              <span className="ml-auto text-[10px] text-zinc-500">
                {battle.kind === 'dungeon'
                  ? t('第 {room}/{rooms} 間', { room: battle.room, rooms: battle.rooms })
                  : t('野外')} · {t('回合')} {battle.tick}
              </span>
            )}
          </div>

          {!battle && (
            <div className="py-6 text-center text-xs text-zinc-500">{t('選一個地方出發，或先去配點與換裝')}</div>
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
                    <span style={{ color: c.color }}>{t(c.name)}</span>
                    <span className="text-zinc-500">{c.hp}/{c.hpMax}</span>
                    {c.mpMax > 0 && <span className="text-sky-400/80">MP {c.mp}</span>}
                  </span>
                ))}
              </div>
              {/* ── 敵人列：點一下集火 ── */}
              <div className="mb-2 flex flex-wrap gap-1.5">
                {battle.foes.map((f) => {
                  const focused = battle.focus === f.uid
                  const charging = (f.charge ?? 0) > 0
                  return (
                    <button
                      key={f.uid}
                      onClick={() => focusOn(f.uid)}
                      title={t('點選集火。再點一次取消')}
                      className={`rounded border px-2 py-1 text-[11px] ${
                        focused ? 'border-amber-400 bg-amber-400/15 text-amber-200'
                          : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
                      }`}
                    >
                      {focused && '🎯 '}
                      {f.elite && <span className="text-amber-300">★</span>}
                      {t(f.name)}
                      <span className="ml-1 text-zinc-500">{f.hp}/{f.hpMax}</span>
                      {charging && <span className="ml-1 animate-pulse text-red-400">{t('蓄力中！')}</span>}
                    </button>
                  )
                })}
              </div>

              {/* ── 操作列：回合制下令 ── */}
              {!auto && (
                <div className="mb-1 text-[11px]">
                  {battle.phase === 'input'
                    ? <span className="text-emerald-400">{t('▶ 輪到你了，選一個行動')}</span>
                    : <span className="text-zinc-500">{t('結算中…')}</span>}
                </div>
              )}
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {!auto && (
                  <button
                    className="rounded border border-zinc-500 px-2 py-1 text-xs disabled:opacity-40"
                    disabled={battle.over || battle.phase !== 'input'}
                    onClick={() => castSkill(null)}
                  >
                    ⚔ {t('普攻')}
                  </button>
                )}
                {battle.hero.skills.map((id) => {
                  const sk = SKILL_BY_ID[id]
                  const cd = battle.hero.cds[id] ?? 0
                  const noMp = sk.mpCost > battle.hero.mp
                  return (
                    <button
                      key={id}
                      title={`${t(sk.desc)}${sk.mpCost ? `  ·  MP ${sk.mpCost}` : ''}`}
                      className="rounded border px-2 py-1 text-xs disabled:opacity-40"
                      style={{ borderColor: LINE_COLOR[sk.line] }}
                      disabled={cd > 0 || noMp || battle.over || (!auto && battle.phase !== 'input')}
                      onClick={() => castSkill(id)}
                    >
                      {t(sk.name)}
                      {cd > 0 && <span className="ml-0.5 text-zinc-500">{cd}</span>}
                      {cd === 0 && noMp && <span className="ml-0.5 text-sky-500/70">MP</span>}
                    </button>
                  )
                })}

                <span className="mx-1 h-4 w-px bg-zinc-700" />

                <button
                  className={`rounded border px-2 py-1 text-xs disabled:opacity-40 ${
                    battle.guarding ? 'border-sky-400 bg-sky-400/15 text-sky-200' : 'border-zinc-600 text-zinc-300'
                  }`}
                  title={t('擋下下一次攻擊的大半傷害。王蓄力時特別有用')}
                  disabled={battle.over || battle.guarding}
                  onClick={doGuard}
                >
                  🛡 {battle.guarding ? t('格擋中') : t('格擋')}
                </button>

                <button
                  className="rounded border border-rose-700/70 px-2 py-1 text-xs text-rose-200 disabled:opacity-40"
                  disabled={battle.over || hero.potions.hp <= 0 || battle.hero.hp >= battle.hero.hpMax}
                  onClick={() => drink('hp')}
                >
                  🧪 {t('生命藥水')} ×{hero.potions.hp}
                </button>
                <button
                  className="rounded border border-sky-700/70 px-2 py-1 text-xs text-sky-200 disabled:opacity-40"
                  disabled={battle.over || hero.potions.mp <= 0 || battle.hero.mp >= battle.hero.mpMax}
                  onClick={() => drink('mp')}
                >
                  🧪 {t('魔力藥水')} ×{hero.potions.mp}
                </button>
              </div>

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
                  {battle.result === 'win' ? t('🏆 通關！') : t('💀 全滅')}
                  <button className="ml-2 rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800" onClick={() => setBattle(null)}>{t('返回')}</button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── 隊伍 ── */}
        <div className="min-w-56 flex-1 rounded border border-zinc-800 bg-zinc-900 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium tracking-widest text-zinc-400">{t('🤝 AI 夥伴')}</span>
            <button
              className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
              onClick={() => setParty(autoParty(4))}
            >
              {t('自動組隊')}
            </button>
            {party.length > 0 && (
              <button className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800" onClick={() => setParty([])}>
                {t('解散')}
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
                  <span className="flex-none font-medium">{t(c.name)}</span>
                  <span className="flex-none text-[10px]" style={{ color: LINE_COLOR[c.line] }}>{t(LINE_NAME[c.line])}</span>
                  <span className="ml-auto truncate text-[10px] text-zinc-500">{joined ? t('已入隊') : st.why}</span>
                </button>
              )
            })}
          </div>
          <div className="mt-2 text-[10px] text-zinc-600">{t('隊伍 {n} 人（含你）', { n: party.length + 1 })}</div>

          {/* ── 寵物 ── */}
          <div className="mt-3 border-t border-zinc-800 pt-2">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs font-medium tracking-widest text-zinc-400">{t('🐾 寵物')}</span>
              <span className="text-[10px] text-zinc-600">{t('打王有機會遇到')}</span>
            </div>
            {hero.pets.length === 0 && (
              <div className="text-[11px] text-zinc-600">{t('還沒有寵物。去打地城的王試試')}</div>
            )}
            <div className="flex flex-col gap-1">
              {hero.pets.map((p) => {
                const on = hero.activePet === p.id
                return (
                  <button
                    key={p.id}
                    title={t(p.desc)}
                    onClick={() => update((h) => { h.activePet = h.activePet === p.id ? undefined : p.id })}
                    className={`flex items-center gap-2 rounded border px-2 py-1 text-left text-[11px] ${
                      on ? 'border-pink-400/70 bg-pink-400/10' : 'border-zinc-800 hover:bg-zinc-800'
                    }`}
                  >
                    <PetIcon art={p.art} />
                    <span className={on ? 'text-pink-200' : 'text-zinc-300'}>{t(p.name)}</span>
                    <span className="text-zinc-500">Lv.{p.level}</span>
                    <span className="text-zinc-600">{p.xp}/{petXpForLevel(p.level)}</span>
                    {on && <span className="ml-auto text-pink-300">{t('出戰中')}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── 出發地點 ── */}
      <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
        <div className="mb-2 text-xs font-medium tracking-widest text-zinc-400">{t('🗺️ 出發')}</div>
        <div className="flex flex-wrap gap-2">
          {ZONES.map((z) => (
            <button
              key={z.id}
              title={t(z.desc)}
              className="rounded border border-zinc-700 px-2.5 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40"
              disabled={hero.level < z.minLevel}
              onClick={() => enterZone(z.id)}
            >
              {t(z.name)} <span className="text-zinc-500">Lv.{z.minLevel}+</span>
            </button>
          ))}
          <span className="mx-1 w-px bg-zinc-700" />
          {DUNGEONS.map((d) => (
            <button
              key={d.id}
              title={`${t(d.desc)}${t('（需要 {n} 人）', { n: d.partySize })}`}
              className="rounded border border-amber-700/60 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-950/40 disabled:opacity-40"
              onClick={() => enterDungeon(d.id)}
            >
              🏰 {t(d.name)} <span className="text-amber-500/70">Lv.{d.minLevel}+ · {t('{n}人', { n: d.partySize })}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── 技能 / 裝備 / 背包 ── */}
      <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
        <div className="mb-2 flex gap-2">
          {([
            ['skills', t('技能（{n} 點）', { n: hero.skillPoints })],
            ['gear', t('裝備')],
            ['bag', t('背包（{n}）', { n: hero.bag.length })],
          ] as const).map(([k, label]) => (
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
                  {t(LINE_NAME[line])} <span className="text-zinc-500">{t('已投 {n} 點', { n: linePoints(lo, line) })}</span>
                </div>
                <div className="flex flex-col gap-1">
                  {SKILLS_OF_LINE(line).map((sk) => {
                    const lv = lo.skills[sk.id] ?? 0
                    const open = skillUnlocked(lo, sk.id)
                    return (
                      <button
                        key={sk.id}
                        title={`${t(sk.desc)}${open ? '' : t('（需要 {line} 投入 {n} 點）', { line: t(LINE_NAME[line]), n: sk.req })}`}
                        className="flex items-center gap-1.5 rounded border border-zinc-800 px-2 py-1 text-left text-xs hover:bg-zinc-800 disabled:opacity-40"
                        disabled={!open || hero.skillPoints <= 0 || lv >= sk.maxLv}
                        onClick={() => addSkill(sk.id)}
                      >
                        <span className={open ? '' : 'text-zinc-600'}>{t(sk.name)}</span>
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
                  <span className="w-12 flex-none text-zinc-500">{t(SLOT_NAME[s])}</span>
                  <div className="min-w-0 flex-1 truncate">
                    {it ? <ItemLine it={it} /> : <span className="text-zinc-600">{t('（空）')}</span>}
                  </div>
                  {it && <button className="flex-none text-zinc-500 hover:text-zinc-200" onClick={() => unequip(s)}>{t('卸下')}</button>}
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
                <option value="all">{t('全部部位')}</option>
                {SLOTS.map((s2) => <option key={s2} value={s2}>{t(SLOT_NAME[s2])}</option>)}
              </select>
              <select
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5"
                value={fRarity} onChange={(e) => setFRarity(e.target.value as Rarity | 'all')}
              >
                <option value="all">{t('全部品質')}</option>
                {RARITY_ORDER.map((r) => <option key={r} value={r}>{t(RARITY_NAME[r])}</option>)}
              </select>
              <select
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5"
                value={fSort} onChange={(e) => setFSort(e.target.value as 'score' | 'ilvl' | 'rarity')}
              >
                <option value="score">{t('依分數')}</option>
                <option value="ilvl">{t('依等級')}</option>
                <option value="rarity">{t('依品質')}</option>
              </select>
              <label className="flex items-center gap-1 text-zinc-400">
                <input type="checkbox" checked={fUpgrade} onChange={(e) => setFUpgrade(e.target.checked)} />
                {t('只看可升級')}
              </label>
              <span className="text-zinc-600">{bagView.length} / {hero.bag.length}</span>
              <button
                className="ml-auto rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600"
                onClick={equipBest}
              >
                {t('⚡ 一鍵擇優裝備')}
              </button>
              <button
                className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:bg-zinc-800"
                title={t('每個部位保留最好的三件與裝備中的，其餘賣掉')}
                onClick={sellJunk}
              >
                {t('🧹 清雜物')}
              </button>
            </div>

            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {hero.bag.length === 0 && <div className="text-xs text-zinc-500">{t('背包空空的，去打點怪吧')}</div>}
              {hero.bag.length > 0 && bagView.length === 0 && (
                <div className="text-xs text-zinc-500">{t('沒有符合篩選條件的裝備')}</div>
              )}
              {bagView.map((it) => {
                const equipped = Object.values(lo.equipped).includes(it.id)
                const better = !equipped && isUpgrade(hero, it)
                return (
                  <div key={it.id} className="flex items-center gap-2 rounded border border-zinc-800 px-2 py-1 text-xs">
                    <ItemIcon it={it} />
                    <span className="w-12 flex-none text-zinc-500">{t(SLOT_NAME[it.slot])}</span>
                    <div className="min-w-0 flex-1 truncate"><ItemLine it={it} dim={equipped} /></div>
                    {better && <span className="flex-none text-emerald-400" title={t('比目前裝著的好')}>▲</span>}
                    <span className="flex-none text-zinc-600">{itemScore(it)}</span>
                    {!equipped && <button className="flex-none text-emerald-400 hover:text-emerald-300" onClick={() => equip(it)}>{t('裝備')}</button>}
                    {!equipped && <button className="flex-none text-zinc-500 hover:text-red-400" onClick={() => sell(it)}>{t('賣')}</button>}
                    {equipped && <span className="flex-none text-zinc-600">{t('使用中')}</span>}
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
