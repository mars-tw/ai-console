# -*- coding: utf-8 -*-
"""
ai-console 索引器
掃描本機各 AI 工具的 session 檔，正規化成統一 JSON：
  public/data/index.json            — 專案 + 工具狀態 + 全部對話摘要
  public/data/conv/<tool>__<id>.json — 單一對話的訊息（有截斷上限）

設計原則：
- 只讀不寫原始 session 檔
- 大檔只取頭尾（>8MB 的檔案不做全文解析）
- Codex 的 thread_spawn 子代理對話標記 subagent=true，前端預設隱藏
"""
import json
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
AI_HUB = HOME / "ai-hub"
APP_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = APP_ROOT / "public" / "data"
CONV_DIR = DATA_DIR / "conv"

HEAD_BYTES = 65536          # 索引用：只讀檔頭 64KB
FULL_PARSE_LIMIT = 8 * 1024 * 1024   # 8MB 以下才全文解析匯出訊息
MAX_MSGS = 120              # 每個對話最多匯出幾則訊息
MAX_TEXT = 2000             # 每則訊息最長字元

# ── 專案歸類規則 ───────────────────────────────────
# 規則內容會洩漏使用者在做什麼專案（客戶名、產品名），所以不寫在程式裡：
#   tools/projects.local.json  ← 你自己的規則（gitignore，不會進開源版）
#   tools/projects.example.json ← 附的範例，讓別人知道格式
# 兩個都沒有就只做「其他／未分類」，功能不會壞。
def _load_project_config():
    here = Path(__file__).resolve().parent
    for name in ("projects.local.json", "projects.example.json"):
        f = here / name
        if not f.exists():
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        rules = [(r["id"], r["keywords"]) for r in d.get("rules", []) if r.get("id")]
        titles = dict(d.get("titles") or {})
        titles.setdefault("other", "其他／未分類")
        return rules, titles
    return [], {"other": "其他／未分類"}


PROJECT_RULES, PROJECT_TITLES = _load_project_config()

# ── 分辨「真人對話」與「AI 派工」──────────────────
#
# 這件事比想像中重要：一台機器跑久了，AI 之間互相派工產生的對話會遠多於
# 使用者自己開的對話，全部混在一起就等於找不到自己的東西。
#
# 判定一律只看「開頭」與「標題長相」，因為工單的特徵都在第一句話。
DISPATCH_PATTERNS = [
    # 明確的代理工單／協調協議
    # 「You are the/a/an …」開頭一律當工單：那是系統提示詞的標準寫法。
    # 原本只列了幾個特定字（sole / bounded / exact-scope…），結果
    # 「You are the preferred cloud…」「You are the canonical external…」全部漏掉
    # —— 光是一個資料夾就有 96 筆這種對話混在主清單上。
    r"^You are (the|a|an)\b",
    r"^You are (currently|now|acting)\b",
    # 中文版的同一件事。要求後面要接內容、而且不是問句，
    # 才不會把使用者真的在問的「你是誰？」也算成工單。
    r"^你是[^？?]{4,}",
    # 治理工單：一開頭就限定可動的檔案範圍，那是機器對機器的講法。
    # 實測有一個資料夾裡 78 筆都是這種，全部混在主清單上。
    r"^Edit only\b", r"^Create exactly\b",
    r"^(You )?[Oo]wn only\b", r"^Update only\b",
    # 不加開頭錨點：工單路徑出現在前 200 字裡就夠明確了
    r"work-orders/tsk_", r"governance/work-orders",
    # 這個控制台自己派出去的工單。這兩個字串是 server/api.py 與
    # server/rules.py 寫進去的，出現在開頭就一定是派工，不是人打的。
    r"^Read the UTF-8 work order at",
    r"^【執行前置",
    # 限定工具／檔案／次數的祈使句 —— 人不會這樣跟 AI 講話。
    r"^(Edit|Replace|Implement|Update|Create|Use|Read|Apply) (only|exactly|one|the entire|the exact)\b",
    r"^(Bounded|Exact|Allowed tools|Say only)\b",
    r"^You are generating\b", r"^You are an? (agent|assistant|worker)\b",
    r"^TASK_ID:", r"^ROLE:",
    r"^This session is being continued",
    r"^Create probe\.txt", r"^回覆兩個字",
    # 派工的連線測試：說 OK / 回覆 OK / 回答 OK
    r"^(說|回覆|回答|輸出)\s*(OK|ok|好)\b",
    # 祈使句一開頭就是絕對路徑：在 C:\... 建立一個檔案
    r"^在\s*[A-Za-z]:[\\/]",
    # 祈使句型的產圖／產檔工單（本專案自己派出去的那種）
    r"^請產出", r"^請為一個", r"^請依", r"^請用\s*image_gen",
    r"^重新產出", r"^用\s*image_gen", r"^你是遊戲美術",
    r"^Generate (an?|one|the)\b", r"^Create (an?|one|the)\b",
    r"^Produce (an?|one|the)\b", r"^Render (an?|one|the)\b",
    # 一開頭就是絕對路徑或命令列
    r"^[A-Za-z]:\\", r"^/[a-z]+/", r"^(npm|npx|python|node|git|pip)\s",
]
DISPATCH_RE = re.compile("|".join(DISPATCH_PATTERNS), re.IGNORECASE)

