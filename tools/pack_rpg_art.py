# -*- coding: utf-8 -*-
"""把冒險模式的生成圖正規化成引擎用素材

四類素材對齊方式不同，所以分開處理：
  怪物   透明去背 → trim → 依「等級/體型」縮到固定高度 → 腳底對齊格底
  主角   同上，但四個動作共用同一個縮放比例，動畫才不會忽大忽小
  道具   透明去背 → trim → 縮到 32×32 方形圖示
  背景   不透明 → 縮到戰鬥畫面尺寸

輸出：public/office/rpg/{monsters,hero,icons,bg}/*.png + manifest.json

用法：python tools/pack_rpg_art.py [name ...]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "assets-src" / "rpg-art"
OUT = ROOT / "public" / "office" / "rpg"

ALPHA_CUT = 110
ICON = 32                 # 道具圖示邊長
BG_W, BG_H = 480, 270     # 戰鬥背景（16:9，畫面再等比放大）
HERO_H = 56               # 主角站姿高度

# 怪物高度：小怪矮、王高，體型差要看得出來
MON_H = {
    "slime": 30, "rat": 32, "wolf": 40, "goblin": 44, "bandit": 52,
    "golem": 64, "wraith": 58, "drake": 60, "revenant": 62,
    "boss-ogre": 84, "boss-lich": 88, "boss-wyrm": 104,
    "scarab": 34, "sandworm": 62, "icewisp": 40, "yeti": 66,
    "voidling": 30, "starseer": 60,
    "boss-sandking": 92, "boss-frostjarl": 96,
}
HERO_POSES = ["hero-stand", "hero-attack", "hero-cast", "hero-hurt",
              "heroine-stand", "heroine-attack", "heroine-cast", "heroine-hurt"]
# 寵物比主角小一號，跟在隊伍旁邊
PETS = ["pet-slimecat", "pet-fluffbird", "pet-emberfox", "pet-mossturtle", "pet-starmoth"]
PET_H = 26
# 技能特效：疊在角色身上，比角色大一點才有魄力
SKILL_FX = ["fx-slash", "fx-cleave", "fx-shoot", "fx-volley", "fx-bolt", "fx-flame",
            "fx-meteor", "fx-smite", "fx-mend", "fx-execute", "fx-snipe", "fx-revive"]
FX_H = 72
# 武器疊在主角手上，高度抓主角的一半左右才不會比人還大
WEAPONS = ["weapon-melee", "weapon-ranged", "weapon-magic", "weapon-faith"]
WEAPON_H = 23
# 區域 + 地城，id 與 data.ts 的 ZONES / DUNGEONS 一致
BGS = ["bg-meadow", "bg-forest", "bg-ridge", "bg-ruins", "bg-abyss",
       "bg-cave", "bg-crypt", "bg-lair",
       "bg-dunes", "bg-glacier", "bg-void", "bg-tomb", "bg-rift"]


def is_magenta(r: int, g: int, b: int) -> bool:
    """洋紅去背殘留：紅藍幾乎相等且都偏亮、綠明顯偏低（紫色角色不會被誤殺）"""
    return abs(r - b) <= 50 and min(r, b) >= 120 and g <= min(r, b) - 60


def clean(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < ALPHA_CUT or is_magenta(r, g, b):
                px[x, y] = (0, 0, 0, 0)
    return img


def harden(img: Image.Image) -> Image.Image:
    """縮放後把半透明邊硬化，維持像素邊緣"""
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 0) if a < ALPHA_CUT else (r, g, b, 255)
    return img


def trimmed(name: str) -> Image.Image | None:
    src = RAW / f"{name}.png"
    if not src.exists():
        return None
    img = clean(Image.open(src))
    box = img.getbbox()
    return img.crop(box) if box else None


def fit_height(img: Image.Image, target_h: int) -> Image.Image:
    w = max(1, round(img.width * target_h / img.height))
    return harden(img.resize((w, target_h), Image.LANCZOS))


def pack_monsters(names: list[str]) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    (OUT / "monsters").mkdir(parents=True, exist_ok=True)
    for n in names:
        img = trimmed(n)
        if not img:
            print(f"[{n}] 找不到素材，跳過")
            continue
        r = fit_height(img, MON_H.get(n, 44))
        r.save(OUT / "monsters" / f"{n}.png")
        out[n] = [r.width, r.height]
        print(f"[{n}] OK  {r.width}x{r.height}")
    return out


def pack_hero(prefix: str = "hero") -> dict[str, list[int]]:
    """四個動作共用同一比例（由站姿決定），動畫才不會抖。
    男女各自算比例，換角時身高才一致。"""
    stand = trimmed(f"{prefix}-stand")
    if not stand:
        print(f"[{prefix}] 沒有站姿，無法決定比例")
        return {}
    ratio = HERO_H / stand.height
    (OUT / "hero").mkdir(parents=True, exist_ok=True)
    out: dict[str, list[int]] = {}
    for n in [p for p in HERO_POSES if p.startswith(prefix + "-")]:
        img = trimmed(n) or stand
        w = max(1, round(img.width * ratio))
        h = max(1, round(img.height * ratio))
        r = harden(img.resize((w, h), Image.LANCZOS))
        r.save(OUT / "hero" / f"{n}.png")
        out[n] = [w, h]
        print(f"[{n}] OK  {w}x{h}")
    return out


def pack_weapons(names: list[str]) -> dict[str, list[int]]:
    """武器：等比縮到固定高度，畫面上再依姿勢擺到手的位置"""
    (OUT / "weapons").mkdir(parents=True, exist_ok=True)
    out: dict[str, list[int]] = {}
    for n in names:
        img = trimmed(n)
        if not img:
            print(f"[{n}] 找不到素材，跳過")
            continue
        r = fit_height(img, WEAPON_H)
        r.save(OUT / "weapons" / f"{n}.png")
        out[n] = [r.width, r.height]
        print(f"[{n}] OK  {r.width}x{r.height}")
    return out


def pack_pets(names: list[str]) -> dict[str, list[int]]:
    """寵物：等比縮到固定高度，比主角小一號"""
    (OUT / "pets").mkdir(parents=True, exist_ok=True)
    out: dict[str, list[int]] = {}
    for n in names:
        img = trimmed(n)
        if not img:
            print(f"[{n}] 找不到素材，跳過")
            continue
        r = fit_height(img, PET_H)
        r.save(OUT / "pets" / f"{n}.png")
        out[n] = [r.width, r.height]
        print(f"[{n}] OK  {r.width}x{r.height}")
    return out


def pack_fx(names: list[str]) -> dict[str, list[int]]:
    """技能特效：等比縮到固定高度"""
    (OUT / "fx").mkdir(parents=True, exist_ok=True)
    out: dict[str, list[int]] = {}
    for n in names:
        img = trimmed(n)
        if not img:
            print(f"[{n}] 找不到素材，跳過")
            continue
        r = fit_height(img, FX_H)
        r.save(OUT / "fx" / f"{n}.png")
        out[n] = [r.width, r.height]
        print(f"[{n}] OK  {r.width}x{r.height}")
    return out


def pack_icons(names: list[str]) -> list[str]:
    (OUT / "icons").mkdir(parents=True, exist_ok=True)
    done = []
    for n in names:
        img = trimmed(n)
        if not img:
            print(f"[{n}] 找不到素材，跳過")
            continue
        # 等比縮進 32×32 再置中，圖示才不會被拉扁
        img.thumbnail((ICON, ICON), Image.LANCZOS)
        canvas = Image.new("RGBA", (ICON, ICON), (0, 0, 0, 0))
        canvas.alpha_composite(img, ((ICON - img.width) // 2, (ICON - img.height) // 2))
        harden(canvas).save(OUT / "icons" / f"{n}.png")
        done.append(n)
        print(f"[{n}] OK  {ICON}x{ICON}")
    return done


def pack_bgs(names: list[str]) -> list[str]:
    (OUT / "bg").mkdir(parents=True, exist_ok=True)
    done = []
    for n in names:
        src = RAW / f"{n}.png"
        if not src.exists():
            print(f"[{n}] 找不到素材，跳過")
            continue
        Image.open(src).convert("RGB").resize((BG_W, BG_H), Image.LANCZOS).save(OUT / "bg" / f"{n}.png")
        done.append(n)
        print(f"[{n}] OK  {BG_W}x{BG_H}")
    return done


def main() -> None:
    only = [a for a in sys.argv[1:] if not a.startswith("-")]
    mons = [n for n in MON_H if not only or n in only]
    icons = [p.stem for p in RAW.glob("icon-*.png") if not only or p.stem in only]
    bgs = [n for n in BGS if not only or n in only]

    weapons = [n for n in WEAPONS if not only or n in only]
    pets = [n for n in PETS if not only or n in only]
    fxs = [n for n in SKILL_FX if not only or n in only]
    m = pack_monsters(mons)
    wp = pack_weapons(weapons)
    pt = pack_pets(pets)
    fx = pack_fx(fxs)
    h = {}
    for pre in ("hero", "heroine"):
        if not only or any(x in only for x in HERO_POSES if x.startswith(pre + "-")):
            h.update(pack_hero(pre))
    i = pack_icons(icons)
    b = pack_bgs(bgs)

    OUT.mkdir(parents=True, exist_ok=True)
    mf = OUT / "manifest.json"
    prev = json.loads(mf.read_text(encoding="utf-8")) if mf.exists() else {}
    prev.setdefault("monsters", {}).update(m)
    if h:
        prev["hero"] = h
    prev.setdefault("weapons", {}).update(wp)
    prev.setdefault("pets", {}).update(pt)
    prev.setdefault("fx", {}).update(fx)
    prev["icons"] = sorted(set(prev.get("icons", []) + i))
    prev["bg"] = sorted(set(prev.get("bg", []) + b))
    prev["icon"] = ICON
    prev["bgSize"] = [BG_W, BG_H]
    mf.write_text(json.dumps(prev, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"打包完成：怪物 {len(prev['monsters'])}、道具 {len(prev['icons'])}、"
          f"背景 {len(prev['bg'])}、主角 {len(prev.get('hero', {}))}")


if __name__ == "__main__":
    main()
