# -*- coding: utf-8 -*-
"""把 AI 產出的辦公室環境圖與家具圖，正規化成引擎直接吃的素材

輸入：assets-src/office-art/{shell,desk,sofa,...}.png
輸出：public/office/props/{name}.png + manifest.json

家具的對齊規則（跟角色精靈不同，這裡是「貼地」而不是「站立」）：
  · 寬度縮放到宣告的格數 × 16px
  · 高度等比跟著跑，往上長出來的部分（螢幕、椅背、葉子）保留
  · 繪製時底部對齊「佔地格的下緣」，所以家具會自然地往上長

用法：python tools/pack_props.py [name ...]
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "assets-src" / "office-art"
OUT = ROOT / "public" / "office" / "props"

TILE = 16
BASE_W, BASE_H = 42 * TILE, 28 * TILE     # 底圖目標尺寸，對應 src/pixel/theme.ts
ALPHA_CUT = 110

# name: (寬格, 高格) —— 必須跟 tools/gen_office_art.py 的 PROPS 一致
FOOTPRINT = {
    "desk": (4, 2), "chair": (1, 1), "meeting-table": (10, 3), "sofa": (9, 2),
    "coffee-table": (5, 2), "coffee-bar": (5, 2), "bookshelf": (5, 2), "armchair": (2, 2),
    "plant-small": (2, 2), "plant-big": (2, 2), "whiteboard": (5, 2), "water-cooler": (1, 2),
    "boxes": (2, 2), "toilet-door": (3, 2), "wall-screen": (5, 1),
    "rug-lounge": (11, 7), "rug-meeting": (18, 9),
}


def is_magenta(r: int, g: int, b: int) -> bool:
    """洋紅去背殘留：紅藍幾乎相等且都偏亮、綠明顯偏低"""
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


def floor_start_tile(img: Image.Image) -> int:
    """量出木地板從第幾格開始。

    生圖模型很容易把俯視地圖畫成低角度透視，牆吃掉半張圖 ——
    那樣所有家具都會落在牆上，所以打包時直接量出來擋掉。
    """
    px = img.convert("RGB").load()
    w, h = img.size
    for ty in range(h // TILE):
        y = ty * TILE + TILE // 2
        row = [px[x, y] for x in range(w // 12, w - w // 12, max(1, w // 40))]
        warm = sum(1 for r, g, b in row if r > 90 and r > b + 30)
        if warm / len(row) > 0.7:
            return ty
    return h // TILE


def pack_shell() -> bool:
    src = RAW / "shell.png"
    if not src.exists():
        print("[shell] 找不到素材，跳過")
        return False
    img = Image.open(src).convert("RGB").resize((BASE_W, BASE_H), Image.LANCZOS)
    start = floor_start_tile(img)
    OUT.mkdir(parents=True, exist_ok=True)
    img.save(OUT / "shell.png")
    verdict = "OK" if start <= 4 else "FAIL 牆太高"
    print(f"[shell] {verdict}  {BASE_W}x{BASE_H}  地板從第 {start} 格開始（需小於等於 4）")
    if start > 4:
        print("        -> 這張底圖的牆佔太多高度，家具會畫到牆上；請重生底圖")
    return start <= 4


# 地毯本來就是實心矩形，四角不透明是正常的，不能套白墊偵測
RECTANGULAR = {"rug-lounge", "rug-meeting"}


def strip_plate(img: Image.Image, name: str) -> Image.Image:
    """拿掉生圖模型自己墊在物件後面的色塊

    模型有時候會把物件畫在一張白卡紙上（卡紙是不透明的，去背去不掉），
    貼到深色牆面就變成一塊突兀的白框。判斷方式很保守：裁切後四個角都
    不透明、而且四角顏色彼此相近 —— 正常去乾淨的物件不會這樣。
    確認是墊板之後，從四邊做容差氾濫填充把它清掉。
    """
    if name in RECTANGULAR:
        return img
    px = img.load()
    w, h = img.size
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    if any(c[3] < 250 for c in corners):
        return img
    ref = corners[0][:3]
    if any(max(abs(a - b) for a, b in zip(c[:3], ref)) > 18 for c in corners):
        return img

    def near(c):
        return c[3] > 0 and max(abs(a - b) for a, b in zip(c[:3], ref)) <= 34

    stack = [(x, y) for x in range(w) for y in (0, h - 1)]
    stack += [(x, y) for y in range(h) for x in (0, w - 1)]
    seen = set()
    while stack:
        x, y = stack.pop()
        if (x, y) in seen or not (0 <= x < w and 0 <= y < h):
            continue
        seen.add((x, y))
        if not near(px[x, y]):
            continue
        px[x, y] = (0, 0, 0, 0)
        stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    print(f"[{name}] 偵測到底板色 {ref}，已清掉 {len(seen)} 點")
    box = img.getbbox()
    return img.crop(box) if box else img


def pack_prop(name: str) -> tuple[int, int] | None:
    src = RAW / f"{name}.png"
    if not src.exists():
        print(f"[{name}] 找不到素材，跳過")
        return None
    tiles_w, _tiles_h = FOOTPRINT[name]
    img = clean(Image.open(src))
    bbox = img.getbbox()
    if not bbox:
        print(f"[{name}] 去背後整張是空的")
        return None
    img = strip_plate(img.crop(bbox), name)

    target_w = tiles_w * TILE
    scale = target_w / img.width
    target_h = max(1, round(img.height * scale))
    img = img.resize((target_w, target_h), Image.LANCZOS)

    # 縮放後把半透明邊硬化，維持像素邊緣
    px = img.load()
    for y in range(target_h):
        for x in range(target_w):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 0) if a < ALPHA_CUT else (r, g, b, 255)

    OUT.mkdir(parents=True, exist_ok=True)
    img.save(OUT / f"{name}.png")
    print(f"[{name}] OK  {target_w}x{target_h}  （佔地 {tiles_w} 格寬）")
    return target_w, target_h


def main():
    targets = [a for a in sys.argv[1:] if not a.startswith("-")]
    if not targets:
        targets = ["shell"] + list(FOOTPRINT)
    sizes: dict[str, list[int]] = {}
    for name in targets:
        if name == "shell":
            pack_shell()
            continue
        if name not in FOOTPRINT:
            print(f"[{name}] 未知項目，跳過")
            continue
        got = pack_prop(name)
        if got:
            sizes[name] = list(got)

    # manifest 累積既有結果，單獨重打一件不會把其他人洗掉
    mf = OUT / "manifest.json"
    prev = json.loads(mf.read_text(encoding="utf-8")).get("props", {}) if mf.exists() else {}
    prev.update(sizes)
    if prev or (OUT / "shell.png").exists():
        OUT.mkdir(parents=True, exist_ok=True)
        mf.write_text(json.dumps({
            "tile": TILE,
            "shell": (OUT / "shell.png").exists(),
            "footprint": {k: list(v) for k, v in FOOTPRINT.items()},
            "props": prev,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"打包完成：{sorted(prev)}")


if __name__ == "__main__":
    main()