# 內容特徵：整段都是工單指示，通常會出現這些字眼
ORDER_HINTS = ("不要問我問題", "不要停下來確認", "完成後只輸出", "只輸出一行",
               # 限定範圍的講法。單獨一個可能是巧合，兩個以上就幾乎確定是機器工單
               "exactly one", "no other tool", "Allowed tools",
               "In cwd ", "Do not ", "work order",
               "Do not ask", "Do not publish", "Do not edit any", "存成 ", "--output")

# 一望即知不是對話的標題
JUNK_TITLES = {"chat_history", "events", "wire", "prompt_history", "updates",
               "models_cache", "rewind_points", "state", "session", "index"}
# 純雜湊 / 純亂碼 ID 當標題
HASHY_RE = re.compile(r"^[0-9a-f]{12,}$|^[A-Za-z0-9_-]{20,}$")


def is_dispatch(title: str, first_msg: str = "") -> bool:
    """這個對話是不是 AI 派工產生的（而不是使用者自己開的）

    光看標題不夠：Grok 與 Codex 會自動把工單摘要成一個正常的名詞短語
    （例如「Revenant Undead Knight Pixel Art PNG」），看起來跟真人開的對話
    一模一樣。所以真正可靠的是第一則訊息的內容 —— 工單一定會有
    「不要問我問題」「完成後只輸出」「--output」這類機器對機器的指示。
    """
    # UTF-8 BOM 會擋掉所有 ^ 開頭的比對。實測漏掉的那一批工單，
    # 標題就是 BOM + "You are the preferred cloud…"
    body = (first_msg or "").lstrip("\ufeff").strip()
    if body:
        head = body[:1500]
        hits = sum(1 for h in ORDER_HINTS if h in head)
        if hits >= 2:
            return True
        # 開頭就是工單語氣
        if DISPATCH_RE.search(head[:200]):
            return True
        # 很長、沒有問句、又帶輸出路徑 → 幾乎確定是機器工單
        if len(body) > 700 and "?" not in head and "？" not in head and (
                "--output" in head or "存成" in head or "image_gen" in head):
            return True

    t = (title or "").lstrip("\ufeff").strip()
    # 標題本身就是貼上來的輸出 —— 表示掃過所有使用者訊息之後，
    # 沒有任何一則像人在講話。那是 agent 迴圈，不是人開的對話。
    if looks_like_paste(t):
        return True
    if not t:
        return True
    low = t.lower()
    if low in JUNK_TITLES:
        return True
    if HASHY_RE.match(t) and " " not in t:
        return True
    # 標題其實是個檔名或單一識別字（plugin / marketplace / .codex-global-state.json）
    if " " not in t and (t.startswith(".") or t.lower().endswith(
            (".json", ".jsonl", ".log", ".md", ".toml", ".yaml", ".yml"))):
        return True
    if " " not in t and len(t) <= 16 and t.isascii() and t.islower():
        return True
    if DISPATCH_RE.search(t):
        return True
    # 標題裡同時出現「工單語氣」與「輸出路徑」，幾乎確定是派工
    if any(h in t for h in ORDER_HINTS) and ("\\" in t or "/" in t):
        return True
    return False


