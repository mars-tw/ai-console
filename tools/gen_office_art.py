# -*- coding: utf-8 -*-
"""產出俯視辦公室的環境材質與家具配件

拆成材質 + 家具兩層而不是一張大圖，理由有三個：
  1. 家具是獨立精靈，才能做深度排序 —— 角色可以走到沙發、書架後面
  2. 版面座標由程式決定，生圖只負責「長什麼樣」，碰撞格與行為目的地不會跑掉
  3. 某一件不滿意可以單獨重生，不用整張重來

產圖交給 tools/imagegen.py 這層，所以這台機器上裝了哪些能畫圖的 AI 就用哪些，
而且會「一個後端一個執行緒」平行跑 —— 一家撞額度就把工作丟回去給別家接手。

用法：
    python tools/gen_office_art.py                    # 材質 + 全部家具
    python tools/gen_office_art.py --only sofa desk   # 只跑指定項目
    python tools/gen_office_art.py --backend grok     # 指定後端
    python tools/gen_office_art.py --jobs 1           # 單執行緒（除錯用）
"""
import queue
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from imagegen import available, generate   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "assets-src" / "office-art"
LOG_DIR = ROOT / "server"

TILE = 16

# 與龍族精靈同一套風格宣告，兩者要能擺在同一個畫面裡不打架
STYLE = (
    "16-bit SNES JRPG pixel art, crisp hard-edged pixels, limited palette, cel shading "
    "with a thin dark outline, three-quarter top-down game view like Stardew Valley "
    "(seen from above and slightly in front, so the top surface and the front face are "
    "both visible), warm night-time office lighting with cool blue rim light from screens, "
    "no text, no watermark, no signature, no border, no grid lines"
)

# 地毯 / 地面貼圖專用：正投影俯視，明確禁止透視與厚度
FLAT_STYLE = (
    "16-bit SNES JRPG pixel art, crisp hard-edged pixels, limited palette, "
    "orthographic TOP-DOWN view looking straight down at the floor, completely flat with "
    "no perspective, no thickness, no visible side faces, no drop shadow, "
    "no text, no watermark, no border"
)

SHELL_PROMPT = (
    "A TOP-DOWN tile-based game map of a completely EMPTY open-plan office room, exactly "
    "like an interior room in Stardew Valley or Pokemon: the camera looks almost straight "
    "down at the floor. "
    "PROPORTIONS ARE CRITICAL — the far wall must be a THIN BAND across only the TOP 12 "
    "PERCENT of the image. Everything below that band, the remaining 88 percent of the "
    "image, is flat wooden floor seen from above, filling the frame all the way down to "
    "the very bottom edge. Do not draw the room in perspective, do not let the wall take "
    "up half the picture, and do not draw a bottom wall. "
    "The thin top wall band is dark navy-slate and contains a row of tall windows with "
    "thin dark frames, looking out on a night city skyline of dark towers with scattered "
    "warm-yellow and cool-cyan lit windows and a few red aircraft-warning lights. "
    "Narrow dark wall strips run down the far left and far right edges, about 3 percent "
    "of the width each. "
    "The floor is warm mid-brown wooden planks running horizontally, with subtle colour "
    "variation and visible seams, and three soft pools of warm amber light spilling onto "
    "it from ceiling lamps. "
    "The room is completely bare: no desks, no chairs, no tables, no plants, no rugs, no "
    "people, nothing standing on the floor. "
    + STYLE
)



# ── 可平鋪材質：整間房由程式用這些鋪出來 ──────────────
# 生圖模型畫不出「真正的俯視平面圖」（兩次都畫成透視房間，牆吃掉半張圖），
# 但它很會畫小塊的無縫材質。所以環境改成材質 + 程式鋪，比例才抓得住。
TILES: dict[str, tuple[str, str]] = {
    "floor-wood": ("1:1",
        "A seamless tileable texture of warm mid-brown wooden floor planks seen from "
        "DIRECTLY ABOVE, flat with no perspective and no shadows. Horizontal planks with "
        "visible seams, subtle plank-to-plank colour variation and a little grain. "
        "The texture must tile seamlessly: the left edge continues into the right edge and "
        "the top edge continues into the bottom edge."),
    "wall-window": ("1:1",
        "A single seamless tileable wall section for a top-down game map, drawn as a flat "
        "horizontal band seen from the front: a dark navy-slate interior wall containing one "
        "tall window with a thin dark frame, looking out on a night city skyline of dark "
        "towers with scattered warm-yellow and cool-cyan lit windows. A darker skirting "
        "board runs along the very bottom of the band. "
        "It must tile seamlessly side by side: the left and right edges are plain wall so "
        "copies line up into a continuous window run."),
    "wall-plain": ("1:1",
        "A single seamless tileable wall section for a top-down game map, drawn as a flat "
        "horizontal band seen from the front: a plain dark navy-slate interior wall with a "
        "subtle vertical panel seam and a darker skirting board along the very bottom. "
        "It must tile seamlessly side by side."),
}


