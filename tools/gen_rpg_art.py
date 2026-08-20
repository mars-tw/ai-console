# -*- coding: utf-8 -*-
"""冒險模式的美術素材：怪物、戰鬥背景、道具圖示、主角

跟辦公室素材同一套做法 —— 提示詞交給 tools/imagegen.py，本機有哪些能畫圖的 AI
就用哪些，一個後端一個執行緒平行跑，撞額度自動換家。

風格刻意跟辦公室的龍族精靈對齊（16-bit JRPG、硬邊像素、細黑描邊），
這樣切到冒險分頁不會像換了一款遊戲。

用法：
    python tools/gen_rpg_art.py                      # 全部
    python tools/gen_rpg_art.py --only slime wolf    # 指定項目
    python tools/gen_rpg_art.py --group monsters     # 指定類別
    python tools/gen_rpg_art.py --backend kimi
"""
from __future__ import annotations

import queue
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from imagegen import available, generate   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "assets-src" / "rpg-art"
LOG_DIR = ROOT / "server"

PIXEL = ("16-bit SNES JRPG pixel art, crisp hard-edged pixels, limited palette, "
         "cel shading with a thin dark outline, no text, no watermark, no border")

# ── 怪物：側面朝左（面向玩家隊伍），透明背景 ──────────
MON_STYLE = (PIXEL + ", single creature seen in side profile facing LEFT, full body, "
             "standing on nothing, centred with empty space around it, "
             "flat pure magenta #FF00FF background")
MONSTERS: dict[str, str] = {
    "slime": "A small round blue slime with a glossy wobbling body and two simple dot eyes.",
    "rat": "A large scruffy grey-brown rat with a long naked tail, bared yellow teeth and red eyes.",
    "wolf": "A lean grey wolf snarling, fur bristling along its back, amber eyes.",
    "goblin": "A short green goblin in scrappy leather scraps, holding a crude notched dagger, big pointed ears. Shown strictly from the side, its pointed nose and dagger both aimed LEFT.",
    "bandit": "A human highway bandit in a dark hood and worn leather armour, holding a curved sabre, face in shadow.",
    "golem": "A hulking stone golem made of mossy cracked boulders, glowing orange runes in the gaps between rocks. Shown strictly from the side, striding to the LEFT with one arm swinging forward.",
    "wraith": "A tattered floating spectre in torn dark robes, no legs, hollow glowing pale-blue eyes. Shown strictly from the side, drifting to the LEFT with its ragged tail streaming out behind it to the right.",
    "drake": "A young red-scaled dragon with spread leathery wings, snarling, small but fierce.",
    "revenant": "An undead knight in rusted dented plate armour, empty helm with two burning green eyes. Shown strictly from the side, turned to the LEFT with a chipped greatsword raised on that side.",
    "boss-ogre": "A huge muscular ogre chieftain holding a giant wooden club, wearing a fur shoulder pad and tribal paint, small tusks and a big round belly. Shown strictly from the side, body turned LEFT with the club hefted on that side. Boss-sized and imposing.",
    "boss-lich": "A skeletal lich in a tall crown and flowing frost-blue robes, skeletal hands wreathed in icy magic. Shown strictly from the side, facing LEFT with both hands thrust out that way. Boss-sized and imposing.",
    # ── 新區域的怪 ──────────────────────────────
    "sandworm": "A segmented desert worm bursting from sand, ringed maw of teeth, sun-bleached carapace. Shown strictly from the side, lunging LEFT.",
    "scarab": "A large armoured scarab beetle with iridescent blue-green shell and sharp mandibles. Shown strictly from the side, facing LEFT.",
    "icewisp": "A floating shard of living ice with a pale glowing core and drifting frost motes. Shown strictly from the side, drifting LEFT.",
    "yeti": "A shaggy white snow beast with long arms, dark claws and small ice-blue eyes. Shown strictly from the side, striding LEFT.",
    "voidling": "A small blot of living darkness with two white eyes and tendrils of shadow. Shown strictly from the side, facing LEFT.",
    "starseer": "A tall robed figure whose hood contains a swirl of stars instead of a face, holding a bone staff. Shown strictly from the side, turned LEFT.",
    "boss-sandking": "A colossal armoured scorpion king with a jagged tail barb and gold-inlaid carapace. Shown strictly from the side, turned LEFT. Boss-sized and imposing.",
    "boss-frostjarl": "A giant frost jarl in furs and ice-plate armour wielding a huge frozen axe. Shown strictly from the side, turned LEFT. Boss-sized and imposing.",
    "boss-wyrm": "An ancient enormous black dragon with battle-scarred scales, glowing molten cracks and huge spread wings. Boss-sized and imposing.",
}