TEXT_KEYS = ("text", "content", "input_text", "output_text")
ROLES = {"user", "assistant", "system", "tool", "human", "model", "ai"}
ROLE_MAP = {"human": "user", "model": "assistant", "ai": "assistant"}


def classify(haystack: str) -> str:
    h = haystack.lower()
    for pid, kws in PROJECT_RULES:
        for kw in kws:
            if kw.startswith("\\b"):
                if re.search(kw, h, re.IGNORECASE):
                    return pid
            elif kw.lower() in h:
                return pid
    return "other"


def norm_role(r):
    r = str(r or "").lower()
    if r in ("user", "human"):
        return "user"
    if r in ("assistant", "model", "ai"):
        return "assistant"
    if r in ("system",):
        return "system"
    return "tool" if r else ""


def extract_text(node, depth=0):
    """從任意 JSON 節點盡力抽出文字"""
    if depth > 6:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        parts = []
        for it in node:
            if isinstance(it, dict):
                t = it.get("type")
                if isinstance(it.get("text"), str):
                    parts.append(it["text"])
                elif t in ("input_text", "output_text") and isinstance(it.get("text"), str):
                    parts.append(it["text"])
                elif isinstance(it.get("content"), (str, list)):
                    parts.append(extract_text(it["content"], depth + 1))
            elif isinstance(it, str):
                parts.append(it)
        return "\n".join(p for p in parts if p)
    if isinstance(node, dict):
        if isinstance(node.get("text"), str):
            return node["text"]
        for k in ("content", "message", "text", "parts"):
            if k in node:
                return extract_text(node[k], depth + 1)
    return ""


def looks_like_paste(t: str) -> bool:
    """這一則其實是貼上來的檔案內容或指令輸出，不是在講話

    拿它當標題的話，清單上會出現一排看不懂的字（實測有八筆標題一模一樣）。

    這裡刻意用結構判斷，不逐條列指令：前幾版是一種一種列（ls、PowerShell dir、
    grep -n、時間戳…），每重建一次索引就冒出新的一種，永遠列不完。
    """
    s = (t or "")[:300].strip()
    if not s:
        return True
    # 表格分隔線：ProcessName Id ... ----------- -- ------
    if re.search(r"-{3,}", s):
        return True
    # 檔案清單：權限位元 / 相對路徑 / 絕對路徑開頭
    if re.match(r"^(total \d+|[dlbcps-][rwxst-]{9}|\./|[A-Za-z]:[\\/])", s):
        return True
    # 帶行號的檔案內容或 grep 輸出
    if re.match(r"^\d+:", s):
        return True
    if re.match(r"^1\s+\S", s) and re.search(r"\s2\s+\S", s) and re.search(r"\s3\s+\S", s):
        return True
    # 一開頭就是時間戳或分隔標記
    if re.match(r"^(\d{4}-\d{2}-\d{2}[T\s]|={3,})", s):
        return True
    # 帶行號的 markdown 清單或表格列：1 - [x](y)、48- - foo
    if re.match(r"^\d+\s*[-*|]\s", s):
        return True
    # 表格列：三個以上的直線分隔
    if s.count(" | ") >= 3:
        return True
    # snake_case 的鍵值傾印：total_records: 14025 …
    if re.match(r"^[a-z][a-z0-9_]*\s*:\s*\S", s) and not re.search(r"[。，、？！]", s[:80]):
        return True
    # 路徑密集而且整段沒有句讀 —— 人在講話一定會有標點
    if len(re.findall(r"[\\/][\w.-]+", s)) >= 3 and not re.search(r"[。，、？！?!,]", s):
        return True
    # 整段只有大寫識別字與符號
    if re.match(r"^[A-Z0-9_ =:/.\\-]+$", s):
        return True
    return False


