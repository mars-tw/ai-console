# -*- coding: utf-8 -*-
"""共用產圖層：同一份提示詞，可以交給任何一個裝得到的 AI 去畫

為什麼要這層：
  · 開源之後別人不會剛好有 Grok CLI，也不會有 kimi-desktop 的外掛
  · 單一後端很容易撞額度，一撞整批就停在那裡
  · 不同模型畫出來的味道不一樣，可以挑

所以這裡只做三件事：找出這台機器上有哪些能畫圖的 AI、把提示詞轉成各自的
呼叫方式、批次時輪流派給不同後端（撞牆就換下一家繼續）。

路徑一律用「環境變數 → PATH → 常見安裝位置」的順序尋找，不寫死任何個人目錄。

用法：
    from imagegen import available, generate
    print(available())                       # ['grok', 'kimi']
    generate("a red apple", Path("out.png"), ratio="1:1", transparent=True)
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}


def _find(name: str, env_var: str, candidates: list[str]) -> str | None:
    """環境變數 → PATH → 常見安裝位置。找不到就回 None（代表這個後端不可用）"""
    override = os.environ.get(env_var)
    if override and Path(override).exists():
        return override
    found = shutil.which(name)
    if found:
        return found
    for c in candidates:
        p = Path(os.path.expandvars(c)).expanduser()
        if p.exists():
            return str(p)
    return None


# ── 各後端的執行檔／腳本位置 ────────────────────────
GROK = _find("grok", "AI_CONSOLE_GROK", [
    "~/.grok/bin/grok.exe", "~/.grok/bin/grok",
])
CODEX = _find("codex", "AI_CONSOLE_CODEX", [
    "~/.codex/plugins/.plugin-appserver/codex.exe", "~/.codex/bin/codex",
])
QWEN = _find("qwen", "AI_CONSOLE_QWEN", [
    "%APPDATA%/npm/qwen.cmd", "~/.local/bin/qwen",
])
KIMI_TOOL = _find("", "AI_CONSOLE_KIMI_IMAGEGEN", [
    "%APPDATA%/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/plugins/"
    "managed/image_generation/scripts/image_generation_tool.py",
])
# Kimi 走自己的橋接（tools/kimi_media.py）：桌面版憑證登入時金鑰在它的設定檔裡，
# 所以不需要使用者另外設 KIMI_API_KEY。用桌面版自帶的 Python 跑，那支才有 agent-gw。
try:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from kimi_media import find_desktop_python, resolve_credentials
    _KIMI_KEY, _, _KIMI_SRC = resolve_credentials()
    KIMI_PY = find_desktop_python()
    KIMI_READY = bool(_KIMI_KEY and KIMI_PY)
except Exception:
    KIMI_PY, KIMI_READY, _KIMI_SRC = None, False, "kimi_media 匯入失敗"
KIMI_BRIDGE = Path(__file__).resolve().parent / "kimi_media.py"


def available() -> list[str]:
    """這台機器上實際可用的產圖後端，依「快 → 慢」排序"""
    out = []
    if KIMI_READY:
        out.append("kimi")      # 直接呼叫 API，最快
    if GROK:
        out.append("grok")      # 代理式，慢但穩，OAuth 免 key
    if CODEX:
        out.append("codex")
    if QWEN:
        out.append("qwen")
    return out


# ── 各後端的呼叫方式 ────────────────────────────────
def _run(argv: list[str], log, timeout: int) -> bool:
    try:
        r = subprocess.run(argv, capture_output=True, timeout=timeout, env=ENV)
    except (subprocess.TimeoutExpired, OSError) as e:
        if log:
            log.write(f"[執行失敗] {e}\n")
        return False
    if log:
        out = (r.stdout or b"").decode("utf-8", "ignore") + (r.stderr or b"").decode("utf-8", "ignore")
        log.write(out[-1500:] + "\n")
    return True


def _agent_order(prompt: str, out: Path, ratio: str, resolution: str, transparent: bool) -> str:
    """給代理式後端（Grok / Codex）的工單"""
    bg = "透明背景" if transparent else "不透明背景"
    return "\n".join([
        f"請產出一張圖並存成 {out}。",
        "",
        f"內容：{prompt}",
        "",
        f"比例 {ratio}，解析度 {resolution}，{bg}。",
        "產完把圖讀回來確認內容正確、沒有文字浮水印、主體沒有被裁到。",
        "完成後只輸出一行：DONE <絕對路徑>",
        "",
        "限制：不要問我問題，不要停下來確認，不要動其他檔案。",
    ])


# Kimi 的生圖 API 只吃特定的「比例 × 解析度」組合，送錯會直接 HTTP 400
# （實測 16:9 + 1K 就被打回來）。這裡換成最接近的可用組合，而不是讓整件工作
# 失敗丟給下一家 —— 否則所有橫幅素材永遠輪不到 Kimi 畫。
# 逐一實測出來的（不是猜的）。2026-08-19 用 7 秒逾時探測全部 7×2 組合：
# 送不支援的組合會在 1 秒內回 HTTP 400，支援的會開始產圖。
#   1:1  → 1K, 2K
#   3:2  → 只有 1K
#   2:3  → 只有 1K
#   16:9 → 只有 2K
#   4:3 / 3:4 / 9:16 → 完全不支援
_KIMI_OK = {
    "1:1": ("1K", "2K"),
    "3:2": ("1K",),
    "2:3": ("1K",),
    "16:9": ("2K",),
}
# 不支援的比例改用形狀最接近的：直式退 2:3，橫式退 3:2
_KIMI_FALLBACK = {"3:4": "2:3", "9:16": "2:3", "4:3": "3:2", "1:2": "2:3", "2:1": "16:9"}


def _kimi_size(ratio: str, resolution: str, transparent: bool) -> tuple[str, str]:
    """挑一組 Kimi 真的收的參數；比例不支援就換成形狀最接近的"""
    r = ratio if ratio in _KIMI_OK else _KIMI_FALLBACK.get(ratio, "1:1")
    allowed = _KIMI_OK[r]
    # 透明背景實測只有 1K 出得來；該比例沒有 1K 就用它唯一支援的那個
    want = "1K" if transparent else resolution
    return r, (want if want in allowed else allowed[0])


def _gen_kimi(prompt, out, ratio, resolution, transparent, log, timeout) -> bool:
    r, res = _kimi_size(ratio, resolution, transparent)
    if (r, res) != (ratio, resolution):
        log.write(f"[kimi] {ratio}/{resolution} 不被支援，改用 {r}/{res}")
        log.write("\n")
        log.flush()
    return _run([KIMI_PY, str(KIMI_BRIDGE), "image",
                 "--description", prompt, "--ratio", r, "--resolution", res,
                 "--background", "transparent" if transparent else "opaque",
                 "--output", str(out)], log, timeout)


def _gen_grok(prompt, out, ratio, resolution, transparent, log, timeout) -> bool:
    return _run([GROK, "-p", _agent_order(prompt, out, ratio, resolution, transparent),
                 "--permission-mode", "bypassPermissions",
                 "--output-format", "plain", "--max-turns", "25"], log, timeout)


def _gen_codex(prompt, out, ratio, resolution, transparent, log, timeout) -> bool:
    return _run([CODEX, "exec", "--skip-git-repo-check",
                 _agent_order(prompt, out, ratio, resolution, transparent)], log, timeout)


def _gen_qwen(prompt, out, ratio, resolution, transparent, log, timeout) -> bool:
    return _run([QWEN, "-p", _agent_order(prompt, out, ratio, resolution, transparent)], log, timeout)


BACKENDS = {"kimi": _gen_kimi, "grok": _gen_grok, "codex": _gen_codex, "qwen": _gen_qwen}

# ── 浮水印清除 ────────────────────────────────────
# Kimi 會在左下角壓一行淺灰色的「AI生成」。這個專案要開源，素材不能帶著
# 別家的標記，而且它會直接出現在遊戲畫面上（實測地城背景與地毯都中招）。
# 所以產完就地補掉：確認那個角落真的有一片中性淺色文字之後，
# 拿右邊同一列的材質水平鏡射蓋過去 —— 對岩壁、地毯這種重複紋理接得起來。
# 實測 Kimi 的浮水印落在固定相對位置：x 0.8%–6.1%、y 94.5%–97.5%。
# 框稍微開大一點涵蓋誤差，但不要開到整個下緣，免得誤傷正常內容。
_WM_BOX = (0.00, 0.925, 0.09, 0.995)    # (x0, y0, x1, y1)，畫面佔比
# 浮水印是半透明白字疊在深色上，實際亮度只到 190 左右，不是純白
_WM_LIGHT = 150


def _neutral_light_ratio(px, box, has_alpha: bool) -> tuple[float, float]:
    """回傳 (淺色佔比, 這塊區域有多少比例是實心的)

    第二個值是給誤判用的：透明圖的角落幾乎全空，只要有兩三個亮點就會
    算出很高的佔比 —— icon-spear 就是這樣被誤清過一次。
    """
    x0, y0, x1, y1 = box
    seen = hit = total = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            total += 1
            p = px[x, y]
            if has_alpha and p[3] < 40:
                continue
            seen += 1
            r, g, b = p[0], p[1], p[2]
            if min(r, g, b) > _WM_LIGHT and max(r, g, b) - min(r, g, b) < 30:
                hit += 1
    return (hit / seen if seen else 0.0), (seen / total if total else 0.0)


def strip_watermark(path: Path, log=None) -> bool:
    """偵測到左下角浮水印就補掉。有動手回 True"""
    try:
        from PIL import Image
    except ImportError:
        return False
    img = Image.open(path)
    mode = img.mode if img.mode in ("RGBA", "RGB") else "RGBA"
    img = img.convert(mode)
    has_alpha = mode == "RGBA"
    w, h = img.size
    fx0, fy0, fx1, fy1 = _WM_BOX
    box = (int(w * fx0), int(h * fy0), max(1, int(w * fx1)), int(h * fy1))
    bw = box[2] - box[0]
    if bw < 8 or box[3] - box[1] < 8 or box[2] * 2 > w:
        return False

    px = img.load()
    src = (box[2], box[1], box[2] + bw, box[3])          # 右邊同高度的乾淨區
    here, solid = _neutral_light_ratio(px, box, has_alpha)
    there, _ = _neutral_light_ratio(px, src, has_alpha)
    # 三個條件都要成立才動手：
    #   1. 那塊區域大致是實心的（透明角落不算）
    #   2. 淺色佔比夠高
    #   3. 明顯比右邊同高度的地方亮 —— 否則整片就是本來就亮
    if solid < 0.5 or here < 0.02 or here < there * 3 + 0.01:
        return False

    patch = img.crop(src).transpose(Image.FLIP_LEFT_RIGHT)
    img.paste(patch, (box[0], box[1]))
    img.save(path)
    if log:
        log.write(f"[浮水印] 左下角偵測到 {here:.1%} 淺色文字，已用右側材質補掉")
        log.write("\n")
        log.flush()
    return True


def generate(prompt: str, out: Path, *, ratio: str = "1:1", resolution: str = "1K",
             transparent: bool = False, backend: str | None = None,
             log=None, timeout: int = 1500) -> str | None:
    """產一張圖。回傳實際成功的後端名稱，全部失敗回 None。

    沒指定 backend 時會依序把所有可用後端都試過一輪 —— 一家撞額度就換下一家，
    整批不會卡死在同一個地方。
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    order = [backend] if backend else available()
    if not order or order == [None]:
        if log:
            log.write("[無可用後端] 這台機器上找不到任何能產圖的 AI\n")
        return None
    for name in order:
        fn = BACKENDS.get(name)
        if not fn:
            continue
        if log:
            log.write(f"\n--- 交給 {name} ---\n")
            log.flush()
        before = out.stat().st_mtime if out.exists() else 0
        fn(prompt, out, ratio, resolution, transparent, log, timeout)
        if out.exists() and out.stat().st_size > 5000 and out.stat().st_mtime > before:
            strip_watermark(out, log)
            return name
        if log:
            log.write(f"[{name}] 沒有產出檔案，換下一個後端\n")
            log.flush()
    return None


def _clean_existing(roots: list[Path]) -> None:
    """回溯清理：把已經產好的素材再掃一次浮水印"""
    import sys as _sys
    n = 0
    for root in roots:
        for f in sorted(root.rglob("*.png")):
            if strip_watermark(f, _sys.stdout):
                print(f"  清掉 {f.relative_to(root.parent)}")
                n += 1
    print(f"共處理 {n} 張")


if __name__ == "__main__":
    import sys
    if "--clean" in sys.argv:
        base = Path(__file__).resolve().parent.parent / "assets-src"
        _clean_existing([p for p in base.iterdir() if p.is_dir()])
        raise SystemExit(0)
    print("可用的產圖後端：", available() or "（無）")
    for n, p in [("grok", GROK), ("codex", CODEX), ("qwen", QWEN), ("kimi python", KIMI_PY)]:
        print(f"  {n:16} {p or '找不到'}")
    print(f"  {'kimi 憑證':16} {_KIMI_SRC}")
    if not KIMI_READY:
        print("  註：Kimi 要能用，需要登入桌面版（會自動讀它的設定），或設 KIMI_API_KEY")
