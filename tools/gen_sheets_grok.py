# -*- coding: utf-8 -*-
"""派工給 Grok CLI：產出龍族員工的動作總表（sprite sheet）

Grok 自己的 game-asset-core 技能明講：一次生成多格 grid 會糊掉，
可靠作法是「逐格生成 + PIL 合成一張乾淨的 sheet」。所以這裡給 Grok 的工單是：
以第一張正面站姿為 canonical 參考，用 image_edit 逐格衍生其餘姿勢，
最後用 PIL 合成 4 欄 × 3 列、每格 256×256 的單一 PNG。

    格位（由左而右、由上而下）
    0  front-stand    1  front-step    2  back-stand   3  back-step
    4  side-stand     5  side-step     6  sit-typing   7  sleeping
    8  arguing        9  coffee       10  reading     11  watering

用法：
    python tools/gen_sheets_grok.py                  # 全部 7 隻（依序）
    python tools/gen_sheets_grok.py kimi             # 只跑指定角色
    python tools/gen_sheets_grok.py kimi --pose 6    # 只重生某一格（會用 canonical 當參考）
"""
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from imagegen import GROK   # noqa: E402  路徑探測交給共用層，不寫死個人目錄
ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "assets-src" / "office-frames"    # 原始生成圖：不放 public，避免被打包進 dist
LOG_DIR = ROOT / "server"
ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}

CELL = 256
COLS, ROWS = 4, 3

POSES = [
    ("front-stand", "standing still, seen from the FRONT facing the viewer, arms relaxed at the sides, both feet together"),
    ("front-step", "seen from the FRONT facing the viewer, mid-stride walking toward the viewer, left leg clearly forward, arms swinging"),
    ("back-stand", "standing still, seen from BEHIND facing away from the viewer, arms relaxed, both feet together"),
    ("back-step", "seen from BEHIND facing away from the viewer, mid-stride walking away, left leg clearly forward, arms swinging"),
    ("side-stand", "standing still in SIDE PROFILE facing right, arms relaxed, both feet together"),
    ("side-step", "in SIDE PROFILE facing right, mid-stride walking to the right, front leg extended forward, arms swinging"),
    ("sit-typing", "sitting on a swivel office chair seen from the front, leaning slightly forward, both hands typing "
                   "on a keyboard resting on its lap. Absolutely no desk and no table in the picture — only the "
                   "character, the chair and the keyboard, because the scene already has its own desk"),
    ("sleeping", "lying down fast asleep on its side, eyes closed, peaceful, curled up comfortably"),
    ("arguing", "standing seen from the front, leaning forward angrily, mouth open shouting, one arm pointing accusingly to the right"),
    ("coffee", "standing seen from the front, holding a steaming coffee mug in one hand, relaxed satisfied expression"),
    ("reading", "standing seen from the front, holding an open book with both hands, head tilted down reading it"),
    ("watering", "standing seen from the front, holding a small watering can and tipping it forward to water a plant"),
]

STYLE = (
    "16-bit SNES JRPG pixel art game sprite, crisp hard-edged pixels, limited palette, "
    "cel shading with a thin dark outline, chibi proportions about two and a half heads tall, "
    "three-quarter top-down game view like Stardew Valley, the whole body fully visible and "
    "centred with its feet near the bottom of the frame, flat pure magenta #FF00FF background, "
    "no text, no watermark, no signature, no border"
)

DRAGONS = {
    "kimi": ("A cool handsome anthropomorphic royal blue dragon office director with sleek deep blue "
             "scales, sharp swept-back horns and calm confident eyes, wearing a crisp white dress shirt, "
             "a dark navy waistcoat and an ID lanyard."),
    "claude": ("A cool handsome anthropomorphic burnt-orange dragon software engineer with warm copper-orange "
               "scales, short curved horns and friendly focused eyes, wearing a rolled-up-sleeve orange shirt "
               "under a beige cardigan with an ID lanyard."),
    "codex": ("A cool handsome anthropomorphic emerald green dragon compliance officer with jade scales, "
              "straight elegant horns and sharp eyes behind thin rectangular glasses, wearing a dark green "
              "blazer over a shirt."),
    "grok": ("A cool handsome anthropomorphic sky-blue dragon creative producer with bright cyan scales, "
             "edgy spiky horns and an energetic grin, wearing a black leather jacket over a blue tee."),
    "qwen": ("A cool elegant anthropomorphic violet-purple dragon, a calm reliable big sister, with deep "
             "violet scales, long graceful curved horns and serene half-lidded eyes, wearing a soft lilac "
             "knitted long cardigan."),
    "cursor": ("A cool laid-back anthropomorphic amber-gold dragon assistant editor with warm amber scales, "
               "small stubby horns and a relaxed easy smile, wearing a grey hoodie with large over-ear "
               "headphones around its neck."),
    "gemini": ("A silly derpy little yellow baby dragon that is deliberately NOT cool and NOT handsome: a "
               "round chubby bright yellow body, tiny useless wings, a stubby tail, huge oversized googly "
               "cartoon eyes with a dopey vacant look, mouth hanging open with a drool drop, tiny nub horns, "
               "and no clothes at all. Adorably dumb and lovable."),
}


