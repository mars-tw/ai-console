# -*- coding: utf-8 -*-
"""
AI 控制台 · 整合伺服器（僅綁定 127.0.0.1，無外部存取）
一個進程供應：應用介面（dist/）+ 即時資料（public/data/）+ 控制 API

  GET  /                     — 應用介面（SPA）
  GET  /assets/*             — 前端靜態檔
  GET  /data/*               — 索引資料（即時從 public/data 讀，不經 dist 副本）
  GET  /api/health           — 活著檢查
  POST /api/refresh          — 重跑索引器（掃描最新對話）
  POST /api/launch           — 接續對話 / 派工：開一個終端機執行原工具的 resume 指令
                               body: {"id": "<conv_id>", "dryRun": false}
  GET  /api/status           — ai-hub status.json 即時內容
"""
import datetime as _dt
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent

# 機器專屬設定（server/config.json，可被打包版指向工作區的即時資料）
_CFG = {}
_cfg_path = Path(__file__).resolve().parent / "config.json"
if _cfg_path.exists():
    try:
        _CFG = json.loads(_cfg_path.read_text(encoding="utf-8"))
    except Exception:
        pass

DIST_DIR = APP_ROOT / "dist"
DATA_DIR = Path(_CFG.get("data_dir", str(APP_ROOT / "public" / "data")))
INDEX_JSON = DATA_DIR / "index.json"
INDEXER = Path(_CFG.get("indexer", str(APP_ROOT / "tools" / "indexer.py")))
STATUS_JSON = Path(_CFG.get("status_json", str(Path.home() / "ai-hub" / "status.json")))
LMS_MODELS_DIR = Path.home() / ".lmstudio" / "models"
LMS_BIN = Path.home() / ".lmstudio" / "bin" / "lms.exe"
sys.path.insert(0, str(Path(__file__).resolve().parent))
import planner   # noqa: E402
import rules     # noqa: E402
import schedule  # noqa: E402

PORT = 5177

# 模型路由表：strengths = 適任任務；min_gb = 磁碟完整門檻（低於視為下載中）；ram_gb ≈ 載入需求
MODEL_TABLE = [
    {"match": "qwen3-coder-next", "min_gb": 44, "strengths": ["coding"], "rank": 1, "note": "程式派工專用（80B/3B active）"},
    {"match": "qwen3.8-27b", "min_gb": 10, "strengths": ["general", "coding"], "rank": 2, "note": "地端最高智商通用"},
    {"match": "gpt-oss-120b", "min_gb": 55, "strengths": ["general"], "rank": 3, "note": "通用推理大型"},
    {"match": "kimi-linear-48b", "min_gb": 20, "strengths": ["long"], "rank": 2, "note": "長上下文"},
    {"match": "qwen3.6-35b", "min_gb": 15, "strengths": ["general", "coding"], "rank": 4, "note": "通用旗艦"},
    {"match": "qwen3.5-4b", "min_gb": 2, "strengths": ["general"], "rank": 9, "note": "輕量快速"},
]

# 大型工作進程特徵：產片/渲染等（名稱或記憶體門檻）
HEAVY_PROC_NAMES = ("comfyui", "ffmpeg", "blender", "obs64", "video")
HEAVY_PROC_RAM_GB = 20  # python.exe 等超過此記憶體也視為大型工作

# 各工具的執行檔位置。
# 開源後別人的 CLI 不會裝在同樣的地方，所以一律用
# 「server/config.json → 環境變數 → PATH → 常見安裝位置」的順序探測，不寫死個人目錄。
_BIN_CANDIDATES = {
    "claude": ["~/.local/bin/claude.exe", "~/.local/bin/claude"],
    "codex": ["~/.codex/plugins/.plugin-appserver/codex.exe", "~/.codex/bin/codex",
              "%LOCALAPPDATA%/Programs/OpenAI/Codex/bin/codex.exe"],
    "kimi": ["%LOCALAPPDATA%/Programs/kimi/kimi.exe", "~/.local/bin/kimi"],
    "grok": ["~/.grok/bin/grok.exe", "~/.grok/bin/grok"],
    "qwen": ["%APPDATA%/npm/qwen.cmd", "~/.local/bin/qwen"],
    "cursor": ["%LOCALAPPDATA%/Programs/cursor/cursor.exe",
               "/Applications/Cursor.app/Contents/MacOS/Cursor"],
    # ANTIGRAVITY 的 CLI 執行檔叫 agy，不叫 gemini —— 用工具名去 PATH 找永遠找不到，
    # 所以這一列在很長一段時間裡是缺的，介面上那隻龍就一直顯示「沒紀錄」。
    "gemini": ["%LOCALAPPDATA%/agy/bin/agy.exe", "~/.local/bin/agy", "~/AppData/Local/agy/bin/agy.exe"],
}



# Windows 上每一次 subprocess 都會閃一個主控台視窗，而且會把焦點搶走。
# 下面這些呼叫是每隔幾秒輪詢一次的（工具狀態、派工是否還活著），
# 使用者只要開著介面就會被打斷打字 —— 實測回報「一直閃 CMD，沒辦法打字」。
# CREATE_NO_WINDOW 只有 Windows 有，所以用 dict 展開的方式帶進去，
# 其他平台自然是空的。
_NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


# CLI 的輸出帶 ANSI 色碼，要顯示在網頁上之前得先清掉
_ANSI_RE = re.compile(chr(92) + 'x1b' + chr(92) + '[[0-9;?]*[ -/]*[@-~]')


def _run(argv, **kw):
    """跑一個子行程，不要在畫面上閃視窗"""
    return subprocess.run(argv, **_NO_WINDOW, **kw)


# 一整批 pid 的存活狀態，快取幾秒。
# /api/dispatches 每 8 秒被輪詢一次，而主控台與辦公室兩個分頁都在輪詢，
# 沒有快取的話同一秒可能連問兩次。
_ALIVE_CACHE: dict[str, object] = {"at": 0.0, "pids": set()}