# ── 戰鬥背景：橫幅，不透明 ─────────────────────────
BG_STYLE = (PIXEL + ", side-on battlefield backdrop for a turn-based RPG, empty ground "
            "across the bottom third with nothing standing on it, atmospheric depth, "
            "no characters, no creatures, no UI")
ZONE_BGS: dict[str, str] = {
    "bg-meadow": "A sunny green meadow with rolling grass, scattered wildflowers and a bright blue sky with fluffy clouds.",
    "bg-forest": "A dim forest of tall dark pines, shafts of pale light through the canopy, mist between the trunks.",
    "bg-ridge": "A rocky mountain pass at dusk, jagged cliffs on both sides, orange sky and distant peaks.",
    "bg-ruins": "A crumbling stone ruin corridor lit by cold blue moonlight, broken pillars and creeping vines.",
    "bg-abyss": "A cavern at the edge of a glowing red chasm, black volcanic rock and drifting embers in the dark.",
    # 地城背景：id 直接對應 DUNGEONS 的 id，戰鬥畫面用 `bg-${placeId}` 取圖
    "bg-cave": "A rough underground goblin cave, damp brown rock walls, crude wooden supports, torches burning in iron sconces.",
    "bg-crypt": "A frozen underground crypt, pale blue ice covering stone sarcophagi and carved pillars, cold mist along the floor.",
    "bg-dunes": "An endless sunlit desert of golden dunes under a pale hot sky, distant rock spires and drifting sand.",
    "bg-glacier": "A blue glacier valley with towering ice walls, frozen waterfalls and pale cold light.",
    "bg-void": "A starlit void with floating shattered stone platforms, deep indigo sky and drifting motes of light.",
    "bg-tomb": "A buried desert tomb interior, sandstone walls with carved hieroglyphs, torchlight and half-buried columns.",
    "bg-rift": "A frozen rift deep in a glacier, jagged ice pillars and an eerie teal glow from below.",
    "bg-lair": "A vast dragon lair deep in a mountain, huge stone arches, piles of gold and bones, dim orange glow from below.",
}

# ── 道具圖示：正方形小圖 ───────────────────────────
ICON_STYLE = (PIXEL + ", a single RPG inventory item icon, object only, seen at a slight "
              "three-quarter angle, centred, filling most of the frame, "
              "flat pure magenta #FF00FF background, no hands, no background scenery")
ITEM_ICONS: dict[str, str] = {
    "icon-sword": "A straight double-edged steel sword with a leather-wrapped grip and a simple crossguard.",
    "icon-axe": "A broad single-bladed battle axe with a heavy wooden haft.",
    "icon-spear": "A long spear with a leaf-shaped steel head and a wrapped shaft.",
    "icon-hammer": "A heavy war hammer with a blocky steel head and a short thick handle.",
    "icon-bow": "A curved wooden short bow with a taut bowstring.",
    "icon-crossbow": "A wooden crossbow with steel prod and a loaded bolt.",
    "icon-dagger": "A slim throwing dagger with a narrow blade and a wrapped grip.",
    "icon-staff": "A gnarled wooden mage staff topped with a glowing blue crystal.",
    "icon-tome": "A thick leather-bound spellbook with brass corners and a ribbon bookmark.",
    "icon-orb": "A polished crystal ball glowing with swirling violet light.",
    "icon-holy": "A golden holy symbol on a chain, radiating a soft warm glow.",
    "icon-helm": "A steel helmet with a nose guard and a small plume.",
    "icon-armor": "A steel breastplate chest armour with riveted straps.",
    "icon-robe": "A folded deep-blue mage robe with gold trim.",
    "icon-gloves": "A pair of reinforced leather gauntlets.",
    "icon-boots": "A pair of sturdy leather travelling boots with buckles.",
    "icon-shield": "A round wooden shield with an iron rim and a central boss.",
    "icon-ring": "A single gold ring set with a glowing gemstone.",
    "icon-potion": "A small round glass flask filled with glowing red liquid, cork stopper.",
    "icon-coin": "A small stack of gold coins.",
}

# ── 主角：跟龍族同格式的動作圖 ─────────────────────
# 主角一律側面朝右：敵人站在畫面右邊，正面站姿看起來像在對著鏡頭發呆，
# 而不是在打怪。朝向跟龍隊友（側面朝右）一致，整排才不會有人面向不同方向。
HERO_STYLE = (PIXEL + ", chibi proportions about two and a half heads tall, "
              "SIDE PROFILE VIEW facing RIGHT, full body visible from the side, "
              "centred, flat pure magenta #FF00FF background")
HERO_DESC = ("A young adventurer with short dark hair, a travel-worn green cloak over "
             "simple leather armour and brown boots. Determined but friendly.")
# 手上不畫武器：武器另外出圖，依實際裝備疊上去，換裝才看得出來。
# 女主角。與男主角同一套姿勢、同一個縮放基準，換角時大小不會跳動。
HEROINE_DESC = ("A young woman adventurer with a long dark ponytail, a travel-worn "
                "burgundy cloak over light scale armour and tall boots. Calm and capable.")
