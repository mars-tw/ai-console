# -*- coding: utf-8 -*-
"""接通 Kimi 的生圖／生影片能力

Kimi 桌面版是憑證登入的，所以 agent-gw SDK 直接跑會說「API key not provided」。
金鑰其實就放在桌面版自己的設定檔裡（明文，在使用者自己機器上），這支就負責
把它找出來、連同正式端點一起帶給 SDK。

金鑰解析順序（取第一個有值的）：
    1. KIMI_API_KEY 環境變數
    2. ~/.kimi/agent-gw.json
    3. Kimi 桌面版設定檔 credentials.kimiCode

安全：金鑰只在記憶體裡傳給 SDK，任何情況都不會印出來或寫進 log。
註：桌面版另外有一份 bridge-store/token-store.json 是 OS 金鑰庫加密的，
   這支「不會」也「不該」去解它 —— 有正規設定檔可讀就不必碰加密憑證。

用法：
    python tools/kimi_media.py check
    python tools/kimi_media.py image --description "一顆紅蘋果" --output out.png \\
        [--ratio 1:1] [--resolution 1K] [--background transparent] [--reference URL]
    python tools/kimi_media.py video --description "蘋果掉下來" --output out.mp4 \\
        [--ratio 16:9] [--duration 5] [--audio] [--reference URL]
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.request
from pathlib import Path

HOME = Path(os.path.expanduser("~"))

# Kimi 桌面版設定檔的常見位置（跨平台，不寫死個人目錄）
DESKTOP_CONFIGS = [
    "%APPDATA%/kimi-desktop/daimon-share/daimon/config.json",
    "%LOCALAPPDATA%/kimi-desktop/daimon-share/daimon/config.json",
    "~/Library/Application Support/kimi-desktop/daimon-share/daimon/config.json",
    "~/.config/kimi-desktop/daimon-share/daimon/config.json",
]
# 桌面版自帶的 venv 裡才有 agent_gw，優先用它跑
DESKTOP_PYTHONS = [
    "%APPDATA%/kimi-desktop/daimon-share/daimon/runtime/python/.venv/Scripts/python.exe",
    "%APPDATA%/kimi-desktop/daimon-share/daimon/runtime/python/.venv/bin/python",
    "~/Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/python/.venv/bin/python",
]


def _expand(p: str) -> Path:
    return Path(os.path.expandvars(p)).expanduser()


def find_desktop_python() -> str | None:
    for c in DESKTOP_PYTHONS:
        p = _expand(c)
        if p.exists():
            return str(p)
    return None


def resolve_credentials() -> tuple[str | None, str | None, str]:
    """回傳 (api_key, base_url, 來源說明)。找不到 key 時 api_key 為 None。"""
    env_key = os.environ.get("KIMI_API_KEY")
    if env_key:
        return env_key, os.environ.get("KIMI_BASE_URL"), "KIMI_API_KEY 環境變數"

    cfg = HOME / ".kimi" / "agent-gw.json"
    if cfg.exists():
        try:
            d = json.loads(cfg.read_text(encoding="utf-8"))
            if d.get("api_key"):
                return d["api_key"], d.get("base_url"), str(cfg)
        except (OSError, json.JSONDecodeError):
            pass

    for c in DESKTOP_CONFIGS:
        p = _expand(c)
        if not p.exists():
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        kc = (d.get("credentials") or {}).get("kimiCode") or {}
        if kc.get("apiKey"):
            return kc["apiKey"], kc.get("baseUrl"), f"Kimi 桌面版設定（{p.name}）"
    return None, None, "找不到憑證"


def _client(timeout: float):
    key, base, _src = resolve_credentials()
    if not key:
        raise SystemExit(
            "找不到 Kimi 憑證。可以：\n"
            "  · 登入 Kimi 桌面版（本程式會自動讀它的設定），或\n"
            "  · 設環境變數 KIMI_API_KEY，或\n"
            '  · 建立 ~/.kimi/agent-gw.json 內容 {"api_key": "sk-..."}')
    try:
        from agent_gw import AgentGwClient
    except ImportError:
        raise SystemExit(
            "這個 Python 沒有 agent-gw 套件。請改用 Kimi 桌面版自帶的直譯器：\n"
            f"  {find_desktop_python() or '（找不到，請先安裝 Kimi 桌面版）'}")
    kwargs = {"api_key": key, "timeout": timeout}
    if base:
        kwargs["base_url"] = base
    return AgentGwClient(**kwargs)


def _download(url: str, out: Path) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=300) as r:
        data = r.read()
    out.write_bytes(data)
    return len(data)


def _media_url(resp) -> str:
    """從 ToolResponse 撈出媒體網址"""
    payload = resp.json() if hasattr(resp, "json") else resp
    media = (payload or {}).get("media") or {}
    url = media.get("url")
    if not url:
        raise SystemExit(f"回應裡沒有媒體網址：{str(payload)[:300]}")
    return url


def gen_image(args) -> None:
    out = Path(args.output)
    with _client(180.0) as c:
        resp = c.tools.generate_image(
            args.description,
            ratio=args.ratio, resolution=args.resolution,
            background=args.background,
            reference_image_urls=args.reference or None,
        )
    n = _download(_media_url(resp), out)
    print(f"Saved {out} ({n} bytes)")


def gen_video(args) -> None:
    out = Path(args.output)
    with _client(600.0) as c:
        resp = c.tools.generate_video(
            args.description,
            ratio=args.ratio, resolution=args.resolution,
            duration_seconds=args.duration,
            generate_audio=args.audio or None,
            reference_image_urls=args.reference or None,
        )
    n = _download(_media_url(resp), out)
    print(f"Saved {out} ({n} bytes)")


def check(_args) -> None:
    key, base, src = resolve_credentials()
    print(f"憑證來源：{src}")
    print(f"金鑰：{'有（不顯示內容）' if key else '沒有'}")
    print(f"端點：{base or '（用 SDK 預設，注意預設是 dev 環境）'}")
    py = find_desktop_python()
    print(f"可用直譯器：{py or '找不到 Kimi 桌面版的 Python'}")
    try:
        import agent_gw  # noqa: F401
        print("agent-gw 套件：這個 Python 有")
    except ImportError:
        print("agent-gw 套件：這個 Python 沒有（請改用上面那支直譯器）")


def main() -> None:
    ap = argparse.ArgumentParser(description="Kimi 生圖／生影片")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("check", help="檢查憑證與環境").set_defaults(fn=check)

    pi = sub.add_parser("image", help="生圖")
    pi.add_argument("--description", required=True)
    pi.add_argument("--output", required=True)
    pi.add_argument("--ratio", default="1:1")
    pi.add_argument("--resolution", default="1K")
    pi.add_argument("--background", default="opaque", choices=["opaque", "transparent"])
    pi.add_argument("--reference", action="append", help="參考圖網址，可重複")
    pi.set_defaults(fn=gen_image)

    pv = sub.add_parser("video", help="生影片")
    pv.add_argument("--description", required=True)
    pv.add_argument("--output", required=True)
    pv.add_argument("--ratio", default="16:9")
    pv.add_argument("--resolution", default="720p", help="影片解析度用小寫，例如 720p")
    pv.add_argument("--duration", type=int, default=5)
    pv.add_argument("--audio", action="store_true", help="同時生成聲音")
    pv.add_argument("--reference", action="append", help="參考圖網址，可重複")
    pv.set_defaults(fn=gen_video)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