def parse_jsonl_messages(path: Path, full: bool, detect_spawn: bool = False):
    """回傳 (messages, first_user_text, last_ts, msg_count, is_subagent, cwd)"""
    msgs = []
    first_user = ""
    # 第一則訊息可能是貼上來的檔案內容，那種拿來當標題看不懂 ——
    # 標記起來，後面遇到看得懂的就換掉
    first_user_is_paste = False
    last_ts = ""
    count = 0
    is_subagent = False
    cwd = ""
    try:
        size = path.stat().st_size
        with open(path, "rb") as fh:
            if full:
                raw = fh.read()
            else:
                raw = fh.read(HEAD_BYTES)
        if detect_spawn and b"thread_spawn" in raw[:HEAD_BYTES]:
            is_subagent = True
        text = raw.decode("utf-8", errors="ignore")
        for line in text.splitlines():
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not cwd and isinstance(rec.get("cwd"), str):
                cwd = rec["cwd"]
            # 取時間戳
            ts = rec.get("timestamp") or rec.get("ts") or rec.get("created_at") or ""
            if isinstance(ts, str) and ts:
                last_ts = ts
            # 找 role + 內容（容忍各種格式）
            candidates = [rec]
            for wrap in ("message", "payload", "record"):
                if isinstance(rec.get(wrap), dict):
                    candidates.append(rec[wrap])
            for c in candidates:
                role = norm_role(c.get("role") or c.get("type") if c.get("type") in ROLES else c.get("role"))
                if not role:
                    t = str(c.get("type", "")).lower()
                    if "user" in t:
                        role = "user"
                    elif "assistant" in t or "agent" in t:
                        role = "assistant"
                if role not in ("user", "assistant"):
                    continue
                body = extract_text(c.get("content") if "content" in c else c)
                if not body or not body.strip():
                    continue
                count += 1
                if role == "user" and (not first_user or first_user_is_paste):
                    cand = re.sub(r"\s+", " ", body).strip()
                    if cand.startswith("<"):
                        continue
                    # 跳過續聊樣板開頭，取真正的主題句
                    m = re.match(r"This session is being continued.*?\n(.*)", body, re.DOTALL | re.IGNORECASE)
                    if m:
                        cand = re.sub(r"\s+", " ", m.group(1)).strip()
                    if cand and not cand.startswith("<"):
                        first_user = cand[:80]
                        first_user_is_paste = looks_like_paste(cand)
                if full and len(msgs) < MAX_MSGS:
                    msgs.append({"role": role, "text": body[:MAX_TEXT], "ts": ts if isinstance(ts, str) else ""})
        if not full and count == 0:
            # 大檔只讀了頭部，count 未知
            count = -1
    except OSError:
        pass
    return msgs, first_user, last_ts, count, is_subagent, cwd


def load_codex_threads():
    """從 Codex state_5.sqlite 讀官方標題、cwd、子代理關係"""
    import sqlite3
    db = HOME / ".codex" / "state_5.sqlite"
    info = {}   # rollout 檔名 → {title, cwd}
    children = set()
    if not db.exists():
        return info, children
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        # archived 是 Codex 自己的封存旗標 —— 使用者在 Codex 裡封存掉的對話，
        # 控制台不應該還把它當成現役的列在清單上。這是唯一有權威來源的封存狀態：
        # Claude Code 沒有封存功能，Qwen / Kimi 桌面版把狀態放在 Electron 的
        # LevelDB 裡，沒有可靠的旗標可讀。
        try:
            rows = con.execute("SELECT rollout_path, title, cwd, archived FROM threads")
        except sqlite3.Error:
            rows = ((r[0], r[1], r[2], 0) for r in
                    con.execute("SELECT rollout_path, title, cwd FROM threads"))
        by_id = {}
        for rp, title, cwd, archived in rows:
            if rp:
                name = Path(str(rp)).name
                info[name] = {"title": title or "", "cwd": cwd or "",
                              "archived": bool(archived), "in_app": False}
        # thread id → rollout 檔名，等一下要拿桌面版目錄對回來
        try:
            for tid, rp in con.execute("SELECT id, rollout_path FROM threads"):
                if rp:
                    by_id[str(tid)] = Path(str(rp)).name
        except sqlite3.Error:
            pass
        # 桌面版的側欄目錄：只有這裡面的才是使用者真的看得到的對話
        cat_db = HOME / ".codex" / "sqlite" / "codex-dev.db"
        if cat_db.exists():
            try:
                cat = sqlite3.connect(f"file:{cat_db}?mode=ro", uri=True)
                for tid, disp in cat.execute(
                        "SELECT thread_id, display_title FROM local_thread_catalog"):
                    name = by_id.get(str(tid))
                    if not name or name not in info:
                        continue
                    info[name]["in_app"] = True
                    if disp:
                        info[name]["title"] = disp
                cat.close()
            except sqlite3.Error:
                pass
        try:
            for (cid,) in con.execute("SELECT child_thread_id FROM thread_spawn_edges"):
                children.add(str(cid))
        except sqlite3.Error:
            pass
        con.close()
    except sqlite3.Error:
        pass
    return info, children