# name: (寬格, 高格, 生圖比例, 描述)
# 高格 = 佔地板的格數；家具往上長出來的部分（例如螢幕）不算在內，
# 打包時以「寬度對齊格寬、底部對齊佔地底緣」處理，所以超出去是正常的。
PROPS: dict[str, tuple[int, int, str, str]] = {
    "desk": (4, 2, "16:9",
             "A single office workstation seen from a three-quarter top-down view: a wide "
             "warm-wood desk with a dark metal frame, one slim widescreen monitor standing at "
             "the back edge with a glowing blue screen, a dark keyboard and a small mouse on "
             "the desktop, and a white ceramic coffee mug beside them. A small PC tower sits "
             "under the desk."),
    "chair": (1, 1, "1:1",
              "A single dark grey office swivel chair seen from a three-quarter top-down view, "
              "backrest facing away from the viewer, five-star base with castors."),
    "meeting-table": (10, 3, "16:9",
                      "A long light-grey conference table seen from a three-quarter top-down "
                      "view, rounded corners, with four open silver laptops and a few sheets of "
                      "paper and a marker scattered on it. Table only, no chairs."),
    "sofa": (9, 2, "16:9",
             "A long comfortable brown leather couch seen from a three-quarter top-down view, "
             "with a padded backrest, two rolled armrests, three seat cushions and two mustard "
             "yellow throw pillows."),
    "coffee-table": (5, 2, "16:9",
                     "A low wooden coffee table seen from a three-quarter top-down view, with an "
                     "instant noodle cup, an open snack bag and a green soda can on top, and a "
                     "couple of magazines on the shelf underneath."),
    "coffee-bar": (5, 2, "16:9",
                   "A small office coffee station seen from a three-quarter top-down view: a "
                   "dark counter with a stone worktop, a chrome espresso machine with a warm "
                   "amber indicator light standing on it, and three white cups lined up beside "
                   "the machine."),
    "bookshelf": (5, 2, "16:9",
                  "A low wide wooden bookshelf seen from a three-quarter top-down view, two "
                  "shelves packed with colourful book spines in red, blue, green and mustard, "
                  "plus a couple of stacked books lying flat on top."),
    "armchair": (2, 2, "1:1",
                 "A single cosy purple velvet armchair seen from a three-quarter top-down view, "
                 "facing the viewer, with a soft seat cushion and rolled armrests."),
    "plant-small": (2, 2, "1:1",
                    "A small terracotta planter box seen from a three-quarter top-down view, "
                    "full of fresh green leaves with two tiny pink and yellow flowers."),
    "plant-big": (2, 2, "1:1",
                  "A large leafy potted office plant in a terracotta pot seen from a "
                  "three-quarter top-down view, tall broad green leaves fanning upward."),
    "whiteboard": (5, 2, "16:9",
                   "A free-standing office whiteboard on a metal stand seen from a "
                   "three-quarter top-down view, white board surface with a simple hand-drawn "
                   "flow diagram of two boxes joined by an arrow and a couple of bullet lines, "
                   "two sticky notes in yellow and green, and red and blue markers in the tray."),
    "water-cooler": (1, 2, "2:3",
                     "An office water cooler seen from a three-quarter top-down view: a white "
                     "dispenser body with a big clear blue water bottle upside down on top, a "
                     "small tap, and a paper cup."),
    "boxes": (2, 2, "1:1",
              "A small stack of three cardboard shipping boxes seen from a three-quarter "
              "top-down view, slightly askew, sealed with beige packing tape."),
    "toilet-door": (3, 2, "1:1",
                    "A closed restroom door set into a dark office wall, seen from a "
                    "three-quarter top-down view, with a brass handle and a small white sign "
                    "plate above it showing simple blue and pink restroom pictograms."),
    "wall-screen": (5, 1, "16:9",
                    "A large wall-mounted flat-screen display in a thin black bezel seen "
                    "head-on, screen glowing with a simple blue dashboard of bars and lines."),
    "rug-lounge": (11, 7, "3:2",
                   "A large rectangular deep-red persian style area rug seen flat from directly "
                   "above, with a woven gold border and a subtle repeating pattern, slightly "
                   "worn and cosy."),
    "rug-meeting": (18, 9, "16:9",
                    "A large rectangular dark teal office area rug lying flat on the floor, "
                    "photographed straight down from the ceiling. It is a thin piece of "
                    "fabric with a subtle woven texture and a slightly darker border, "
                    "clean and corporate."),
}


