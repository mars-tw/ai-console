# -*- coding: utf-8 -*-
"""把 AI 產出的動作總表切格、正規化，打包成引擎直接吃的 sprite sheet

輸入：assets-src/office-frames/{agent}/NN-*.png    （逐格姿勢圖；沒有才退回 {agent}-sheet.png）
輸出：public/office/sprites/{agent}.png            （4 欄 × 3 列，每格 48×48）
      public/office/sprites/manifest.json

正規化做三件事，缺一動畫就會抖：
  1. 每格依 alpha 去除留白，取得真正的角色範圍
  2. 全部格子套用「同一個縮放比例」（由正面站姿決定），比例才不會忽大忽小
  3. 腳底對齊格內固定基準線 FOOT_Y，角色走路時不會上下跳動

用法：python tools/pack_sprites.py [agent ...]
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "assets-src" / "office-frames"    # 原始生成圖（不進 dist）
OUT = ROOT / "public" / "office" / "sprites"

COLS, ROWS = 4, 3
CELL = 48          # 引擎格尺寸
FOOT_Y = 46        # 腳底基準線（格內 y）
STAND_H = 44       # 正面站姿的目標高度，其餘格子等比套用
ALPHA_CUT = 110    # 低於此值的半透明邊緣直接砍掉，避免放大後出現灰邊

# 引擎的約定：側面素材一律朝右，往左走時才由引擎鏡射。
# 目前這批生成圖本來就朝右，所以不需要翻 —— 之前誤翻過一次，
# 結果每隻龍都倒著走。要是換一批素材是朝左的，把名字加進來即可。
SIDE_FLIP: set[str] = set()
SIDE_CELLS = (4, 5)


def is_magenta(r: int, g: int, b: int) -> bool:
    """洋紅去背殘留：紅藍幾乎相等且都偏亮、綠明顯偏低。

    用「紅≈藍」而不是絕對閾值，紫色角色（紅遠低於藍）才不會被誤殺。
    """
    return abs(r - b) <= 50 and min(r, b) >= 120 and g <= min(r, b) - 60


def clean(img: Image.Image) -> Image.Image:
    """砍掉半透明邊緣與殘留的洋紅去背痕跡（含混色出來的粉紅光暈）"""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < ALPHA_CUT or is_magenta(r, g, b):
                px[x, y] = (0, 0, 0, 0)
    return img


def load_cells(agent: str):
    """優先吃單張姿勢圖（好重生某一格），沒有才退回已合成的總表"""
    frame_dir = RAW / agent
    singles = sorted(frame_dir.glob("[0-9][0-9]-*.png")) if frame_dir.is_dir() else []
    if len(singles) >= COLS * ROWS:
        by_index = {int(p.name[:2]): p for p in singles}
        out = []
        for i in range(COLS * ROWS):
            p = by_index.get(i)
            if not p:
                out.append(None)
                continue
            cell = clean(Image.open(p))
            bbox = cell.getbbox()
            out.append(cell.crop(bbox) if bbox else None)
        return out, "單張姿勢圖"

    src_path = RAW / f"{agent}-sheet.png"
    if not src_path.exists():
        return None, ""
    sheet = Image.open(src_path).convert("RGBA")
    cw, ch = sheet.width // COLS, sheet.height // ROWS
    out = []
    for i in range(COLS * ROWS):
        box = ((i % COLS) * cw, (i // COLS) * ch, (i % COLS + 1) * cw, (i // COLS + 1) * ch)
        cell = clean(sheet.crop(box))
        bbox = cell.getbbox()
        out.append(cell.crop(bbox) if bbox else None)
    return out, "合成總表"


def pack(agent: str) -> bool:
    cells, src_kind = load_cells(agent)
    if cells is None:
        print(f"[{agent}] 找不到素材，跳過")
        return False

    if cells[0] is None:
        print(f"[{agent}] 第 0 格（正面站姿）是空的，無法決定比例")
        return False

    # 所有格子共用同一個縮放比例 → 角色大小恆定
    ratio = STAND_H / cells[0].height

    out = Image.new("RGBA", (CELL * COLS, CELL * ROWS), (0, 0, 0, 0))
    missing = []
    for i in range(COLS * ROWS):
        src = cells[i] or cells[0]
        if cells[i] is None:
            missing.append(i)
        w = max(1, round(src.width * ratio))
        h = max(1, round(src.height * ratio))
        frame = src.resize((w, h), Image.LANCZOS)
        # 縮放後再砍一次半透明邊，維持像素硬邊
        px = frame.load()
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                px[x, y] = (r, g, b, 0) if a < ALPHA_CUT else (r, g, b, 255)
        if i in SIDE_CELLS and agent in SIDE_FLIP:
            frame = frame.transpose(Image.FLIP_LEFT_RIGHT)
        # 貼上：水平置中、腳底對齊 FOOT_Y（超出格子就往上裁）
        dx = (i % COLS) * CELL + (CELL - w) // 2
        dy = (i // COLS) * CELL + FOOT_Y - h
        out.alpha_composite(frame, (max(0, dx), max((i // COLS) * CELL, dy)))

    OUT.mkdir(parents=True, exist_ok=True)
    out.save(OUT / f"{agent}.png")
    note = f"（第 {missing} 格缺圖，以站姿代替）" if missing else ""
    print(f"[{agent}] OK  {out.width}×{out.height}  比例 {ratio:.3f}  來源：{src_kind} {note}")
    return True


def main():
    targets = [a for a in sys.argv[1:] if not a.startswith("-")]
    if not targets:
        targets = sorted(p.stem.replace("-sheet", "") for p in RAW.glob("*-sheet.png"))
    for a in targets:
        pack(a)
    # manifest 列出「目前打包好的全部角色」，不只這次跑的
    done = sorted(p.stem for p in OUT.glob("*.png"))
    if done:
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / "manifest.json").write_text(json.dumps({
            "cell": CELL, "footY": FOOT_Y, "cols": COLS, "rows": ROWS,
            "frames": ["front-stand", "front-step", "back-stand", "back-step",
                       "side-stand", "side-step", "sit-typing", "sleeping",
                       "arguing", "coffee", "reading", "watering"],
            "agents": done,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"打包完成：{done}")


if __name__ == "__main__":
    main()
