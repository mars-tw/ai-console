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
  GET  /api/conv/tail?id=... — 從 canonical index 安全讀取對話真正尾端
"""
import contextlib
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
import uuid
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
# 地端模型的把關腳本（載入前 / 載入後各問一次），路徑可由 config.json 覆蓋
LOCAL_GATE = Path(_CFG.get("local_gate", str(Path.home() / "ai-hub" / "tools" / "local_gate.py")))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import planner   # noqa: E402
import rules     # noqa: E402
import schedule  # noqa: E402
from conversation_tail import ConversationTailError, load_indexed_tail  # noqa: E402

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


def _lms_run(argv, **kw):
    """LM Studio CLI 固定輸出 UTF-8，不要讓 Windows 依 CP950 解碼。

    實機 smoke test 抓到：``text=True`` 會用系統 ANSI code page，lms 的進度
    符號一出現，subprocess reader thread 就丟 UnicodeDecodeError，stdout 變成空值。
    只收斂 lms 呼叫；tasklist 等系統工具仍沿用本機 code page。
    """
    kw.pop("text", None)
    return _run(argv, text=True, encoding="utf-8", errors="replace", **kw)


# 一整批 pid 的存活狀態，快取幾秒。
# /api/dispatches 每 8 秒被輪詢一次，而主控台與辦公室兩個分頁都在輪詢，
# 沒有快取的話同一秒可能連問兩次。
_ALIVE_CACHE: dict[str, object] = {"at": 0.0, "pids": set()}


def _alive_pids(pids: set) -> set:
    """一次查完一整批 pid 是否還活著

    快取只能用來確認「還活著」，不能用來斷定「已經結束」。
    問到的 pid 不在快取裡時有兩種可能：真的結束了，或是它在上一次
    快照之後才誕生。這兩件事分不出來，就一定要重新查一次。

    這不是理論問題，是序列派工壞掉的直接原因：
    介面每 8 秒輪詢一次 /api/dispatches 把快取填滿，接著三秒內派出第一件，
    新 pid 不在那份舊快照裡 → 回報「已結束」→ worker 立刻派下一件，
    兩個 agent 同時改同一批檔案 —— 正是「一件一件跑」要避免的事。
    實測重現：新行程明明在跑，_alive_pids 回空集合。
    """
    if not pids:
        return set()
    now = time.time()
    if now - float(_ALIVE_CACHE["at"]) < 3.0:
        hit = {p for p in pids if p in _ALIVE_CACHE["pids"]}
        if len(hit) == len(pids):
            return hit          # 全部都確認活著，快取夠用
        # 有人不在快取裡 —— 可能是新生的，重查一次才敢說它死了
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

_STAMP_LOCK = threading.Lock()


def _new_stamp(log_dir: Path, tool: str) -> str:
    """取一個同一秒也不會撞的派工編號

    這個編號同時是派工 id、log 檔名與工單檔名。原本是
    time.strftime("%Y%m%d-%H%M%S") 再配一個「檔案已存在就加 _2」的迴圈，
    但那是先看再建：兩個執行緒在同一秒可以同時看到「不存在」，
    於是拿到同一個編號 —— 兩件工共用一個 id、工單檔互相覆蓋、
    點開 log 看到的是別人的產出。批次派工正是一口氣送出好幾件。

    改成用 O_CREAT|O_EXCL 直接搶號：建得起來才算搶到，
    這一步在檔案系統層是原子的。行程內另外加一把鎖只是少繞幾圈。

    搶的是「不帶工具名」的佔位檔，不是 {stamp}_{tool}.log。
    帶工具名的話，同一秒派給兩個不同工具會各自搶到同一個 stamp
    （檔名不同、都建得起來），於是：
      · 兩件工共用一個派工 id，查 log 與補一句都會指到錯的那一件
      · 更糟的是 {stamp}_task.md 不帶工具名，後寫的直接蓋掉前一份，
        兩個 agent 拿到同一份工單
    實測踩到：同一秒派給 gemini 與 codex，兩份工單只活一份。
    """
    base = time.strftime("%Y%m%d-%H%M%S")
    with _STAMP_LOCK:
        for n in range(1, 200):
            stamp = base if n == 1 else f"{base}_{n}"
            try:
                fd = os.open(str(log_dir / f"{stamp}.id"),
                             os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                continue
            except OSError:
                break
            os.close(fd)
            return stamp
    # 同一秒兩百件還撞得到就不要再猜了，直接給隨機碼
    return f"{base}_{uuid.uuid4().hex[:6]}"


def _tail_text(path: Path, limit: int = 64 * 1024) -> str:
    """只讀檔案尾端。整份讀進來只為了取最後一行是很貴的。

    從尾端往回 seek，切掉可能被切壞的第一個字元序列再解碼。
    """
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            if size > limit:
                f.seek(size - limit)
                raw = f.read()
                # 從尾端切進去可能落在多位元組字元中間，丟掉第一行比較乾淨
                nl = raw.find(b"\n")
                if nl >= 0:
                    raw = raw[nl + 1:]
            else:
                raw = f.read()
        return raw.decode("utf-8", errors="ignore")
    except OSError:
        return ""


# ── 派工到底成功了沒 ────────────────────────────────────
#
# 為什麼不能只看 exit code：
#   實際案例（2026-08-24）—— 派給 codex 的實作工單，它的地端優先治理層先用
#   一顆 4B 產出「候選設計」，接著的雲端步驟撞上 API Error 529 Overloaded，
#   整份工作在沒有改到任何一個檔案的情況下結束，**而行程回傳 0**。
#   派工畫面顯示的是正常結束，使用者會以為工作做完了，
#   幾個小時後才發現檔案根本沒動。
#
#   各家 CLI 對「我失敗了」的表達方式都在 log 裡，不在 exit code 裡。
#   所以判斷依據是 log 內容。

# 各家 CLI 宣告自己失敗的說法。命中就是 error，並把那一行當成原因回報。
# 要有「動詞」才算數，不能只有名詞。
# 第一版是 r'(?:usage|rate)[ _-]?limit' 這種裸名詞 —— 立刻被自己的測試打回來：
# 工單本文會被寫進 log 開頭，而工單裡交代「如果撞到 usage limit 就回報」
# 是家常便飯，於是每一件成功的派工都被標成紅色失敗。
# 誤判比沒有這個功能更糟：使用者會開始不相信這個標示，連真的失敗也一起忽略。
_FAIL_PATTERNS = [
    re.compile(r'(?im)^[ \t]*API Error:\s*\d{3}[^"\r\n]*[ \t\r]*$'),
    re.compile(r'(?im)^[ \t]*(?:rate|usage|quota|credit)[ _-]?limits?\s+'
               r'(?:reached|exceeded|hit)\b[^"\r\n]{0,60}[ \t\r]*$'),
    re.compile(r"(?im)^[ \t]*(?:you(?:'ve| have)\s+)?(?:hit|reached|exceeded)\s+"
               r'(?:your\s+)?'
               r'(?:\w+\s+){0,2}(?:rate|usage|quota|credit)[ _-]?limit\b'
               r'[^"\r\n]{0,60}[ \t\r]*$'),
    re.compile(r'(?im)^[ \t]*429\s+Too\s+Many\s+Requests\b[^\r\n]*[ \t\r]*$'),
    re.compile(r'(?im)^[ \t]*(?:quota|credits?)\s+exhaust\w*'
               r'[^"\r\n]{0,60}[ \t\r]*$'),
    # 帶嚴重性前綴、而且後面接一整句話的那種。
    #
    # 上面那幾條都要求片語從行首開始、後面最多再 60 個字 —— 那個限制是為了
    # 不要去咬「文章裡順帶提到 usage limit」的句子。但 codex 實際吐出來的是：
    #   ERROR: You've hit your usage limit. Visit https://…/usage to purchase
    #   more credits or try again at Sep 1st, 2026 10:37 PM.
    # 前綴是 `ERROR: `（不是行首片語），尾巴 110 個字（不只 60）——
    # 兩個條件都不合，於是**一次都沒有被認出來過**。派工照樣送過去撞牆，
    # 而畫面上那件事看起來不是失敗。
    #
    # 這一條放寬尾巴，但改用「行首必須是明確的嚴重性標記」換回精確度：
    # 一行以 ERROR: 開頭、接著說「你撞到額度上限」，那不會是敘述文字。
    # _benign_failure_context 仍然會擋掉「（這只是範例）」那種。
    re.compile(r"(?im)^[ \t]*\[?(?:ERROR|FATAL|CRITICAL)\]?[ \t]*:[ \t]*"
               r"(?:you(?:'ve| have)\s+)?(?:hit|reached|exceeded)\s+"
               r'(?:your\s+)?(?:\w+\s+){0,2}(?:rate|usage|quota|credit)'
               r'[ _-]?limits?\b'),
    # 登入／認證失敗。
    #
    # 這一類是實際踩到的（2026-08-27）：派給 claude 的工單，整份 log 只有 73 bytes——
    #   Failed to authenticate: OAuth session expired and could not be refreshed
    # 工作**一秒都沒開始跑**，而畫面顯示「已完成」。
    # 那是這個功能最該抓、卻最容易漏的一種：額度用完至少還會吐一段話，
    # 認證失敗是一行就結束，看起來反而像「乾淨地做完了」。
    #
    # 一樣要求「有動詞、成句」：`authenticate` 這個字本身在工單裡很常見
    # （「先確認認證有效」），裸名詞會把成功的派工標成紅色。
    # `you(?:'re| are)` 這個前綴要放行：CLI 實際上就是這樣講話的
    #   You are not logged in. Please run login to continue.
    # 它仍然是「對本次工作階段的斷言」，不是把名詞放進句子裡提及，
    # 所以不會把工單裡的「先確認有沒有登入」誤判成失敗。
    re.compile(r'(?im)^[ \t]*(?:\[?(?:ERROR|FATAL)\]?[ \t]*:?[ \t]*)?'
               r"(?:you(?:'re|\s+are)\s+)?"
               r'(?:failed\s+to\s+authenticate|authentication\s+failed|'
               r'not\s+(?:logged\s+in|authenticated)|'
               r'(?:oauth|session|token|credential)s?\s+(?:has\s+)?expired|'
               r'please\s+(?:run\s+)?(?:login|log\s+in|sign\s+in)|'
               r'login\s+required)\b[^\r\n]{0,120}[ \t\r]*$'),
    re.compile(r'(?im)^[ \t]*(?:\[?(?:ERROR|FATAL)\]?[ \t]*:?[ \t]*)?'
               r'(?:401\s+Unauthorized|'
               r'invalid\s+api\s+key|api\s+key\s+(?:not\s+found|missing|invalid))'
               r'\b[^\r\n]{0,120}[ \t\r]*$'),
]
_BENIGN_FAILURE_CONTEXT_RE = re.compile(
    r'\b(?:historical|past|previous|prior)\s+(?:example|incident|case|attempt)\b|'
    r'\b(?:example|sample|documentation|docs?|illustration|quoted?|'
    r'mention(?:ed|s)?)\b|'
    r'\b(?:not|never)\s+(?:this|the\s+current)\s+(?:run|execution|attempt)\b|'
    r'\b(?:did|does)\s+not\s+(?:happen|occur|apply)\b|'
    r'歷史(?:範例|案例|紀錄)|過去(?:範例|案例|紀錄)|先前(?:案例|紀錄|嘗試)|'
    r'(?:只是|僅是|僅供)?(?:範例|示例|例子|說明)|'
    r'(?:並非|不是)(?:本次|這次)(?:執行|運行|工作|派工)?|'
    r'(?:本次|這次)(?:沒有|未)(?:發生|出現)|不代表(?:本次)?失敗|'
    r'文件(?:中)?(?:提到|引用)', re.I)
_TRACEBACK_RE = re.compile(r'(?im)^[ \t]*Traceback \(most recent call last\):[ \t\r]*$')
_TERMINAL_STATUS_RE = re.compile(
    r'(?im)^[ \t]*(?:STATUS|FINAL(?:_|[ \t]+)STATUS|OUTCOME)[ \t]*:[ \t]*'
    r'(?P<status>COMPLETE|COMPLETED|OK|PASS|PASSED|SUCCESS|SUCCEEDED|DONE|'
    r'ERROR|FAILED|FAILURE|BLOCKED|TIMEOUT|PARTIAL|UNAVAILABLE|'
    r'NO[_ -]?CHANGES?|NO[_ -]?WRITE)[ \t]*[.!]?[ \t\r]*$')
_TERMINAL_SUCCESS_RE = re.compile(
    r'(?im)^[ \t]*(?:(?:task|work|implementation)[ \t]+)?'
    r'(?:completed|succeeded)(?:[ \t]+successfully)?[.!]?[ \t\r]*$|'
    r'^[ \t]*(?:(?:任務|工作|實作)[：:]?[ \t]*)?已完成[。.!]?[ \t\r]*$')
_TERMINAL_OK = {"complete", "completed", "ok", "pass", "passed",
                "success", "succeeded", "done"}
_TERMINAL_ERROR = {"error", "failed", "failure", "timeout",
                   "partial", "unavailable"}
_TERMINAL_NO_CHANGE = {"no_change", "no_changes", "no_write"}
# BLOCKED 不是失敗，是**照規範停下來**。
#
# 這台機器的 POLICY 明寫「缺授權標 BLOCKED」——agent 回報 BLOCKED 的時候
# 它做對了。跟 529、崩潰混在同一個紅色裡的話，使用者會學會忽略紅字，
# 然後真正的失敗也一起被忽略。要分開講。
_TERMINAL_BLOCKED = {"blocked"}
# Claude CLI 的結算 JSON
_COST_USD_RE = re.compile(r'"total_cost_usd"\s*:\s*([0-9.]+)')
_MODEL_USAGE_RE = re.compile(
    r'"([a-z0-9][\w.-]*)"\s*:\s*\{[^{}]*?"inputTokens"\s*:\s*(\d+)[^{}]*?"outputTokens"\s*:\s*(\d+)')
# 地端治理層的結算 JSON（沒有金額，地端不花錢，但有 token 數）
_LOCAL_STATS_RE = re.compile(
    r'"input_tokens"\s*:\s*(\d+)\s*,\s*"total_output_tokens"\s*:\s*(\d+)')
# codex CLI 收尾時只印一個總數，沒有拆輸入／輸出，也沒有金額：
#     tokens used
#     371,555
# 只認得前面兩種格式的話，codex 的每一趟都會顯示成「沒有用量」——
# 而它其實是這裡最貴的一個。
_CODEX_TOTAL_RE = re.compile(r'tokens?\s+used\s*[\r\n]+\s*([\d,]+)', re.I)

# 成本要掃完整 log，但不能把幾百 MB 一次讀進記憶體。每次只保留最後 64 KiB
# 當跨區塊接縫，前面的統計增量寫進 accumulator。Codex 的 tokens used 是同一
# session 的累積快照，所以取最大值，不把多次畫面重印重複相加。
_COST_SCAN_CHUNK = 64 * 1024
_COST_SCAN_OVERLAP = 64 * 1024
_COST_SCAN_MAX_CARRY = 2 * _COST_SCAN_OVERLAP
_COST_USD_BYTES_RE = re.compile(br'"total_cost_usd"\s*:\s*([0-9.]+)')
_MODEL_USAGE_BYTES_RE = re.compile(
    br'"([a-z0-9][\w.-]*)"\s*:\s*\{[^{}]*?"inputTokens"\s*:\s*(\d+)'
    br'[^{}]*?"outputTokens"\s*:\s*(\d+)')
_LOCAL_STATS_BYTES_RE = re.compile(
    br'"input_tokens"\s*:\s*(\d+)\s*,\s*"total_output_tokens"\s*:\s*(\d+)')
_CODEX_TOTAL_BYTES_RE = re.compile(
    br'tokens?\s+used\s*[\r\n]+\s*([\d,]+)', re.I)

# log 不會回頭改寫，所以同一個 (路徑, 大小) 的解析結果可以一直用。
# 沒有這層的話，/api/dispatches 每 8 秒被打一次、每次重掃 30 份 log 的尾端，
# 光是正規表示式就會把輪詢本身變成負擔。
_OUTCOME_CACHE: dict = {}
_OUTCOME_LOCK = threading.Lock()
_COST_STREAMS: dict = {}
_COST_STREAM_LOCK = threading.Lock()


def _normalise_terminal_status(value) -> str:
    return re.sub(r'[- ]+', '_', str(value or '').strip().lower())


def _status_signal(value, issue_text: str = ""):
    """把各家終端狀態字轉成統一結果；未知狀態不是訊號。"""
    state = _normalise_terminal_status(value)
    if state in _TERMINAL_BLOCKED:
        return "blocked", _ANSI_RE.sub("", issue_text or str(value)).strip()[:160]
    if state in _TERMINAL_ERROR:
        issue = _ANSI_RE.sub("", issue_text or str(value)).strip()[:160]
        return "error", issue
    if state in _TERMINAL_NO_CHANGE:
        return "no_changes", ""
    if state in _TERMINAL_OK:
        return "ok", ""
    return None


def _latest_failure_in(text: str):
    """回傳一段文字裡最後一個明確失敗訊號，普通名詞不算。"""
    found = []
    for pat in _FAIL_PATTERNS:
        for match in pat.finditer(text):
            if _benign_failure_context(text, match):
                continue
            found.append((match.end(), match.group(0)))
    if not found:
        return None
    _, raw = max(found, key=lambda item: item[0])
    return _ANSI_RE.sub("", raw).strip()[:160]


def _benign_failure_context(text: str, match) -> bool:
    """錯誤行若明說是範例／歷史／非本次執行，就不是終端結果。"""
    end = match.end()
    # 同一行最常見；也看緊接的下一行，涵蓋「錯誤字樣\n這只是範例」。
    first_newline = text.find("\n", end)
    if first_newline >= 0:
        second_newline = text.find("\n", first_newline + 1)
        end = second_newline if second_newline >= 0 else len(text)
    return bool(_BENIGN_FAILURE_CONTEXT_RE.search(text[match.start():end]))


def _traceback_issue(text: str, start: int) -> str:
    """Traceback 的最後一行通常才是真正例外；取不到時至少回報標頭。"""
    lines = [_ANSI_RE.sub("", line).strip()
             for line in text[start:start + 8000].splitlines()]
    lines = [line for line in lines if line]
    for line in reversed(lines[:80]):
        if re.match(r'^[\w.]+(?:Error|Exception|Interrupt|Exit|Timeout)\b', line):
            return line[:160]
    return "Traceback (most recent call last)"


def _record_terminal_signal(record: dict):
    """一個 JSONL 結算物件只產生一個訊號，避免欄位順序互相推翻。"""
    result = record.get("result")
    result_text = result if isinstance(result, str) else ""
    terminal_reason = _normalise_terminal_status(record.get("terminal_reason"))

    statuses = [record.get("outcome"), record.get("final_status"),
                record.get("status")]
    failed_status = next((s for s in statuses
                          if _normalise_terminal_status(s) in _TERMINAL_ERROR), None)
    explicit_error = (
        record.get("is_error") is True
        or record.get("success") is False
        or terminal_reason in {"api_error", "error", "timeout"}
        or bool(record.get("api_error_status"))
        or failed_status is not None
    )
    if explicit_error:
        result_failure = _latest_failure_in(result_text) if result_text else None
        issue = (result_failure or record.get("issue") or record.get("error")
                 or record.get("message") or failed_status
                 or record.get("terminal_reason") or "執行失敗")
        return "error", _ANSI_RE.sub("", str(issue)).strip()[:160]

    # wrapper 的 success/is_error 只代表 wrapper 自己有正常回傳，不代表包在
    # result 裡的工作成功。先讀真正的 worker-return；FAILED、NO_CHANGES 與
    # traceback 都要比 success:true / is_error:false 更有權威。
    if result_text:
        embedded = _terminal_signals(result_text)
        if embedded:
            _, _, outcome, issue = max(embedded,
                                       key=lambda item: (item[0], item[1]))
            return outcome, issue
    elif isinstance(result, dict):
        embedded_record = _record_terminal_signal(result)
        if embedded_record:
            return embedded_record
    elif isinstance(result, list):
        embedded_record = None
        for item in result:
            if isinstance(item, dict):
                candidate = _record_terminal_signal(item)
            elif isinstance(item, str):
                nested = _terminal_signals(item)
                latest = (max(nested, key=lambda signal: (signal[0], signal[1]))
                          if nested else None)
                candidate = ((latest[2], latest[3]) if latest else None)
            else:
                candidate = None
            if candidate:
                embedded_record = candidate
        if embedded_record:
            return embedded_record

    explicit = next((sig for sig in (_status_signal(s) for s in statuses)
                     if sig and sig[0] == "no_changes"), None)
    if explicit:
        return explicit

    if "changed_files" in record and isinstance(record["changed_files"], list):
        return ("ok", "") if record["changed_files"] else ("no_changes", "")

    explicit = next((sig for sig in (_status_signal(s) for s in statuses) if sig), None)
    if explicit:
        return explicit
    if record.get("success") is True:
        return "ok", ""
    if record.get("is_error") is False and result is not None:
        return "ok", ""
    if terminal_reason in {"success", "succeeded", "complete", "completed", "end_turn"}:
        return "ok", ""
    return None


def _terminal_signals(text: str) -> list:
    """依出現順序收集終端訊號；結算 JSON 以整筆物件為一個裁決。"""
    signals = []
    serial = 0
    # CLI 色碼可能包在一整行最前面。換成等長空白可同時保留 match 位置，
    # 讓「最後訊號」排序正確，也讓行首 terminal pattern 照常命中。
    clean_text = _ANSI_RE.sub(lambda m: " " * len(m.group(0)), text)

    def add(position: int, signal) -> None:
        nonlocal serial
        if signal is None:
            return
        serial += 1
        signals.append((position, serial, signal[0], signal[1]))

    for pat in _FAIL_PATTERNS:
        for match in pat.finditer(clean_text):
            if _benign_failure_context(clean_text, match):
                continue
            issue = _ANSI_RE.sub("", match.group(0)).strip()[:160]
            add(match.end(), ("error", issue))
    for match in _TRACEBACK_RE.finditer(clean_text):
        add(match.end(), ("error", _traceback_issue(text, match.start())))
    for match in _TERMINAL_STATUS_RE.finditer(clean_text):
        add(match.end(), _status_signal(match.group("status"), match.group(0)))
    for match in _TERMINAL_SUCCESS_RE.finditer(clean_text):
        add(match.end(), ("ok", ""))

    # JSONL 與 pretty JSON 都從行首的「{」開始。raw_decode 讓多行物件也能
    # 以整筆判斷，不會因 status 在 changed_files 前面就被欄位順序誤導。
    decoder = json.JSONDecoder()
    for match in re.finditer(r'(?m)^[ \t]*(?=\{)', clean_text):
        start = match.end()
        try:
            record, consumed = decoder.raw_decode(clean_text[start:])
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(record, dict):
            add(start + consumed, _record_terminal_signal(record))
    return signals


def _new_cost_accumulator() -> dict:
    return {"usd": 0.0, "in": 0, "out": 0, "codex_total": 0,
            "models": set(), "seen": False}


def _copy_cost_accumulator(acc: dict) -> dict:
    copied = dict(acc)
    copied["models"] = set(acc["models"])
    return copied


def _apply_cost_event(acc: dict, kind: str, values) -> None:
    try:
        if kind == "usd":
            acc["usd"] += float(values[0])
        elif kind == "usage":
            model, input_tokens, output_tokens = values
            acc["in"] += int(input_tokens)
            acc["out"] += int(output_tokens)
            acc["models"].add(str(model))
        elif kind == "local":
            input_tokens, output_tokens = values
            acc["in"] += int(input_tokens)
            acc["out"] += int(output_tokens)
            acc["models"].add("local")
        elif kind == "codex":
            # Codex 會重印同一 session 的累積總數；最大值才是不重複計費的總量。
            total = int(str(values[0]).replace(",", ""))
            acc["codex_total"] = max(acc["codex_total"], total)
            acc["models"].add("codex")
        else:
            return
        acc["seen"] = True
    except (TypeError, ValueError):
        return


def _text_cost_events(text: str):
    for match in _COST_USD_RE.finditer(text):
        yield match.start(), match.end(), "usd", (match.group(1),)
    for match in _MODEL_USAGE_RE.finditer(text):
        yield match.start(), match.end(), "usage", match.groups()
    for match in _LOCAL_STATS_RE.finditer(text):
        yield match.start(), match.end(), "local", match.groups()
    for match in _CODEX_TOTAL_RE.finditer(text):
        yield match.start(), match.end(), "codex", (match.group(1),)


def _byte_cost_events(data: bytes):
    for match in _COST_USD_BYTES_RE.finditer(data):
        yield match.start(), match.end(), "usd", (match.group(1).decode("ascii"),)
    for match in _MODEL_USAGE_BYTES_RE.finditer(data):
        model, input_tokens, output_tokens = match.groups()
        yield (match.start(), match.end(), "usage",
               (model.decode("ascii", errors="replace"),
                input_tokens.decode("ascii"), output_tokens.decode("ascii")))
    for match in _LOCAL_STATS_BYTES_RE.finditer(data):
        yield (match.start(), match.end(), "local",
               tuple(value.decode("ascii") for value in match.groups()))
    for match in _CODEX_TOTAL_BYTES_RE.finditer(data):
        yield match.start(), match.end(), "codex", (match.group(1).decode("ascii"),)


def _cost_from_accumulator(acc: dict):
    if not acc["seen"]:
        return None
    models = sorted(acc["models"])
    model = models[0] if len(models) == 1 else ("mixed" if models else "")
    unattributed = acc["codex_total"]
    cost = {
        "usd": round(acc["usd"], 6),
        "in": acc["in"],
        "out": acc["out"],
        "total": acc["in"] + acc["out"] + unattributed,
        "model": model,
    }
    if unattributed:
        # 這部分只有總數，不能假裝知道輸入／輸出拆分。
        cost["unattributed"] = unattributed
    return cost


def _parse_cost(text: str):
    acc = _new_cost_accumulator()
    for _, _, kind, values in _text_cost_events(text):
        _apply_cost_event(acc, kind, values)
    return _cost_from_accumulator(acc)


def _best_signal(text: str, base: int):
    """這段文字裡最後一個終端訊號，位置換算成全檔的位元組座標。

    只需要「順序」不需要精確位置：chunk 是照順序處理的，base 單調遞增，
    所以 (base, 段內位置) 就是一個正確的全域排序鍵。
    """
    sigs = _terminal_signals(text)
    if not sigs:
        return None
    pos, _, outcome, issue = max(sigs, key=lambda s: (s[0], s[1]))
    return (base + pos, outcome, issue)


def _advance_log_stream(state: dict, data: bytes) -> None:
    combined = state["carry"] + data
    events = list(_byte_cost_events(combined))
    cutoff = max(0, len(combined) - _COST_SCAN_OVERLAP)
    crossing = [start for start, end, _, _ in events
                if start < cutoff < end]
    carry_start = min([cutoff, *crossing]) if crossing else cutoff

    # 惡意或壞掉的超長單筆不能讓 carry 無上限成長。完整且跨過強制邊界的
    # event 現在就結算；不完整且超過 128 KiB 的紀錄則安全略過。
    forced = len(combined) - carry_start > _COST_SCAN_MAX_CARRY
    if forced:
        carry_start = max(0, len(combined) - _COST_SCAN_MAX_CARRY)
    for start, end, kind, values in events:
        if (end <= carry_start) or (forced and start < carry_start):
            _apply_cost_event(state["acc"], kind, values)

    # 成敗訊號跟成本走同一條串流。
    #
    # 原本它只看 log 的最後 64 KiB —— 而實測那份撞上 API Error 529、
    # 一個檔都沒改的派工，三個失敗標記（529、terminal_reason、
    # "changed_files":[]）全落在檔案的 42%～53% 處，尾端永遠掃不到，
    # 於是畫面顯示「已完成」。這個功能在它自己的起因案例上是壞的。
    #
    # 解碼用 errors="ignore"：chunk 邊界可能切在多位元組字元中間，
    # 但所有 pattern 都是純 ASCII，壞掉的中文尾巴不會造出假訊號；
    # 而真的跨邊界的匹配還留在 carry 裡，下一輪會被完整看到。
    settled = combined[:carry_start]
    if settled:
        found = _best_signal(settled.decode("utf-8", errors="ignore"), state["base"])
        if found:
            state["sig"] = found
    state["base"] += carry_start
    state["carry"] = combined[carry_start:]


def _scan_log(log: Path, size: int, fallback_text: str):
    """增量掃**完整** log，取出成本與成敗訊號。記憶體固定。

    為什麼一定要掃完整份、而不是只看尾端：
      實測那份撞上 API Error 529、一個檔都沒改就結束的派工，
      三個失敗標記全落在 1.1 MB 檔案的 42%～53% 處。
      只看最後 64 KiB 的話畫面會顯示「已完成」——
      而那正是當初做這個功能要抓的案例。

    為什麼可以負擔得起：狀態依 log 路徑保存，只讀「上次之後新增的位元組」。
    已結束的派工大小不再變，一輩子只掃一次；還在跑的每次只掃新長出來的那段。
    """
    if not log.is_file():
        return _parse_outcome_text(fallback_text)
    key = str(log)
    with _COST_STREAM_LOCK:
        state = _COST_STREAMS.get(key)
        if state is None or size < state["offset"]:
            state = {"offset": 0, "carry": b"", "base": 0, "sig": None,
                     "acc": _new_cost_accumulator()}
            if len(_COST_STREAMS) > 100:
                _COST_STREAMS.clear()
            _COST_STREAMS[key] = state
        try:
            with open(log, "rb") as handle:
                handle.seek(state["offset"])
                remaining = max(0, size - state["offset"])
                while remaining:
                    chunk = handle.read(min(_COST_SCAN_CHUNK, remaining))
                    if not chunk:
                        break
                    _advance_log_stream(state, chunk)
                    state["offset"] += len(chunk)
                    remaining -= len(chunk)
        except OSError:
            return _parse_outcome_text(fallback_text)

        # carry 尚未封存，因為下一輪可能從中間接著長；用副本算暫時結果，
        # 不污染 accumulator，也不會在下次輪詢把同一筆重複加一次。
        current = _copy_cost_accumulator(state["acc"])
        for _, _, kind, values in _byte_cost_events(state["carry"]):
            _apply_cost_event(current, kind, values)

        best = state["sig"]
        tail = _best_signal(state["carry"].decode("utf-8", errors="ignore"),
                            state["base"])
        if tail and (best is None or tail[0] >= best[0]):
            best = tail
        return {"outcome": best[1] if best else "ok",
                "issue": best[2] if best else "",
                "cost": _cost_from_accumulator(current)}


def _parse_outcome_text(text: str) -> dict:
    """純字串版本：沒有 log 檔可讀時的退路，也給測試直接呼叫。"""
    signals = _terminal_signals(text)
    if signals:
        _, _, outcome, issue = max(signals, key=lambda item: (item[0], item[1]))
    else:
        outcome, issue = "ok", ""
    return {"outcome": outcome, "issue": issue, "cost": _parse_cost(text)}


# 舊名字留著：既有測試與外部呼叫都用這個名稱
_parse_outcome = _parse_outcome_text


def _outcome_for(log: Path, size: int, text: str) -> dict:
    key = (str(log), size)
    with _OUTCOME_LOCK:
        hit = _OUTCOME_CACHE.get(key)
        if hit is not None:
            return hit
    got = _scan_log(log, size, text)
    with _OUTCOME_LOCK:
        # 上限只是防呆：一台機器的派工紀錄本來就只留最近幾十筆
        if len(_OUTCOME_CACHE) > 500:
            _OUTCOME_CACHE.clear()
        _OUTCOME_CACHE[key] = got
    return got


# 單檔與整份的上限。一個被格式化工具掃過的檔可以有幾萬行 diff，
# 整份送到瀏覽器只會讓畫面卡住 —— 那不是「看得到改動」，是當機。
_DIFF_FILE_CAP = 200_000
_DIFF_TOTAL_CAP = 2_000_000


def _order_body(order: Path) -> str:
    """從工單檔取回原始工單內容（切掉派工系統加的前置那一段）。

    切點是「【工單】」自成一行。這個切點之所以可靠，是因為存進檔案的
    工單內容已經被 rules._neutralize 中和過 —— 使用者自己寫的
    「【工單】」會被換成半形的「[工單]」。所以檔案裡全形的那一個
    一定是系統加的分隔線，只有一個。

    找不到分隔線就回空字串，讓呼叫端明講「無法原樣重派」。
    寧可不重派，也不要送出一份只有半截的工單 ——
    那比不能重派更糟，使用者會以為重跑了同一件事。
    """
    if not order.is_file():
        return ""
    try:
        lines = order.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    cut = next((i for i, ln in enumerate(lines) if ln.strip() == "【工單】"), -1)
    return "\n".join(lines[cut + 1:]).strip() if cut >= 0 else ""


# ── 對話內容全文搜尋 ────────────────────────────────
#
# 為什麼需要：側欄的搜尋只比對標題、路徑與專案目錄。但這個程式的賣點是
# 「所有 AI 對話的統一收件匣」—— 而人真正記得的往往是「我那時候在哪一段
# 對話裡討論過 CP950」，不是那段對話當初被自動命名成什麼。
# 標題是工具自己取的，常常跟內容沒什麼關係。
#
# 為什麼不建索引：實測這台機器 646 份對話、12 MB，整份掃一次 31～58 ms。
# 建索引要多一份會過期的狀態、要處理增量更新、要處理索引壞掉 ——
# 為了省下 50 ms 去養一個新的失敗來源，不划算。
_SEARCH_MAX_Q = 120
_SEARCH_MAX_HITS = 60
_SEARCH_SNIPPETS = 2
_SEARCH_PAD = 60
# 解碼過的內容快取，鍵是 (路徑, mtime, 大小)。
# 搜尋是邊打邊查，同一批檔案會在幾秒內被讀很多次；
# 快取之後第二次起只剩正規表示式的成本。
_SEARCH_CACHE: dict = {}
_SEARCH_CACHE_BYTES = 0
_SEARCH_CACHE_CAP = 48 * 1024 * 1024
_SEARCH_LOCK = threading.Lock()


def _conv_text(f: Path):
    """讀出一份對話的訊息。回傳 [(role, text)]，讀不動就回空。"""
    try:
        st = f.stat()
    except OSError:
        return []
    key = (str(f), int(st.st_mtime), st.st_size)
    with _SEARCH_LOCK:
        hit = _SEARCH_CACHE.get(key)
        if hit is not None:
            return hit
    try:
        d = json.loads(f.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return []
    msgs = d.get("messages")
    out = [(str(m.get("role") or ""), str(m.get("text") or ""))
           for m in msgs if isinstance(m, dict)] if isinstance(msgs, list) else []
    size = sum(len(t) for _, t in out)
    with _SEARCH_LOCK:
        global _SEARCH_CACHE_BYTES
        # 超過上限就整個倒掉，不做 LRU：一次全清最多讓下一輪慢 50 ms，
        # 而維護一個正確的 LRU 是額外的複雜度與 bug 來源。
        if _SEARCH_CACHE_BYTES + size > _SEARCH_CACHE_CAP:
            _SEARCH_CACHE.clear()
            _SEARCH_CACHE_BYTES = 0
        _SEARCH_CACHE[key] = out
        _SEARCH_CACHE_BYTES += size
    return out


def _snippet(text: str, m) -> str:
    """把命中處前後各留一段，讓人一眼看出「是不是我要找的那一段」。"""
    a = max(0, m.start() - _SEARCH_PAD)
    b = min(len(text), m.end() + _SEARCH_PAD)
    s = text[a:b].replace("\n", " ").strip()
    return ("…" if a > 0 else "") + s + ("…" if b < len(text) else "")


def _search_conversations(q: str) -> dict:
    """在匯出的對話內容裡找一段文字。"""
    q = (q or "").strip()[:_SEARCH_MAX_Q]
    if len(q) < 2:
        # 一個字的查詢在中文裡會命中幾乎所有東西，回幾百筆等於沒回答
        return {"ok": True, "q": q, "hits": [], "scanned": 0,
                "truncated": False, "tooShort": True}

    conv_dir = DATA_DIR / "conv"
    if not conv_dir.is_dir():
        return {"ok": True, "q": q, "hits": [], "scanned": 0, "truncated": False}

    pat = re.compile(re.escape(q), re.I)
    needle = q.encode("utf-8")
    needle_lower = q.lower().encode("utf-8")
    hits, scanned, truncated = [], 0, False
    # 先看新的：找東西的人通常在找最近做過的事
    files = sorted(conv_dir.glob("*.json"),
                   key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    for f in files:
        scanned += 1
        try:
            raw = f.read_bytes()
        except OSError:
            continue
        # bytes 粗篩：大部分檔案在這裡就被刷掉，不必解碼也不必跑正規表示式
        if needle not in raw and needle_lower not in raw.lower():
            continue
        snippets = []
        for role, text in _conv_text(f):
            m = pat.search(text)
            if not m:
                continue
            snippets.append({"role": role, "text": _snippet(text, m)})
            if len(snippets) >= _SEARCH_SNIPPETS:
                break
        if not snippets:
            continue          # 只出現在 metadata 裡，不算命中
        hits.append({"id": f.stem, "snippets": snippets})
        if len(hits) >= _SEARCH_MAX_HITS:
            truncated = True
            break
    return {"ok": True, "q": q, "hits": hits, "scanned": scanned,
            "truncated": truncated}


def _has_git(cwd: str) -> bool:
    """這個目錄是不是 git 工作區。

    刻意不呼叫 git —— 這個判斷會在 /api/dispatches 的輪詢路徑上跑，
    一次 30 筆、每 8 秒一輪，開 30 個子行程只為了問一個是非題太貴。
    往上找 .git 就夠：那是 git 自己的定義，而且 worktree 的 .git 是檔案
    不是目錄，所以用 exists() 不是 is_dir()。
    """
    try:
        p = Path(cwd)
        if not p.is_dir():
            return False
        for node in (p, *p.parents):
            if (node / ".git").exists():
                return True
    except OSError:
        pass
    return False


def _git_diff(cwd: str) -> dict:
    """某個目錄現在有什麼未提交的改動，逐檔給 +/− 行數與 patch。

    encoding="utf-8" 是這個函式的關鍵，不是可選的講究。

    這個坑 _lms_run 的註解裡已經寫過一次，實作這個功能時還是踩了：
    在 Windows 上 text=True 會用系統 ANSI code page（這台是 CP950）解碼，
    而這個專案的原始碼註解全是中文 —— patch 內容一進來就 UnicodeDecodeError，
    subprocess 的 reader thread 直接死掉，stdout 變成空字串。
    沒有例外、沒有錯誤碼，畫面上就是「每個檔都有 +25 −2，但點開 patch 是空的」。
    --numstat 逃過一劫只是因為它的輸出是純 ASCII。

    core.quotepath=false：否則非 ASCII 檔名會被 git 轉成 "\\346\\226\\207"
    這種八進位跳脫，跟 numstat 的路徑對不起來，patch 就配不到檔案。
    """
    def git(*args):
        return _run(["git", "-C", cwd, "-c", "core.quotepath=false", *args],
                    capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=30)

    if git("rev-parse", "--show-toplevel").returncode != 0:
        return {"ok": True, "cwd": cwd, "isGit": False, "files": []}
    # --numstat 拿增減行數，--patch 拿內容。分兩次呼叫比解析合併輸出可靠得多。
    stat = git("diff", "--numstat", "HEAD")
    patch = git("diff", "--patch", "HEAD")

    # 依檔案切開 patch。git 每個檔案一定以 "diff --git " 開頭。
    chunks: dict = {}
    cur = None
    for line in (patch.stdout or "").splitlines(keepends=True):
        if line.startswith("diff --git "):
            # "diff --git a/x b/x" —— 取 b/ 那一側，改名時它才是新名字
            cur = line.rstrip("\n").split(" b/", 1)[-1]
            chunks[cur] = []
        elif cur is not None:
            chunks[cur].append(line)

    files, total, truncated = [], 0, False

    def bounded_patch(body: str) -> str:
        """同時守住單檔與整份上限；截斷提示也算在上限裡。"""
        nonlocal total, truncated
        file_note = "\n… （這個檔的差異太長，只顯示前段）"
        if len(body) > _DIFF_FILE_CAP:
            keep = max(0, _DIFF_FILE_CAP - len(file_note))
            body = body[:keep] + file_note[:_DIFF_FILE_CAP - keep]
            truncated = True

        remaining = max(0, _DIFF_TOTAL_CAP - total)
        if len(body) > remaining:
            total_note = "\n… （整份差異太長，只顯示前段）"
            keep = max(0, remaining - len(total_note))
            body = body[:keep] + total_note[:remaining - keep]
            truncated = True
        total += len(body)
        return body

    def append_file(path: str, added: str, removed: str, body: str) -> bool:
        nonlocal truncated
        if total >= _DIFF_TOTAL_CAP:
            truncated = True
            return False
        body = bounded_patch(body)
        files.append({
            "path": path,
            # 二進位檔 git 給的是 "-"
            "added": int(added) if added.isdigit() else 0,
            "removed": int(removed) if removed.isdigit() else 0,
            "binary": not (added.isdigit() and removed.isdigit()),
            "patch": body,
        })
        if total >= _DIFF_TOTAL_CAP:
            truncated = True
            return False
        return True

    for ln in (stat.stdout or "").splitlines():
        parts = ln.split("\t")
        if len(parts) < 3:
            continue
        added, removed, path = parts[0], parts[1], parts[2]
        body = "".join(chunks.get(path, []))
        if not append_file(path, added, removed, body):
            break

    # git diff HEAD 看不到「還沒 git add」的新檔。用 ls-files 只列未追蹤且
    # 未被 ignore 的檔，再逐檔以 --no-index 與 /dev/null 比較；這條路徑完全
    # 不碰 index，卻能沿用 git 對文字／二進位與 numstat 的判定。
    if total < _DIFF_TOTAL_CAP:
        untracked = git("ls-files", "--others", "--exclude-standard", "-z")
        paths = [p for p in (untracked.stdout or "").split("\0") if p]
        for path in paths:
            one_stat = git("diff", "--no-index", "--numstat", "-z", "--",
                           "/dev/null", path)
            match = re.match(r'([^\t]*)\t([^\t]*)\t', one_stat.stdout or "")
            added, removed = match.groups() if match else ("0", "0")

            one_patch = git("diff", "--no-index", "--patch", "--",
                            "/dev/null", path)
            patch_lines = (one_patch.stdout or "").splitlines(keepends=True)
            if patch_lines and patch_lines[0].startswith("diff --git "):
                body = "".join(patch_lines[1:])
            else:
                body = "".join(patch_lines)
            if not append_file(path, added, removed, body):
                break
    return {"ok": True, "cwd": cwd, "isGit": True,
            "files": files, "truncated": truncated}


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


# 對話 id 的合法長相。這幾家用的都是 UUID 或 session_xxx，
# 沒有一家會用到空白、引號或 & —— 收斂到這個範圍不影響任何真實的對話。
_SID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def safe_sid(c: dict) -> str:
    """取出可以安全放進指令列的 sessionId

    這個值最後會被寫進一個 .cmd 批次檔。批次檔裡的 & 是真的會執行
    第二條命令（同機制已用探針重現），所以不合格式就直接拒絕，
    不要嘗試「跳脫掉再用」—— cmd.exe 的跳脫規則太容易寫錯。
    """
    sid = str(c.get("sessionId") or "")
    if not _SID_RE.match(sid):
        raise ValueError(f"對話 id 的格式不合法，為安全起見不開啟：{sid[:40]!r}")
    return sid


RESUME_CMD = {
    "claude": lambda c: f'"{BIN["claude"]}" --resume "{safe_sid(c)}"',
    "codex": lambda c: f'"{BIN["codex"]}" resume "{safe_sid(c)}"',
    "kimi": lambda c: (f'"{BIN["kimi"]}" -r "{safe_sid(c)}"' if safe_sid(c).startswith("session_")
                       else f'"{BIN["kimi"]}" -r "session_{safe_sid(c)}"'),
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


def _claude_desktop_session_roots() -> list[Path]:
    home = Path.home()
    return [
        home / "AppData" / "Roaming" / "Claude" / "claude-code-sessions",
        home / "AppData" / "Local" / "Packages" / "Claude_pzs8sxrjxfjjc"
        / "LocalCache" / "Roaming" / "Claude" / "claude-code-sessions",
    ]


def claude_desktop_cards(cli_id: str) -> list[Path]:
    """對上 Claude Desktop 側欄卡（cliSessionId == jsonl 檔名）。"""
    if not cli_id:
        return []
    seen: set[str] = set()
    out: list[Path] = []
    for root in _claude_desktop_session_roots():
        if not root.is_dir():
            continue
        for path in root.rglob("local_*.json"):
            try:
                d = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
            except (OSError, json.JSONDecodeError):
                continue
            if str(d.get("cliSessionId") or "") != cli_id:
                continue
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(path)
    return out


def drop_index_conv(conv_id: str) -> None:
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


def lms_installed_models():
    """磁碟上已安裝、而且路由表認得的模型（回傳 lms 給的 modelKey 原字串）

    「已安裝」「已載入」「API 伺服器開著」是三件不同的事，要分開問。
    實測踩到的故障：lms ls --llm --json 明明列得出完整的模型，但
    lms ps 是空的、lms server status 回 running=false —— 整個介面於是說
    「找不到可用模型（LM Studio 未啟動或無完整模型）」，其實模型好好地
    躺在磁碟上，只是沒有人去開伺服器。lms ls 是純讀取（不連伺服器、
    不下載也不安裝任何東西），拿來當清單的後備正好。

    只留路由表認得的 modelKey：這份清單之後同時是「允許載入什麼」的白名單，
    寧可漏掉沒登錄過的模型，也不要讓任意字串走到 lms load 的參數裡。
    """
    if not LMS_BIN.exists():
        return []
    try:
        r = _lms_run([str(LMS_BIN), "ls", "--llm", "--json"],
                     capture_output=True, timeout=20)
        data = json.loads(r.stdout or "[]")
    except Exception:
        return []
    if isinstance(data, dict):                       # 有些版本包在 {"models": [...]}
        data = data.get("models") or data.get("data") or []
    if not isinstance(data, list):
        return []
    out, seen = [], set()
    for m in data:
        if not isinstance(m, dict):
            continue
        key = m.get("modelKey")
        if not isinstance(key, str) or not key or key in seen:
            continue
        rule = next((t for t in MODEL_TABLE if t["match"].lower() in key.lower()), None)
        if not rule:
            continue
        size = m.get("sizeBytes")
        try:
            size = int(size)
        except (TypeError, ValueError):
            size = 0
        if size > 0:
            if size < rule["min_gb"] * (1024 ** 3) * 0.9:
                continue
        elif not model_complete(key):
            # 舊版 lms 不一定回 sizeBytes；缺欄位時改用既有的磁碟門檻驗證，
            # 兩邊都驗不出完整檔案就 fail closed，不把半套模型放進白名單。
            continue
        seen.add(key)
        out.append(key)                              # 原字串，不重組也不改寫
    return out


def lms_models():
    """可用的模型清單固定回傳磁碟上的完整 modelKey。

    /v1/models 回的是已載入實例的 identifier；它可能叫 ``copy-line``，
    不是可交給 ``lms load`` 的 modelKey。若把兩種名字混在同一個下拉選單，
    使用者選到的值會被後端白名單拒絕。因此這裡永遠以唯讀的 ``lms ls``
    為準；API 伺服器開沒開不再影響模型是否「存在」。
    """
    return lms_installed_models()


def _lms_ps():
    if not LMS_BIN.exists():
        return []
    try:
        r = _lms_run([str(LMS_BIN), "ps", "--json"], capture_output=True, timeout=15)
        data = json.loads(r.stdout or "[]")
        return [m for m in data if isinstance(m, dict)]
    except Exception:
        return []


def lms_loaded():
    """lms ps 已載入記憶體的模型（識別碼優先，給所有權檢查用）"""
    return [m.get("identifier") or m.get("modelKey") for m in _lms_ps()]


def lms_loaded_keys():
    """已載入模型的「模型名」。

    不能用 lms_loaded() 來比對模型名 —— 它回的是識別碼，
    而載入時可以用 --identifier 取任意名字。實測踩過：
    用 `lms load kimi-linear-48b-a3b-instruct --identifier copy-line` 載入之後，
    lms_loaded() 回 ["copy-line"]，任何拿模型名去比對的判斷都不會中，
    於是「已載入優先」失效、又去冷載入另一個模型，還把這個踢掉。
    """
    out = []
    for m in _lms_ps():
        k = m.get("modelKey") or m.get("identifier")
        if k:
            out.append(k)
    return out


# ── 地端模型生命週期：只有明確的 POST /api/chat 會走到這一段 ──────────
#
# 這裡是整份檔案唯一會改變 LM Studio 狀態的地方（開伺服器、載模型）。
# 所有 GET 端點一律維持唯讀 —— 一個惡意網頁的
# <img src="http://127.0.0.1:5177/api/models"> 不該在使用者機器上載起一個 27B。
LMS_RUNTIME = "llama.cpp-win-x86_64-avx2@2.24.0"
_LIFECYCLE_MUTEX = "Local" + chr(92) + "CodexLocalModelLifecycleV1"
_LIFECYCLE_WAIT_S = 5.0
_LIFECYCLE_FALLBACK = threading.Lock()
_IDENT_BAD_RE = re.compile(r"[^A-Za-z0-9._-]+")


@contextlib.contextmanager
def _lifecycle_lock():
    """載入/卸載期間的互斥鎖，最多等 5 秒

    要跨行程，所以不能只用 threading.Lock：ai-hub 的其他流程也會載模型，
    只鎖住自己這個行程等於沒鎖 —— 兩邊同時看到「什麼都沒載入」，
    於是同時去載，後到的那個把先到的踢掉。Windows 的具名 mutex 是所有
    參與者都看得到的同一把鎖，名字必須跟既有流程用的一致。

    等不到就放棄，不排隊：使用者按的是「送出對話」，等超過幾秒還沒輪到
    就該回一句話說明，而不是把 HTTP 連線一直掛著。
    """
    if os.name == "nt":
        handle = None
        try:
            import ctypes
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateMutexW.argtypes = (ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p)
            k32.CreateMutexW.restype = ctypes.c_void_p
            k32.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
            k32.WaitForSingleObject.restype = ctypes.c_uint32
            k32.ReleaseMutex.argtypes = (ctypes.c_void_p,)
            k32.CloseHandle.argtypes = (ctypes.c_void_p,)
            handle = k32.CreateMutexW(None, 0, _LIFECYCLE_MUTEX)
        except Exception:
            handle = None                # 建不起來就退回行程內的鎖，至少擋住自己
        if handle:
            # 0 = 拿到；0x80（WAIT_ABANDONED）= 上一個持有者沒釋放就結束了，這裡接手
            rc = k32.WaitForSingleObject(handle, int(_LIFECYCLE_WAIT_S * 1000))
            if rc not in (0, 0x80):
                k32.CloseHandle(handle)
                raise RuntimeError("另一個流程正在處理地端模型，等 5 秒仍未輪到")
            try:
                yield
            finally:
                k32.ReleaseMutex(handle)
                k32.CloseHandle(handle)
            return
    if not _LIFECYCLE_FALLBACK.acquire(timeout=_LIFECYCLE_WAIT_S):
        raise RuntimeError("另一個流程正在處理地端模型，等 5 秒仍未輪到")
    try:
        yield
    finally:
        _LIFECYCLE_FALLBACK.release()


def _lms_server_status() -> dict:
    """回傳 lms server status；探測失敗視為未執行。"""
    if not LMS_BIN.exists():
        return {"running": False, "port": None}
    try:
        r = _lms_run([str(LMS_BIN), "server", "status", "--json"],
                     capture_output=True, timeout=15)
        data = json.loads(r.stdout or "{}")
    except Exception:
        return {"running": False, "port": None}
    if isinstance(data, list):
        data = next((d for d in data if isinstance(d, dict)), {})
    return data if isinstance(data, dict) else {"running": False, "port": None}


def _lms_server_running() -> bool:
    return bool(_lms_server_status().get("running"))


def _lms_server_start() -> None:
    """把 API 伺服器開起來（已經開著就什麼都不做）"""
    status = _lms_server_status()
    if status.get("running"):
        try:
            port = int(status.get("port"))
        except (TypeError, ValueError):
            port = 0
        if port != 1234:
            raise RuntimeError(f"LM Studio API 已在其他連接埠執行（{port or '未知'}），不會停止或重啟它")
        return
    try:
        r = _lms_run([str(LMS_BIN), "server", "start", "--port", "1234",
                      "--bind", "127.0.0.1"],
                     capture_output=True, timeout=90)
    except Exception as e:
        raise RuntimeError(f"啟動 LM Studio API 伺服器失敗：{e}")
    if r.returncode != 0:
        raise RuntimeError("啟動 LM Studio API 伺服器失敗："
                           + ((r.stderr or r.stdout) or "").strip()[-300:])
    status = _lms_server_status()
    if not status.get("running") or int(status.get("port") or 0) != 1234:
        raise RuntimeError("LM Studio API 啟動後未在 127.0.0.1:1234 就緒")


def _lms_runtime_select() -> None:
    """指定 CPU 推論環境；失敗就停止，不以 --gpu off 當成唯一保險。"""
    try:
        r = _lms_run([str(LMS_BIN), "runtime", "select", LMS_RUNTIME],
                     capture_output=True, timeout=60)
    except Exception as e:
        raise RuntimeError(f"選擇 CPU 推論環境失敗：{e}")
    if r.returncode != 0:
        raise RuntimeError("選擇 CPU 推論環境失敗："
                           + ((r.stderr or r.stdout) or "").strip()[-300:])


def _run_gate(*extra):
    """跑地端把關腳本，回傳 (是否放行, 說明)

    退出碼沿用 ai-hub 的約定：0 / 1 放行（1 是「有意見但不擋」），2 是擋下。
    其他退出碼一律當成擋下 —— 把關腳本自己壞掉的時候，
    「先不要載」比「當作沒事照樣載」安全。找不到腳本同理。
    """
    if not LOCAL_GATE.exists():
        return False, (f"找不到把關腳本 {LOCAL_GATE}"
                       "（可在 server/config.json 以 local_gate 指定路徑）")
    try:
        r = _run([sys.executable, str(LOCAL_GATE), *extra],
                 capture_output=True, text=True, encoding="utf-8", errors="replace",
                 timeout=120)
    except Exception as e:
        return False, f"把關腳本執行失敗：{e}"
    msg = ((r.stdout or "") + (r.stderr or "")).strip()[-400:]
    if r.returncode in (0, 1):
        return True, msg
    if r.returncode == 2:
        return False, msg or "把關腳本擋下這次載入"
    return False, f"把關腳本以非預期的退出碼 {r.returncode} 結束：{msg}"


def _owned_identifier(model: str) -> str:
    """自己載入的實例取一個看得出來源的名字 —— 之後只卸載這一個"""
    key = _IDENT_BAD_RE.sub("-", model).strip("-")[:48] or "model"
    return f"ai-console-{key}"


def ensure_lms_chat_model(model: str) -> str:
    """把地端對話要用的模型準備好，回傳真正要送進 payload 的名字

    只有明確的 POST /api/chat 會呼叫這裡。三條路，只有最後一條會動到機器：

      · 已載入的正是這個模型 → 沿用它現有的識別碼（伺服器沒開就只開伺服器）
      · 載入的是別的模型     → 直接報錯。絕不卸載、絕不取代：那可能是影片
                              管線或另一個專案花好幾分鐘載進去的，而這台
                              機器載一個 20～28 GB 的模型要 30～55 秒。
      · 什麼都沒載入         → 過了把關腳本才自己載一個，並記住識別碼

    模型名一定要跟已安裝清單完全相等才往下走 —— 這個字串會變成 lms load
    的參數，不做白名單就等於把命令列參數交給呼叫端決定。
    """
    if not LMS_BIN.exists():
        raise RuntimeError(f"找不到 lms 執行檔（{LMS_BIN}）")
    installed = lms_installed_models()
    if not installed:
        raise RuntimeError("lms ls 列不出任何已登錄的模型")
    if model not in installed:
        raise ValueError(f"模型不在本機已安裝清單內，拒絕載入：{str(model)[:80]!r}")

    with _lifecycle_lock():
        # 鎖外面看到的狀態可能已經過期（別的流程剛載完或剛卸載），重問一次
        loaded = _lms_ps()
        mine = [m for m in loaded if m.get("modelKey") == model]
        others = [m for m in loaded if m.get("modelKey") != model]
        if others or len(mine) > 1:
            names = "、".join(str(m.get("identifier") or m.get("modelKey") or "未知實例")
                              for m in loaded[:3])
            raise RuntimeError(
                f"LM Studio 目前是混合或其他模型狀態（{names}）。這裡不會卸載或取代它")
        if len(mine) == 1:
            _lms_server_start()
            # 識別碼優先：載入時可以用 --identifier 取任意名字，
            # 拿模型名去打 /v1 會找不到那個實例。
            return mine[0].get("identifier") or model
        ok, note = _run_gate()
        if not ok:
            raise RuntimeError(f"地端把關未放行：{note}")

        _lms_runtime_select()
        _lms_server_start()
        ident = _owned_identifier(model)
        try:
            # --ttl 300：閒置五分鐘自動釋放，不會讓這次對話永久佔住記憶體
            r = _lms_run([str(LMS_BIN), "load", model, "-y", "--gpu", "off",
                          "-c", "8192", "--ttl", "300", "--identifier", ident],
                         capture_output=True, timeout=300)
        except Exception as e:
            raise RuntimeError(f"載入模型失敗：{e}")
        if r.returncode != 0:
            raise RuntimeError("載入模型失敗：" + ((r.stderr or r.stdout) or "").strip()[-300:])

        ok, note = _run_gate("--post-load-identifier", ident)
        if not ok:
            # 只卸載自己剛剛載的那一個。這裡絕不會出現 --all：
            # 同一時間可能有別的流程也載了東西，全卸等於砸別人的場。
            try:
                _lms_run([str(LMS_BIN), "unload", ident],
                         capture_output=True, timeout=60)
            except Exception:
                pass
            raise RuntimeError(f"載入後把關未放行，已卸載自己載入的實例：{note}")
        return ident


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
    # 順序照「多久拿得到能用的產出」排，不是照參數量、也不是照 tok/s 排。
    #
    # 這台機器（CPU 推論）三個模型的實測：
    #   kimi-linear-48b-a3b-instruct   9.3 tok/s   推理 0 tok    3 秒交稿  ← 最快拿到東西
    #   qwen3.6-35b-a3b               14.9 tok/s   推理 100%     永遠空的
    #   qwen3.8-27b（dense）            3.7 tok/s   推理大量      61 秒一句話
    #
    # 中間那個原本被我排在第一位，因為它 tok/s 最高 —— 但它是推理型，
    # 給到 1500 tokens 還是全花在 reasoning_content 上，content 一個字都不吐，
    # 連 /no_think 都關不掉。tok/s 高但吐不出東西等於零。
    # instruct 版沒有這個問題，所以排最前面。
    capable = ("kimi-linear-48b", "qwen3-coder-next", "qwen3.8-27b",
               "gpt-oss-120b", "qwen3.6-35b")
    loaded = [m for m in lms_loaded_keys() if m]
    for m in loaded:
        if any(c in m for c in capable):
            return m
    for want in capable:
        for m in available:
            if want in m:
                return m
    # 偏好清單全落空時，已載入的還是比要重新載的好
    return (loaded[0] if loaded else (available[0] if available else ""))


# 任務鏈：順序照「多久拿得到能用的產出」排，不是照參數量或 tok/s。
#
# 這台機器是 CPU 推論（GPU0 影片管線專屬、GPU1 只放得下 4B），實測：
#   kimi-linear-48b-a3b-instruct   9.3 tok/s  推理 0 tok   3 秒交稿
#   qwen3.6-35b-a3b               14.9 tok/s  推理 100%    永遠吐不出 content
#   qwen3.8-27b（dense）            3.7 tok/s  推理大量     61 秒一句話
# 所以 instruct 版的 MoE 排在最前面：tok/s 不是最高的，但它真的會交東西。
_CHAINS = {
    "coding": ["qwen3-coder-next", "kimi-linear-48b", "qwen3.8-27b"],
    "long": ["kimi-linear-48b", "qwen3.8-27b"],
    "general": ["kimi-linear-48b", "qwen3.8-27b", "gpt-oss-120b"],
}


def chains_all():
    return _CHAINS


def chains_for(task: str):
    return _CHAINS.get(task, []) + _CHAINS["general"]


def route_model(task: str = "general"):
    """依任務類型 + 系統狀態自動選模型，回傳 (model, reason, signals)"""
    available = [m for m in lms_models() if model_complete(m)]
    loaded = lms_loaded_keys()          # 比對模型名，不是識別碼
    heavy = detect_heavy_job()
    signals = {"loaded": loaded, "heavy_job": heavy, "available": len(available)}

    def pick(cands):
        for c in cands:
            for m in available:
                if c in m:
                    return m
        return None

    # 1. 已經載入的優先 —— 這一關要在「大型工作降級」之前。
    #
    # LM Studio 一次只載一個。任務鏈挑的是「磁碟上有的」，挑到沒載入的
    # 就會冷載入，順便把別人載的那個踢掉：這台機器載一個 20～28 GB 的模型
    # 要 30～55 秒，而且違反 ai-hub 的「不得卸載或取代未知實例」。
    #
    # 為什麼要贏過降級規則：影片管線一跑就是整個週末，heavy 會一直命中，
    # 於是每一次對話都想冷載入 4B、把已經載好的模型踢掉 —— 換來的「輕量」
    # 遠不如「不要重載」值錢。何況現在是 CPU 推論，降級省的不是顯卡而是
    # CPU，而已經常駐的模型不會因為換成小的就少佔記憶體（要先卸再載）。
    if loaded:
        for c in chains_for(task):
            for m in loaded:
                if m and c in m:
                    return m, "沿用已載入的模型（避免冷載入與互踢）", signals

    # 2. 大型工作進行中且手上沒有現成模型 → 挑輕量的，避免搶資源
    if heavy:
        m = pick(["qwen3.5-4b"])
        if m:
            return m, f"偵測到大型工作進行中（{heavy}），自動改用輕量模型避免搶資源", signals

    # 3. 任務鏈
    chains = chains_all()
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


def _parse_reset(raw: str, now: _dt.datetime) -> _dt.datetime | None:
    """把 reset_at（MM/DD HH:MM）還原成年份正確的時間。

    12/31 的限流在 1/1 讀到時，補上「今年」會得到一個十二個月前的時間，
    於是「已經過了」→ 旗標被清掉 → 明明還在限流卻一直被派工。
    """
    try:
        when = _dt.datetime.strptime(f"{now.year}/{raw}", "%Y/%m/%d %H:%M")
    except ValueError:
        return None
    if when < now - _dt.timedelta(days=180):
        when = when.replace(year=now.year + 1)
    return when


def _latest_log_per_tool(log_dir: Path) -> dict:
    """每個工具最近一次派工的 log。只看最近一次是關鍵 ——
    幾天前撞過一次牆不代表現在還在牆裡。

    排序用檔名的時間戳，不用 mtime。兩個理由：
      · mtime 排的是「誰最後被寫過」。一件還在跑的舊派工會一直長 log，
        於是它的 mtime 比一件剛派出去的還新 —— 但「最近一次派工」問的是
        哪一件比較晚被派出去，那是時間戳。
      · 同一秒建立的兩個檔 mtime 會相等，排序結果不穩定（測試就先咬到這個）。
    檔名是 {YYYYMMDD-HHMMSS[_n]}_{tool}.log，時間戳在最前面，
    所以整個 stem 直接字典序比大小就是時間序。
    """
    out: dict = {}
    try:
        logs = sorted(log_dir.glob("*_*.log"), key=lambda p: p.stem, reverse=True)[:80]
    except OSError:
        return out
    for f in logs:
        tool = f.stem.split("_")[-1]
        out.setdefault(tool, f)
    return out


def detect_rate_limits(data: dict) -> None:
    """從最近一次派工的 log，認出「這個工具自己說沒額度了」。

    為什麼需要：底下的 enrich_reset_times 只會替**已經被標成限流**的工具
    補上恢復時間，它從來不會自己加上那個標記。而它的註解卻寫著
    「判斷錯了也會自我修正：真的還在限流的話，下次派工失敗會寫進 log 再被抓到」
    —— 那個「被抓到」在程式裡不存在。

    這不是理論問題。實際發生的事：codex 的額度用到 2026-09-01，
    log 裡明明白白寫著「You've hit your usage limit... try again at
    Sep 1st, 2026 10:37 PM」，但 status.json 裡 rate_limited 還是 false，
    於是派工照樣送過去、照樣撞牆，改派邏輯完全沒有觸發 ——
    使用者第二次講「不會自動切換有額度的模型」，指的就是這一層。

    只在「有恢復時間、而且還沒到」的時候才標記。理由跟 enrich_reset_times
    一樣：沒有恢復時間就沒有證據證明現在還在限流，寧可讓它被派一次工
    再失敗，也不要把一個其實可用的工具永久關在門外。
    """
    tools = data.get("tools") or {}
    if not tools:
        return
    now = _dt.datetime.now()
    for tool, log in _latest_log_per_tool(Path.home() / "ai-hub" / "dispatch-log").items():
        v = tools.get(tool)
        if not isinstance(v, dict) or v.get("rate_limited"):
            continue                      # 已經標了就不用再認一次
        try:
            text = log.read_text(encoding="utf-8", errors="ignore")[-8192:]
        except OSError:
            continue
        hit = None
        for pat in _FAIL_PATTERNS:
            for m in pat.finditer(text):
                # 工單本文會被寫進 log 開頭，而工單裡交代「撞到 usage limit 就回報」
                # 是家常便飯 —— 那不是本次執行的結果
                if not _benign_failure_context(text, m):
                    hit = m
        if not hit:
            continue
        found = RESET_RE.search(text)
        if not found:
            continue
        raw = _fmt_reset(found.group(1))
        when = _parse_reset(raw, now)
        if not when or when <= now:
            continue                      # 恢復時間已經過了，不是現在的限流
        v["rate_limited"] = True
        v["status"] = "rate_limited"
        v["reset_at"] = raw
        v["evidence"] = f"{log.name}：{_ANSI_RE.sub('', hit.group(0)).strip()[:120]}"


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
        when = _parse_reset(raw, now)                    # MM/DD HH:MM → 補年份（含跨年）
        if not when:
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

    # 請求體上限。工單再長也不會到 2 MB —— 這個數字是為了擋掉
    # 「送一份 500 MB 的 body 把記憶體吃光」，不是為了限制正常使用。
    MAX_BODY = 2 * 1024 * 1024

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            return {}
        if n <= 0:
            return {}
        if n > self.MAX_BODY:
            # 一定要把資料讀掉再回，不然連線會卡在半路
            remain = n
            while remain > 0:
                chunk = self.rfile.read(min(65536, remain))
                if not chunk:
                    break
                remain -= len(chunk)
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
        if self.path == "/api/bins":
            # 互動終端要拿執行檔路徑才開得起 pty session。
            #
            # 只回「白名單裡而且真的存在」的那幾個 —— 這份清單本來就是
            # 這台機器上裝了哪些 AI CLI，介面上早就看得到（辦公室的龍、
            # 派工的下拉選單）。真正敏感的是路徑本身，所以：
            #   · 只在同源請求下回完整路徑
            #   · 跨來源只回「有沒有裝」，不給路徑
            # 這個端點沒有副作用，純讀。
            same = self._same_origin()
            out = {}
            for name in sorted(self.KNOWN_TOOLS):
                if name in ("local", "auto"):
                    continue
                path = BIN.get(name) or ""
                if not path or not Path(path).exists():
                    continue
                out[name] = path if same else True
            return self._json({"ok": True, "bins": out, "paths": same})
        if self.path == "/api/status":
            if STATUS_JSON.exists():
                data = json.loads(STATUS_JSON.read_text(encoding="utf-8"))
                detect_rate_limits(data)
                enrich_reset_times(data)
                enrich_installed(data)
                return self._json(data)
            return self._json({"ok": False, "error": "status.json 不存在"}, 404)
        if self.path.split("?", 1)[0] == "/api/conv/tail":
            # 對話內容比「裝了哪些工具」敏感得多，讀取也必須同源。
            # 查詢只收 id；來源路徑永遠由 canonical index 決定，回應也不回傳路徑。
            if not self._same_origin():
                return self._json({"ok": False, "error": "跨來源請求已拒絕"}, 403)
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            want = query.get("id", [""])[0]
            try:
                result = load_indexed_tail(INDEX_JSON, want)
            except ConversationTailError as exc:
                return self._json({
                    "ok": False,
                    "code": exc.code,
                    "error": str(exc),
                    "resumeAvailable": exc.resume_available,
                }, exc.status)
            return self._json({"ok": True, **result})
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
        if self.path == "/api/dispatch/tools":
            return self.do_dispatch_tools()
        if self.path.split("?", 1)[0] == "/api/search":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            return self._json(_search_conversations((q.get("q") or [""])[0]))
        if self.path.split("?", 1)[0] == "/api/dispatch/diff":
            return self.do_dispatch_diff()
        if self.path == "/api/audit":
            # 這個 GET 會啟動外部腳本，等於有副作用 —— 一定要過同源檢查。
            # 不然惡意網頁一個 <img src="http://127.0.0.1:5177/api/audit">
            # 就能在使用者的機器上跑起這條流程。
            if not self._same_origin():
                return self._json({"ok": False, "error":
                                   "跨來源請求已拒絕"}, 403)
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
        # ── 條件式請求：沒變就回 304，不要再送一次 body ──
        #
        # 畫面每 60 秒重讀一次 index.json。那個檔在這台機器上是 1.4 MB，
        # 而它只有在跑過掃描之後才會變（預設 15 分鐘一次）——
        # 也就是說十五次裡有十四次是把同一份 1.4 MB 再搬一遍。
        #
        # 前端本來就寫了 `if (r.status === 304) return null`，它一直在等這個 304；
        # 是伺服器這半從來沒實作，所以那行是永遠走不到的死碼。
        #
        # 而且浪費的不只是頻寬：每次拿到 body 就會 setIndex(新物件)，
        # 於是「目前選取的對話」換了身分，正在讀的那份對話跟著被重新抓一次，
        # 畫面還會自動捲回最底 —— 捲上去讀舊訊息的人每 60 秒被打斷一次。
        try:
            st = f.stat()
            body = f.read_bytes()
        except OSError:
            return self._json({"ok": False, "error": "read fail"}, 500)
        # 用 mtime + 大小組 ETag，不用內容雜湊：這個檔 1.4 MB，
        # 每次輪詢都算一次 sha 反而把省下來的 I/O 又花回去。
        etag = f'W/"{int(st.st_mtime)}-{st.st_size}"'
        last_mod = _dt.datetime.fromtimestamp(
            st.st_mtime, _dt.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S GMT")

        if self.headers.get("If-None-Match") == etag \
                or self.headers.get("If-Modified-Since") == last_mod:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Last-Modified", last_mod)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return

        mime = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        if f.suffix in (".js", ".mjs"):
            mime = "text/javascript"
        elif f.suffix == ".json":
            mime = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime.startswith(("text", "application/json")) else mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", last_mod)
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
            try:
                cmd, cwd = build_launch(conv)
            except ValueError as e:
                # safe_sid 擋下來的。講清楚是哪一筆，不要只回一個 500
                return self._json({"ok": False, "error": str(e)}, 400)
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
            # 只接受本機 LM Studio 已安裝的模型，避免任意字串注入。
            # 需要的話也在這裡（而且只有這裡）把伺服器與模型準備好 ——
            # 原本直接打 /v1/chat/completions，伺服器沒開就一路失敗到底。
            try:
                resolved = ensure_lms_chat_model(model)
            except ValueError as e:
                return self._json({"ok": False, "error": str(e)}, 400)
            except Exception as e:
                return self._json({"ok": False, "error": f"地端模型無法使用：{e}"}, 502)
            try:
                payload = json.dumps({
                    "model": resolved,
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
                    "model": resolved,      # 實際用到的實例（可能是識別碼，不是模型名）
                })
            except Exception as e:
                return self._json({"ok": False, "error": f"地端模型呼叫失敗：{e}"}, 502)

        if self.path == "/api/conv/delete":
            return self.do_conv_delete()
        if self.path == "/api/conv/archive":
            return self.do_conv_archive()
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
        if self.path == "/api/dispatch/cancel":
            return self.do_dispatch_cancel()
        if self.path == "/api/dispatch/retry":
            return self.do_dispatch_retry()
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
        # 不要用 cmd /c。qwen 是 npm 的 .CMD 包裝殼，經過 cmd.exe 的話
        # 使用者補的那句話會被動三次手腳（實測矩陣）：
        #   · 遇到雙引號就把後面整段截掉 —— 「改用 "tools/" 那份」只送出前半
        #   · %VAR% 被展開 —— %CD% 變成本機絕對路徑，跟著送進雲端模型
        #   · 含換行就整個不執行 —— 貼一段錯誤訊息會靜默失敗
        # 直接給 argv，跟無頭派工那條走一樣的路。
        "qwen": lambda p: [BIN["qwen"], "-c", "-p", p],
        "gemini": lambda p: [BIN["gemini"], "--dangerously-skip-permissions",
                             "--print-timeout", "30m", "-c", "-p", p],
    }
    # 可以被指定的工具名。任何不在這裡面的一律拒絕 —— 見 do_dispatch 的說明。
    KNOWN_TOOLS = set(BIN) | {"local", "auto"}
    # 只會開一個可見終端、把指令帶進去、然後等人按 Enter 的工具。
    # 它們不是壞掉，是本來就沒有無頭模式 —— 但對「派工」來說差別是致命的：
    # 派出去之後沒有人按，那件事就永遠停在原地，而畫面上它看起來已經派出去了。
    TERMINAL_TOOLS = {"grok", "kimi", "cursor"}
    # 自動路由順序。**只放會自己跑完的工具**（地端由 LM Studio 兜底）。
    #
    # 原本這裡是 [claude, codex, gemini, grok, qwen] —— grok 排在 qwen 前面，
    # 而 grok 只開終端。於是「前三個都限流」的那天，auto 會挑中 grok，
    # 開一個視窗擺在那裡，沒有人按，工單一步都不會動；
    # 而 qwen 明明有額度、也會自己跑完，卻永遠輪不到。
    # 使用者的原話是「不會自動切換有額度的模型」—— 真正的病因在這一行。
    #
    # 要人手動按的工具仍然可以「指名」派工（那是使用者自己的選擇），
    # 但不該由自動路由替他做這個選擇。
    CLOUD_CHAIN = ["claude", "codex", "gemini", "qwen"]
    DISPATCHES = []  # 派工登錄：{id, tool, task, started, pid, log, mode, reply}
    # 請求執行緒、批次工作執行緒、排程執行緒都會動這份清單再整份寫檔。
    # 沒有鎖的話兩邊同時寫會互相蓋掉 —— 這個專案已經因為登錄被覆蓋而丟過一次歷史。
    # 用 RLock：底下幾個交易在持鎖狀態下還會呼叫 _save_registry()
    _REG_LOCK = threading.RLock()
    # 批次的「檢查 + 標記」要原子，不然兩個請求會各開一個 worker
    _BATCH_LOCK = threading.Lock()
    MAX_STEPS = 20          # 一批最多幾件
    MAX_TASK = 20000        # 單件工單字數上限
    REGISTRY = Path.home() / "ai-hub" / "dispatch-log" / "_registry.json"

    def _reg_append(self, rec: dict) -> None:
        """把一筆派工寫進登錄。整段（必要時載入 → append → 存檔）都在鎖裡。

        原本 append 與 _save_registry() 是兩個獨立動作，鎖只包住後者。
        兩個請求同時進來時，其中一筆的 append 會被另一筆的整份寫檔蓋掉 ——
        這個專案已經因為登錄被覆蓋而丟過一次歷史。
        """
        with self._REG_LOCK:
            if not self.DISPATCHES:
                self._load_registry()
            self.DISPATCHES.append(rec)
            self._save_registry()

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
        home = Path.home().resolve()
        extras: list[Path] = []
        if conv.get("tool") == "claude":
            extras = claude_desktop_cards(str(conv.get("sessionId") or ""))

        # jsonl 已不在時仍要把桌面板殘卡清掉，否則側欄會掛著刪不掉
        if src.exists():
            try:
                if not src.resolve().is_relative_to(home):
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
        else:
            dest = None

        for card in extras:
            try:
                if not card.resolve().is_relative_to(home):
                    continue
            except (OSError, ValueError):
                continue
            self.TRASH.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            cdest = self.TRASH / f"{stamp}_claude-card_{card.name}"
            try:
                import shutil
                shutil.move(str(card), str(cdest))
            except OSError:
                continue

        drop_index_conv(conv_id)
        return self._json({"ok": True, "trash": str(dest) if dest else "card-only"})

    def do_conv_archive(self):
        """封存 Claude Desktop 側欄卡：寫 isArchived，不刪 jsonl。"""
        body = self._body()
        conv_id = str(body.get("id", "")).strip()
        archived = bool(body.get("archived", True))
        if not conv_id:
            return self._json({"ok": False, "error": "需要 id"}, 400)
        conv = find_conv(conv_id)
        if not conv:
            return self._json({"ok": False, "error": "找不到這個對話"}, 404)
        if conv.get("tool") != "claude":
            return self._json({"ok": False, "error": "目前只支援 Claude 桌面板封存"}, 400)
        cards = claude_desktop_cards(str(conv.get("sessionId") or ""))
        if not cards:
            return self._json({"ok": False, "error": "找不到桌面板對話卡"}, 404)
        n = 0
        for card in cards:
            try:
                data = json.loads(card.read_text(encoding="utf-8"))
                data["isArchived"] = archived
                tmp = card.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                tmp.replace(card)
                n += 1
            except (OSError, json.JSONDecodeError) as e:
                return self._json({"ok": False, "error": f"寫入失敗：{e}"}, 500)
        try:
            data = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
            for c in data.get("conversations", []):
                if c["id"] == conv_id:
                    c["archived"] = archived
                    c["trashed"] = archived or c.get("trashed")
                    if archived:
                        c["trashReason"] = "archived"
            INDEX_JSON.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except (OSError, json.JSONDecodeError):
            pass
        return self._json({"ok": True, "cards": n, "archived": archived})

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

        # ── 選一個現在真的有額度的工具 ──
        #
        # 原本只有 tool == "auto" 會查限流。指名的話一律照派 ——
        # 於是指名一個正在限流的工具，等於把工單丟進牆裡：
        # 派得出去、log 裡一行「usage limit」、然後就沒了。
        # 使用者的原話是「不會自動切換有額度的模型」。
        #
        # 「你指名誰就是誰」仍然是這個程式的原則，所以改派不是安靜做掉的：
        # 回傳 rerouted，畫面要明講換了誰、為什麼。
        # 指名的深層意圖是「這件事要做完」，不是「就算做不成也要給他」。
        limited = self._limited_tools()
        rerouted = None
        if tool == "auto":
            tool = next((t for t in self.CLOUD_CHAIN if t not in limited), "local")
        elif tool in limited:
            alt = next((t for t in self.CLOUD_CHAIN
                        if t != tool and t not in limited
                        and t in self.DISPATCH_TOOLS and BIN.get(t)), None)
            if alt:
                rerouted = {"from": tool, "to": alt, "why": f"{tool} 的額度已經用完"}
                tool = alt
            else:
                return self._json({"ok": False, "error":
                                   f"{tool} 的額度已經用完，而其他工具現在也都不能用"
                                   "（限流或沒安裝）。等額度恢復，或改用地端"}, 503)

        # 掛上規範與技能。派出去的 agent 不會自己知道這台機器的不可違反條款，
        # 也不會知道有現成技能可用 —— 工單裸奔的代價太高，所以一律加。
        # body 傳 raw=true 可以跳過（例如系統自己發的探測指令）。
        applied_skills: list[str] = []
        if not body.get("raw"):
            task, applied_skills = rules.wrap(task, tool, _CFG)

        log_dir = Path.home() / "ai-hub" / "dispatch-log"
        log_dir.mkdir(parents=True, exist_ok=True)
        # 時間戳只到秒，同一秒派兩件會撞號 —— 實測踩過：
        # 一次派兩個測試員，第一個的結果直接消失。
        # _new_stamp 用原子建檔搶號，不是「先看再建」。
        stamp = _new_stamp(log_dir, tool)
        log_file = log_dir / f"{stamp}_{tool}.log"

        if tool in self.DISPATCH_TOOLS:
            # 派工可以指定工作目錄。沒指定才退回家目錄。
            #
            # 為什麼要能指定：無頭派工原本一律從家目錄啟動，工單裡只用文字寫著
            # 「專案根目錄：…」。後果有兩層：
            #   1. agent 得自己 cd 過去，多一個會出錯的步驟
            #   2. 派工紀錄裡的 cwd 永遠是家目錄，於是「這一筆改了什麼」
            #      根本問不出來 —— 家目錄不是 git 專案，git diff 沒有東西可看
            # sanitize_cwd 已經處理過引號、斜線與 \\?\ 前綴。
            want = (body.get("cwd") or body.get("projectDir") or "").strip()
            cwd = sanitize_cwd(want) if want else str(Path.home())
            if not Path(cwd).is_dir():
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
            except OSError as e:
                # 一定要 fail closed。原本這裡退回 DISPATCH_TOOLS[tool](task)，
                # 把使用者原始文字直接放進命令列 —— 換行會被截斷、%VAR% 會被
                # 展開成本機路徑，終端分支那條更會被寫進 .cmd 而執行第二條命令
                # （已用探針重現）。寫不了工單就不要派，比派出一個殘缺或危險的好。
                return self._json({"ok": False,
                                   "error": f"工單檔寫不進去，這次不派工：{e}"}, 500)
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
                self._reg_append({"id": stamp, "tool": tool, "task": raw_task[:120],
                                  "started": stamp, "pid": proc_pid, "log": str(log_file),
                                  "mode": "headless", "cwd": cwd})
                note = f"已派出 {tool} 無頭執行" + (
                    f"（已掛技能：{'、'.join(applied_skills)}）" if applied_skills else "")
                if rerouted:
                    note = f"{rerouted['why']}，已改派給 {tool}。" + note
                return self._json({"ok": True, "tool": tool, "mode": "headless",
                                   "log": str(log_file), "id": stamp, "skills": applied_skills,
                                   "rerouted": rerouted, "note": note})
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
                msg = (resp.get("choices") or [{}])[0].get("message", {}) or {}
                # 推理型模型會把答案留在 reasoning_content，content 反而空的。
                # 拆解器早就兩邊都看了，這條漏掉 —— 結果是畫面顯示「完成」
                # 但回覆一個字都沒有，使用者也看不出發生什麼事。
                content = msg.get("content") or msg.get("reasoning_content") or ""
                if not content.strip():
                    finish = (resp.get("choices") or [{}])[0].get("finish_reason") or ""
                    content = (f"（{model} 沒有回出內容"
                               + (f"，finish_reason={finish}" if finish else "")
                               + "。推理型模型可能把額度用在推理上，"
                               "換一個模型或把問題講得更短會好一些）")
                log_file.write_text(f"[{stamp}] local({model})\n指令：{task}\n\n{content}", encoding="utf-8")
                self._reg_append({"id": stamp, "tool": "local", "task": raw_task[:120],
                                  "started": stamp, "pid": None, "log": str(log_file),
                                  "mode": "sync", "reply": content[:300]})
                return self._json({"ok": True, "tool": "local", "model": model, "mode": "sync",
                                   "id": stamp, "reply": content, "log": str(log_file)})
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
            except OSError as e:
                # 同上，fail closed。這條的代價更高：prompt 會原樣寫進 .cmd，
                # 而批次檔裡的 & 是真的會執行第二條命令（探針已重現）。
                return self._json({"ok": False,
                                   "error": f"工單檔寫不進去，這次不派工：{e}"}, 500)
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
            self._reg_append({"id": stamp, "tool": tool, "task": raw_task[:120],
                              "started": stamp, "pid": None, "log": str(log_file),
                              "mode": "terminal", "echo_size": echo_size})
            note = f"{tool} 已開終端並帶入指令（指令已帶進去，但**還沒有人按下去**）"
            if rerouted:
                note = f"{rerouted['why']}，已改派給 {tool}。" + note
            return self._json({"ok": True, "tool": tool, "mode": "terminal",
                               "id": stamp, "note": note, "rerouted": rerouted,
                               "log": str(log_file)})
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 500)

    def _dispatch_state(self, d: dict, alive: bool) -> str:
        """running / waiting / done / failed / silent

        原本只有 alive 一個布林值，所以畫面只分得出「執行中」跟「不是執行中」，
        跑完的、失敗的、還沒被按下去的終端全部長一樣 ——
        清單標題寫「執行中的派工」，實際上是一份只增不減的歷史。
        """
        # 取消優先於一切。已取消的那件如果剛好還活著（使用者在按下取消的
        # 前一秒把終端按下去了），畫面上仍然標成「已取消」是對的 ——
        # 這個狀態代表的是「不要再把它算成待辦」，不是「行程已經死了」。
        if d.get("cancelled"):
            return "cancelled"
        if alive:
            return "running"
        raw_log = d.get("log") or ""
        if not raw_log:
            return "done" if d.get("mode") == "sync" else "silent"
        log = Path(raw_log)
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
                if size < 4000:
                    return "waiting"
            elif size <= echo:
                return "waiting"
        if d.get("mode") == "sync" and size == 0:
            return "done"
        if size == 0:
            return "silent"          # 無頭跑完但一個字都沒輸出
        # state 與 outcome 必須使用同一個終端裁決。舊版在這裡另做一次裸字串
        # 搜尋，會把已恢復的早期錯誤判成 failed，也會把工單正文的 error: 誤判。
        terminal = _parse_outcome(_tail_text(log))
        return "failed" if terminal["outcome"] == "error" else "done"

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
        stamp = _new_stamp(log_dir, f"{tool}_followup")
        log_file = log_dir / f"{stamp}_{tool}_followup.log"
        # 補的話一律寫成 UTF-8 檔，命令列只帶一行 ASCII 的「去讀這個檔」。
        # 派工那條早就這樣做了（因為踩過中文被地碼頁弄壞、換行被截斷），
        # 續談這條卻漏掉 —— 同樣的坑要一起補，不然使用者會發現
        # 「第一次講的有效、補的那句沒效」而完全不知道為什麼。
        order_file = log_dir / f"{stamp}_followup.md"
        try:
            order_file.write_text(safe, encoding="utf-8")
        except OSError as e:
            return {"error": f"補充內容寫不進檔案，這次不送：{e}"}
        prompt = (f"Read the UTF-8 note at {order_file} and continue accordingly. "
                  f"The file is the full instruction; do not ask for more input.")
        try:
            lf = open(log_file, "w", encoding="utf-8")
            # qwen 的 node-pty 需要一個 console，跟無頭派工那條一樣給它一個並最小化
            extra = {}
            if tool == "qwen":
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = 6      # SW_MINIMIZE
                extra = {"startupinfo": si,
                         "creationflags": subprocess.CREATE_NEW_CONSOLE}
            else:
                extra = {"creationflags": subprocess.CREATE_NO_WINDOW}
            proc = subprocess.Popen(
                make(prompt), cwd=str(Path.home()), stdout=lf,
                stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **extra)
            lf.close()
        except Exception as e:
            return {"error": str(e)}
        self._reg_append({
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

    def do_dispatch_cancel(self):
        """取消一件還沒被按下去的終端派工。

        為什麼需要：終端派工會開一個視窗、把指令帶進去，然後等人按。
        在那之前它一直被算成「進行中」。真實情況是 —— 派給 kimi 的工單
        擺了半小時沒人按，我把同一件事改派給會自己跑的 gemini；
        於是同一份工單有兩個持有者，誰先按下那個視窗，就有兩個 AI
        在同一批檔案上做同一件事。介面上完全沒有辦法把前一件收掉。

        只能取消 waiting 的那些。running 的要停下來得殺行程，
        那是另一件事，而且中途砍掉一個正在改檔案的 agent 更危險。

        取消做兩件事，缺一不可：
          1. 登錄標記 cancelled —— 畫面不再把它算成待辦
          2. **把工單檔內容換成一句「已取消」** —— 那個終端視窗還開著，
             指令也還帶在裡面。只做第 1 件的話，半小時後有人回到桌面
             看到那個視窗、順手按下去，工單照樣會被執行一次。
             換掉內容之後就算被按下去，agent 讀到的是「不要做任何事」。
        """
        body = self._body()
        did = str(body.get("id") or "").strip()
        with self._REG_LOCK:
            if not self.DISPATCHES:
                self._load_registry()
            rec = next((d for d in self.DISPATCHES if d.get("id") == did), None)
            if not rec:
                return self._json({"ok": False, "error": "找不到這筆派工"}, 404)
            alive = bool(rec.get("pid")) and int(rec["pid"]) in _alive_pids({int(rec["pid"])})
            state = self._dispatch_state(dict(rec), alive)
            if state == "cancelled":
                return self._json({"ok": True, "id": did, "already": True,
                                   "note": "這件先前已經取消過了"})
            if state != "waiting":
                return self._json({"ok": False, "error":
                                   f"只有『等你執行』的派工可以取消，這件現在是「{state}」"},
                                  409)
            rec["cancelled"] = time.strftime("%Y%m%d-%H%M%S")
            self._save_registry()

        # 工單檔換成取消通知。寫不進去不算失敗（登錄已經標記了），
        # 但一定要讓使用者知道那個視窗還是危險的。
        note = ""
        try:
            order = Path(rec.get("log", "")).parent / f"{did}_task.md"
            if order.exists():
                order.write_text(
                    "這件工作已經取消。\n\n"
                    "不要執行任何動作、不要修改任何檔案、不要回報進度。\n"
                    "如果你正在讀這份檔案，請直接結束並回覆一句「已取消」。\n",
                    encoding="utf-8")
            else:
                note = "工單檔已經不在了；那個終端視窗如果還開著，請直接關掉"
        except OSError as e:
            note = f"工單檔改不動（{e}）；請直接把那個終端視窗關掉"
        return self._json({"ok": True, "id": did, "note": note})

    def do_dispatch_retry(self):
        """把某一筆派工原封不動再派一次。

        為什麼需要：撞上 API 529、被規範擋下、或跑完什麼都沒改的時候，
        目前唯一的辦法是把整份工單重打一次 —— 而工單常常是幾十行。
        529 是伺服器端的暫時性問題，重派一次就好，不該讓人重打。

        原始工單取自 {id}_task.md，切在「【工單】」那一行之後。
        存進去的版本已經被 rules._neutralize 中和過（工單內文裡的全形
        控制標記換成半形），所以那一行一定是系統加的那個，切點是安全的；
        再中和一次也是冪等的。

        重派會產生一筆新的派工紀錄，不是覆蓋舊的 ——
        「這件重試過幾次、每次結果是什麼」本身就是要看得到的資訊。
        """
        body = self._body()
        did = str(body.get("id") or "").strip()
        if not self.DISPATCHES:
            self._load_registry()
        rec = next((d for d in self.DISPATCHES if d.get("id") == did), None)
        if not rec:
            return self._json({"ok": False, "error": "找不到這筆派工"}, 404)
        if rec.get("pid") and int(rec["pid"]) in _alive_pids({int(rec["pid"])}):
            return self._json({"ok": False, "error": "這件還在跑，先等它結束"}, 409)

        task = _order_body(Path(rec.get("log", "")).parent / f"{did}_task.md")
        if not task:
            # 工單檔不在了（清過 log、或那時候還沒有這個機制）。
            # 登錄裡只留前 120 字，拿它重派會送出一份被截斷的工單 ——
            # 那比不能重派更糟：使用者以為重跑了同一件事。
            return self._json({"ok": False, "error":
                               "找不到原始工單內容，無法原樣重派"}, 404)

        # 原樣重派，但工具本身撞牆的話就不要再撞一次 ——
        # 使用者按重派是想「把這件做完」，不是「再看它失敗一次」。
        # do_dispatch 會自己處理改派並回報 rerouted，這裡照原樣送就好。
        payload = {"tool": rec.get("tool") or "auto", "task": task}
        if rec.get("cwd"):
            payload["cwd"] = rec["cwd"]
        req = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/api/dispatch",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8",
                     "Origin": f"http://127.0.0.1:{PORT}"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                out = json.loads(r.read())
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 500)
        out["retryOf"] = did
        return self._json(out)

    def do_dispatch_batch(self):
        """一次收下整批工單，在背景一件一件跑

        serial=True（預設）會等前一件的行程真的結束才派下一件。
        這是唯一能避免多個 agent 同時改同一批檔案的做法 ——
        前端 await 一個非阻塞的 Popen 是等不到的。
        """
        body = self._body()
        steps = body.get("steps") or []
        serial = bool(body.get("serial", True))
        # 整批共用一個工作目錄。逐件指定沒有意義 —— 一批工單本來就是
        # 針對同一件事拆出來的，散在不同專案的話 serial 也保護不了什麼。
        batch_cwd = str(body.get("cwd") or "").strip()
        if not isinstance(steps, list) or not steps:
            return self._json({"ok": False, "error": "需要 steps"}, 400)
        if len(steps) > self.MAX_STEPS:
            # 拆解器最多回 5 件，介面也不會生出更多。真的送幾千件進來，
            # serial=false 會在幾秒內開出幾千個 AI CLI 行程，
            # RAM、PID、檔案控制代碼跟雲端額度會一起見底。
            return self._json({"ok": False,
                               "error": f"一批最多 {self.MAX_STEPS} 件"}, 400)

        jobs = []
        for x in steps:
            if not isinstance(x, dict):
                continue            # [null] 這種進來不該讓整個請求執行緒死掉
            task = str(x.get("task") or "").strip()
            if task:
                job = {"tool": str(x.get("tool") or "auto"),
                       "task": task[:self.MAX_TASK]}
                if batch_cwd:
                    job["cwd"] = batch_cwd
                jobs.append(job)
        if not jobs:
            return self._json({"ok": False, "error": "工單內容都是空的"}, 400)

        cls = type(self)
        # 「看有沒有在跑」跟「標記成在跑」必須是同一個不可分割的動作。
        # 分開寫的話兩個請求可以同時讀到 running=False，各自啟動一個 worker，
        # 然後互相覆蓋同一份進度 —— 使用者會看到進度條莫名其妙倒退。
        with cls._BATCH_LOCK:
            if cls.BATCH["running"]:
                return self._json({"ok": False, "error": "上一批還在跑，等它結束或先取消"}, 409)
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

    @staticmethod
    def _limited_tools() -> set:
        """現在限流中的工具。讀不到就當成沒有人限流（不要因此擋住派工）。

        這裡跟 /api/status 一樣會跑 detect_rate_limits —— 原本這一層完全不存在，
        於是 codex 的 log 裡明明白白寫著「usage limit… try again at Sep 1st」，
        status.json 的 rate_limited 卻還是 false，工單照樣送過去撞牆。

        但**刻意不跑 enrich_reset_times**，雖然畫面那邊會跑。不是疏忽：
        那個函式做的是「找不到恢復時間就把旗標清掉」，而清掉旗標在這兩個地方
        的代價完全不同 ——
          · 畫面猜錯：一隻龍的顏色不對，看一眼就知道
          · 路由猜錯：工單送進一個沒額度的工具，log 裡一行錯誤，然後就沒了，
            半小時後才發現這件事根本沒開始
        兩邊都往「比較不痛的那個方向」錯：畫面寧可說它還能用，
        路由寧可換一個。加旗標兩邊一致，清旗標只在畫面。
        """
        try:
            status = json.loads(STATUS_JSON.read_text(encoding="utf-8"))
            detect_rate_limits(status)
            return {k for k, v in (status.get("tools") or {}).items()
                    if v.get("rate_limited")}
        except Exception:
            return set()

    # 給人看的工具名。程式裡用小寫 id，畫面上用這個。
    TOOL_LABELS = {"claude": "Claude", "codex": "Codex", "gemini": "Gemini",
                   "qwen": "Qwen", "grok": "Grok", "kimi": "Kimi",
                   "cursor": "Cursor", "local": "地端模型"}

    def do_dispatch_tools(self):
        """現在派得出去的工具，以及每一個「派出去之後會發生什麼」。

        為什麼要有這支 API：前端的工具下拉本來是寫死的一串字串，
        於是畫面上 kimi 跟 gemini 長得一模一樣 —— 但選前者要人回到桌面
        找到那個視窗按 Enter，選後者按完就沒事了。這個差別在派工的當下
        完全看不出來，只會在半小時後發現「怎麼一步都沒動」。

        limited 也一起回：限流中的工具照樣列出來（使用者要知道它存在），
        但畫面上要能標成不可選，而不是選了才在 503 裡看到原因。
        """
        limited = self._limited_tools()
        out = []
        for tool in ["claude", "codex", "gemini", "qwen", "grok", "kimi", "cursor"]:
            if not BIN.get(tool):
                continue          # 這台機器上沒裝，不要列出來給人選
            out.append({
                "id": tool,
                "label": self.TOOL_LABELS.get(tool, tool),
                "mode": "terminal" if tool in self.TERMINAL_TOOLS else "headless",
                "limited": tool in limited,
            })
        out.append({"id": "local", "label": self.TOOL_LABELS["local"],
                    "mode": "local", "limited": False})
        # auto 現在會挑到誰。畫面上直接寫出來，不要讓人猜。
        pick = next((t for t in self.CLOUD_CHAIN
                     if t not in limited and BIN.get(t)), "local")
        return self._json({"ok": True, "tools": out, "auto": pick,
                           "limited": sorted(limited)})

    def _handoff_order(self, target: dict, text: str, why: str) -> str:
        """把一件做到一半的工作，交接給另一個 AI。

        為什麼需要：「💬 補一句」是用各家的續談旗標（--continue / -c /
        resume --last）再派一次 —— **一定是原本那個 AI 執行**。
        它撞到額度上限的時候，這條路就斷了；而 kimi 這種只能開終端的工具
        從一開始就沒有這條路。

        那正是這個程式該解決的事：對話的脈絡活在原工具裡帶不走，
        但「原始工單」與「它已經做到哪裡」是我們手上就有的東西。
        把這兩樣加上使用者補的那句話組成一份新工單，換一個沒限流的 AI 接手，
        比讓使用者自己複製貼上重打一遍可靠得多。

        log 尾端刻意只給 6000 字：太少看不出做到哪，太多會把接手的那個
        AI 的注意力吃光，而且前面多半是它自己的思考過程，不是結論。
        """
        order = _order_body(Path(target.get("log", "")).parent
                            / f"{target.get('id')}_task.md")
        log = Path(target.get("log", ""))
        tail = _ANSI_RE.sub("", _tail_text(log, 24 * 1024))[-6000:] if log.is_file() else ""
        prev = target.get("tool", "?")
        # 只開終端的工具（kimi／grok／cursor）不會把產出寫進 log，
        # 檔案裡只有「啟動時回顯的那份工單」。判準用 rules 的控制標記，
        # 那是回顯才會有的東西，不是猜的。
        echoed = "【執行前置" in tail or "【工單】" in tail
        has_progress = bool(tail) and not echoed
        parts = [
            f"【接力】這件工作原本交給 {prev}，{why}。請你接手做完。",
            "",
            "接手的規則（很重要）：",
            # 規則要跟下面的內容一致。沒有進度可讀卻寫「先讀下面它做到哪裡」，
            # 接手的 AI 會去找一段不存在的東西，然後自己編一個它以為的進度。
            (f"1. 先讀下面「{prev} 已經做到哪裡」，**不要把它做過的事再做一次**。"
             if has_progress
             else f"1. {prev} 沒有留下可讀的輸出，**先自己確認檔案現況**，"
                  "不要假設它什麼都沒做，也不要假設它做完了。"),
            "2. 它可能做到一半就中斷，檔案可能處於半完成狀態 —— 先確認現況再動手。",
            "3. 有疑慮就照原始工單的要求走，不要自己改需求。",
            "",
            "── 原始工單 ──",
            order or "（原始工單檔已經不在，只能依下面的紀錄推斷）",
        ]
        if has_progress:
            parts += ["", f"── {prev} 已經做到哪裡（它的輸出尾端）──", tail]
        else:
            parts += ["", f"── {prev} 的進度 ──",
                      f"（{prev} 是開終端執行的，沒有留下可讀的輸出。"
                      "請先自己確認檔案現況，再決定要做什麼。）"]
        if text:
            parts += ["", "── 使用者這次補充的要求 ──", text]
        return "\n".join(parts)

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

        # ── 原本那個 AI 接不下去的時候，換一個人接手 ──
        #
        # 「補一句」是用各家的續談旗標再派一次，所以**一定是原本那個 AI 執行**。
        # 兩種情況它接不下去：
        #   · 沒有續談模式（kimi 只能開終端，沒有無頭續談）
        #   · 額度用完了 —— 而這正是使用者問的：「額度就用完了怎麼執行」
        # 以前這兩種都只回一句「只能重新派一件」，把問題丟回給使用者，
        # 而他要做的事是把整份工單重打一遍。
        #
        # 對話脈絡活在原工具裡帶不走，但「原始工單」與「它做到哪裡」
        # 我們手上就有。組成一份接力工單換人做，比讓人重打可靠得多。
        prev_tool = target.get("tool", "")
        limited = self._limited_tools()
        why = ""
        if prev_tool not in self.FOLLOWUP_TOOLS:
            why = f"{prev_tool} 沒有無頭續談模式"
        elif prev_tool in limited:
            why = f"{prev_tool} 的額度已經用完"
        if why:
            # 挑一個「能無頭跑、有執行檔、而且沒限流」的工具
            pick = next((t for t in self.CLOUD_CHAIN
                         if t != prev_tool and t in self.DISPATCH_TOOLS
                         and BIN.get(t) and t not in limited), None)
            if not pick:
                return self._json({"ok": False, "error":
                                   f"{why}，而其他工具現在也都不能用（限流或沒安裝）。"
                                   "等額度恢復，或自己開終端接手"}, 503)
            payload = {"tool": pick, "task": self._handoff_order(target, text, why)}
            if target.get("cwd"):
                payload["cwd"] = target["cwd"]
            req = urllib.request.Request(
                f"http://127.0.0.1:{PORT}/api/dispatch",
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json; charset=utf-8",
                         "Origin": f"http://127.0.0.1:{PORT}"})
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    out = json.loads(r.read())
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 500)
            out["handoff"] = {"from": prev_tool, "to": pick, "why": why}
            out["note"] = f"{why}，已把工單與它做到的進度交給 {pick} 接手"
            return self._json(out)

        pid = target.get("pid")
        alive = bool(pid) and int(pid) in _alive_pids({int(pid)})
        if alive:
            # 讀 pending → 加一句 → 寫回，要在同一把鎖裡。
            # 分開做的話兩個分頁同時補話，後寫的那份會把前一句吃掉。
            with self._REG_LOCK:
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
        """跑完的那些，把排隊中的續談送出去

        先在鎖裡把 pending「認領」走（讀出來並立刻清空），再放開鎖去送。
        兩個分頁同時輪詢 /api/dispatches 都會走到這裡 —— 不認領的話兩邊
        會讀到同一句還沒清空的 pending，同一句話送出兩次、
        開兩個 AI 行程去改同一批檔案。
        送出動作放在鎖外，因為它會啟動子行程，不該佔著鎖。
        """
        claimed = []
        with self._REG_LOCK:
            for d in rows:
                if d.get("alive") or not d.get("pending"):
                    continue
                src = next((x for x in self.DISPATCHES if x.get("id") == d.get("id")), None)
                if not src or not src.get("pending"):
                    continue
                claimed.append((src, "\n".join(src.get("pending") or [])))
                src["pending"] = []
            if claimed:
                self._save_registry()
        for src, text in claimed:
            self._send_followup(src, text)

    def do_dispatch_diff(self):
        """某一筆派工的工作目錄現在有什麼未提交的改動。

        為什麼是「未提交的改動」而不是「這一趟改了什麼」：
          派出去的 agent 一律不 commit（工單就是這樣寫的），所以工作目錄的
          未提交差異就是它做的事。真要精確到「這一趟」得在派工開始時存一份
          git 快照，但那會讓每一次派工都多一次 git 呼叫，而收穫只在
          「同一個目錄連續派兩件、想分開看」這種少見情況 —— 不值得。
          這個取捨要講出來，不然使用者會以為看到的是精確歸屬。

        只在使用者按下按鈕時才跑，不在輪詢路徑上 —— git diff 在大 repo 上不便宜。
        """
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        did = (q.get("id") or [""])[0]
        if not self.DISPATCHES:
            self._load_registry()
        rec = next((d for d in self.DISPATCHES if d.get("id") == did), None)
        if not rec:
            return self._json({"ok": False, "error": "找不到這筆派工"}, 404)
        cwd = rec.get("cwd") or ""
        if not cwd or not Path(cwd).is_dir():
            return self._json({"ok": True, "cwd": cwd, "isGit": False, "files": []})
        # 一定要指定 encoding="utf-8"。
        #
        # 這個坑 _lms_run 的註解裡已經寫過一次，我還是踩了：
        # 在 Windows 上 text=True 會用系統 ANSI code page（這台是 CP950）解碼，
        # 而這個專案的原始碼註解全是中文 —— patch 內容一進來就 UnicodeDecodeError，
        # subprocess 的 reader thread 直接死掉，stdout 變成空字串。
        # 沒有例外、沒有錯誤碼，畫面上就是「每個檔都有 +25 −2，但點開 patch 是空的」。
        # --numstat 逃過一劫只是因為它的輸出是純 ASCII。
        #
        # core.quotepath=false：否則非 ASCII 檔名會被 git 轉成 "\346\226\207"
        # 這種八進位跳脫，跟 numstat 的路徑對不起來，patch 就配不到檔案。
        try:
            return self._json(_git_diff(cwd))
        except Exception as e:
            return self._json({"ok": False, "error": str(e)}, 500)

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
                # 只讀尾端。這個端點每 8 秒被打一次、兩個分頁都在打，
                # 而 CLI 可以吐出幾百 MB 的 log —— 整份讀進來只為了取最後一行，
                # 記憶體會被輪詢本身吃掉。
                text = _tail_text(log)
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
                # 還在跑的不判定結果 —— 中途出現的一次重試訊息不代表最後失敗。
                # 但花費是累積的，跑到一半也算得出來，先給使用者看。
                got = _outcome_for(log, d["logSize"], text)
                d["cost"] = got["cost"]
                # state 是 running／waiting 時**沒有結果可以講**。
                #
                # 這是實際點過畫面才看到的：兩張剛派給 kimi 的工單，
                # 清單標題寫「3 件進行中」，三列卻全部寫「已完成」——
                # 而 kimi 的終端才剛開，一個字都還沒做。
                # 原因是終端派工的 pid 是啟動器不是 kimi，啟動器一退出
                # alive 就變 false，outcome 就被算成 ok。
                # 「行程結束」對無頭派工等於「工作做完」，對終端派工只等於
                # 「視窗開好了」—— 那是兩件完全不同的事。
                # _dispatch_state 本來就判得對（waiting／等你執行），
                # 是後加的 outcome 把它輾過去了。
                if d["state"] in ("running", "waiting"):
                    d["outcome"], d["issue"] = None, ""
                else:
                    d["outcome"], d["issue"] = got["outcome"], got["issue"]
            # 這一筆的工作目錄有沒有 git，決定「📝 看改了什麼」值不值得出現。
            #
            # 不給這個旗標的話，每一筆都長出一顆按鈕，而多數派工的 cwd 是家目錄
            # ——按下去只會得到「這個工作目錄不是 git 專案」。
            # 一顆按十次有九次沒東西的按鈕，比沒有這顆按鈕更糟：
            # 使用者會學會不按它，然後真的有改動的那一次也不會去看。
            d["canDiff"] = _has_git(d.get("cwd") or "")
            out.append(d)
        # 排隊中的續談：上一輪一結束就送出去。放在輪詢裡而不是另開執行緒，
        # 是因為主控台本來就每 8 秒問一次，不需要再多一個背景迴圈。
        #
        # 但這一步會啟動子行程 —— 是副作用，不是讀取。跨來源的 <img> 也能打
        # 到這個 GET，所以只在同源時才送；跨來源就純粹回報狀態。
        if self._same_origin():
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
