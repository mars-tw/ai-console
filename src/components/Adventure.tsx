// ⚔️ 冒險分頁：邊工作邊玩的小型 MMORPG
//
// 沒有職業：近戰 / 遠程 / 魔法 / 信仰四條線自己混。
// 裝備、技能、屬性各存一套，隨時整組換掉。
// 戰鬥是 tick 制，所以切到別的分頁去工作時它也會自己打。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BattleScene from '@/components/BattleScene'
import { itemLabel, t, useLang } from '@/i18n'
import { useReadable } from '@/theme'
import { DUNGEONS, RARITY_ORDER, SKILLS_OF_LINE, SKILL_BY_ID, ZONES } from '@/rpg/data'
import {
  activeLoadout, attrLeft, autoEquipBest, collect, computeStats, isUpgrade,
  itemById, itemScore, linePoints, skillLeft, skillUnlocked, startBattle, stepBattle,
  xpForLevel, type Battle,
} from '@/rpg/engine'
import { SHOP, type BuyResult, type ShopEntry } from '@/rpg/shop'
import { ALLY_BY_ID, recruitById, recruitCombatant, recruitXpForLevel } from '@/rpg/allies'
import { ALLY_PULL_GOLD, GEAR_PULL_GOLD, TEN, floorAt, pullAlly, pullGear, tenCost } from '@/rpg/gacha'
import { MAX_PLUS, enhance, enhanceCost, odds } from '@/rpg/enhance'
import { SECRETS } from '@/rpg/secrets'
import { loadBattle, loadHero, resetHero, saveBattle, saveHero } from '@/rpg/save'
import { drainPending, setAuto as setSessionAuto, setMounted, startSession } from '@/rpg/session'
import { commitOrder, guard, setFocus, stepTurn, drinkPotion, petXpForLevel } from '@/rpg/engine'
import {
  AFFIX_NAME, AFFIX_PCT, ALLY_CAT_NAME, ALLY_ROLE_COLOR, ALLY_ROLE_NAME,
  ATTRS, ATTR_NAME, LINES, LINE_NAME, RARITY_COLOR,
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
function Bar({ v, max, color, h = 6 }: { v: number; max: number; color: string; h?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0
  return (
    <div className="w-full overflow-hidden rounded-sm bg-app" style={{ height: h }}>
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
  const tone = useReadable()
  return (
    <div className={dim ? 'opacity-60' : ''}>
      <span style={{ color: tone(RARITY_COLOR[it.rarity]) }}>
        {it.unique && <span className="mr-0.5 text-amber-700 dark:text-amber-300">★</span>}
        {itemLabel(it.name)}
        {!!it.plus && <span className="ml-0.5 text-amber-700 dark:text-amber-300">+{it.plus}</span>}
      </span>
      <span className="ml-1 text-mute2">
        ({t(RARITY_NAME[it.rarity])} · iLv{it.ilvl}
        {it.atk ? ` · ${t('攻')}${it.atk}` : ''}{it.def ? ` · ${t('防')}${it.def}` : ''})
      </span>
      {it.affixes.length > 0 && (
        <span className="ml-1 text-emerald-700 dark:text-emerald-400/80">
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
  // 資料驅動的色票是照深底挑的，亮色主題下要壓暗才讀得清楚
  const tone = useReadable()
  const [hero, setHero] = useState<Hero>(() => loadHero())
  // 從存檔還原上一場。切分頁會讓這個元件 unmount，沒有這一步戰鬥就消失了；
  // 而離場期間 session 的心跳會繼續推進並寫回存檔，所以這裡讀到的
  // 已經是「你不在的時候打到哪」的最新進度。
  const [battle, setBattle] = useState<Battle | null>(() => loadBattle())
  const [auto, setAuto] = useState(true)
  const [party, setPartyState] = useState<string[]>(() => hero.party ?? [])
  const [tab, setTab] = useState<'skills' | 'gear' | 'bag' | 'shop' | 'gacha' | 'secret'>('skills')
  // 背包篩選
  const [fSlot, setFSlot] = useState<Slot | 'all'>('all')
  const [fRarity, setFRarity] = useState<Rarity | 'all'>('all')
  const [fUpgrade, setFUpgrade] = useState(false)
  const [fSort, setFSort] = useState<'score' | 'ilvl' | 'rarity'>('score')
  const [notice, setNotice] = useState('')
  /** 抽卡結果：最近一次的清單，抽完停在畫面上，不然十連刷過去什麼都看不到 */
  const [pulls, setPulls] = useState<{ label: string; color: string; note?: string }[]>([])
  const heroRef = useRef(hero)
  const battleRef = useRef(battle)
  const partyRef = useRef(party)
  /** 手動模式排隊的技能：放在 ref，不去改動 state 物件 */
  // ref 只在 effect 裡更新，不在 render 期間寫
  const autoRef = useRef(auto)
  useEffect(() => { autoRef.current = auto }, [auto])
  // 掛機開關要讓模組心跳也知道 —— 離場後由它接手推進
  useEffect(() => { setSessionAuto(auto) }, [auto])
  /**
   * 跟模組心跳交接。
   *
   * 這個分頁是條件渲染，切走就 unmount。在場時由底下那顆 useEffect 心跳
   * 負責節奏（手動下令要即時反應）；離場後 setMounted(false) 讓
   * src/rpg/session.ts 的模組層心跳接手，戰鬥才會真的繼續打。
   * 回來時把離場期間的事件補報一次。
   */
  useEffect(() => {
    startSession()
    setMounted(true)
    const missed = drainPending()
    if (missed.length) setTimeout(() => flash(missed.join('；')), 0)
    return () => setMounted(false)
  }, [])
  useEffect(() => { heroRef.current = hero }, [hero])
  useEffect(() => { battleRef.current = battle }, [battle])

  const stats = useMemo(() => computeStats(hero), [hero])
  const lo = activeLoadout(hero)
  // 點數是「這一套」的，不是全域共用的池子 —— 三套各自配滿，隨時切
  const attrPts = attrLeft(hero)
  const skillPts = skillLeft(hero)

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
        // 解鎖彩蛋比升級更值得報 —— 那是玩家不知道存在的東西，不講他不會發現
        if (gained.secrets.length) flash(t('🔮 解鎖隱藏技能：{name}', { name: gained.secrets.map((x) => t(x)).join('、') }))
        else if (gained.levels > 0) flash(t('升到 Lv.{lv}！獲得技能點與屬性點', { lv: h.level }))
        else if (gained.allyUps.length) flash(t('{who} 升級了', { who: gained.allyUps.map((x) => t(x)).join('、') }))
        saveHero(h)
        setHero({ ...h })
      }
      const next = { ...b }
      battleRef.current = next        // 立刻同步，不等 React 的 effect
      setBattle(next)
      // 每一拍都寫回。切分頁是隨時可能發生的，沒有「存檔時機」可以挑。
      // 結束的那一場 saveBattle 會自己清掉，不會殘留。
      saveBattle(next)
      timer = window.setTimeout(beat, gap)
    }
    timer = window.setTimeout(beat, TICK_MS)
    return () => clearTimeout(timer)
  }, [])

  /**
   * 把隊伍名單變成戰鬥單位。
   *
   * 夥伴的數值來自各自的等級（存在 roster 裡，會成長），不再是每場
   * 照主角等級臨時捏一個 —— 那樣練誰都一樣，等於沒有養成。
   */
  const buildParty = (members: string[] = party): Combatant[] =>
    members.flatMap((id) => {
      const r = recruitById(hero, id)
      if (!r) return []
      const c = recruitCombatant(r)
      // AI 龍如果剛好接得到本機工具狀態，給一點風味加成；人形夥伴沒有這層
      if (ALLY_BY_ID[r.kind]?.cat === 'ai') {
        const bonus = allyState(r.kind).bonus
        c.atk = Math.round(c.atk * bonus)
        c.hpMax = Math.round(c.hpMax * bonus)
        c.hp = c.hpMax
      }
      return [c]
    })

  /** 自動組隊：把隊伍補到指定人數（含自己）。優先挑等級高的，單機也進得去地城 */
  const autoParty = (need: number): string[] => {
    const picked = [...party]
    const rest = (hero.roster ?? [])
      .filter((r) => !picked.includes(r.id))
      .sort((a, b) => b.level - a.level)
    for (const r of rest) {
      if (picked.length + 1 >= need) break
      picked.push(r.id)
    }
    return picked
  }

  /**
   * 隊伍變動 → 存檔 + 立刻反映到進行中的戰鬥。
   *
   * 原本 setParty 只是元件內的 state，兩個問題都很致命：
   *   1. 沒有存檔，重開就散隊，每次都要重揪
   *   2. 只影響「下一場」，打到一半按入隊只有按鈕變綠，戰場上根本沒那個人
   * 看起來就是組隊功能壞掉。這裡兩個一起修。
   */
  const setParty = (next: string[] | ((p: string[]) => string[])) => {
    const members = typeof next === 'function' ? next(partyRef.current) : next
    partyRef.current = members
    setPartyState(members)
    update((h) => { h.party = members })

    const b = battleRef.current
    if (!b || b.over) return
    const keep = b.allies.filter((a) => members.includes(a.art))
    const have = new Set(keep.map((a) => a.art))
    b.allies = [...keep, ...buildParty(members.filter((k) => !have.has(k)))]
    const nb = { ...b }
    battleRef.current = nb      // 心跳讀的是 ref，只 setBattle 會被下一拍蓋掉
    setBattle(nb)
    saveBattle(nb)
  }

  /**
   * 開一場新的。
   *
   * battleRef 一定要當場設好：心跳跑在 setTimeout 上、讀的是 battleRef.current，
   * 而 useEffect 同步 ref 要等這次 render 提交完。中間那段空窗如果剛好心跳到了，
   * 它會推進舊的那一場再 setBattle 蓋回去 —— 表現出來就是「按了新地圖沒有換」。
   */
  const launch = (b: Battle, zoneId: string) => {
    battleRef.current = b
    setBattle(b)
    saveBattle(b)
    update((h) => { h.zone = zoneId })
  }

  /** 打到一半換地方 = 這一場的進度全丟，先問過再說 */
  const confirmLeave = () => {
    const b = battleRef.current
    return !b || b.over || confirm(t('這一場還沒打完，換地方就得從頭開始。確定要走嗎？'))
  }

  const enterZone = (id: string) => {
    if (!confirmLeave()) return
    launch(startBattle(hero, 'field', id, buildParty()), id)
  }

  const enterDungeon = (id: string) => {
    const dg = DUNGEONS.find((d) => d.id === id)!
    if (hero.level < dg.minLevel) return flash(t('等級不足，{name} 需要 Lv.{lv}', { name: t(dg.name), lv: dg.minLevel }))
    if (!confirmLeave()) return
    // 人不夠不擋你，直接叫 AI 夥伴補位
    const members = party.length + 1 < dg.partySize ? autoParty(dg.partySize) : party
    if (members.length !== party.length) {
      const added = members.filter((k) => !party.includes(k))
        .map((k) => t(ALLY_BY_ID[recruitById(hero, k)?.kind ?? '']?.name ?? k)).join('、')
      partyRef.current = members
      setPartyState(members)
      update((h) => { h.party = members })
      flash(t('人手不夠，{who} 自動加入隊伍', { who: added }))
    }
    launch(startBattle(hero, 'dungeon', id, buildParty(members)), id)
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

  /**
   * 鍵盤操作。
   *
   * 回合制的節奏是「看一下場面 → 決定這回合做什麼」，一直把手移到滑鼠去點
   * 會把那個節奏切碎。數字鍵對應技能列的順序（跟畫面上由左到右一致），
   * 這樣不用記快捷鍵表，看畫面就知道按幾。
   *
   * 只在手動模式、輪到你下令時生效 —— 沉浸自動模式下按鍵沒有意義，
   * 而且會讓人以為指令被吃掉了。輸入框有焦點時一律不攔。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const b = battleRef.current
      if (!b || b.over || autoRef.current || b.phase !== 'input') return

      const k = e.key.toLowerCase()
      // 數字鍵：0 是普攻，1..9 依序對應技能列
      if (/^[0-9]$/.test(k)) {
        const idx = Number(k)
        if (idx === 0) { e.preventDefault(); castSkill(null); return }
        const id = b.hero.skills[idx - 1]
        if (id) { e.preventDefault(); castSkill(id) }
        return
      }
      if (k === ' ') { e.preventDefault(); castSkill(null); return }
      if (k === 'g') { e.preventDefault(); doGuard(); return }
      if (k === 'h') { e.preventDefault(); drink('hp'); return }
      if (k === 'm') { e.preventDefault(); drink('mp'); return }
      // Tab 換集火目標：只在活著的敵人之間循環
      if (k === 'tab') {
        const alive = b.foes.filter((f) => f.hp > 0)
        if (!alive.length) return
        e.preventDefault()
        const cur = alive.findIndex((f) => f.uid === b.focus)
        focusOn(alive[(cur + 1) % alive.length].uid)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // 這幾個 handler 每次 render 都會重建，但它們讀的是 battleRef / autoRef，
    // 不是 render 當下的複本 —— 掛一次就永遠是對的。放進相依陣列只會讓
    // 監聽器每一幀拆掉重綁，按鍵反而可能掉。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 配點 ──
  const addAttr = (a: typeof ATTRS[number]) => update((h) => {
    if (attrLeft(h) <= 0) return
    h.loadouts[h.active].attrs[a] = (h.loadouts[h.active].attrs[a] ?? 0) + 1
  })
  const addSkill = (id: string) => update((h) => {
    const l = h.loadouts[h.active]
    const sk = SKILL_BY_ID[id]
    if (skillLeft(h) <= 0 || !sk) return
    if ((l.skills[id] ?? 0) >= sk.maxLv) return
    if (linePoints(l, sk.line) < sk.req) return
    l.skills[id] = (l.skills[id] ?? 0) + 1
  })
  /**
   * 買東西。
   *
   * 金幣本來只進不出 —— 打贏拿到的數字沒有任何用處，藥水喝完也只能等掉落。
   * 有了出口，賣雜物、要不要現在換裝、留著洗點才變成決策。
   */
  const buy = (e: ShopEntry) => {
    const price = e.price(hero)
    if (hero.gold < price) return flash(t('金幣不夠，還差 {n}', { n: price - hero.gold }))
    const why = e.blocked?.(hero)
    if (why) return flash(t(why))
    let res: BuyResult | undefined
    update((h) => { h.gold -= price; res = e.buy(h) })
    setTimeout(() => { if (res) flash(t(res.msg, res.params)) }, 0)
  }

  // ── 抽卡 ──
  // 有券優先用券，沒券才吃金幣。反過來的話玩家會先把金幣花光又不知道自己有券。
  const rollAllies = (count: number) => {
    const have = hero.tickets?.ally ?? 0
    const byTicket = have >= count
    const cost = byTicket ? 0 : (count === 1 ? ALLY_PULL_GOLD : tenCost(ALLY_PULL_GOLD))
    if (!byTicket && hero.gold < cost) return flash(t('金幣不夠，還差 {n}', { n: cost - hero.gold }))
    const out: { label: string; color: string; note?: string }[] = []
    update((h) => {
      h.tickets ??= { ally: 0, gear: 0 }
      if (byTicket) h.tickets.ally -= count
      else h.gold -= cost
      for (let i = 0; i < count; i++) {
        const r = pullAlly(h, floorAt(i, count))
        out.push({
          label: t(r.kind.name),
          color: RARITY_COLOR[r.kind.rarity],
          note: r.dupeXp ? t('重複 → 經驗 +{n}', { n: r.dupeXp }) : t('新夥伴！'),
        })
      }
    })
    setPulls(out)
  }

  const rollGear = (count: number) => {
    const have = hero.tickets?.gear ?? 0
    const byTicket = have >= count
    const cost = byTicket ? 0 : (count === 1 ? GEAR_PULL_GOLD : tenCost(GEAR_PULL_GOLD))
    if (!byTicket && hero.gold < cost) return flash(t('金幣不夠，還差 {n}', { n: cost - hero.gold }))
    const out: { label: string; color: string; note?: string }[] = []
    update((h) => {
      h.tickets ??= { ally: 0, gear: 0 }
      if (byTicket) h.tickets.gear -= count
      else h.gold -= cost
      for (let i = 0; i < count; i++) {
        const r = pullGear(h, () => `gx${Date.now().toString(36)}${i}`, floorAt(i, count))
        h.bag.push(r.item)
        out.push({
          label: itemLabel(r.item.name),
          color: RARITY_COLOR[r.item.rarity],
          note: r.unique ? t('★ 彩蛋裝備') : t(RARITY_NAME[r.item.rarity]),
        })
      }
      autoEquipBest(h)
    })
    setPulls(out)
  }

  /**
   * 強化一件裝備。
   *
   * 會爆的段位一定先問過 —— 這是遊戲裡唯一會讓玩家永久失去東西的操作，
   * 手滑點掉一件 +9 主手的體驗，比任何數值調整都傷。
   */
  const doEnhance = (it: Item, protect: boolean) => {
    const cost = enhanceCost(it)
    if ((it.plus ?? 0) >= MAX_PLUS) return flash(t('已經強化到頂了'))
    if (hero.gold < cost) return flash(t('金幣不夠，還差 {n}', { n: cost - hero.gold }))
    if (protect && !(hero.tickets?.protect ?? 0)) return flash(t('沒有保護符了'))
    const o = odds(it.plus ?? 0, hero)
    if (!protect && o.destroy > 0 && !confirm(t(
      '{name} 目前 +{p}。成功率 {s}%，失敗有 {d}% 會直接碎掉。要繼續嗎？',
      { name: itemLabel(it.name), p: it.plus ?? 0, s: Math.round(o.success * 100), d: Math.round(o.destroy * 100) },
    ))) return
    let msg = ''
    update((h) => {
      const target = h.bag.find((x) => x.id === it.id)
      if (!target) return
      h.gold -= cost
      const r = enhance(h, target, protect)
      if (r.usedProtect || (protect && r.outcome !== 'up')) {
        h.tickets ??= { ally: 0, gear: 0 }
        h.tickets.protect = Math.max(0, (h.tickets.protect ?? 0) - 1)
      }
      if (r.outcome === 'destroy') {
        h.bag = h.bag.filter((x) => x.id !== target.id)
        for (const l of h.loadouts) for (const sl of SLOTS) if (l.equipped[sl] === target.id) delete l.equipped[sl]
      }
      msg = t(r.msg, r.params)
    })
    setTimeout(() => flash(msg), 0)
  }

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
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-app p-3 text-ink2">
      {notice && (
        <div className="rounded border border-amber-300 dark:border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-700 dark:text-amber-200">{notice}</div>
      )}

      <div className="flex flex-wrap gap-3">
        {/* ── 角色 ── */}
        <div className="min-w-64 flex-1 rounded border border-line bg-panel p-3">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-sm font-bold">{t(hero.name)}</span>
            <span className="text-xs text-mute">Lv.{hero.level}</span>
            <span className="ml-auto text-xs text-amber-700 dark:text-amber-300">🪙 {hero.gold}</span>
          </div>
          {/* 外觀只影響用哪組圖，不動任何數值，所以隨時可以換 */}
          <div className="mb-2 flex items-center gap-1 text-[10px]">
            <span className="text-mute2">{t('外觀')}</span>
            {([['hero', t('男')], ['heroine', t('女')]] as const).map(([look, label]) => (
              <button
                key={look}
                className={`rounded px-2 py-0.5 ${hero.look === look
                  ? 'bg-ink text-invink' : 'border border-line2 text-mute hover:bg-elev'}`}
                onClick={() => update((h) => { h.look = look })}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mb-1 text-[10px] text-mute2">{t('經驗')} {hero.xp} / {xpNeed}</div>
          <Bar v={hero.xp} max={xpNeed} color="#a78bfa" />
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-mute">
            <div>{t('生命')} <span className="text-ink2">{stats.hpMax}</span></div>
            <div>{t('魔力')} <span className="text-ink2">{stats.mpMax}</span></div>
            <div>{t('攻擊')} <span className="text-ink2">{stats.atk}</span></div>
            <div>{t('防禦')} <span className="text-ink2">{stats.def}</span></div>
            <div>{t('暴擊')} <span className="text-ink2">{(stats.crit * 100).toFixed(1)}%</span></div>
            <div>{t('急速')} <span className="text-ink2">{(stats.haste * 100).toFixed(1)}%</span></div>
          </div>
          <div className="mt-2 border-t border-line pt-2">
            <div className="mb-1 text-[10px] text-mute2">{t('屬性點：{n}（這一套）', { n: attrPts })}</div>
            <div className="flex flex-wrap gap-1.5">
              {ATTRS.map((a) => (
                <button
                  key={a}
                  className="rounded border border-line2 px-1.5 py-0.5 text-xs hover:bg-elev disabled:opacity-60 dark:disabled:opacity-40"
                  disabled={attrPts <= 0}
                  onClick={() => addAttr(a)}
                >
                  {t(ATTR_NAME[a])} {stats.attrs[a]} <span className="text-emerald-700 dark:text-emerald-400">+</span>
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 border-t border-line pt-2">
            <div className="mb-1 text-[10px] text-mute2">{t('套裝（裝備 + 技能 + 屬性整組切換）')}</div>
            <div className="flex gap-1.5">
              {hero.loadouts.map((l, i) => (
                <button
                  key={i}
                  className={`flex-1 rounded px-2 py-1 text-xs ${i === hero.active ? 'bg-ink text-invink' : 'border border-line2 text-ink3 hover:bg-elev'}`}
                  onClick={() => update((h) => { h.active = i })}
                >
                  {t(l.name)}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between text-[10px] text-mute3">
            <span>{t('擊殺')} {hero.kills} · {t('陣亡')} {hero.deaths}</span>
            <button className="hover:text-ink3" onClick={() => { if (confirm(t('重置角色與存檔？'))) { setHero(resetHero()); setBattle(null) } }}>{t('重置')}</button>
          </div>
        </div>

        {/* ── 戰鬥 ── */}
        <div className="min-w-80 flex-[2] rounded border border-line bg-panel p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium tracking-widest text-mute">{t('⚔️ 戰鬥')}</span>
            <button
              className={`rounded px-2 py-0.5 text-xs ${auto ? 'bg-emerald-600 text-white' : 'border border-line2 text-mute'}`}
              onClick={() => setAuto((v) => !v)}
            >
              {auto ? t('沉浸自動') : t('手動操作')}
            </button>
            {battle && !battle.over && (
              <button className="rounded border border-line2 px-2 py-0.5 text-xs text-mute hover:bg-elev" onClick={() => setBattle(null)}>
                {t('撤退')}
              </button>
            )}
            {battle && (
              <span className="ml-auto text-[10px] text-mute2">
                {battle.kind === 'dungeon'
                  ? t('第 {room}/{rooms} 間', { room: battle.room, rooms: battle.rooms })
                  : t('野外')} · {t('回合')} {battle.tick}
              </span>
            )}
          </div>

          {!battle && (
            <div className="py-6 text-center text-xs text-mute2">{t('選一個地方出發，或先去配點與換裝')}</div>
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
                    <span style={{ color: tone(c.color) }}>{t(c.name)}</span>
                    <span className="text-mute2">{c.hp}/{c.hpMax}</span>
                    {c.mpMax > 0 && <span className="text-sky-700 dark:text-sky-400/80">MP {c.mp}</span>}
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
                        focused ? 'border-amber-400 bg-amber-100 dark:bg-amber-400/15 text-amber-700 dark:text-amber-200'
                          : 'border-line2 text-mute hover:bg-elev'
                      }`}
                    >
                      {focused && '🎯 '}
                      {f.elite && <span className="text-amber-700 dark:text-amber-300">★</span>}
                      {t(f.name)}
                      <span className="ml-1 text-mute2">{f.hp}/{f.hpMax}</span>
                      {charging && <span className="ml-1 animate-pulse text-red-700 dark:text-red-400">{t('蓄力中！')}</span>}
                    </button>
                  )
                })}
              </div>

              {/* ── 操作列：回合制下令 ── */}
              {!auto && (
                <div className="mb-1 text-[11px]">
                  {battle.phase === 'input'
                    ? <span className="text-emerald-700 dark:text-emerald-400">{t('▶ 輪到你了，選一個行動')}</span>
                    : <span className="text-mute2">{t('結算中…')}</span>}
                </div>
              )}
              <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('戰鬥指令')}>
                {!auto && (
                  <button
                    className="rounded border border-line4 px-2 py-1 text-xs disabled:opacity-60 dark:disabled:opacity-40"
                    title={t('快捷鍵：空白或 0')}
                    aria-keyshortcuts="0 Space"
                    disabled={battle.over || battle.phase !== 'input'}
                    onClick={() => castSkill(null)}
                  >
                    ⚔ {t('普攻')}
                  </button>
                )}
                {battle.hero.skills.map((id, i) => {
                  const sk = SKILL_BY_ID[id]
                  const cd = battle.hero.cds[id] ?? 0
                  const noMp = sk.mpCost > battle.hero.mp
                  return (
                    <button
                      key={id}
                      title={`${t(sk.desc)}${sk.mpCost ? `  ·  MP ${sk.mpCost}` : ''}${auto ? '' : t('  ·  快捷鍵 {k}', { k: i + 1 })}`}
                      aria-keyshortcuts={auto ? undefined : String(i + 1)}
                      className="rounded border px-2 py-1 text-xs disabled:opacity-60 dark:disabled:opacity-40"
                      style={{ borderColor: tone(LINE_COLOR[sk.line]) }}
                      disabled={cd > 0 || noMp || battle.over || (!auto && battle.phase !== 'input')}
                      onClick={() => castSkill(id)}
                    >
                      {t(sk.name)}
                      {cd > 0 && <span className="ml-0.5 text-mute2">{cd}</span>}
                      {cd === 0 && noMp && <span className="ml-0.5 text-sky-500/70">MP</span>}
                    </button>
                  )
                })}

                <span className="mx-1 h-4 w-px bg-elev2" />

                <button
                  className={`rounded border px-2 py-1 text-xs disabled:opacity-60 dark:disabled:opacity-40 ${
                    battle.guarding ? 'border-sky-400 bg-sky-100 dark:bg-sky-400/15 text-sky-700 dark:text-sky-200' : 'border-line3 text-ink3'
                  }`}
                  title={t('擋下下一次攻擊的大半傷害。王蓄力時特別有用') + (auto ? '' : t('  ·  快捷鍵 G'))}
                  aria-keyshortcuts={auto ? undefined : 'g'}
                  disabled={battle.over || battle.guarding}
                  onClick={doGuard}
                >
                  🛡 {battle.guarding ? t('格擋中') : t('格擋')}
                </button>

                <button
                  className="rounded border border-rose-300 dark:border-rose-700/70 px-2 py-1 text-xs text-rose-700 dark:text-rose-200 disabled:opacity-60 dark:disabled:opacity-40"
                  title={auto ? undefined : t('快捷鍵 H')}
                  aria-keyshortcuts={auto ? undefined : 'h'}
                  disabled={battle.over || hero.potions.hp <= 0 || battle.hero.hp >= battle.hero.hpMax}
                  onClick={() => drink('hp')}
                >
                  🧪 {t('生命藥水')} ×{hero.potions.hp}
                </button>
                <button
                  className="rounded border border-sky-300 dark:border-sky-700/70 px-2 py-1 text-xs text-sky-700 dark:text-sky-200 disabled:opacity-60 dark:disabled:opacity-40"
                  title={auto ? undefined : t('快捷鍵 M')}
                  aria-keyshortcuts={auto ? undefined : 'm'}
                  disabled={battle.over || hero.potions.mp <= 0 || battle.hero.mp >= battle.hero.mpMax}
                  onClick={() => drink('mp')}
                >
                  🧪 {t('魔力藥水')} ×{hero.potions.mp}
                </button>
              </div>

              {!auto && (
                <div className="mb-2 text-[10px] text-mute3">
                  {t('鍵盤：1–9 技能 · 0/空白 普攻 · G 格擋 · H/M 藥水 · Tab 換目標')}
                </div>
              )}
              <div
                className="max-h-40 overflow-y-auto rounded bg-app p-2 font-mono text-[11px] leading-5"
                role="log"
                aria-live="polite"
                aria-label={t('戰鬥紀錄')}
              >
                {[...battle.log].reverse().map((l, i) => (
                  <div key={i} className={
                    l.kind === 'crit' ? 'text-amber-700 dark:text-amber-300'
                      : l.kind === 'loot' ? 'text-emerald-700 dark:text-emerald-400'
                      : l.kind === 'heal' ? 'text-sky-700 dark:text-sky-300'
                      : l.kind === 'death' ? 'text-red-700 dark:text-red-400'
                      : l.kind === 'info' ? 'text-mute'
                      : 'text-ink3'
                  }>{l.text}</div>
                ))}
              </div>
              {battle.over && (
                <div className="mt-2 text-center text-xs text-mute">
                  {battle.result === 'win' ? t('🏆 通關！') : t('💀 全滅')}
                  <button className="ml-2 rounded border border-line2 px-2 py-0.5 hover:bg-elev" onClick={() => setBattle(null)}>{t('返回')}</button>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── 隊伍 ── */}
        <div className="min-w-56 flex-1 rounded border border-line bg-panel p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium tracking-widest text-mute">{t('🤝 AI 夥伴')}</span>
            <button
              className="ml-auto rounded border border-line2 px-2 py-0.5 text-[10px] text-mute hover:bg-elev"
              onClick={() => setParty(autoParty(4))}
            >
              {t('自動組隊')}
            </button>
            {party.length > 0 && (
              <button className="rounded border border-line2 px-2 py-0.5 text-[10px] text-mute hover:bg-elev" onClick={() => setParty([])}>
                {t('解散')}
              </button>
            )}
          </div>
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {(hero.roster ?? []).map((r) => {
              const k = ALLY_BY_ID[r.kind]
              if (!k) return null
              const joined = party.includes(r.id)
              // AI 龍才有本機工具狀態可以顯示；人形夥伴顯示稀有度
              const tail = joined ? t('已入隊')
                : k.cat === 'ai' ? allyState(r.kind).why : t(RARITY_NAME[k.rarity])
              return (
                <button
                  key={r.id}
                  title={`${t(k.desc)} · ${t(ALLY_CAT_NAME[k.cat])} · ${t(ALLY_ROLE_NAME[k.role])}`
                    + ` · Lv.${r.level} ${r.xp}/${recruitXpForLevel(r.level)}`}
                  className={`flex items-center gap-1.5 rounded border px-2 py-1 text-left text-xs ${joined ? 'border-emerald-300 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40' : 'border-line hover:bg-elev'}`}
                  onClick={() => setParty((p) => (joined ? p.filter((x) => x !== r.id) : [...p, r.id]))}
                >
                  <span className="h-2 w-2 flex-none rounded-full" style={{ background: tone(k.color) }} />
                  <span className="flex-none font-medium" style={{ color: k.cat === 'human' ? tone(RARITY_COLOR[k.rarity]) : undefined }}>{t(k.name)}</span>
                  <span className="flex-none rounded px-1 text-[9px]" style={{ color: tone(ALLY_ROLE_COLOR[k.role]), border: `1px solid ${tone(ALLY_ROLE_COLOR[k.role])}55` }}>
                    {t(ALLY_ROLE_NAME[k.role])}
                  </span>
                  <span className="flex-none text-[10px]" style={{ color: tone(LINE_COLOR[k.line]) }}>{t(LINE_NAME[k.line])}</span>
                  <span className="flex-none text-[10px] text-mute">Lv.{r.level}</span>
                  <span className="ml-auto truncate text-[10px] text-mute2">{tail}</span>
                </button>
              )
            })}
          </div>
          <div className="mt-2 text-[10px] text-mute3">{t('隊伍 {n} 人（含你）', { n: party.length + 1 })}</div>

          {/* ── 寵物 ── */}
          <div className="mt-3 border-t border-line pt-2">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs font-medium tracking-widest text-mute">{t('🐾 寵物')}</span>
              <span className="text-[10px] text-mute3">{t('打王有機會遇到')}</span>
            </div>
            {hero.pets.length === 0 && (
              <div className="text-[11px] text-mute3">{t('還沒有寵物。去打地城的王試試')}</div>
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
                      on ? 'border-pink-400/70 bg-pink-100 dark:bg-pink-400/10' : 'border-line hover:bg-elev'
                    }`}
                  >
                    <PetIcon art={p.art} />
                    <span className={on ? 'text-pink-700 dark:text-pink-200' : 'text-ink3'}>{t(p.name)}</span>
                    <span className="text-mute2">Lv.{p.level}</span>
                    <span className="text-mute3">{p.xp}/{petXpForLevel(p.level)}</span>
                    {on && <span className="ml-auto text-pink-700 dark:text-pink-300">{t('出戰中')}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── 出發地點 ── */}
      <div className="rounded border border-line bg-panel p-3">
        <div className="mb-2 text-xs font-medium tracking-widest text-mute">{t('🗺️ 出發')}</div>
        <div className="flex flex-wrap gap-2">
          {ZONES.map((z) => (
            <button
              key={z.id}
              title={t(z.desc)}
              className="rounded border border-line2 px-2.5 py-1 text-xs hover:bg-elev disabled:opacity-60 dark:disabled:opacity-40"
              disabled={hero.level < z.minLevel}
              onClick={() => enterZone(z.id)}
            >
              {t(z.name)} <span className="text-mute2">Lv.{z.minLevel}+</span>
            </button>
          ))}
          <span className="mx-1 w-px bg-elev2" />
          {DUNGEONS.map((d) => (
            <button
              key={d.id}
              title={`${t(d.desc)}${t('（需要 {n} 人）', { n: d.partySize })}`}
              className="rounded border border-amber-300 dark:border-amber-700/60 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-200 hover:bg-amber-950/40 disabled:opacity-60 dark:disabled:opacity-40"
              onClick={() => enterDungeon(d.id)}
            >
              🏰 {t(d.name)} <span className="text-amber-500/70">Lv.{d.minLevel}+ · {t('{n}人', { n: d.partySize })}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── 技能 / 裝備 / 背包 ── */}
      <div className="rounded border border-line bg-panel p-3">
        <div className="mb-2 flex gap-2">
          {([
            ['skills', t('技能（{n} 點）', { n: skillPts })],
            ['gear', t('裝備')],
            ['bag', t('背包（{n}）', { n: hero.bag.length })],
            ['shop', t('🏪 商店')],
            ['gacha', t('🎴 抽卡')],
            ['secret', t('🔮 彩蛋')],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              className={`rounded px-2.5 py-1 text-xs ${tab === k ? 'bg-ink text-invink' : 'border border-line2 text-mute hover:bg-elev'}`}
              onClick={() => setTab(k)}
            >{label}</button>
          ))}
        </div>

        {tab === 'skills' && (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {LINES.map((line) => (
              <div key={line}>
                <div className="mb-1 text-xs font-bold" style={{ color: tone(LINE_COLOR[line]) }}>
                  {t(LINE_NAME[line])} <span className="text-mute2">{t('已投 {n} 點', { n: linePoints(lo, line) })}</span>
                </div>
                <div className="flex flex-col gap-1">
                  {SKILLS_OF_LINE(line).map((sk) => {
                    const lv = lo.skills[sk.id] ?? 0
                    const open = skillUnlocked(lo, sk.id)
                    return (
                      <button
                        key={sk.id}
                        title={`${t(sk.desc)}${open ? '' : t('（需要 {line} 投入 {n} 點）', { line: t(LINE_NAME[line]), n: sk.req })}`}
                        className="flex items-center gap-1.5 rounded border border-line px-2 py-1 text-left text-xs hover:bg-elev disabled:opacity-60 dark:disabled:opacity-40"
                        disabled={!open || skillPts <= 0 || lv >= sk.maxLv}
                        onClick={() => addSkill(sk.id)}
                      >
                        <span className={open ? '' : 'text-mute3'}>{t(sk.name)}</span>
                        <span className="ml-auto text-mute2">{lv}/{sk.maxLv}</span>
                        {open && skillPts > 0 && lv < sk.maxLv && <span className="text-emerald-700 dark:text-emerald-400">+</span>}
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
                <div key={s} className="flex items-center gap-2 rounded border border-line px-2 py-1 text-xs">
                  {it ? <ItemIcon it={it} /> : <span className="inline-block h-[22px] w-[22px] flex-none rounded-sm bg-app" />}
                  <span className="w-12 flex-none text-mute2">{t(SLOT_NAME[s])}</span>
                  <div className="min-w-0 flex-1 truncate">
                    {it ? <ItemLine it={it} /> : <span className="text-mute3">{t('（空）')}</span>}
                  </div>
                  {it && <button className="flex-none text-mute2 hover:text-ink2" onClick={() => unequip(s)}>{t('卸下')}</button>}
                </div>
              )
            })}
          </div>
        )}

        {tab === 'bag' && (
          <>
            {/* 篩選列 */}
            <div className="mb-2 flex flex-wrap items-center gap-2 border-b border-line pb-2 text-xs">
              <select
                className="rounded border border-line2 bg-panel px-1.5 py-0.5"
                value={fSlot} onChange={(e) => setFSlot(e.target.value as Slot | 'all')}
              >
                <option value="all">{t('全部部位')}</option>
                {SLOTS.map((s2) => <option key={s2} value={s2}>{t(SLOT_NAME[s2])}</option>)}
              </select>
              <select
                className="rounded border border-line2 bg-panel px-1.5 py-0.5"
                value={fRarity} onChange={(e) => setFRarity(e.target.value as Rarity | 'all')}
              >
                <option value="all">{t('全部品質')}</option>
                {RARITY_ORDER.map((r) => <option key={r} value={r}>{t(RARITY_NAME[r])}</option>)}
              </select>
              <select
                className="rounded border border-line2 bg-panel px-1.5 py-0.5"
                value={fSort} onChange={(e) => setFSort(e.target.value as 'score' | 'ilvl' | 'rarity')}
              >
                <option value="score">{t('依分數')}</option>
                <option value="ilvl">{t('依等級')}</option>
                <option value="rarity">{t('依品質')}</option>
              </select>
              <label className="flex items-center gap-1 text-mute">
                <input type="checkbox" checked={fUpgrade} onChange={(e) => setFUpgrade(e.target.checked)} />
                {t('只看可升級')}
              </label>
              <span className="text-mute3">{bagView.length} / {hero.bag.length}</span>
              <button
                className="ml-auto rounded bg-emerald-700 px-2 py-0.5 text-white hover:bg-emerald-600"
                onClick={equipBest}
              >
                {t('⚡ 一鍵擇優裝備')}
              </button>
              <button
                className="rounded border border-line2 px-2 py-0.5 text-mute hover:bg-elev"
                title={t('每個部位保留最好的三件與裝備中的，其餘賣掉')}
                onClick={sellJunk}
              >
                {t('🧹 清雜物')}
              </button>
            </div>

            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {hero.bag.length === 0 && <div className="text-xs text-mute2">{t('背包空空的，去打點怪吧')}</div>}
              {hero.bag.length > 0 && bagView.length === 0 && (
                <div className="text-xs text-mute2">{t('沒有符合篩選條件的裝備')}</div>
              )}
              {bagView.map((it) => {
                const equipped = Object.values(lo.equipped).includes(it.id)
                const better = !equipped && isUpgrade(hero, it)
                return (
                  <div key={it.id} className="flex items-center gap-2 rounded border border-line px-2 py-1 text-xs">
                    <ItemIcon it={it} />
                    <span className="w-12 flex-none text-mute2">{t(SLOT_NAME[it.slot])}</span>
                    <div className="min-w-0 flex-1 truncate"><ItemLine it={it} dim={equipped} /></div>
                    {better && <span className="flex-none text-emerald-700 dark:text-emerald-400" title={t('比目前裝著的好')}>▲</span>}
                    <span className="flex-none text-mute3">{itemScore(it)}</span>
                    <button
                      className="flex-none text-amber-700 dark:text-amber-400/90 hover:text-amber-300 disabled:opacity-50 dark:disabled:opacity-30"
                      disabled={(it.plus ?? 0) >= MAX_PLUS}
                      title={t('強化到 +{p}：成功 {s}%，碎裂 {d}%，費用 {g} 金', {
                        p: (it.plus ?? 0) + 1,
                        s: Math.round(odds(it.plus ?? 0, hero).success * 100),
                        d: Math.round(odds(it.plus ?? 0, hero).destroy * 100),
                        g: enhanceCost(it),
                      })}
                      onClick={() => doEnhance(it, false)}
                    >⚒</button>
                    {!!(hero.tickets?.protect ?? 0) && odds(it.plus ?? 0, hero).destroy > 0 && (
                      <button
                        className="flex-none text-sky-700 dark:text-sky-400/90 hover:text-sky-300"
                        title={t('用一張保護符強化：失敗也不會碎（剩 {n} 張）', { n: hero.tickets?.protect ?? 0 })}
                        onClick={() => doEnhance(it, true)}
                      >🛡️</button>
                    )}
                    {!equipped && <button className="flex-none text-emerald-700 dark:text-emerald-400 hover:text-emerald-300" onClick={() => equip(it)}>{t('裝備')}</button>}
                    {!equipped && <button className="flex-none text-mute2 hover:text-red-400" onClick={() => sell(it)}>{t('賣')}</button>}
                    {equipped && <span className="flex-none text-mute3">{t('使用中')}</span>}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {tab === 'shop' && (
          <>
            <div className="mb-2 text-[11px] text-mute2">
              {t('身上有 {n} 金。價格會隨等級走，所以任何時候都買得起一點東西。', { n: hero.gold })}
            </div>
            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {SHOP.map((e) => {
                const price = e.price(hero)
                const why = e.blocked?.(hero)
                const poor = hero.gold < price
                return (
                  <button
                    key={e.id}
                    onClick={() => buy(e)}
                    disabled={!!why}
                    title={t(e.desc)}
                    className={`flex flex-col gap-0.5 rounded border px-2.5 py-2 text-left ${
                      why ? 'border-line opacity-40'
                        : poor ? 'border-line hover:bg-elev'
                          : 'border-amber-300 dark:border-amber-700/50 hover:bg-amber-950/30'}`}
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <span>{e.icon}</span>
                      <span className="font-medium text-ink2">{t(e.name)}</span>
                      <span className={`ml-auto ${poor ? 'text-mute3' : 'text-amber-700 dark:text-amber-300'}`}>🪙 {price}</span>
                    </div>
                    <div className="text-[10px] leading-snug text-mute2">{why ? t(why) : t(e.desc)}</div>
                  </button>
                )
              })}
            </div>
          </>
        )}

        {tab === 'gacha' && (
          <>
            <div className="mb-2 text-[11px] text-mute2">
              {t('券打王與超級菁英會掉，也能在商店買。有券優先用券，沒券才扣金幣。十連付九抽的錢，最後一抽保底稀有。')}
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {([
                ['ally', t('🎴 夥伴招募'), hero.tickets?.ally ?? 0, ALLY_PULL_GOLD, rollAllies,
                  t('抽人形夥伴。重複不會浪費，會轉成那一隻的經驗')],
                ['gear', t('⚔️ 裝備召喚'), hero.tickets?.gear ?? 0, GEAR_PULL_GOLD, rollGear,
                  t('抽裝備。有低機率直接掉獨一無二的彩蛋裝備')],
              ] as const).map(([key, title, tickets, price, fn, desc]) => (
                <div key={key} className="rounded border border-line bg-app/50 p-3">
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <span className="font-medium text-ink2">{title}</span>
                    <span className="ml-auto text-mute2">{t('券 {n} 張', { n: tickets })}</span>
                  </div>
                  <div className="mb-2 text-[10px] leading-snug text-mute2">{desc}</div>
                  <div className="flex gap-2">
                    <button
                      className="flex-1 rounded border border-amber-300 dark:border-amber-700/60 px-2 py-1 text-xs text-amber-700 dark:text-amber-200 hover:bg-amber-950/40"
                      onClick={() => fn(1)}
                    >
                      {tickets >= 1 ? t('單抽（用券）') : t('單抽 🪙{n}', { n: price })}
                    </button>
                    <button
                      className="flex-1 rounded border border-amber-300 dark:border-amber-700/60 px-2 py-1 text-xs text-amber-700 dark:text-amber-200 hover:bg-amber-950/40"
                      onClick={() => fn(TEN)}
                    >
                      {tickets >= TEN ? t('十連（用券）') : t('十連 🪙{n}', { n: tenCost(price) })}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {pulls.length > 0 && (
              <div className="mt-3 border-t border-line pt-2">
                <div className="mb-1 text-[10px] tracking-widest text-mute2">{t('抽卡結果')}</div>
                <div className="grid gap-1 md:grid-cols-2 lg:grid-cols-5">
                  {pulls.map((r, i) => (
                    <div key={i} className="rounded border border-line px-2 py-1 text-[11px]">
                      <div className="truncate" style={{ color: tone(r.color) }}>{r.label}</div>
                      <div className="truncate text-[10px] text-mute2">{r.note}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'secret' && (
          <>
            <div className="mb-2 text-[11px] text-mute2">
              {t('藏起來的常駐技能。條件都做得到，但不會不小心達成 —— 沒解鎖時只給線索，自己去湊。')}
            </div>
            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {SECRETS.map((sc) => {
                const got = hero.secrets?.includes(sc.id)
                return (
                  <div
                    key={sc.id}
                    className={`rounded border px-2.5 py-2 ${got ? 'border-violet-300 dark:border-violet-500/60 bg-violet-50 dark:bg-violet-950/25' : 'border-line'}`}
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <span>{got ? '🔮' : '🔒'}</span>
                      <span className={got ? 'font-medium text-violet-700 dark:text-violet-200' : 'text-mute2'}>
                        {got ? t(sc.name) : t('？？？')}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10px] leading-snug text-mute2">
                      {got ? t(sc.desc) : t(sc.hint)}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="mt-2 text-[10px] text-mute3">
              {t('目前：連續陣亡 {a} · 暴擊 {b} · 超級菁英 {c} · 無藥水通關 {d} · 強化碎裂 {e}', {
                a: hero.tally?.deathStreak ?? 0, b: hero.tally?.crits ?? 0,
                c: hero.tally?.superKills ?? 0, d: hero.tally?.cleanClears ?? 0,
                e: hero.tally?.breaks ?? 0,
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