def spec(name: str) -> tuple[str, str, str, bool]:
    """回傳 (提示詞, 比例, 解析度, 是否透明)"""
    if name in TILES:
        ratio, desc = TILES[name]
        return (
            f"{desc} 風格：{STYLE}。"
            "最重要的是無縫：把同一張圖左右上下並排時，接縫不能看得出來。"
            "不要畫任何家具、人物、文字或邊框，整張都是材質本身。",
            ratio, "1K", False,
        )
    if name == "shell":
        return SHELL_PROMPT, "3:2", "2K", False
    w, h, ratio, desc = PROPS[name]
    # 地毯是「貼在地板上的一張布」，不能套 STYLE 的三等分俯視 ——
    # 之前套了，模型就把地毯畫成一塊有側面的立體平台，看起來像游泳池。
    if name.startswith("rug-"):
        return (
            f"{desc} 風格：{FLAT_STYLE}。"
            "這是一張平鋪在地上的布，沒有厚度、沒有側面、沒有立體邊緣，"
            "整張圖就是地毯本身的正上方視角，四邊切齊、不要留陰影、不要畫地板。",
            ratio, "1K", True,
        )
    return (
        f"{desc} 風格：{STYLE}。"
        "只畫這一件物件，置中，四周留一點空白，不要畫地板、不要畫陰影底盤、不要畫其他東西。"
        "背景必須完全透明：不要在物件後面墊白色卡紙、白色方塊或任何色塊，"
        "物件的輪廓之外一個像素都不要畫。"
        f"這件家具在遊戲裡佔 {w}×{h} 格（一格 {TILE} 像素），請畫成橫寬比大約 {w}:{h} 的物件；"
        "往上長出來的部分（螢幕、椅背、葉子）可以超出這個比例，那是正常的。",
        ratio, "1K", True,
    )


def run(name: str, backend: str | None = None) -> str | None:
    """產一件。回傳成功的後端名稱，失敗回 None"""
    prompt, ratio, res, transparent = spec(name)
    out = RAW / f"{name}.png"
    log_file = LOG_DIR / f"art-{name}.log"
    t0 = time.time()
    with open(log_file, "w", encoding="utf-8") as lf:
        lf.write(f"=== {name} @ {time.strftime('%H:%M:%S')} ===\n{prompt}\n")
        lf.flush()
        used = generate(prompt, out, ratio=ratio, resolution=res,
                        transparent=transparent, backend=backend, log=lf)
    print(f"[{name}] {used or 'FAIL'} {time.time() - t0:.0f}s", flush=True)
    return used


def run_pool(names: list[str], backends: list[str]) -> None:
    """一個後端一個執行緒，各自從同一個工作佇列拿件。

    某一家失敗（撞額度、畫壞）就把這件丟回佇列，讓別家接手；
    每件最多被重試 len(backends) 次，不會無限繞。
    """
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
                    q.put((name, tries + 1))     # 換一家再試
                else:
                    print(f"[{name}] 所有後端都失敗，放棄", flush=True)
            q.task_done()

    threads = [threading.Thread(target=worker, args=(b,), daemon=True) for b in backends]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print(f"完成 {len(done)} / {len(names)} 件", flush=True)


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    argv = sys.argv[1:]

    backend = None
    if "--backend" in argv:
        i = argv.index("--backend")
        backend = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    jobs = None
    if "--jobs" in argv:
        i = argv.index("--jobs")
        jobs = int(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]

    if "--only" in argv:
        targets = argv[argv.index("--only") + 1:]
    else:
        targets = list(TILES) + list(PROPS)
    targets = [t for t in targets if t == "shell" or t in PROPS or t in TILES]
    if not targets:
        print("沒有可產的項目")
        return

    backends = [backend] if backend else available()
    if not backends:
        print("這台機器上找不到任何能產圖的 AI。可設 AI_CONSOLE_GROK / AI_CONSOLE_CODEX / "
              "AI_CONSOLE_QWEN 指向執行檔，或設 KIMI_API_KEY。")
        return
    if jobs:
        backends = backends[:max(1, jobs)]
    print(f"要產 {len(targets)} 件，後端：{backends}", flush=True)
    run_pool(targets, backends)
    print("ART-DONE", flush=True)


if __name__ == "__main__":
    main()