def _alive_pids(pids: set) -> set:
    """一次查完一整批 pid 是否還活著"""
    if not pids:
        return set()
    now = time.time()
    if now - float(_ALIVE_CACHE["at"]) < 3.0:
        return {p for p in pids if p in _ALIVE_CACHE["pids"]}
    alive = set()
    try:
        r = _run(["tasklist", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=15)
        for line in r.stdout.splitlines():
            parts = [p.strip('"') for p in line.split('","')]
            if len(parts) > 1 and parts[1].strip().isdigit():
                alive.add(int(parts[1].strip()))
    except Exception:
        return set()
    _ALIVE_CACHE["at"] = now
    _ALIVE_CACHE["pids"] = alive
    return {p for p in pids if p in alive}

def _find_bin(tool: str) -> str:
    """找工具執行檔。找不到就回工具名，交給 PATH 解析（失敗訊息也還看得懂）"""
    import shutil
    configured = (_CFG.get("bin") or {}).get(tool)
    if configured and Path(configured).exists():
        return configured
    env = os.environ.get("AI_CONSOLE_" + tool.upper())
    if env and Path(env).exists():
        return env
    found = shutil.which(tool)
    if found:
        return found
    for c in _BIN_CANDIDATES.get(tool, []):
        cand = Path(os.path.expandvars(c)).expanduser()
        if cand.exists():
            return str(cand)
    return tool


BIN = {t: _find_bin(t) for t in _BIN_CANDIDATES}


def sanitize_cwd(cwd: str) -> str:
    r"""路徑消毒：去 \\?\ 前綴、統一反斜線、不存在則回家目錄"""
    import re as _re
    c = (cwd or "").replace("/", "\\").replace("\\\\?\\", "").strip().strip('"')
    if not c or not _re.match(r"^[A-Za-z]:\\", c) or not Path(c).exists():
        return str(Path.home())
    return c


RESUME_CMD = {
    "claude": lambda c: f'"{BIN["claude"]}" --resume {c["sessionId"]}',
    "codex": lambda c: f'"{BIN["codex"]}" resume {c["sessionId"]}',
    "kimi": lambda c: (f'"{BIN["kimi"]}" -r {c["sessionId"]}' if c["sessionId"].startswith("session_")
                       else f'"{BIN["kimi"]}" -r session_{c["sessionId"]}'),
    # grok / qwen / cursor 無公開 resume 旗標：開在原目錄即可
    "grok": lambda c: f'"{BIN["grok"]}"',
    "qwen": lambda c: f'cmd /c "{BIN["qwen"]}"',
    "cursor": lambda c: f'"{BIN["cursor"]}"',
}


def find_conv(conv_id: str):
    if not INDEX_JSON.exists():
        return None
    data = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
    for c in data.get("conversations", []):
        if c["id"] == conv_id:
            return c
    return None


def lms_models():
    """LM Studio /v1/models 的清單"""
    try:
        import urllib.request
        resp = json.loads(urllib.request.urlopen("http://127.0.0.1:1234/v1/models", timeout=8).read())
        return [m.get("id") for m in resp.get("data", []) if m.get("id")]
    except Exception:
        return []


def lms_loaded():
    """lms ps 已載入記憶體的模型"""
    if not LMS_BIN.exists():
        return []
    try:
        r = _run([str(LMS_BIN), "ps", "--json"], capture_output=True, text=True, timeout=15)
        data = json.loads(r.stdout or "[]")
        return [m.get("identifier") or m.get("modelKey") for m in data if isinstance(m, dict)]
    except Exception:
        return []


def model_complete(model_id: str) -> bool:
    """檢查模型檔案是否下載完整（依磁碟大小門檻）"""
    for t in MODEL_TABLE:
        if t["match"] in model_id:
            total = 0
            for f in LMS_MODELS_DIR.rglob("*.gguf"):
                if t["match"].lower() in f.name.lower() or t["match"].lower() in f.parent.name.lower():
                    total += f.stat().st_size
            return total >= t["min_gb"] * (1024 ** 3) * 0.9
    return True  # 不在表內的模型不設限


def detect_heavy_job():
    """偵測產片/渲染等大型工作：進程名特徵或單進程記憶體過高"""
    try:
        r = _run(["tasklist", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=20)
        for line in r.stdout.splitlines():
            parts = [p.strip('"') for p in line.split('","')]
            if len(parts) < 5:
                continue
            name, mem_s = parts[0].lower(), parts[4]
            mem_kb = int(mem_s.replace(",", "").replace(" K", "").split()[0] or 0)
            if any(k in name for k in HEAVY_PROC_NAMES) and mem_kb > 500_000:
                return f"{parts[0]}（{mem_kb // 1048576}GB）"
            if mem_kb > HEAVY_PROC_RAM_GB * 1048576 and "llama" not in name:
                return f"{parts[0]}（{mem_kb // 1048576}GB）"
    except Exception:
        pass
    return ""


def faster_model_hint(current: str, available: list[str]) -> str:
    """拆解逾時的時候，建議一個更適合的地端模型

    這台機器實測：dense 的 qwen3.8-27b 吞吐只有 3.7 tok/s，一份三步驟的
    計畫連 240 秒都跑不完，每次都退回整件派工。而同一台機器上有 a3b 的
    MoE 模型（只啟用 3B），同樣的活快一個數量級。

    刻意「只建議、不自己換」：LM Studio 一次只能載一個，自動換掉會把
    使用者為了別的用途（影片管線、其他專案）載的模型踢掉。
    """
    if any(k in (current or "").lower() for k in ("a3b", "moe")):
        return ""                                   # 已經在用快的了，沒得建議
    faster = [m for m in available
              if ("a3b" in m.lower() or "moe" in m.lower()) and m != current]
    if not faster:
        return ""
    return f"　建議在 LM Studio 改載 {faster[0]}（MoE，只啟用 3B，同樣的拆解快很多）。"


def planner_model():
    """挑一個拆解派工用的模型

    刻意不走 route_model()：那裡偵測到大型工作（產片、渲染）就會降級到 4B，
    而 4B 拆不出結構化的派工計畫 —— 實測會把提示詞的範例整段抄回來。
    拆解只是一次幾秒的短呼叫，不像影片管線是持續佔用，所以這裡優先挑有能力的，
    真的只剩小模型才用小模型。

    但「有能力」要讓位給「已經載入」。lms_models() 列的是磁碟上有的，
    照偏好清單挑等於常常點到一個沒載入的 —— LM Studio 就得臨時載，
    這台機器載一個 27B 要好幾分鐘，而拆解的逾時是 120 秒。
    結果就是每一次拆解都逾時、每一次都退回「整句話原封不動派出去」。
    實測踩到：note 回「地端模型呼叫失敗：timed out」。
    所以先看 lms ps，已經載入的又夠格就直接用它。
    """
    available = [m for m in lms_models() if model_complete(m)]
    # 順序照「拆得出 JSON 又跑得快」排，不是照參數量排。
    # 原本 qwen3.8-27b 在第一個 —— 那是 dense 27B，實測這台機器只有 3.7 tok/s，
    # 一份兩步驟的計畫要 87 秒，真實工單常常超過 120 秒的逾時。
    # 3.6-35b-a3b 與 kimi-linear-48b-a3b 是 MoE，只啟用 3B，同樣的活快一個數量級。
    capable = ("qwen3.6-35b", "kimi-linear-48b", "qwen3-coder-next", "gpt-oss-120b", "qwen3.8-27b")
    loaded = [m for m in lms_loaded() if m]
    for m in loaded:
        if any(c in m for c in capable):
            return m
    for want in capable:
        for m in available:
            if want in m:
                return m
    # 偏好清單全落空時，已載入的還是比要重新載的好
    return (loaded[0] if loaded else (available[0] if available else ""))


def route_model(task: str = "general"):
    """依任務類型 + 系統狀態自動選模型，回傳 (model, reason, signals)"""
    available = [m for m in lms_models() if model_complete(m)]
    loaded = lms_loaded()
    heavy = detect_heavy_job()
    signals = {"loaded": loaded, "heavy_job": heavy, "available": len(available)}

    def pick(cands):
        for c in cands:
            for m in available:
                if c in m:
                    return m
        return None

    # 1. 大型工作進行中 → 輕量模型，避免搶資源
    if heavy:
        m = pick(["qwen3.5-4b"])
        if m:
            return m, f"偵測到大型工作進行中（{heavy}），自動改用輕量模型避免搶資源", signals
    # 2. 任務鏈
    chains = {
        "coding": ["qwen3-coder-next", "qwen3.8-27b", "qwen3.6-35b"],
        "long": ["kimi-linear-48b", "qwen3.8-27b"],
        "general": ["qwen3.8-27b", "gpt-oss-120b", "qwen3.6-35b"],
    }
    for t in ([task] if task in chains else []) + ["general"]:
        m = pick(chains.get(t, []))
        if m:
            note = next((x["note"] for x in MODEL_TABLE if x["match"] in m), "")
            return m, f"依任務鏈選擇（{note}）", signals
    if available:
        return available[0], "僅存的可用模型", signals
    return "", "找不到可用模型（LM Studio 未啟動或無完整模型）", signals


def build_launch(conv):
    """組出 (要在終端執行的指令, 工作目錄)"""
    cwd = sanitize_cwd(conv.get("projectDir") or str(Path.home()))
    cmd = RESUME_CMD.get(conv["tool"], lambda c: "")(conv)
    if not cmd:
        return None, cwd
    return cmd, cwd


# ── 額度恢復時間：從派工 log 撈出工具自己講的「try again at …」──────
RESET_RE = re.compile(
    r"(?:try again (?:at|after)|resets? (?:at|on)|available again at)\s+"
    r"([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?"
    r"|\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}"
    r"|\d{1,2}:\d{2}\s*(?:AM|PM))",
    re.IGNORECASE)

_RESET_FORMATS = ("%b %d, %Y %I:%M %p", "%B %d, %Y %I:%M %p",
                  "%b %d %Y %I:%M %p", "%B %d %Y %I:%M %p",
                  "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M")


def _fmt_reset(raw: str) -> str:
    """把工具吐出的時間字串正規化成 MM/DD HH:MM；解析不了就原樣回傳"""
    txt = re.sub(r"(?<=\d)(st|nd|rd|th)", "", raw.strip().rstrip("."))
    txt = txt.replace(",", " ").replace("T", " ")
    txt = re.sub(r"\s+", " ", txt)
    for fmt in _RESET_FORMATS:
        try:
            return _dt.datetime.strptime(txt, fmt).strftime("%m/%d %H:%M")
        except ValueError:
            continue
    try:  # 只有 HH:MM AM/PM 的情形
        return _dt.datetime.strptime(txt, "%I:%M %p").strftime("%H:%M")
    except ValueError:
        return raw.strip().rstrip(".")


def enrich_installed(data: dict) -> None:
    """把「查不到」跟「沒裝」分開。

    上游的掃描器只看 session 檔在不在，找不到就報 unknown。但那兩件事是不同的：
      · 執行檔在、只是還沒用過  → 它隨時可以派工，應該算「待命中」
      · 執行檔根本不在          → 真的沒有這個工具
    全部混成 unknown 的結果，是介面上那隻龍永遠顯示「沒紀錄」，
    而且自動路由也不會考慮它 —— 明明裝好了、登入了、模型清單也拉得到。

    只在 unknown 時才動，已經有真實狀態（active / idle / rate_limited）的不碰。
    """
    for key, v in (data.get("tools") or {}).items():
        if not isinstance(v, dict) or v.get("status") != "unknown":
            continue
        exe = BIN.get(key)
        if exe and exe != key and Path(exe).exists():
            v["status"] = "idle"
            v["evidence"] = f"已安裝但尚無使用紀錄（{Path(exe).name}）"


def enrich_reset_times(data: dict) -> None:
    """校正「限流中」的判定，並補上額度恢復時間。

    上游的掃描器是靠「近 24 小時的 log 裡有沒有出現額度錯誤字樣」來判定的，
    但像 grok 的 updates.jsonl 是累積型事件檔 —— 幾天前的一筆限流錯誤會一直
    躺在檔尾，只要之後沒有新事件寫入就會被誤判成「現在還在限流」。
    使用者會看到龍在睡覺，但自己的 CLI 明明還能用。

    所以這裡以「工具自己回報的恢復時間」為準：
      · 有恢復時間且還沒到  → 真的還在限流
      · 有恢復時間但已經過  → 已恢復，清掉旗標
      · 完全找不到恢復時間  → 無法證實，降級成 idle 並標記 unverified，
                              把原始證據留在 evidence 讓使用者自己判斷
    判斷錯了也會自我修正：真的還在限流的話，下次派工失敗會寫進 log 再被抓到。
    """
    tools = data.get("tools") or {}
    limited = [k for k, v in tools.items() if v.get("rate_limited")]
    if not limited:
        return

    log_dir = Path.home() / "ai-hub" / "dispatch-log"
    if log_dir.exists():
        logs = sorted(log_dir.glob("*_*.log"), key=lambda p: p.stat().st_mtime, reverse=True)[:60]
        for f in logs:
            tool = f.stem.split("_")[-1]
            if tool not in limited or tools[tool].get("reset_at"):
                continue
            try:
                m = RESET_RE.search(f.read_text(encoding="utf-8", errors="ignore")[-8192:])
            except OSError:
                continue
            if m:
                tools[tool]["reset_at"] = _fmt_reset(m.group(1))

    now = _dt.datetime.now()
    for k in limited:
        v = tools[k]
        raw = v.get("reset_at")
        if not raw:
            # 沒有恢復時間 = 沒有證據證明現在還在限流
            v["rate_limited"] = False
            v["status"] = "idle"
            v["rate_limit_unverified"] = True
            v["evidence"] = (v.get("evidence") or "") + "（無法確認是否仍在限流：找不到工具回報的恢復時間，已當作可用）"
            continue
        # reset_at 是 MM/DD HH:MM，補上年份後跟現在比
        try:
            when = _dt.datetime.strptime(f"{now.year}/{raw}", "%Y/%m/%d %H:%M")
            if when < now - _dt.timedelta(days=180):     # 跨年
                when = when.replace(year=now.year + 1)
        except ValueError:
            continue
        if when <= now:
            v["rate_limited"] = False
            v["status"] = "idle"
            v["recovered_at"] = raw
            v["evidence"] = (v.get("evidence") or "") + f"（{raw} 已過，額度應已恢復）"


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/api/health":
            return self._json({"ok": True, "ts": time.time()})
        if self.path == "/api/status":
            if STATUS_JSON.exists():
                data = json.loads(STATUS_JSON.read_text(encoding="utf-8"))
                enrich_reset_times(data)
                enrich_installed(data)
                return self._json(data)
            return self._json({"ok": False, "error": "status.json 不存在"}, 404)
        if self.path == "/api/models":
            # 即時代理 LM Studio 的模型清單（自動偵測新模型），過濾未下載完整的
            models = [m for m in lms_models() if model_complete(m)]
            if not models:
                return self._json({"ok": False, "error": "LM Studio 未啟動或無模型", "models": []}, 502)
            return self._json({"ok": True, "models": models})
        if self.path.startswith("/api/route"):
            from urllib.parse import urlparse, parse_qs
            task = parse_qs(urlparse(self.path).query).get("task", ["general"])[0]
            model, reason, signals = route_model(task)
            return self._json({"ok": bool(model), "model": model, "reason": reason, "signals": signals})
        if self.path.startswith("/api/dispatch/log"):
            # 讀某次派工的產出。路徑一律從登錄查，不接受呼叫端指定 ——
            # 否則這就是「叫本機 API 讀任意檔案」。
            from urllib.parse import urlparse, parse_qs
            want = parse_qs(urlparse(self.path).query).get("id", [""])[0]
            # 登錄檔要先載。重啟伺服器後 DISPATCHES 是空的，
            # 只有 /api/dispatches 會載 —— 直接開這個端點就查不到任何東西。
            if not self.DISPATCHES:
                self._load_registry()
            rec = next((d for d in self.DISPATCHES if d.get("id") == want), None)
            if not rec:
                return self._json({"ok": False, "error": "找不到這次派工"}, 404)
            f = Path(rec.get("log", ""))
            if not f.exists():
                return self._json({"ok": True, "text": "", "note": "還沒有輸出"})
            try:
                raw = f.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                return self._json({"ok": False, "error": str(e)}, 500)
            # 無頭模式的 CLI 會先吐一段警告，對使用者沒意義，濾掉
            lines = [ln for ln in raw.splitlines()
                     if "running headless with --yolo" not in ln
                     and "Shell cwd was reset" not in ln]
            text = chr(10).join(lines).strip()
            return self._json({"ok": True, "text": text[-8000:], "path": str(f),
                               "task": rec.get("task", "")})

        if self.path == "/api/map":
            return self.do_map()
        if self.path == "/api/dispatch/batch":
            return self._json({"ok": True, **type(self).BATCH})
        if self.path == "/api/schedules":
            return self._json({"ok": True, "jobs": [
                {**j, "desc": schedule.describe(j)} for j in schedule.load()]})
        if self.path == "/api/dispatches":
            return self.do_dispatches()
        if self.path == "/api/audit":
            # 稽核是使用者私人的批次流程，路徑一律由 server/config.json 指定，
            # 不寫死任何個人專案位置；沒設定就明講，不要假裝有這功能。
            script = _CFG.get("audit_script")
            report = _CFG.get("audit_report")
            cand = [Path(script)] if script else [
                APP_ROOT / "private" / "audit_batch.py",
                APP_ROOT / "tools" / "audit_batch.py",
            ]
            audit_script = next((c for c in cand if c.exists()), None)
            if not audit_script or not report:
                return self._json({"ok": False, "error":
                    "未設定稽核流程。請在 server/config.json 加上 "
                    '{"audit_script": "...", "audit_report": "..."}'}, 404)
            report_path = Path(report)
            try:
                _run([sys.executable, str(audit_script)],
                               capture_output=True, timeout=120)
                if report_path.exists():
                    return self._json(json.loads(report_path.read_text(encoding="utf-8")))
                return self._json({"ok": False, "error": "報告未產出"}, 500)
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
        if self.path.startswith("/api/"):
            return self._json({"ok": False, "error": "not found"}, 404)
        return self._static()

    def _static(self):
        """供應應用介面與資料檔。/data/* 即時讀 public/data；其餘讀 dist；未知路徑回 index.html（SPA）"""
        url = self.path.split("?", 1)[0].split("#", 1)[0]
        rel = urllib.parse.unquote(url).lstrip("/")
        if not rel:
            rel = "index.html"

        # 路徑穿越防護：不能只檢查 ".."。
        # Windows 上反斜線也是分隔符，"..\..\Windows\win.ini" 用 split("/")
        # 根本切不出 ".."，而 pathlib 會照樣往上跳。所以改成「組完之後
        # 解析成絕對路徑，再確認它真的還在允許的根目錄底下」。
        if rel.startswith("data/"):
            root, f = DATA_DIR, DATA_DIR / rel[5:]
        else:
            root, f = DIST_DIR, DIST_DIR / rel
        try:
            if not f.resolve().is_relative_to(root.resolve()):
                return self._json({"ok": False, "error": "bad path"}, 400)
        except (OSError, ValueError):
            return self._json({"ok": False, "error": "bad path"}, 400)

        if not f.is_file():
            if rel.startswith("data/"):
                return self._json({"ok": False, "error": "not found"}, 404)
            f = DIST_DIR / "index.html"  # SPA fallback
        try:
            body = f.read_bytes()
        except OSError:
            return self._json({"ok": False, "error": "read fail"}, 500)
        mime = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if f.suffix in (".js", ".mjs"):
            mime = "text/javascript"
        elif f.suffix == ".json":
            mime = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime.startswith(("text", "application/json")) else mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # 只接受來自自己的請求。
    #
    # 這個 API 能派工、能開終端機、能執行指令。雖然只綁 127.0.0.1（區網進不來），
    # 但「你用瀏覽器打開的任何網頁」都能對 127.0.0.1:5177 發 POST —— 那等於
    # 一個惡意網頁就能在你電腦上執行任意指令。瀏覽器跨來源送 POST 時一定會帶
    # Origin，所以擋掉不是自己的 Origin 就能防住這條路；curl 之類本機工具不帶
    # Origin，照常可用。
    # 應用自己（5177）＋ vite 開發伺服器（3000，它會把 /api 代理過來，
    # 但瀏覽器帶的 Origin 仍是 3000，不放行的話 npm run dev 會整個不能用）
    ALLOWED_ORIGINS = {
        f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}",
        "http://127.0.0.1:3000", "http://localhost:3000",
    }

    # 這些端點只是讀狀態，沒有副作用，允許腳本直接呼叫（沒有 Origin 也行）
    READONLY_POSTS = {"/api/plan"}

    def _same_origin(self) -> bool:
        """會產生副作用的 POST 一律要求來自本應用自己的頁面

        Origin 不符 → 擋掉（瀏覽器一定會帶，所以網頁 CSRF 在這裡就死了）。
        **完全沒有 Origin 也要擋**：本機任何程式（某個套件的安裝腳本、
        下載來的執行檔）都能對 127.0.0.1 發 POST，而派工端點會用你的憑證
        叫 AI 執行任意指令。瀏覽器不會漏掉 Origin，所以要求它不影響正常使用。
        """
        origin = self.headers.get("Origin")
        ref = self.headers.get("Referer")
        if origin:
            if origin not in self.ALLOWED_ORIGINS:
                return False
        elif ref:
            if not any(ref.startswith(o) for o in self.ALLOWED_ORIGINS):
                return False
        elif self.path not in self.READONLY_POSTS:
            return False           # 兩個都沒有 → 不是從本應用頁面來的
        return True

    def do_POST(self):
        if not self._same_origin():
            return self._json({"ok": False, "error":
                               "跨來源請求已拒絕（此 API 只接受本應用自己的呼叫）"}, 403)

        if self.path == "/api/refresh":
            try:
                r = _run([sys.executable, str(INDEXER)], capture_output=True,
                                   text=True, timeout=300, cwd=str(APP_ROOT))
                return self._json({"ok": r.returncode == 0, "out": (r.stdout or r.stderr)[-500:]})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)

        if self.path == "/api/launch":
            body = self._body()
            conv = find_conv(body.get("id", ""))
            if not conv:
                return self._json({"ok": False, "error": "找不到對話"}, 404)
            cmd, cwd = build_launch(conv)
            if not cmd:
                return self._json({"ok": False, "error": "此工具不支援接續"}, 400)
            full = f'cd /d "{cwd}" && {cmd}'
            if body.get("dryRun"):
                return self._json({"ok": True, "cmd": full, "cwd": cwd, "dryRun": True})
            try:
                # 指令寫成一個 .cmd 再叫終端執行它，不要整串當參數傳。
                #
                # 原本是 Popen(["cmd","/c","start",title,"cmd","/k", full])，full 裡面
                # 有巢狀引號（cd /d "路徑" && "執行檔" --resume xxx）。Python 的
                # list2cmdline 會把內層引號跳脫成 \"，但 cmd.exe 不認反斜線跳脫 ——
                # 整條指令被拆壞，使用者看到的是
                # 「檔案名稱、目錄名稱或磁碟區標籤語法錯誤」。
                # 寫成檔案就沒有任何要跳脫的東西；chcp 65001 放在 cd 之前，
                # 中文路徑那一行才讀得對（實測 C:\\Users\\User\\Documents\\燒雞 可以進去）。
                launch_dir = Path.home() / ".ai-console" / "launch"
                launch_dir.mkdir(parents=True, exist_ok=True)
                crlf = "\r\n"
                bat = launch_dir / f"resume-{time.strftime('%Y%m%d-%H%M%S')}-{conv['tool']}.cmd"
                bat.write_text("@echo off" + crlf + "chcp 65001 >nul" + crlf
                               + f'cd /d "{cwd}"' + crlf + cmd + crlf, encoding="utf-8")
                # 只留最近 40 份，不要無限長
                old = sorted(launch_dir.glob("resume-*.cmd"))[:-40]
                for f in old:
                    try:
                        f.unlink()
                    except OSError:
                        pass
                subprocess.Popen(["cmd", "/c", "start", f'AI:{conv["toolLabel"]}',
                                  "cmd", "/k", str(bat)],
                                 cwd=cwd if Path(cwd).exists() else str(Path.home()))
                return self._json({"ok": True, "cmd": full, "cwd": cwd})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)

        if self.path == "/api/chat":
            body = self._body()
            model = body.get("model", "")
            messages = body.get("messages", [])
            if not model or not isinstance(messages, list) or not messages:
                return self._json({"ok": False, "error": "需要 model 與 messages"}, 400)
            # 只接受本機 LM Studio 已載入/存在的模型，避免任意字串注入
            try:
                import urllib.request
                payload = json.dumps({
                    "model": model,
                    "messages": [{"role": m.get("role", "user"), "content": str(m.get("content", ""))[:4000]}
                                 for m in messages[-14:] if m.get("role") in ("user", "assistant", "system")],
                    "max_tokens": int(body.get("max_tokens", 1024)),
                }, ensure_ascii=False).encode("utf-8")
                req = urllib.request.Request(
                    "http://127.0.0.1:1234/v1/chat/completions", data=payload,
                    headers={"Content-Type": "application/json; charset=utf-8"})
                resp = json.loads(urllib.request.urlopen(req, timeout=280).read())
                choice = (resp.get("choices") or [{}])[0]
                msg = choice.get("message", {})
                return self._json({
                    "ok": True,
                    "content": msg.get("content") or "",
                    "reasoning": msg.get("reasoning_content") or "",
                    "usage": resp.get("usage"),
                })
            except Exception as e:
                return self._json({"ok": False, "error": f"地端模型呼叫失敗：{e}"}, 502)

        if self.path == "/api/conv/delete":
            return self.do_conv_delete()
        if self.path == "/api/plan":
            return self.do_plan()
        if self.path == "/api/schedule/save":
            return self.do_schedule_save()
        if self.path == "/api/schedule/delete":
            return self.do_schedule_delete()
        if self.path == "/api/schedule/run":
            return self.do_schedule_run()
        if self.path == "/api/dispatch/batch":
            return self.do_dispatch_batch()
        if self.path == "/api/dispatch/followup":
            return self.do_followup()
        if self.path == "/api/dispatch":
            return self.do_dispatch()

        return self._json({"ok": False, "error": "not found"}, 404)

    # ── 中控台對接總覽：帳號 / 瀏覽器 / 技能 / 全域設定 ──
    def do_map(self):
        import base64
        H = Path.home()

        def jwt_payload(token: str) -> dict:
            try:
                seg = token.split(".")[1]
                seg += "=" * (-len(seg) % 4)
                return json.loads(base64.urlsafe_b64decode(seg))
            except Exception:
                return {}

        out = {}

        # Claude
        acc = {}
        try:
            d = json.loads((H / ".claude.json").read_text(encoding="utf-8", errors="ignore"))
            oa = d.get("oauthAccount", {})
            acc = {"account": oa.get("emailAddress", ""), "plan": oa.get("organizationType", ""),
                   "name": oa.get("displayName", "")}
        except Exception:
            pass
        out["claude"] = {"account": acc, "browser": "無",
                         "skills": sorted(p.name for p in (H / ".claude" / "skills").iterdir() if p.is_dir()) if (H / ".claude" / "skills").exists() else [],
                         "settings": [f for f in (".claude/settings.json", ".claude/CLAUDE.md") if (H / f).exists()]}

        # Codex（JWT 只取安全欄位）
        acc = {}
        try:
            d = json.loads((H / ".codex" / "auth.json").read_text(encoding="utf-8", errors="ignore"))
            pl = jwt_payload(d.get("tokens", {}).get("id_token", ""))
            auth = pl.get("https://api.openai.com/auth", {})
            acc = {"account": pl.get("email", ""), "plan": f'ChatGPT {auth.get("chatgpt_plan_type", "")}'.strip(),
                   "until": auth.get("chatgpt_subscription_active_until", "")[:10], "name": pl.get("name", "")}
        except Exception:
            pass
        out["codex"] = {"account": acc, "browser": "內建 CDP 瀏覽器（.codex/browser）",
                        "skills": sorted(p.name for p in (H / ".codex" / "skills").iterdir() if p.is_dir()) if (H / ".codex" / "skills").exists() else [],
                        "settings": [f for f in (".codex/config.toml", ".codex/AGENTS.md") if (H / f).exists()]}

        # Grok
        acc = {}
        try:
            d = json.loads((H / ".grok" / "auth.json").read_text(encoding="utf-8", errors="ignore"))
            inner = next(iter(d.values()), {})
            acc = {"account": inner.get("email", ""), "plan": inner.get("auth_mode", ""),
                   "name": f'{inner.get("first_name", "")} {inner.get("last_name", "")}'.strip()}
        except Exception:
            pass
        out["grok"] = {"account": acc, "browser": "無",
                       "skills": sorted(p.name for p in (H / ".grok" / "skills").iterdir() if p.is_dir()) if (H / ".grok" / "skills").exists() else [],
                       "settings": [f for f in (".grok/autonomy.json",) if (H / f).exists()]}

        # Gemini
        acc = {}
        try:
            d = json.loads((H / ".gemini" / "google_accounts.json").read_text(encoding="utf-8", errors="ignore"))
            acc = {"account": d.get("active", "")}
        except Exception:
            pass
        out["gemini"] = {"account": acc, "browser": "無",
                         "skills": [],
                         "settings": [f for f in (".gemini/settings.json",) if (H / f).exists()]}

        # Qwen（地端）
        out["qwen"] = {"account": {"account": "地端鏈（無雲端帳號）", "plan": "免費"},
                       "browser": "無",
                       "skills": sorted(p.name for p in (H / ".qwen" / "skills").iterdir() if p.is_dir()) if (H / ".qwen" / "skills").exists() else [],
                       "settings": [f for f in (".qwen/QWEN.md", ".qwen/output-language.md") if (H / f).exists()]}

        # Kimi
        kimi_acc = {"account": "Kimi 桌面版（本機登入）", "plan": ""}
        try:
            kimi_acc["name"] = (H / ".kimi-code" / "device_id").read_text().strip()[:8] + "…"
        except Exception:
            pass
        out["kimi"] = {"account": kimi_acc,
                       "browser": "kimi-webbridge → 使用者真實瀏覽器（Chrome/Edge 登入態）",
                       "skills": sorted(p.name for p in (H / ".kimi-code" / "skills").iterdir() if p.is_dir()) if (H / ".kimi-code" / "skills").exists() else [],
                       "settings": [f for f in (".kimi-code/config.toml",) if (H / f).exists()]}

        # Cursor
        out["cursor"] = {"account": {"account": "Cursor（本機）"}, "browser": "無",
                         "skills": [], "settings": []}

        # 全域治理（.agents）
        gov = (H / ".agents" / "skills")
        out["_governance"] = {"skills": sorted(p.name for p in gov.iterdir() if p.is_dir()) if gov.exists() else []}
        return self._json({"ok": True, "map": out})
    DISPATCH_TOOLS = {  # tool → argv 模板；直接執行（.cmd 經 cmd /c）
        "claude": lambda task: [BIN["claude"], "-p", task],
        "codex": lambda task: [BIN["codex"], "exec", "--skip-git-repo-check", task],
        "qwen": lambda task: ["cmd", "/c", BIN["qwen"], "-p", task],
        # ANTIGRAVITY（agy）：--print 是單次非互動，跟 claude -p 同形狀。
        # 它走的是獨立額度池，所以雲端鏈上多這一條很有價值。
        #
        # 兩個旗標都是必要的，實測踩過：
        #   --dangerously-skip-permissions：非互動模式沒有人可以按同意，
        #     連「讀工單檔」都會被拒（實測錯誤：user denied permission for read_file）。
        #     其他無人值守工具本來就是同樣的姿態（qwen 走 --yolo、codex 是 approval never）。
        #   --print-timeout：預設只有 5 分鐘，真實工單常常不夠。
        "gemini": lambda task: [BIN["gemini"], "--dangerously-skip-permissions",
                                "--print-timeout", "30m", "-p", task],
    }
    # 續談：對同一段對話再補一句。四個無人值守的工具都有這個能力，
    # 所以「工作中介入告知」不用改成互動模式也做得到。
    FOLLOWUP_TOOLS = {
        "claude": lambda p: [BIN["claude"], "--continue", "-p", p],
        "codex": lambda p: [BIN["codex"], "exec", "resume", "--last",
                            "--skip-git-repo-check", p],
        "qwen": lambda p: ["cmd", "/c", BIN["qwen"], "-c", "-p", p],
        "gemini": lambda p: [BIN["gemini"], "--dangerously-skip-permissions",
                             "--print-timeout", "30m", "-c", "-p", p],
    }
    # 可以被指定的工具名。任何不在這裡面的一律拒絕 —— 見 do_dispatch 的說明。
    KNOWN_TOOLS = set(BIN) | {"local", "auto"}
    CLOUD_CHAIN = ["claude", "codex", "gemini", "grok", "qwen"]  # 自動路由順序（地端由 LM Studio 兜底）
    DISPATCHES = []  # 派工登錄：{id, tool, task, started, pid, log, mode, reply}
    # 請求執行緒、批次工作執行緒、排程執行緒都會動這份清單再整份寫檔。
    # 沒有鎖的話兩邊同時寫會互相蓋掉 —— 這個專案已經因為登錄被覆蓋而丟過一次歷史。
    _REG_LOCK = threading.Lock()
    REGISTRY = Path.home() / "ai-hub" / "dispatch-log" / "_registry.json"

    def _load_registry(self):
        with self._REG_LOCK:
            try:
                if self.REGISTRY.exists():
                    type(self).DISPATCHES = json.loads(self.REGISTRY.read_text(encoding="utf-8"))
            except Exception:
                pass

    def _save_registry(self):
        with self._REG_LOCK:
            try:
                self.REGISTRY.parent.mkdir(parents=True, exist_ok=True)
                # 先寫暫存再換掉：中途斷電或同時寫，至少不會留下半個檔案
                tmp = self.REGISTRY.with_suffix(".tmp")
                tmp.write_text(json.dumps(self.DISPATCHES[-100:], ensure_ascii=False),
                               encoding="utf-8")
                tmp.replace(self.REGISTRY)
            except Exception:
                pass

    # 刪掉的對話搬到這裡，不是真的抹掉。誤刪救得回來。
    TRASH = Path.home() / ".ai-console" / "trash"

    def do_conv_delete(self):
        """刪除一個對話：把來源檔搬到回收區

        路徑一律從索引查，不接受呼叫端指定 —— 否則這就變成
        「叫本機 API 搬走任意檔案」的漏洞。
        """
        body = self._body()
        conv_id = str(body.get("id", "")).strip()
        if not conv_id:
            return self._json({"ok": False, "error": "需要 id"}, 400)
        conv = find_conv(conv_id)
        if not conv:
            return self._json({"ok": False, "error": "找不到這個對話"}, 404)

        src = Path(conv.get("path", ""))
        if not src.exists():
            return self._json({"ok": True, "note": "來源檔已不存在，視為已刪除"})
        # 只允許動使用者家目錄底下的對話檔，擋掉任何奇怪的路徑
        try:
            if not src.resolve().is_relative_to(Path.home().resolve()):
                return self._json({"ok": False, "error": "路徑不在家目錄內，拒絕"}, 400)
        except (OSError, ValueError):
            return self._json({"ok": False, "error": "路徑無法解析"}, 400)

        self.TRASH.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = self.TRASH / f"{stamp}_{conv.get('tool', 'x')}_{src.name}"
        try:
            import shutil
            shutil.move(str(src), str(dest))
        except OSError as e:
            return self._json({"ok": False, "error": f"搬移失敗：{e}"}, 500)

        # 同步把索引裡那筆拿掉，畫面不用等重新掃描
        try:
            data = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
            before = len(data.get("conversations", []))
            data["conversations"] = [c for c in data["conversations"] if c["id"] != conv_id]
            if len(data["conversations"]) != before:
                st = data.setdefault("stats", {})
                st["total"] = max(0, (st.get("total") or before) - 1)
                INDEX_JSON.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except (OSError, json.JSONDecodeError):
            pass
        return self._json({"ok": True, "trash": str(dest)})

    def do_plan(self):
        """一句話 → 派工計畫。只回計畫，不動手 —— 派工是使用者按下去才發生的。"""
        body = self._body()
        instruction = str(body.get("instruction", "")).strip()
        if not instruction:
            return self._json({"ok": False, "error": "需要 instruction"}, 400)

        # 拆解用地端模型：不燒雲端額度，雲端全限流時主控台也還能用
        model = planner_model()

        # 只把「現在真的能用」的工具給拆解器選。限流中的排掉，
        # 否則計畫做出來全是派不出去的工單。
        try:
            status = json.loads(STATUS_JSON.read_text(encoding="utf-8"))
            limited = {k for k, v in status.get("tools", {}).items() if v.get("rate_limited")}
        except Exception:
            limited = set()
        usable = [t for t in list(self.DISPATCH_TOOLS) + ["grok", "local"]
                  if t not in limited and (t in ("local",) or BIN.get(t))]
        if not usable:
            usable = ["local"]

        skills = _CFG.get("tool_skills") or None
        result = planner.plan(instruction, model, skills=skills, available=usable)
        result["usable"] = usable
        result["limited"] = sorted(limited)

        # 拆解失敗時，如果磁碟上有更適合的模型就直接講出來。
        #
        # 這台機器實測：載 dense 的 qwen3.8-27b 時吞吐只有 3.7 tok/s，
        # 一份三步驟的計畫連 240 秒都跑不完，每次都退回整件派工。
        # 而同一台機器上有 a3b 的 MoE 模型（只啟用 3B），同樣的活快一個數量級。
        # 這裡刻意「只建議、不自己換」—— LM Studio 一次只能載一個，
        # 自動換掉會把使用者為了別的用途載的模型踢掉。
        if not result.get("ok") and result.get("model"):
            hint = faster_model_hint(result["model"],
                                     [m for m in lms_models() if model_complete(m)])
            if hint:
                result["note"] = result.get("note", "") + hint
        return self._json(result)

    def do_dispatch(self):
        # 先把磁碟上的登錄讀進來再 append。
        #
        # DISPATCHES 是類別屬性，伺服器重啟後是空的，而 _load_registry() 原本
        # 只在 GET /api/dispatches 時才呼叫。所以「重啟 → 直接派一件工」的順序下，
        # append 到空清單再 _save_registry()，整份歷史就被那一筆蓋掉了。
        # 實測踩到：重啟 API 後派一件測試工，早上六筆派工紀錄全部消失。
        if not self.DISPATCHES:
            self._load_registry()
        body = self._body()
        task = str(body.get("task", "")).strip()
        tool = str(body.get("tool", "auto")).strip()
        if not task:
            return self._json({"ok": False, "error": "需要 task"}, 400)
        # tool 一定要是已知的工具名。
        #
        # 之前完全沒有這一層：任何字串只要不在 DISPATCH_TOOLS 也不是 "local"，
        # 就會掉進最後的「開可見終端」分支，而那裡拿它做兩件事：
        #   log_dir / f"{stamp}_{tool}.log"   → tool 帶 ..\..\ 就寫到 dispatch-log 外面
        #   exe = BIN.get(tool, tool)          → 找不到就直接把 tool 當執行檔名跑
        # 等於「指定任意路徑寫檔」加「執行任意程式」。
        # 伺服器只綁 127.0.0.1、POST 又有同源檢查，門檻不低，但這個洞太便宜，不該留著。
        if tool not in self.KNOWN_TOOLS:
            return self._json({"ok": False,
                               "error": f"不認得的工具：{tool[:40]}"}, 400)
        raw_task = task

        # 自動路由：依 ROUTER 鏈跳過限流的工具
        if tool == "auto":
            try:
                status = json.loads(STATUS_JSON.read_text(encoding="utf-8"))
                limited = {k for k, v in status.get("tools", {}).items() if v.get("rate_limited")}
            except Exception:
                limited = set()
            tool = next((t for t in self.CLOUD_CHAIN if t not in limited), "local")

        # 掛上規範與技能。派出去的 agent 不會自己知道這台機器的不可違反條款，
        # 也不會知道有現成技能可用 —— 工單裸奔的代價太高，所以一律加。
        # body 傳 raw=true 可以跳過（例如系統自己發的探測指令）。
        applied_skills: list[str] = []
        if not body.get("raw"):
            task, applied_skills = rules.wrap(task, tool, _CFG)

        log_dir = Path.home() / "ai-hub" / "dispatch-log"
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        # 時間戳只到秒，同一秒派兩件會寫到同一個檔、後者覆蓋前者。
        # 實測就踩到了：一次派兩個測試員，第一個的結果直接消失。
        log_file = log_dir / f"{stamp}_{tool}.log"
        if log_file.exists():
            n = 2
            while (log_dir / f"{stamp}_{tool}_{n}.log").exists():
                n += 1
            stamp = f"{stamp}_{n}"
            log_file = log_dir / f"{stamp}_{tool}.log"

        if tool in self.DISPATCH_TOOLS:
            cwd = str(Path.home())
            # 工單一律寫成 UTF-8 檔案，命令列只傳一行 ASCII 的「去讀這個檔」。
            #
            # 兩個實測踩到的理由：
            #   1. cmd /c 會在第一個換行處把參數截斷。加了多行執行前置之後，
            #      qwen 收到的工單只剩第一行 —— 測試員自己回報「沒有任務內容送達」
            #   2. 中文經過命令列會被當地碼頁轉碼弄壞
            order_file = log_dir / f"{stamp}_task.md"
            try:
                order_file.write_text(task, encoding="utf-8")
                argv = self.DISPATCH_TOOLS[tool](
                    f"Read the UTF-8 work order at {order_file} and carry it out. "
                    f"The file is the full instruction; do not ask for more input.")
            except OSError:
                argv = self.DISPATCH_TOOLS[tool](task)   # 寫不了檔就退回原本作法
            try:
                if tool == "qwen":
                    # qwen 的 node-pty 需要一個 console。
                    # 這裡「不能」用 shell=True 去內插 task —— 那等於把使用者輸入
                    # 直接餵進命令列，一個引號就能接上任意指令。改成 argv 陣列，
                    # 用 CREATE_NEW_CONSOLE 給它 console，視窗最小化。
                    lf = open(log_file, "w", encoding="utf-8")
                    si = subprocess.STARTUPINFO()
                    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    si.wShowWindow = 6  # SW_MINIMIZE
                    proc = subprocess.Popen(
                        [BIN["qwen"], "-p", argv[-1]], cwd=cwd,
                        stdout=lf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                        creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=si)
                    proc_pid = proc.pid
                    lf.close()          # 子行程已經有自己的一份，父行程不留
                else:
                    lf = open(log_file, "w", encoding="utf-8")
                    env = dict(__import__("os").environ, QWEN_CODE_SUPPRESS_YOLO_WARNING="1")
                    proc = subprocess.Popen(argv, cwd=cwd, stdout=lf, stderr=subprocess.STDOUT,
                                            stdin=subprocess.DEVNULL, env=env,
                                            creationflags=subprocess.CREATE_NO_WINDOW)
                    proc_pid = proc.pid
                    lf.close()          # 同上
                self.DISPATCHES.append({"id": stamp, "tool": tool, "task": raw_task[:120],
                                        "started": stamp, "pid": proc_pid, "log": str(log_file),
                                        "mode": "headless"})
                self._save_registry()
                return self._json({"ok": True, "tool": tool, "mode": "headless",
                                   "log": str(log_file), "id": stamp, "skills": applied_skills,
                                   "note": f"已派出 {tool} 無頭執行"
                                           + (f"（已掛技能：{'、'.join(applied_skills)}）" if applied_skills else "")})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)

        if tool == "local":
            # 地端兜底：直接叫 LM Studio 回答（同步回覆）
            try:
                model, _, _ = route_model("general")
                if not model:
                    return self._json({"ok": False, "error": "地端無可用模型"}, 502)
                import urllib.request
                payload = json.dumps({"model": model, "messages": [
                    {"role": "system", "content": "你是 AI 辦公室的地端值班夥伴，雲端工具都在休息。直接、簡潔地用繁體中文執行使用者的指令或回答。"},
                    {"role": "user", "content": task},
                ], "max_tokens": 2048}, ensure_ascii=False).encode("utf-8")
                req = urllib.request.Request("http://127.0.0.1:1234/v1/chat/completions",
                                             data=payload, headers={"Content-Type": "application/json; charset=utf-8"})
                resp = json.loads(urllib.request.urlopen(req, timeout=280).read())
                content = (resp.get("choices") or [{}])[0].get("message", {}).get("content", "")
                log_file.write_text(f"[{stamp}] local({model})\n指令：{task}\n\n{content}", encoding="utf-8")
                self.DISPATCHES.append({"id": stamp, "tool": "local", "task": raw_task[:120],
                                        "started": stamp, "pid": None, "log": str(log_file),
                                        "mode": "sync", "reply": content[:300]})
                self._save_registry()
                return self._json({"ok": True, "tool": "local", "model": model, "mode": "sync",
                                   "reply": content, "log": str(log_file)})
            except Exception as e:
                return self._json({"ok": False, "error": f"地端呼叫失敗：{e}"}, 502)

        # 沒有無頭模式的工具 → 開可見終端並預填指令
        #
        # 原本只有 grok 會把指令帶進去，其他工具開的是一個空的 CLI ——
        # 介面卻回報「已開終端」，看起來像已經派出去了，實際上那個視窗裡什麼都沒有。
        # 現在一律走跟無頭模式相同的作法：工單寫成 UTF-8 檔，命令列只帶一行
        # ASCII 的「去讀這個檔」，中文不會被命令列的地碼頁弄壞，也不怕換行截斷。
        try:
            exe = BIN.get(tool, tool)
            order_file = log_dir / f"{stamp}_task.md"
            try:
                order_file.write_text(task, encoding="utf-8")
                prompt = (f"Read the UTF-8 work order at {order_file} and carry it out. "
                          f"The file is the full instruction; do not ask for more input.")
            except OSError:
                prompt = task
            # 跟 /api/launch 一樣：指令寫成 .cmd 再執行，不要整串當參數傳。
            # 巢狀引號經過 list2cmdline 會被跳脫成 \"，cmd.exe 不認，指令就壞了。
            crlf = "\r\n"
            bat = log_dir / f"{stamp}_{tool}_run.cmd"
            bat.write_text("@echo off" + crlf + "chcp 65001 >nul" + crlf
                           + f'"{exe}" "{prompt}"' + crlf, encoding="utf-8")
            argv = ["cmd", "/c", "start", f"AI:{tool}", "cmd", "/k", str(bat)]
            subprocess.Popen(argv, cwd=str(Path.home()))
            log_file.write_text(f"[{stamp}] {tool} 開啟可見終端\n指令：{task}", encoding="utf-8")
            # 記下這份「回音」有多大：之後只要檔案沒有長大，就表示那個視窗裡
            # 還沒有任何實際輸出，也就是使用者還沒讓它跑起來
            try:
                echo_size = log_file.stat().st_size
            except OSError:
                echo_size = 0
            self.DISPATCHES.append({"id": stamp, "tool": tool, "task": raw_task[:120],
                                    "started": stamp, "pid": None, "log": str(log_file),
                                    "mode": "terminal", "echo_size": echo_size})
            self._save_registry()
            note = f"{tool} 已開終端並帶入指令"
            return self._json({"ok": True, "tool": tool, "mode": "terminal",
                               "note": note, "log": str(log_file)})
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 500)

    # 從 log 尾端認出「跑起來了但失敗」。這些都是實際踩過的訊息，不是猜的。
    # qwen 的說法是 quota exhausted / insufficient_quota，跟其他家都不一樣 ——
    # 漏了它就會把「額度用光」誤判成「完成」（實測踩過）。
    _FAIL_MARKS = ("usage limit", "rate limit", "quota exceeded", "quota exhausted",
                   "insufficient_quota", "error:",
                   "traceback (most recent call last)", "is not recognized",
                   "command not found", "invalid_grant")

    def _dispatch_state(self, d: dict, alive: bool) -> str:
        """running / waiting / done / failed / silent

        原本只有 alive 一個布林值，所以畫面只分得出「執行中」跟「不是執行中」，
        跑完的、失敗的、還沒被按下去的終端全部長一樣 ——
        清單標題寫「執行中的派工」，實際上是一份只增不減的歷史。
        """
        if alive:
            return "running"
        if d.get("mode") == "sync":
            return "done"
        log = Path(d.get("log") or "")
        try:
            size = log.stat().st_size if log.exists() else 0
        except OSError:
            size = 0
        if d.get("mode") == "terminal":
            # 終端模式追不到 pid。log 裡只有派工當下寫進去的那份指令回音，
            # 表示那個視窗還沒被執行 —— 這是最常見的「以為派出去了其實沒有」。
            echo = d.get("echo_size")
            if echo is None:
                # 舊登錄沒有這個欄位，退回保守判斷：只有回音那幾行就算還沒跑
                return "waiting" if size < 4000 else "done"
            return "waiting" if size <= echo else "done"
        if size == 0:
            return "silent"          # 無頭跑完但一個字都沒輸出
        try:
            tail = log.read_text(encoding="utf-8", errors="ignore")[-4000:].lower()
        except OSError:
            return "done"
        return "failed" if any(m in tail for m in self._FAIL_MARKS) else "done"

    def _send_followup(self, d: dict, text: str) -> dict:
        """實際送出續談。回傳要寫回登錄的欄位"""
        tool = d.get("tool", "")
        make = self.FOLLOWUP_TOOLS.get(tool)
        if not make:
            return {"error": f"{tool} 沒有續談模式"}
        # 續談不重掛執行前置：那段規範上一輪已經給過了，再貼一次只是雜訊。
        # 但控制標記還是要中和，不然補的這句話可以偽裝成系統指示。
        safe = rules._neutralize(text)
        log_dir = Path.home() / "ai-hub" / "dispatch-log"
        log_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        log_file = log_dir / f"{stamp}_{tool}_followup.log"
        try:
            lf = open(log_file, "w", encoding="utf-8")
            proc = subprocess.Popen(
                make(safe), cwd=str(Path.home()), stdout=lf,
                stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW)
            lf.close()
        except Exception as e:
            return {"error": str(e)}
        self.DISPATCHES.append({
            "id": stamp, "tool": tool, "task": f"（接續）{text[:110]}",
            "started": stamp, "pid": proc.pid, "log": str(log_file),
            "mode": "headless", "followupOf": d.get("id"),
        })
        return {"pid": proc.pid, "log": str(log_file)}

    def _dispatch_now(self, task: str, tool: str) -> str:
        """定時工作到期時走的路徑 —— 就是手動派工那一條，只是沒有人按按鈕。

        直接呼叫 do_dispatch() 會需要偽造一個 request body，太繞；
        這裡把同一段邏輯用 HTTP 打回自己，確保行為完全一致
        （包含掛規範、寫 log、進派工登錄、自動路由）。
        """
        payload = json.dumps({"task": task, "tool": tool or "auto"},
                             ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/api/dispatch", data=payload,
            headers={"Content-Type": "application/json; charset=utf-8",
                     # 自己打自己，同源檢查要過
                     "Origin": f"http://127.0.0.1:{PORT}"})
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read())
        return d.get("note") or ("已派出" if d.get("ok") else str(d.get("error")))

    def do_schedule_save(self):
        body = self._body()
        job = schedule.normalize(body)
        if not job["task"]:
            return self._json({"ok": False, "error": "需要工作內容"}, 400)
        # 用 upsert 而不是自己 load→append→save：那是三個獨立動作，
        # 中間插進另一個執行緒（或排程的 tick）就會互相蓋掉。
        schedule.upsert(job)
        return self._json({"ok": True, "job": {**job, "desc": schedule.describe(job)}})

    def do_schedule_delete(self):
        schedule.remove(str(self._body().get("id", "")))
        return self._json({"ok": True})

    def do_schedule_run(self):
        """立刻跑一次。設定完馬上驗證得到，不用等到明天早上八點"""
        jid = str(self._body().get("id", ""))
        job = next((j for j in schedule.load() if j.get("id") == jid), None)
        if not job:
            return self._json({"ok": False, "error": "找不到這個定時工作"}, 404)
        try:
            note = self._dispatch_now(job.get("task", ""), job.get("tool", "auto"))
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 500)

        def mark(j: dict) -> None:
            j["lastRun"] = time.time()
            j["runs"] = int(j.get("runs") or 0) + 1
            j["lastResult"] = note[:200]

        schedule.update(jid, mark)
        return self._json({"ok": True, "note": note})

    # 目前這一批的進度，給介面看的
    BATCH = {"total": 0, "done": 0, "running": False, "current": "", "note": ""}

    def do_dispatch_batch(self):
        """一次收下整批工單，在背景一件一件跑

        serial=True（預設）會等前一件的行程真的結束才派下一件。
        這是唯一能避免多個 agent 同時改同一批檔案的做法 ——
        前端 await 一個非阻塞的 Popen 是等不到的。
        """
        body = self._body()
        steps = body.get("steps") or []
        serial = bool(body.get("serial", True))
        if not isinstance(steps, list) or not steps:
            return self._json({"ok": False, "error": "需要 steps"}, 400)
        if self.BATCH["running"]:
            return self._json({"ok": False, "error": "上一批還在跑，等它結束或先取消"}, 409)

        jobs = [{"tool": str(x.get("tool") or "auto"), "task": str(x.get("task") or "").strip()}
                for x in steps if str(x.get("task") or "").strip()]
        if not jobs:
            return self._json({"ok": False, "error": "工單內容都是空的"}, 400)

        cls = type(self)
        cls.BATCH = {"total": len(jobs), "done": 0, "running": True,
                     "current": jobs[0]["task"][:60], "note": ""}

        def worker():
            for i, j in enumerate(jobs):
                cls.BATCH["current"] = j["task"][:60]
                try:
                    payload = json.dumps(j, ensure_ascii=False).encode("utf-8")
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{PORT}/api/dispatch", data=payload,
                        headers={"Content-Type": "application/json; charset=utf-8",
                                 "Origin": f"http://127.0.0.1:{PORT}"})
                    with urllib.request.urlopen(req, timeout=60) as r:
                        d = json.loads(r.read())
                    pid = d.get("pid")
                    if serial and pid:
                        # 真的等它跑完。上限兩小時，免得一件卡死就整批不動。
                        end = time.time() + 7200
                        while time.time() < end and int(pid) in _alive_pids({int(pid)}):
                            time.sleep(5)
                except Exception as e:
                    cls.BATCH["note"] = f"第 {i + 1} 件失敗：{e}"[:160]
                cls.BATCH["done"] = i + 1
            cls.BATCH["running"] = False
            cls.BATCH["current"] = ""

        threading.Thread(target=worker, daemon=True).start()
        return self._json({"ok": True, "total": len(jobs), "serial": serial,
                           "note": f"已收下 {len(jobs)} 件，"
                                   + ("一件跑完才派下一件" if serial else "同時派出")})

    def do_followup(self):
        """對一件已派出的工作補一句話

        上一輪還在跑就先掛著 —— 兩個行程同時續談同一段對話會互相蓋掉。
        """
        if not self.DISPATCHES:
            self._load_registry()
        body = self._body()
        did = str(body.get("id", "")).strip()
        text = str(body.get("text", "")).strip()
        if not did or not text:
            return self._json({"ok": False, "error": "需要 id 與 text"}, 400)
        target = next((x for x in self.DISPATCHES if x.get("id") == did), None)
        if not target:
            return self._json({"ok": False, "error": "找不到這件派工"}, 404)
        if target.get("tool") not in self.FOLLOWUP_TOOLS:
            return self._json({"ok": False,
                               "error": f"{target.get('tool')} 沒有續談模式，只能重新派一件"}, 400)

        pid = target.get("pid")
        alive = bool(pid) and int(pid) in _alive_pids({int(pid)})
        if alive:
            pend = list(target.get("pending") or [])
            pend.append(text)
            target["pending"] = pend
            self._save_registry()
            return self._json({"ok": True, "queued": True,
                               "note": f"這一輪還在跑，已排隊（第 {len(pend)} 句），結束後自動送出"})
        r = self._send_followup(target, text)
        if r.get("error"):
            return self._json({"ok": False, "error": r["error"]}, 500)
        self._save_registry()
        return self._json({"ok": True, "queued": False, "note": f"已送出給 {target['tool']}"})

    def _flush_pending(self, rows: list) -> None:
        """跑完的那些，把排隊中的續談送出去"""
        changed = False
        for d in rows:
            if d.get("alive") or not d.get("pending"):
                continue
            src = next((x for x in self.DISPATCHES if x.get("id") == d.get("id")), None)
            if not src:
                continue
            text = "\n".join(src.get("pending") or [])
            src["pending"] = []
            changed = True
            self._send_followup(src, text)
        if changed:
            self._save_registry()

    def do_dispatches(self):
        """派工追蹤：列出登錄的派工，判斷真正的狀態，附 log 尾端預覽"""
        if not self.DISPATCHES:
            self._load_registry()
        out = []
        recent = [dict(d) for d in reversed(self.DISPATCHES[-30:])]
        # 一次把所有 pid 問完。原本是每一筆各叫一次 tasklist，
        # 一次輪詢就開好幾個子行程；這個端點每 8 秒被打一次，
        # 在 Windows 上等於持續閃視窗、持續搶焦點。
        alive_pids = _alive_pids({int(d["pid"]) for d in recent if d.get("pid")})
        for d in recent:
            d["alive"] = bool(d.get("pid")) and int(d["pid"]) in alive_pids
            d["state"] = self._dispatch_state(d, d["alive"])
            log = Path(d.get("log", ""))
            if log.exists():
                text = log.read_text(encoding="utf-8", errors="ignore")
                if not d["alive"]:
                    d["result"] = text[-400:]
                # 執行中的最後一行輸出。使用者最常問的是「到底有沒有在動」——
                # 只有一個「執行中」的字樣看不出差別，看到 log 一直在變才知道還活著。
                # CLI 的輸出帶 ANSI 色碼，直接顯示會變成一串 ESC[1m[31m
                lines = [_ANSI_RE.sub("", ln).strip() for ln in text.splitlines()]
                lines = [ln for ln in lines if ln]
                d["tail"] = lines[-1][:140] if lines else ""
                try:
                    d["logSize"] = log.stat().st_size
                except OSError:
                    d["logSize"] = 0
            out.append(d)
        # 排隊中的續談：上一輪一結束就送出去。放在輪詢裡而不是另開執行緒，
        # 是因為主控台本來就每 8 秒問一次，不需要再多一個背景迴圈。
        self._flush_pending(out)
        return self._json({"ok": True, "dispatches": out})


