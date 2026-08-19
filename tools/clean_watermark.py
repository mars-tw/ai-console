# -*- coding: utf-8 -*-
"""像素立繪後處理：清除 AI生成 浮水印（設為透明）"""
import sys
from pathlib import Path
from PIL import Image

OFFICE = Path(__file__).resolve().parent.parent / "public" / "office"


def clean(path: Path):
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    px = img.load()
    # 浮水印區域：左下 x 0-15%, y 92-100%
    for y in range(int(h * 0.915), h):
        for x in range(0, int(w * 0.16)):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 0)
    img.save(path)
    print(f"cleaned: {path.name}")


if __name__ == "__main__":
    files = sys.argv[1:] or [str(p) for p in OFFICE.glob("*.png") if p.stem != "bg"]
    for f in files:
        clean(Path(f))