def load_sidecar(path: Path, tool: str):
    """讀 Grok summary.json / Kimi state.json 的官方標題與 cwd"""
    try:
        if tool == "grok":
            f = path.parent / "summary.json"
            if f.exists():
                d = json.loads(f.read_text(encoding="utf-8", errors="ignore"))
                return (d.get("generated_title") or d.get("session_summary") or "",
                        (d.get("info") or {}).get("cwd") or "")
        if tool == "kimi":
            # wire.jsonl 位於 session_xxx/agents/<agent>/ 下
            p = path
            for _ in range(4):
                p = p.parent
                f = p / "state.json"
                if f.exists():
                    d = json.loads(f.read_text(encoding="utf-8", errors="ignore"))
                    return d.get("title") or "", d.get("cwd") or ""
    except Exception:
        pass
    return "", ""


def session_id_from_name(name: str) -> str:
    m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", name)
    return m.group(1) if m else Path(name).stem


UUID_RE = r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"


# ── 垃圾桶規則 ─────────────────────────────────────
#
# 「清理但不刪除」：符合下面任一條的對話會被標成 trashed，主畫面預設不顯示，
# 但檔案完全不動，介面上打開垃圾桶就看得到，也可以單筆留回來。
#
# 兩條規則的理由不一樣：
#   非現役工具 —— 使用者現在只用這幾個 CLI，其他工具的舊對話留在清單上只是雜訊
#   太久沒動   —— 現役工具裡也會累積用完就不再回頭的對話
# 兩條都可以用環境變數覆蓋，因為「現在在用哪幾個」會隨時間變。
ACTIVE_TOOLS = {t.strip() for t in
                os.environ.get("AI_CONSOLE_ACTIVE_TOOLS", "codex,claude,qwen,kimi").split(",")
                if t.strip()}
TRASH_AFTER_DAYS = int(os.environ.get("AI_CONSOLE_TRASH_DAYS", "30"))


def trash_reason(tool: str, mtime: float, now: float) -> str:
    """回傳進垃圾桶的理由；不該進就回空字串"""
    if ACTIVE_TOOLS and tool not in ACTIVE_TOOLS:
        return "not-active-tool"
    if TRASH_AFTER_DAYS > 0 and (now - mtime) > TRASH_AFTER_DAYS * 86400:
        return "stale"
    return ""


# 明顯不是對話的目錄名。工具會在自己的資料夾裡放快取、日誌、暫存，
# 那些檔案的副檔名跟對話一樣，只能靠目錄名擋。
NOISE_DIR_RE = re.compile(
    r"^(cache|caches|logs?|tmp|temp|crash|telemetry|metrics|"
    r"updates?|backups?|node_modules|[.]system_generated)$", re.I)


def _in_noise_dir(path: Path, root: Path) -> bool:
    """這個檔案的路徑上有沒有經過雜訊目錄"""
    try:
        parts = path.relative_to(root).parts[:-1]
    except ValueError:
        return False
    return any(NOISE_DIR_RE.match(p) for p in parts)


def session_id_for(path: Path, root: Path) -> str:
    """依序從檔名往上四層找 UUID 或 session_ 前綴；都不行就用路徑雜湊"""
    import hashlib
    cands = [path.name]
    p = path.parent
    for _ in range(4):
        if p == root or p == p.parent:
            break
        cands.append(p.name)
        p = p.parent
    for cand in cands:
        m = re.search(UUID_RE, cand)
        if m:
            return m.group(1)
        if cand.startswith("session_"):
            return cand
    return "h" + hashlib.md5(str(path.relative_to(root)).encode("utf-8")).hexdigest()[:12]