HERO_POSES: dict[str, str] = {
    "hero-stand": ("standing at rest in side view facing right, weight on the back foot, "
                   "the right arm hanging down with the hand open and empty"),
    "hero-attack": ("lunging forward to the right in side view, front leg extended, "
                    "the right arm swung forward and up with the hand open and empty"),
    "hero-cast": ("in side view facing right, leaning back slightly with both arms raised "
                  "forward, glowing motes of light gathering in front of the open hands"),
    "hero-hurt": ("in side view still facing right but recoiling backwards to the left, "
                  "head turned away, one arm raised to shield the face"),
}

# ── 人形夥伴：可以抽到的隊友 ─────────────────────
# 用跟主角同一套風格與朝向（側面朝右、同樣的頭身比），
# 這樣一整排站在戰場左側時比例與視線才會一致 —— 混了正面圖就會很突兀。
# 只出站姿：攻擊的動感由 attackCurve 的位移做，跟龍隊友的處理方式一致。
RECRUIT_STYLE = HERO_STYLE
RECRUITS: dict[str, str] = {
    "ally-knight": ("A stout knight in polished steel plate armour with a dark blue tabard, "
                    "a large tower shield strapped to the left arm, visor up showing a steady face."),
    "ally-ranger": ("A lean ranger in a deep green hooded cloak over leather armour, "
                    "a longbow held at the side, a quiver of arrows on the back."),
    "ally-mage": ("A young witch in a violet robe with a wide pointed hat, "
                  "holding a long wooden staff topped with a small glowing crystal."),
    "ally-cleric": ("A gentle cleric in white and gold layered robes with a hood down, "
                    "holding a small ornate prayer book, a sun pendant at the chest."),
    "ally-rogue": ("A nimble rogue in dark grey leathers with a face scarf pulled down, "
                   "twin daggers held in reverse grip, light and ready to move."),
    "ally-bard": ("A cheerful bard in a red and cream doublet with a feathered cap, "
                  "carrying a wooden lute across the body."),
    "ally-dragoon": ("A dragoon in dark blue armour with a winged helm and a long tapered spear "
                     "held upright, a short cape behind."),
    "ally-miko": ("A shrine maiden in a white top and red hakama with long black hair tied low, "
                  "holding a paper talisman between two fingers."),
}

# 武器單獨出圖，畫面上疊在主角手裡。這樣換武器看得出來，而且不用替
# 每一種武器都重畫一整組主角動作。
WEAPON_STYLE = (PIXEL + ", a single weapon seen from the side with the blade or tip "
                "pointing to the UPPER RIGHT at about 30 degrees, no hand holding it, "
                "no character, centred, flat pure magenta #FF00FF background")
WEAPONS: dict[str, str] = {
    "weapon-melee": "A straight double-edged steel sword with a leather-wrapped grip and a simple crossguard.",
    "weapon-ranged": "A curved wooden short bow with a taut string and one arrow nocked.",
    "weapon-magic": "A gnarled wooden mage staff topped with a glowing blue crystal.",
    "weapon-faith": "A golden ceremonial war mace with a radiant sun emblem on its head.",
}

# ── 寵物：可愛路線，側面朝右跟在隊伍旁邊 ──────────
PET_STYLE = (PIXEL + ", a small cute creature companion, chibi and round, "
             "SIDE PROFILE facing RIGHT, full body, big friendly eyes, "
             "centred, flat pure magenta #FF00FF background")
PETS: dict[str, str] = {
    "pet-slimecat": "A round jelly-cat made of translucent mint-green slime, with a curled tail and a tiny bell.",
    "pet-fluffbird": "A fluffy round bird chick with oversized peach wings, orange beak and a single tall head feather.",
    "pet-emberfox": "A tiny fox kit with warm orange fur and a flame-tipped bushy tail, small and playful.",
    "pet-mossturtle": "A baby turtle with a mossy green shell that has small mushrooms growing on it, sleepy eyes.",
    "pet-starmoth": "A palm-sized moth with soft violet wings dusted with tiny stars, glowing antennae.",
}

# ── 技能特效：手動施放時疊在目標身上的一格大圖 ──────
# 用生成圖而不是純程式畫：刀光可以用程式畫，但「隕星」「烈焰」這種
# 要有質感的東西，畫出來跟畫不出來差很多。
FX_STYLE = (PIXEL + ", a single spell effect on a flat pure magenta #FF00FF background, "
            "the effect only with no character and no ground, centred, "
            "bold readable shapes, strong glow")