def work_order(key: str) -> str:
    frames_dir = RAW / key
    lines = [
        f"你是遊戲美術管線。請為一個像素遊戲角色產出 {len(POSES)} 張動作圖，並合成一張 sprite sheet。",
        "",
        f"角色設定（每一張都必須是同一隻，外觀完全一致）：{DRAGONS[key]}",
        "",
        f"共同風格（每一張都要完整帶上）：{STYLE}",
        "",
        "步驟：",
        f"1. 先用 image_gen 產出第 1 張 front-stand 作為 canonical 參考圖，存成 {frames_dir / '00-front-stand.png'}",
        "2. 其餘每一張都必須用 image_edit 以那張 canonical 參考圖衍生（絕對不要重新 image_gen），",
        "   只描述姿勢的改變，保持鱗片顏色、服裝、角、臉、體型、比例、光線完全一致。",
        "3. 每張圖的角色都要一樣大、腳底位置一致、置中。",
        "",
        "要產的姿勢與檔名：",
    ]
    for i, (name, desc) in enumerate(POSES):
        lines.append(f"   {i:02d}-{name}.png — {desc}")
    lines += [
        "",
        f"4. 全部產完後，用 Python + PIL 合成一張總表：{COLS} 欄 × {ROWS} 列，每格 {CELL}×{CELL} 像素，",
        f"   總尺寸 {COLS * CELL}×{ROWS * CELL}，格子順序就是上面的 00→11，不要畫任何格線或邊框。",
        "   合成前先把每張圖的洋紅色 #FF00FF 背景轉成透明（容差抓寬一點，順便清掉邊緣殘留的洋紅），",
        "   再把角色等比縮放置中、腳底對齊格子底部往上 8 像素。",
        f"   存成 {RAW / (key + '-sheet.png')}（RGBA PNG）。",
        "",
        "5. 最後把 sheet 讀回來檢查：12 格都有角色、同一隻、大小一致、背景透明。",
        "   完成後只輸出一行：DONE <sheet 絕對路徑>",
        "",
        "限制：不要問我問題，不要停下來確認，直接做完。不要動 repo 裡的其他檔案。",
    ]
    return "\n".join(lines)


def pose_order(key: str, idx: int) -> str:
    """只重生單一姿勢：以 canonical 正面站姿為參考，覆寫該格"""
    frames = RAW / key
    name, desc = POSES[idx]
    return "\n".join([
        f"重新產出一張像素角色動作圖，覆蓋掉舊的 {frames / f'{idx:02d}-{name}.png'}。",
        "",
        f"角色設定：{DRAGONS[key]}",
        f"共同風格：{STYLE}",
        "",
        f"作法：用 image_edit，以 {frames / '00-front-stand.png'} 這張 canonical 圖為來源，",
        "只改變姿勢，鱗片顏色、服裝、角、臉、體型、比例、光線都要跟來源完全一致。",
        f"目標姿勢：{desc}",
        "",
        f"存成 {frames / f'{idx:02d}-{name}.png'}（覆蓋舊檔）。",
        "存檔後把圖讀回來確認姿勢正確、背景是純洋紅、角色沒有被裁到。",
        "完成後只輸出一行：DONE <絕對路徑>",
        "",
        "限制：不要問我問題，不要停下來確認，不要動其他檔案。",
    ])


def run_pose(key: str, idx: int) -> bool:
    log_file = LOG_DIR / f"grok-pose-{key}-{idx:02d}.log"
    prompt = pose_order(key, idx)
    with open(log_file, "w", encoding="utf-8") as lf:
        lf.write(f"=== {key} pose {idx} @ {time.strftime('%H:%M:%S')} ===\n{prompt}\n\n--- GROK ---\n")
        lf.flush()
        try:
            subprocess.run(
                [GROK, "-p", prompt, "--permission-mode", "bypassPermissions",
                 "--output-format", "plain", "--max-turns", "30"],
                cwd=str(ROOT), stdout=lf, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, env=ENV, timeout=1200)
        except subprocess.TimeoutExpired:
            lf.write("\n[TIMEOUT]\n")
            return False
    out = RAW / key / f"{idx:02d}-{POSES[idx][0]}.png"
    ok = out.exists()
    print(f"[{key}] pose {idx} {'OK' if ok else 'FAIL'}", flush=True)
    return ok


def run(key: str) -> bool:
    (RAW / key).mkdir(parents=True, exist_ok=True)
    log_file = LOG_DIR / f"grok-sheet-{key}.log"
    prompt = work_order(key)
    t0 = time.time()
    with open(log_file, "w", encoding="utf-8") as lf:
        lf.write(f"=== {key} @ {time.strftime('%H:%M:%S')} ===\n{prompt}\n\n--- GROK ---\n")
        lf.flush()
        try:
            p = subprocess.run(
                [GROK, "-p", prompt, "--permission-mode", "bypassPermissions",
                 "--output-format", "plain", "--max-turns", "80"],
                cwd=str(ROOT), stdout=lf, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, env=ENV, timeout=3600)
            rc = p.returncode
        except subprocess.TimeoutExpired:
            lf.write("\n[TIMEOUT 3600s]\n")
            rc = -1
    sheet = RAW / f"{key}-sheet.png"
    ok = sheet.exists() and sheet.stat().st_size > 5000
    print(f"[{key}] rc={rc} {'OK' if ok else 'NO-SHEET'} {time.time() - t0:.0f}s", flush=True)
    return ok


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    argv = sys.argv[1:]
    pose_idx = None
    if "--pose" in argv:
        i = argv.index("--pose")
        pose_idx = int(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
    targets = [a for a in argv if not a.startswith("-")] or list(DRAGONS)
    if pose_idx is not None:
        for key in targets:
            if key in DRAGONS:
                run_pose(key, pose_idx)
        print("POSE-DONE", flush=True)
        return
    for key in targets:
        if key not in DRAGONS:
            print(f"[{key}] 未知角色，跳過", flush=True)
            continue
        run(key)
    print("ALL-DONE", flush=True)


if __name__ == "__main__":
    main()