SOURCES = [
    {
        "tool": "claude", "label": "Claude Code",
        "root": HOME / ".claude" / "projects", "pattern": "*.jsonl",
        "resume": lambda sid, cwd: f'claude --resume {sid}',
    },
    {
        "tool": "codex", "label": "Codex CLI",
        "root": HOME / ".codex" / "sessions", "pattern": "*.jsonl",
        "resume": lambda sid, cwd: f'codex resume {sid}',
    },
    # 使用者手動封存過的 Codex 對話（~/.codex/archived_sessions）刻意不掃：
    # 封存的意思就是「處理完了、不要再出現」，再列出來只是雜訊。
    {
        "tool": "grok", "label": "Grok CLI",
        "root": HOME / ".grok" / "sessions", "pattern": "chat_history.jsonl",
        "resume": lambda sid, cwd: "",
    },
    {
        "tool": "qwen", "label": "Qwen",
        "root": HOME / ".qwen" / "projects", "pattern": "*.jsonl",
        "resume": lambda sid, cwd: "",
    },
    {
        "tool": "cursor", "label": "Cursor",
        "root": HOME / ".cursor" / "projects", "pattern": "*.jsonl",
        "resume": lambda sid, cwd: "",
    },
    {
        "tool": "kimi", "label": "Kimi CLI",
        "root": HOME / ".kimi-code" / "sessions", "pattern": "*.jsonl",
        "resume": lambda sid, cwd: f'kimi -r {sid}' if sid.startswith("session_") else f'kimi -r session_{sid}',
    },
]

# ── 自動發現 ───────────────────────────────────────
# 上面的 SOURCES 是「已知工具」，額外提供 resume 指令與正式名稱。
# 除此之外一律交給 tools/scan_ai.py 靠檔案內容掃出來 —— 開源之後別人裝的是
# 清單外的工具、或路徑跟這裡不同，也一樣找得到。
#
# 掃描要 20 秒上下，但工具不會天天換，所以結果快取在 public/data/sources.json，
# 過期或加 --rescan 才重掃。
SOURCES_CACHE = DATA_DIR / "sources.json"
SCAN_TTL = 7 * 86400


