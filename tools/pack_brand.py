# -*- coding: utf-8 -*-
"""把品牌原圖打包成各處要用的圖示

一張原圖要餵四個地方，尺寸與格式都不一樣：
  public/logo.png      512  介面上顯示、README 用
  public/favicon.png    64  瀏覽器分頁
  build/icon.ico    多尺寸  electron-packager 的 --icon（Windows 工作列／捷徑）
  build/icon.png       512  Linux/開發時的視窗圖示

原圖四周通常貼著邊，直接縮成 16px 會糊成一團，所以先 trim 再留邊。

用法：python tools/pack_brand.py [來源圖]
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pack_props import strip_plate   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src" / "brand" / "logo.png"
PUBLIC = ROOT / "public"
BUILD = ROOT / "build"

MARGIN = 0.06          # 四周留白佔邊長比例
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def squared(img: Image.Image) -> Image.Image:
    """去掉透明邊界，置中放進正方形畫布，四周留一點白

    生圖模型很愛把圖案畫在一張白卡紙上（實測這個 LOGO 就是），卡紙是不透明的，
    直接打包出來的工作列圖示外面會多一圈白框。所以先用跟家具打包器同一套
    白墊偵測把卡紙清掉，再做正方形化。
    """
    img = img.convert("RGBA")
    box = img.getbbox()
    if box:
        img = img.crop(box)
    img = strip_plate(img, "logo")
    side = max(img.width, img.height)
    canvas_side = int(side * (1 + MARGIN * 2))
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    canvas.alpha_composite(img, ((canvas_side - img.width) // 2,
                                 (canvas_side - img.height) // 2))
    return canvas


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else SRC
    if not src.exists():
        print(f"找不到原圖：{src}")
        print("先跑一次生圖，或把自己的圖放到 assets-src/brand/logo.png")
        raise SystemExit(1)

    base = squared(Image.open(src))
    PUBLIC.mkdir(parents=True, exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)

    def save(size: int, path: Path) -> None:
        base.resize((size, size), Image.LANCZOS).save(path)
        print(f"  {path.relative_to(ROOT)}  {size}x{size}")

    save(512, PUBLIC / "logo.png")
    save(64, PUBLIC / "favicon.png")
    save(512, BUILD / "icon.png")

    # ICO 一定要多尺寸：只塞 256 的話，工作列縮成 16px 會由系統硬縮，很糊
    ico = BUILD / "icon.ico"
    base.resize((256, 256), Image.LANCZOS).save(
        ico, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"  {ico.relative_to(ROOT)}  {ICO_SIZES}")
    print("圖示打包完成")


if __name__ == "__main__":
    main()