SKILL_FX: dict[str, str] = {
    "fx-slash": "Three overlapping white sword slash arcs with sharp motion trails, diagonal.",
    "fx-cleave": "One huge wide crescent sword shockwave in pale blue-white, sweeping horizontally.",
    "fx-shoot": "A streaking arrow with a long white motion trail and a small impact spark at the tip.",
    "fx-volley": "Five arrows in a fan formation with motion trails, all pointing the same way.",
    "fx-bolt": "A jagged violet arcane bolt with crackling energy around it.",
    "fx-flame": "A billowing column of orange and yellow flame with ember sparks.",
    "fx-meteor": "A blazing meteor with a long fiery tail streaking down diagonally, orange and white hot.",
    "fx-smite": "A vertical shaft of golden holy light with radiating rays and small sparkles.",
    "fx-mend": "A ring of soft green healing light with rising sparkles and leaf motes.",
    "fx-execute": "A dark red crescent slash with dripping crimson energy, heavy and final.",
    "fx-snipe": "A single piercing white beam with a crosshair flare at the impact point.",
    "fx-revive": "A wide dome of warm golden light with feathers and rising motes.",
}

GROUPS = {
    "monsters": (MONSTERS, MON_STYLE, "1:1", True),
    "backgrounds": (ZONE_BGS, BG_STYLE, "16:9", False),
    "icons": (ITEM_ICONS, ICON_STYLE, "1:1", True),
    "hero": ({k: f"{HERO_DESC} The character is {v}." for k, v in HERO_POSES.items()},
             HERO_STYLE, "1:1", True),
    "heroine": ({k.replace("hero-", "heroine-"): f"{HEROINE_DESC} The character is {v}."
                 for k, v in HERO_POSES.items()}, HERO_STYLE, "1:1", True),
    "pets": (PETS, PET_STYLE, "1:1", True),
    "skillfx": (SKILL_FX, FX_STYLE, "1:1", True),
    "weapons": (WEAPONS, WEAPON_STYLE, "1:1", True),
    "recruits": (RECRUITS, RECRUIT_STYLE, "1:1", True),
}


def spec(name: str) -> tuple[str, str, bool] | None:
    for items, style, ratio, transparent in GROUPS.values():
        if name in items:
            return f"{items[name]} {style}", ratio, transparent
    return None


def run(name: str, backend: str | None = None) -> str | None:
    got = spec(name)
    if not got:
        print(f"[{name}] 未知項目，跳過", flush=True)
        return None
    prompt, ratio, transparent = got
    out = RAW / f"{name}.png"
    t0 = time.time()
    with open(LOG_DIR / f"rpg-{name}.log", "w", encoding="utf-8") as lf:
        lf.write(f"=== {name} @ {time.strftime('%H:%M:%S')} ===\n{prompt}\n")
        lf.flush()
        used = generate(prompt, out, ratio=ratio, resolution="1K",
                        transparent=transparent, backend=backend, log=lf)
    print(f"[{name}] {used or 'FAIL'} {time.time() - t0:.0f}s", flush=True)
    return used


def run_pool(names: list[str], backends: list[str]) -> None:
    """一個後端一個執行緒；某家失敗就把這件丟回佇列讓別家接手"""
    q: queue.Queue[tuple[str, int]] = queue.Queue()
    for n in names:
        q.put((n, 0))
    lock = threading.Lock()
    done: list[str] = []

    def worker(backend: str):
        while True:
            try:
                name, tries = q.get_nowait()
            except queue.Empty:
                return
            used = run(name, backend)
            with lock:
                if used:
                    done.append(name)
                elif tries + 1 < len(backends):
                    q.put((name, tries + 1))
                else:
                    print(f"[{name}] 所有後端都失敗，放棄", flush=True)
            q.task_done()

    threads = [threading.Thread(target=worker, args=(b,), daemon=True) for b in backends]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print(f"完成 {len(done)} / {len(names)} 件", flush=True)


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    argv = sys.argv[1:]
    backend = None
    if "--backend" in argv:
        i = argv.index("--backend")
        backend, argv = argv[i + 1], argv[:i] + argv[i + 2:]

    if "--group" in argv:
        i = argv.index("--group")
        g = argv[i + 1]
        targets = list(GROUPS[g][0]) if g in GROUPS else []
    elif "--only" in argv:
        targets = argv[argv.index("--only") + 1:]
    else:
        targets = [n for items, *_ in GROUPS.values() for n in items]

    targets = [t for t in targets if spec(t)]
    if not targets:
        print("沒有可產的項目")
        return
    backends = [backend] if backend else available()
    if not backends:
        print("找不到任何能產圖的 AI。設 AI_CONSOLE_GROK / AI_CONSOLE_CODEX / "
              "AI_CONSOLE_QWEN，或登入 Kimi 桌面版。")
        return
    print(f"要產 {len(targets)} 件，後端：{backends}", flush=True)
    run_pool(targets, backends)
    print("RPG-ART-DONE", flush=True)


if __name__ == "__main__":
    main()