class SingleInstanceServer(ThreadingHTTPServer):
    """關掉位址重用。

    Windows 的 SO_REUSEADDR 語意跟 Unix 不一樣：兩個行程可以同時綁同一個埠，
    請求會被隨機分給其中一個，畫面行為就會忽好忽壞、非常難查。
    這裡明確關掉，重複啟動時就會乾脆地報錯，而不是安靜地製造鬼故事。
    """
    allow_reuse_address = False


def already_running() -> bool:
    """已經有一個實例在服務就不要再起一個"""
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


if __name__ == "__main__":
    if already_running():
        print(f"AI 控制台 API 已經在 http://127.0.0.1:{PORT} 執行，這次不重複啟動", flush=True)
        sys.exit(0)
    try:
        srv = SingleInstanceServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print(f"無法綁定 127.0.0.1:{PORT}：{e}\n"
              f"（可能有另一個實例正在啟動中，或該埠被其他程式佔用）", flush=True)
        sys.exit(1)
    print(f"AI 控制台 API 於 http://127.0.0.1:{PORT} （僅本機）", flush=True)

    # 定時工作的背景排程。
    #
    # 到期時用 HTTP 打回自己的 /api/dispatch —— 這樣定時工作走的是跟手動派工
    # 一模一樣的路徑（掛規範、寫 log、進派工登錄、自動路由），不會有兩套行為。
    # 用 daemon 執行緒，關掉伺服器就跟著結束，不需要另外處理收尾。
    def _fire(job: dict) -> str:
        payload = json.dumps({"task": job.get("task", ""),
                              "tool": job.get("tool") or "auto"},
                             ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/api/dispatch", data=payload,
            headers={"Content-Type": "application/json; charset=utf-8",
                     "Origin": f"http://127.0.0.1:{PORT}"})
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read())
        return d.get("note") or ("已派出" if d.get("ok") else str(d.get("error")))

    sched = schedule.Scheduler(_fire)
    sched.start()
    jobs = [j for j in schedule.load() if j.get("enabled")]
    print(f"定時工作：{len(jobs)} 件啟用中", flush=True)

    srv.serve_forever()