def discover_sources(force: bool = False) -> list[dict]:
    """回傳掃描到的來源（會用快取）"""
    if not force and SOURCES_CACHE.exists():
        try:
            cache = json.loads(SOURCES_CACHE.read_text(encoding="utf-8"))
            if time.time() - cache.get("scanned_at", 0) < SCAN_TTL:
                return cache.get("sources", [])
        except (OSError, json.JSONDecodeError):
            pass
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from scan_ai import scan
        found = scan()
    except Exception as e:
        print(f"  自動掃描失敗（{e}），只用已知來源", flush=True)
        return []
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SOURCES_CACHE.write_text(json.dumps(
        {"scanned_at": time.time(), "sources": found}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    return found


GROK_AUX = {"events.jsonl", "updates.jsonl", "rewind_points.jsonl", "prompt_history.jsonl"}


def decode_project_dir(name: str) -> str:
    """還原工具的專案目錄名稱為可讀路徑"""
    if "%" in name:
        return urllib.parse.unquote(name)
    # Claude 風格：C--Users-alice-Documents-demo → C:\Users\alice\Documents\demo
    if re.match(r"^[A-Za-z]--", name):
        return name.replace("--", ":\\", 1).replace("-", "\\")
    return name


SKIP_TITLE_PREFIXES = ("<user_info", "<system-reminder", "<command-", "<local-command", "<meta ")


def read_hub_projects():
    """讀 ai-hub 的專案狀態（若有）"""
    try:
        d = json.loads((AI_HUB / "status.json").read_text(encoding="utf-8"))
        return d.get("projects", []), d.get("tools", {})
    except Exception:
        return [], {}


def main():
    t0 = time.time()
    CONV_DIR.mkdir(parents=True, exist_ok=True)
    # 清掉舊匯出
    for old in CONV_DIR.glob("*.json"):
        old.unlink()

    conversations = []
    used_ids = set()
    skipped_subagent = 0
    codex_threads, codex_children = load_codex_threads()

    # 自動發現：掃描全機，把已知來源沒涵蓋到的補進來
    sources = list(SOURCES)
    known_roots = {str(src["root"]).lower() for src in SOURCES}
    discovered = []
    for d in discover_sources("--rescan" in sys.argv):
        root = Path(d["root"])
        if str(root).lower() in known_roots or not root.exists():
            continue
        # 已知工具的子目錄就不重複收（例如 .claude/projects 已經在 SOURCES）
        if any(str(root).lower().startswith(k) for k in known_roots):
            continue
        sources.append({"tool": d["tool"], "label": d["label"], "root": root,
                        "pattern": d["pattern"], "resume": lambda sid, cwd: ""})
        discovered.append(f"{d['label']}（{d['hits']} 個對話檔）")

    for src in sources:
        root = src["root"]
        if not root.exists():
            continue
        for path in root.rglob(src["pattern"]):
            # 跳過工具內部的快取與日誌目錄。
            #
            # rglob 本來是完全不挑目錄的，工具自己的暫存檔只要副檔名對就會被
            # 當成對話收進來。實測：Antigravity 的
            # brain/<uuid>/.system_generated/logs 底下每個 uuid 都有兩個 .db，
            # 一次多出兩百多筆假對話，標題是 transcript_full、訊息數 1。
            # 這一層對每個工具都有用，不是只為了某一家。
            if _in_noise_dir(path, root):
                continue
            # 跳過常見的非對話檔
            if path.name in ("updates.jsonl",) and path.stat().st_size > 50 * 1024 * 1024:
                continue
            try:
                size = path.stat().st_size
                mtime = path.stat().st_mtime
            except OSError:
                continue
            if size < 200:  # 幾乎是空檔
                continue
            sid = session_id_for(path, root)
            full = size <= FULL_PARSE_LIMIT
            msgs, first_user, last_ts, count, is_subagent, cwd = parse_jsonl_messages(path, full, detect_spawn=(src["tool"] == "codex"))
            # kimi-code：agents/main 以外的 wire.jsonl 都是子代理
            if src["tool"] == "kimi" and path.parent.name != "main":
                is_subagent = True
            # Codex：官方 threads DB 的標題/cwd + spawn 關係
            official_title = ""
            archived = False
            # Codex 專用：桌面版的側欄目錄裡有沒有這一筆。
            # 其他工具沒有這種目錄，所以預設 True（不因為這條被收起來）。
            in_app = True
            if src["tool"] == "codex":
                th = codex_threads.get(path.name)
                if th:
                    official_title = th["title"]
                    cwd = cwd or th["cwd"]
                    archived = th.get("archived", False)
                    # 桌面版側欄沒有列的，就不是使用者開的對話
                    in_app = th.get("in_app", False)
                if sid in codex_children:
                    is_subagent = True
            # Grok / Kimi：附屬檔的官方標題與 cwd
            if src["tool"] in ("grok", "kimi"):
                st, sc = load_sidecar(path, src["tool"])
                official_title = official_title or st
                cwd = cwd or sc
            if is_subagent:
                skipped_subagent += 1
            rel = str(path.relative_to(root))
            proj_dir = cwd or decode_project_dir(path.parent.name)
            # grok 的 session 在 <cwd>/<uuid>/chat_history.jsonl，分類用上層目錄
            if src["tool"] == "grok" and not cwd:
                proj_dir = decode_project_dir(path.parent.parent.name)
            proj_dir = proj_dir.replace("\\\\?\\", "").replace("//?/", "")
            # 同一個目錄用不同分隔符寫出來會被當成兩個專案 ——
            # 實測 C:/WINDOWS/system32 與 C:\\WINDOWS\\system32 各自佔一列。
            # Windows 絕對路徑一律統一成反斜線，結尾的分隔符也去掉。
            if re.match(r"^[A-Za-z]:[\\/]", proj_dir):
                proj_dir = proj_dir.replace("/", "\\").rstrip("\\")
            title = official_title or first_user or path.stem[:60]
            if src["tool"] == "codex" and title.startswith("<codex_delegation"):
                is_subagent = True
            hay = f"{proj_dir} {title}"
            project = classify(hay)
            conv_id = f'{src["tool"]}__{sid}'
            if conv_id in used_ids:  # 同 UUID 出現在多處（副本/resume 鏈），加雜湊後綴保證唯一
                import hashlib
                conv_id += "-" + hashlib.md5(str(path).encode("utf-8")).hexdigest()[:6]
            used_ids.add(conv_id)
            first_user_msg = next(
                (m.get("text", "") for m in (msgs or []) if m.get("role") == "user"), "")
            # 有訊息卻一句使用者發言都沒有 → 不可能是「你在跟它對話」。
            # Grok 的 chat_history.jsonl 就只存 assistant 這一側，它自動摘要出來的
            # 標題（例如「Revenant Undead Knight Pixel Art PNG」）看起來跟真人開的
            # 對話一模一樣，只有這個訊號分得出來。
            no_human_turn = bool(msgs) and not any(m.get("role") == "user" for m in msgs)
            entry = {
                "id": conv_id,
                "tool": src["tool"],
                "toolLabel": src["label"],
                "sessionId": sid,
                "title": title,
                "project": project,
                "projectDir": proj_dir,
                "path": str(path),
                "size": size,
                "mtime": mtime,
                "lastTs": last_ts,
                "msgCount": count,
                "subagent": is_subagent,
                # 在來源工具裡被封存的：控制台預設收進垃圾桶，但不刪檔
                "archived": archived,
                # 控制台自己的垃圾桶判定（規則見 trash_reason）。
                # 來源工具已經封存的一律進垃圾桶，優先於其他規則。
                # 一則訊息都沒有的不是對話，是被誤判成對話的設定檔／schema。
                # 實測 studio_plan.schema、AUTOPILOT_MANIFEST、studio-plan.example
                # 都是這樣混進來的。一樣只收進垃圾桶，不刪檔。
                "trashed": (not count) or bool(archived) or (not in_app)
                           or bool(trash_reason(src["tool"], mtime, t0)),
                "trashReason": ("no-messages" if not count else
                                "archived" if archived else
                                "not-in-app" if not in_app else
                                trash_reason(src["tool"], mtime, t0)),
                "dispatch": no_human_turn or is_dispatch(title, first_user_msg),
                "resume": src["resume"](sid, cwd),
                "hasMessages": bool(msgs),
            }
            conversations.append(entry)
            if msgs:
                (CONV_DIR / f"{conv_id}.json").write_text(
                    json.dumps({"id": conv_id, "tool": src["tool"], "title": entry["title"],
                                "messages": msgs, "truncated": count > MAX_MSGS},
                               ensure_ascii=False), encoding="utf-8")

    conversations.sort(key=lambda c: c["mtime"], reverse=True)

    # ── 去重：同一 sessionId 出現多次（跨工具副本 / resume 鏈）──
    # 正本 = mtime 最新者；平手時依工具優先序（Codex 為治理正本，Qwen 多為快照副本）
    TOOL_PRIORITY = {"codex": 0, "kimi": 1, "claude": 2, "grok": 3, "cursor": 4, "qwen": 5}
    by_sid = {}
    for c in conversations:
        by_sid.setdefault(c["sessionId"], []).append(c)
    dup_count = 0
    for sid, group in by_sid.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda c: (c["mtime"], -TOOL_PRIORITY.get(c["tool"], 9)), reverse=True)
        canonical = group[0]
        canonical["dupCount"] = len(group) - 1
        for dup in group[1:]:
            dup["dup"] = True
            dup["dupOf"] = canonical["id"]
            dup["dupOfTool"] = canonical["toolLabel"]
            dup_count += 1

    hub_projects, hub_tools = read_hub_projects()

    index = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
        "projects": hub_projects,
        "tools": hub_tools,
        "projectTitles": PROJECT_TITLES,
        "conversations": conversations,
        "stats": {
            "total": len(conversations),
            "subagent": skipped_subagent,
            "duplicates": dup_count,
            "archived": sum(1 for c in conversations if c.get("archived")),
            "trashed": sum(1 for c in conversations if c.get("trashed")),
            "dispatch": sum(1 for c in conversations if c.get("dispatch") and not c["subagent"] and not c.get("dup")),
            "unique": len(conversations) - dup_count,
            "elapsed_sec": round(time.time() - t0, 1),
            "discovered_sources": discovered,
        },
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "index.json").write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    print(f"indexed {len(conversations)} conversations ({skipped_subagent} subagent, {dup_count} duplicates), "
          f"exported {len(list(CONV_DIR.glob('*.json')))} message files, "
          f"{time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
