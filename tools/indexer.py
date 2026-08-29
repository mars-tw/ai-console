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
import tempfile
import time
import urllib.parse
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path

try:  # ``import tools.indexer`` package mode
    from .index_lock import conversation_index_lock
    from .scan_ai import (is_excluded_candidate as scan_excluded_candidate,
                          is_excluded_dir as scan_excluded_dir,
                          is_excluded_file as scan_excluded_file,
                          is_noise as scan_is_noise)
except ImportError:  # ``python tools/indexer.py`` / tools on sys.path
    from index_lock import conversation_index_lock
    from scan_ai import (is_excluded_candidate as scan_excluded_candidate,
                         is_excluded_dir as scan_excluded_dir,
                         is_excluded_file as scan_excluded_file,
                         is_noise as scan_is_noise)

HOME = Path(os.path.expanduser("~"))
AI_HUB = HOME / "ai-hub"
APP_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = APP_ROOT / "public" / "data"
CONV_DIR = DATA_DIR / "conv"

HEAD_BYTES = 65536          # 索引用：只讀檔頭 64KB
FULL_PARSE_LIMIT = 8 * 1024 * 1024   # 8MB 以下才全文解析匯出訊息
MAX_MSGS = 120              # 每個對話最多匯出幾則訊息
MAX_TEXT = 2000             # 每則訊息最長字元
UUID_RE = r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"


@dataclass
class SessionMetadata:
    """來源工具的官方側欄／狀態中繼資料。

    所有 loader 都回傳同一型別，避免缺檔或壞 JSON 時用 tuple 長度猜欄位。
    ``in_app=False`` 是權威 metadata 讀取失敗時的安全預設。只有舊版 Qwen
    根本不存在 Desktop catalog 時，呼叫端才會明確採 fail-open 相容模式。
    """

    title: str = ""
    cwd: str = ""
    archived: bool = False
    in_app: bool = False
    session_id: str = ""
    source: str = ""
    conflict: bool = False
    conflicts: dict = field(default_factory=dict)
    metadata_errors: list[str] = field(default_factory=list)
    cards: list[str] = field(default_factory=list)
    selected_card: str = ""
    alias_count: int = 0
    metadata_path: str = ""
    updated_at: float = 0.0

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


def normalize_session_id(value) -> str:
    """正規化 UUID session id；非 UUID 識別字只去除外層空白。"""
    raw = str(value or "").strip()
    if not raw:
        return ""
    prefix = ""
    candidate = raw
    if raw.lower().startswith("session_"):
        prefix = "session_"
        candidate = raw[len("session_"):].strip()
    try:
        parsed = str(uuid.UUID(candidate.strip("{}")))
    except (ValueError, AttributeError):
        return raw
    return prefix + parsed


def strict_metadata_session_id(value, *, require_session_prefix: bool = False) -> str:
    """只接受標準 UUID（Kimi 則必須是 session_<UUID>）。

    Metadata 內的任意字串不能變成側欄 membership key；無效值回空字串，
    讓來源 fail-closed。外層空白、大括號與 UUID 大小寫仍會正規化。
    """
    raw = str(value or "").strip()
    prefix = ""
    candidate = raw
    if require_session_prefix:
        if not raw.lower().startswith("session_"):
            return ""
        prefix = "session_"
        candidate = raw[len("session_"):].strip()
    elif raw.lower().startswith("session_"):
        return ""
    if candidate.startswith("{") and candidate.endswith("}"):
        candidate = candidate[1:-1]
    elif "{" in candidate or "}" in candidate:
        return ""
    if not re.fullmatch(UUID_RE, candidate, re.IGNORECASE):
        return ""
    try:
        return prefix + str(uuid.UUID(candidate))
    except ValueError:
        return ""


def strict_claude_card_id(value) -> str:
    """Claude physical card id 接受 UUID 或官方 local_<UUID>，其餘拒絕。"""
    raw = str(value or "").strip()
    if raw.lower().startswith("local_"):
        sid = strict_metadata_session_id(raw[len("local_"):])
        return f"local_{sid}" if sid else ""
    return strict_metadata_session_id(raw)


def _sqlite_columns(con, table: str) -> set[str]:
    try:
        return {str(row[1]) for row in con.execute(f"PRAGMA table_info({table})")}
    except Exception:
        return set()


def _numeric(value, default=0.0) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                pass
    return float(default)


def load_codex_threads(home: Path | None = None):
    """讀 Codex state 與本機側欄 catalog，回傳 rollout metadata/children。"""
    import sqlite3
    home = Path(home) if home is not None else HOME
    db = home / ".codex" / "state_5.sqlite"
    info = {}   # rollout 檔名 → {title, cwd}
    children = set()
    cards = {}  # 本機側欄 thread id → metadata（包含沒有本機 rollout 的卡）
    state_by_id = {}
    if not db.exists():
        return info, children, cards, {}
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        cols = _sqlite_columns(con, "threads")
        archived_expr = "archived" if "archived" in cols else "0"
        preview_expr = "preview" if "preview" in cols else "''"
        pinned_expr = "is_pinned" if "is_pinned" in cols else "0"
        source_expr = "thread_source" if "thread_source" in cols else "NULL"
        updated_expr = "updated_at_ms" if "updated_at_ms" in cols else (
            "updated_at" if "updated_at" in cols else "0")
        rows = con.execute(
            "SELECT id, rollout_path, title, cwd, "
            f"{archived_expr}, {preview_expr}, {pinned_expr}, {source_expr}, "
            f"{updated_expr} FROM threads")
        by_id = {}
        for (tid, rp, title, cwd, archived, preview, is_pinned,
             thread_source, updated_at) in rows:
            if rp:
                name = Path(str(rp)).name
                norm_tid = normalize_session_id(tid)
                item = {"title": title or "", "cwd": cwd or "",
                        "archived": bool(archived), "in_app": False,
                        "preview": preview or "", "is_pinned": bool(is_pinned),
                        "thread_source": thread_source, "session_id": norm_tid,
                        "rollout_path": str(rp), "updated_at": _numeric(updated_at)}
                info[name] = item
                if norm_tid:
                    by_id[norm_tid] = name
                    state_by_id[norm_tid] = item
                    if "subagent" in str(thread_source or "").casefold():
                        children.add(norm_tid)
        # 桌面版的側欄目錄：只有這裡面的才是使用者真的看得到的對話
        cat_db = home / ".codex" / "sqlite" / "codex-dev.db"
        if cat_db.exists():
            try:
                cat = sqlite3.connect(f"file:{cat_db}?mode=ro", uri=True)
                cat_cols = _sqlite_columns(cat, "local_thread_catalog")
                wanted = [c for c in (
                    "host_id", "thread_id", "display_title", "cwd", "source_kind",
                    "source_updated_at", "source_recency_at", "observation_sequence",
                    "missing_candidate") if c in cat_cols]
                candidates = {}
                if "thread_id" in wanted:
                    for raw_row in cat.execute(
                            f"SELECT {', '.join(wanted)} FROM local_thread_catalog"):
                        row = dict(zip(wanted, raw_row))
                        if bool(row.get("missing_candidate", 0)):
                            continue
                        host = str(row.get("host_id") or "").strip().lower()
                        kind = str(row.get("source_kind") or "").strip().lower()
                        # 新版同時收 local 與 chatgpt host；舊 schema 沒有這兩欄。
                        if "host_id" in cat_cols and host != "local":
                            continue
                        if "source_kind" in cat_cols and kind not in ("vscode", "codex"):
                            continue
                        tid = normalize_session_id(row.get("thread_id"))
                        if tid:
                            candidates.setdefault(tid, []).append(row)
                for tid, group in candidates.items():
                    name = by_id.get(tid)
                    if not name or name not in info:
                        continue

                    def rank(row):
                        return (_numeric(row.get("source_recency_at")),
                                _numeric(row.get("source_updated_at")),
                                _numeric(row.get("observation_sequence")),
                                str(row.get("host_id") or "").casefold(),
                                str(row.get("display_title") or "").casefold())

                    selected = max(group, key=rank)
                    item = info[name]
                    item["in_app"] = True
                    if selected.get("display_title"):
                        item["title"] = str(selected["display_title"])
                    if selected.get("cwd"):
                        item["cwd"] = str(selected["cwd"])
                    item["catalog_hosts"] = sorted({
                        str(r.get("host_id") or "") for r in group})
                    item["catalog_updated_at"] = max(
                        (_numeric(r.get("source_recency_at")) or
                         _numeric(r.get("source_updated_at")) for r in group), default=0.0)
                    values = {
                        "title": sorted({str(r.get("display_title") or "") for r in group}),
                        "cwd": sorted({str(r.get("cwd") or "") for r in group}),
                    }
                    conflicts = {k: v for k, v in values.items() if len(v) > 1}
                    if conflicts:
                        item["metadata_conflict"] = True
                        item["metadata_conflicts"] = conflicts
                    cards[tid] = item
                cat.close()
            except sqlite3.Error:
                pass
        try:
            for (cid,) in con.execute("SELECT child_thread_id FROM thread_spawn_edges"):
                child = normalize_session_id(cid)
                if child:
                    children.add(child)
        except sqlite3.Error:
            pass
        con.close()
    except sqlite3.Error:
        pass
    return info, children, cards, state_by_id


def _claude_activity(card: dict) -> float:
    return max((_numeric(card.get(k)) for k in
                ("lastActivityAt", "lastFocusedAt", "updatedAt", "createdAt")), default=0.0)


def load_claude_desktop(home: Path | None = None, bases=None):
    """讀 Claude Desktop 側欄卡，合併 Win32/Store 的實體鏡像。

    衝突不再由 rglob 的偶然順序覆寫：活動時間、mtime、路徑依序決勝，
    同時把衝突值與所有卡片路徑帶回。新鮮度完全相同卻 archive 衝突時
    fail-open，避免用任意路徑把仍在側欄的對話隱藏。
    """
    home = Path(home) if home is not None else HOME
    if bases is None:
        bases = [
            home / "AppData" / "Roaming" / "Claude" / "claude-code-sessions",
            home / "AppData" / "Local" / "Packages" / "Claude_pzs8sxrjxfjjc"
            / "LocalCache" / "Roaming" / "Claude" / "claude-code-sessions",
        ]
    grouped = {}
    for base in bases:
        base = Path(base)
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("local_*.json"), key=lambda p: str(p).casefold()):
            try:
                d = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(d, dict):
                continue
            cli = strict_metadata_session_id(d.get("cliSessionId"))
            if not cli:
                continue
            errors = []
            archived = d.get("isArchived", False)
            if not isinstance(archived, bool):
                errors.append("invalid-isArchived")
                archived = False
            title = d.get("title") if isinstance(d.get("title"), str) else ""
            cwd = d.get("cwd") if isinstance(d.get("cwd"), str) else ""
            if not cwd and isinstance(d.get("originCwd"), str):
                cwd = d["originCwd"]
            card_id = strict_claude_card_id(
                d.get("sessionId") or path.stem.removeprefix("local_"))
            if not card_id:
                continue
            try:
                mtime_ns = path.stat().st_mtime_ns
            except OSError:
                mtime_ns = 0
            grouped.setdefault(cli, []).append({
                "card_id": card_id, "title": title, "cwd": cwd,
                "archived": archived, "activity": _claude_activity(d),
                "mtime_ns": mtime_ns, "path": str(path), "errors": errors,
            })

    info = {}
    for cli, physical in grouped.items():
        logical = {}
        for rec in physical:
            fingerprint = (rec["card_id"], rec["title"], rec["cwd"],
                           rec["archived"], rec["activity"])
            item = logical.setdefault(fingerprint, dict(rec, alias_paths=[]))
            item["alias_paths"].append(rec["path"])
            if (rec["mtime_ns"], rec["path"].casefold(), rec["path"]) > (
                    item["mtime_ns"], item["path"].casefold(), item["path"]):
                aliases = item["alias_paths"]
                item.update(rec)
                item["alias_paths"] = aliases
        records = list(logical.values())

        def rank(rec):
            return (rec["activity"], rec["mtime_ns"],
                    rec["path"].casefold(), rec["path"])

        selected = max(records, key=rank)
        values = {
            "title": sorted({r["title"] for r in records}),
            "cwd": sorted({r["cwd"] for r in records}),
            "archived": sorted({r["archived"] for r in records}),
        }
        conflicts = {k: v for k, v in values.items() if len(v) > 1}
        all_errors = sorted({e for r in physical for e in r["errors"]})
        if "invalid-isArchived" in all_errors:
            conflicts["isArchivedType"] = ["expected-bool", "invalid"]
        same_freshness = [r for r in records if (
            r["activity"], r["mtime_ns"]) ==
            (selected["activity"], selected["mtime_ns"])]
        archive_ambiguous = len({r["archived"] for r in same_freshness}) > 1
        cards = sorted({r["path"] for r in physical}, key=str.casefold)
        info[cli] = SessionMetadata(
            title=selected["title"], cwd=selected["cwd"],
            archived=False if archive_ambiguous else selected["archived"],
            in_app=not all_errors, session_id=cli, source="claude-desktop-card",
            conflict=bool(conflicts or all_errors), conflicts=conflicts,
            metadata_errors=all_errors,
            cards=cards, selected_card=selected["path"],
            alias_count=len(physical) - len(records), metadata_path=selected["path"],
            updated_at=selected["mtime_ns"] / 1_000_000_000)
    return info


def claude_metadata_for(session_id: str, catalog: dict[str, SessionMetadata]) -> SessionMetadata:
    """Claude CLI JSONL 只有出現在 Desktop card catalog 才算側欄對話。"""
    return catalog.get(
        normalize_session_id(session_id),
        SessionMetadata(in_app=False, source="claude-cli-only",
                        metadata_errors=["missing-desktop-card"]),
    )


def load_kimi_desktop(home: Path | None = None):
    """讀 Kimi Desktop archive/title JSON；回傳 (overlay, catalog_ok)。

    已確認的 userData 目錄存在時，archive/title 檔缺少代表空 Map；檔案存在
    卻無法解析則 catalog_ok=False，呼叫端必須把側欄狀態視為 unknown。
    """
    home = Path(home) if home is not None else HOME
    base = home / "AppData" / "Roaming" / "kimi-desktop" / "kimi-agent"
    if not base.is_dir():
        return {}, False
    archive_file = base / "conversation-archive.json"
    titles_file = base / "conversation-titles.json"
    try:
        archive = (json.loads(archive_file.read_text(encoding="utf-8"))
                   if archive_file.exists() else {})
        titles = (json.loads(titles_file.read_text(encoding="utf-8"))
                  if titles_file.exists() else {})
        if not isinstance(archive, dict) or not isinstance(titles, dict):
            return {}, False
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}, False
    out = {}
    for raw_key, raw_value in archive.items():
        key = strict_metadata_session_id(raw_key, require_session_prefix=True)
        if not key:
            continue
        value = raw_value if isinstance(raw_value, dict) else {}
        out[key] = {
            "title": value.get("title") if isinstance(value.get("title"), str) else "",
            "archived": bool(value.get("archivedAt")),
            "project": value.get("project") if isinstance(value.get("project"), str) else "",
        }
    for raw_key, raw_value in titles.items():
        key = strict_metadata_session_id(raw_key, require_session_prefix=True)
        if not key:
            continue
        title = raw_value.get("title") if isinstance(raw_value, dict) else raw_value
        if isinstance(title, str):
            out.setdefault(key, {"title": "", "archived": False, "project": ""})["title"] = title
    return out, True


def _read_kimi_state(path: Path, desktop: dict, desktop_ok: bool) -> SessionMetadata:
    try:
        d = json.loads(path.read_text(encoding="utf-8", errors="strict"))
        if not isinstance(d, dict):
            raise ValueError("state-not-object")
        sid = strict_metadata_session_id(d.get("id"), require_session_prefix=True)
        if not sid:
            return SessionMetadata(
                in_app=False, source="kimi-state-invalid",
                metadata_path=str(path), metadata_errors=["invalid-id"])
        archived = d.get("archived", False)
        errors = []
        if not isinstance(archived, bool):
            errors.append("invalid-archived")
            archived = False
        title = d.get("title") if isinstance(d.get("title"), str) else ""
        cwd = d.get("cwd") if isinstance(d.get("cwd"), str) else ""
        overlay = desktop.get(sid, {})
        if overlay.get("title"):
            title = overlay["title"]
        if overlay.get("project") and not cwd:
            cwd = overlay["project"]
        archived = archived or bool(overlay.get("archived"))
        try:
            updated = path.stat().st_mtime
        except OSError:
            updated = 0.0
        return SessionMetadata(
            title=title, cwd=cwd, archived=archived,
            in_app=bool(desktop_ok and not errors), session_id=sid,
            source="kimi-state+desktop", metadata_path=str(path),
            updated_at=updated,
            conflict=bool(errors),
            conflicts={"archivedType": ["expected-bool", "invalid"]} if errors else {},
            metadata_errors=errors + ([] if desktop_ok else ["desktop-catalog-unknown"]))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        return SessionMetadata(
            in_app=False, source="kimi-state-invalid", metadata_path=str(path),
            metadata_errors=[type(exc).__name__])


def load_kimi_catalog(home: Path | None = None, *, desktop=None, desktop_ok=None):
    """以 bounded glob 建 Kimi state catalog；不讀 wire 本文。"""
    home = Path(home) if home is not None else HOME
    if desktop is None or desktop_ok is None:
        desktop, desktop_ok = load_kimi_desktop(home)
    root = home / ".kimi-code" / "sessions"
    info = {}
    if not root.is_dir():
        return info, False
    for path in sorted(root.glob("*/session_*/state.json"), key=lambda p: str(p).casefold()):
        meta = _read_kimi_state(path, desktop or {}, bool(desktop_ok))
        if not meta.session_id:
            continue
        old = info.get(meta.session_id)
        if old is None or (meta.updated_at, meta.metadata_path.casefold()) > (
                old.updated_at, old.metadata_path.casefold()):
            if old is not None:
                meta.conflict = True
                meta.conflicts = {"metadata_path": sorted(
                    [old.metadata_path, meta.metadata_path], key=str.casefold)}
            info[meta.session_id] = meta
    return info, True


def _read_qwen_header(path: Path) -> SessionMetadata:
    try:
        with path.open("rb") as fh:
            raw = fh.read(8192)
        first = raw.splitlines()[0] if raw else b""
        d = json.loads(first.decode("utf-8", errors="strict"))
        if not isinstance(d, dict):
            raise ValueError("header-not-object")
        sid = strict_metadata_session_id(d.get("id"))
        if not sid:
            return SessionMetadata(
                in_app=False, source="qwen-header-invalid",
                metadata_path=str(path), metadata_errors=["invalid-id"])
        archived = d.get("isArchived", False)
        hidden = d.get("hidden", False)
        errors = []
        if not isinstance(archived, bool):
            errors.append("invalid-isArchived")
            archived = False
        if not isinstance(hidden, bool):
            errors.append("invalid-hidden")
            hidden = True
        try:
            updated = path.stat().st_mtime
        except OSError:
            updated = 0.0
        return SessionMetadata(
            title=d.get("name") if isinstance(d.get("name"), str) else "",
            cwd=d.get("workspaceRootPath") if isinstance(d.get("workspaceRootPath"), str) else "",
            archived=archived, in_app=bool(not hidden and not errors), session_id=sid,
            source="qwen-desktop-header", metadata_path=str(path), updated_at=updated,
            conflict=bool(errors),
            conflicts={e: ["expected-bool", "invalid"] for e in errors},
            metadata_errors=errors)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        return SessionMetadata(
            in_app=False, source="qwen-header-invalid", metadata_path=str(path),
            metadata_errors=[type(exc).__name__])


def load_qwen_catalog(home: Path | None = None, root: Path | None = None):
    """讀 Qwen Desktop header catalog；回傳 (有效卡 map, catalog 是否存在)。"""
    home = Path(home) if home is not None else HOME
    root = Path(root) if root is not None else home / ".craft-agent" / "workspaces"
    info = {}
    if not root.is_dir():
        return info, False
    for path in sorted(root.glob("*/sessions/*/session.jsonl"), key=lambda p: str(p).casefold()):
        meta = _read_qwen_header(path)
        if not meta.session_id:
            continue
        old = info.get(meta.session_id)
        if old is None or (meta.updated_at, meta.metadata_path.casefold()) > (
                old.updated_at, old.metadata_path.casefold()):
            if old is not None:
                fields = {
                    "title": sorted({old.title, meta.title}),
                    "cwd": sorted({old.cwd, meta.cwd}),
                    "archived": sorted({old.archived, meta.archived}),
                    "in_app": sorted({old.in_app, meta.in_app}),
                }
                meta.conflicts = {k: v for k, v in fields.items() if len(v) > 1}
                meta.conflict = bool(meta.conflicts)
            info[meta.session_id] = meta
    return info, True


def qwen_metadata_for(session_id: str, catalog: dict[str, SessionMetadata],
                      catalog_available: bool) -> SessionMetadata:
    sid = normalize_session_id(session_id)
    return catalog.get(
        sid,
        SessionMetadata(
            in_app=not catalog_available, session_id=sid,
            source="qwen-cli-only" if catalog_available else "qwen-legacy-compat",
            metadata_errors=["missing-desktop-card"] if catalog_available else []),
    )


def load_sidecar(path: Path, tool: str, *, kimi_desktop=None,
                 kimi_catalog_ok=True, qwen_catalog_available=False):
    """讀 Grok/Kimi/Qwen 官方中繼資料，固定回傳 SessionMetadata。"""
    path = Path(path)
    try:
        if tool == "grok":
            f = path.parent / "summary.json"
            if f.exists():
                d = json.loads(f.read_text(encoding="utf-8", errors="ignore"))
                if not isinstance(d, dict):
                    raise ValueError("summary-not-object")
                info = d.get("info") if isinstance(d.get("info"), dict) else {}
                return SessionMetadata(
                    title=d.get("generated_title") or d.get("session_summary") or "",
                    cwd=info.get("cwd") or "", in_app=True, source="grok-summary")
            return SessionMetadata(in_app=True, source="grok-summary-missing")
        if tool == "kimi":
            is_main = path.parent.name == "main"
            p = path
            for _ in range(6):
                p = p.parent
                f = p / "state.json"
                if f.exists():
                    meta = _read_kimi_state(f, kimi_desktop or {}, kimi_catalog_ok)
                    return meta if is_main else replace(meta, in_app=False)
            return SessionMetadata(in_app=False, source="kimi-state-missing",
                                   metadata_errors=["missing-state"])
        if tool == "qwen":
            if path.name == "session.jsonl" and path.parent.parent.name == "sessions":
                return _read_qwen_header(path)
            return SessionMetadata(
                in_app=not qwen_catalog_available,
                source="qwen-legacy-compat" if not qwen_catalog_available
                else "qwen-cli-only")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        # 權威 metadata 存在卻壞掉時 fail-closed，不猜測成仍在側欄。
        return SessionMetadata(in_app=False, source=f"{tool}-metadata-invalid",
                               metadata_errors=[type(exc).__name__])
    return SessionMetadata(in_app=False, source=f"{tool}-metadata-missing")


def session_id_from_name(name: str) -> str:
    m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
                  name, re.IGNORECASE)
    return normalize_session_id(m.group(1)) if m else Path(name).stem


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
    r"updates?|backups?|node_modules|subagents|[.]system_generated)$", re.I)


def _in_noise_dir(path: Path, root: Path) -> bool:
    """套用 indexer 雜訊規則與 scan_ai 完整敏感目錄／檔名政策。"""
    if scan_excluded_file(path.name):
        return True
    try:
        parts = path.relative_to(root).parts[:-1]
    except ValueError:
        return False
    return any(NOISE_DIR_RE.match(p) or scan_is_noise(p) or scan_excluded_dir(p)
               for p in parts)


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
        # Kimi Desktop 的 join key 是完整 session_<uuid>；先判前綴，不能先
        # 讓通用 UUID regex 把 session_ 剝掉。
        if cand.lower().startswith("session_"):
            return normalize_session_id(cand)
        m = re.search(UUID_RE, cand, re.IGNORECASE)
        if m:
            return normalize_session_id(m.group(1))
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
        try:
            from .scan_ai import scan
        except ImportError:
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


def source_roots_overlap(left: Path, right: Path) -> bool:
    """兩個來源根目錄是同一個，或其一包住另一個。

    自動發現會把 ``~/.codex`` 回報成新來源，但已知來源是
    ``~/.codex/sessions``。只比對「發現路徑是否位於已知路徑下」會漏掉
    這種反向包含，導致同一批 rollout 被掃兩次。
    """
    try:
        a = os.path.normcase(os.path.realpath(os.path.abspath(os.fspath(left))))
        b = os.path.normcase(os.path.realpath(os.path.abspath(os.fspath(right))))
        common = os.path.commonpath((a, b))
    except (OSError, ValueError, TypeError):
        return False
    return common == a or common == b


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


def _unix_seconds(value) -> float:
    value = _numeric(value)
    return value / 1000.0 if value > 100_000_000_000 else value


def _surface_metadata(entry: dict, meta: SessionMetadata | None = None,
                      codex_meta: dict | None = None):
    if meta is not None:
        entry["metadataSource"] = meta.source
        if meta.conflict:
            entry["metadataConflict"] = True
            entry["metadataConflicts"] = meta.conflicts
            entry["metadataCards"] = meta.cards
            entry["metadataSelectedCard"] = meta.selected_card
        if meta.metadata_errors:
            entry["metadataErrors"] = meta.metadata_errors
        if meta.alias_count:
            entry["metadataAliasCount"] = meta.alias_count
    if codex_meta:
        entry["preview"] = codex_meta.get("preview", "")
        entry["pinned"] = bool(codex_meta.get("is_pinned"))
        entry["threadSource"] = codex_meta.get("thread_source")
        if codex_meta.get("metadata_conflict"):
            entry["metadataConflict"] = True
            entry["metadataConflicts"] = codex_meta.get("metadata_conflicts", {})


def _metadata_only_entry(tool: str, label: str, sid: str, meta: SessionMetadata,
                         *, resume: str = "", subagent: bool = False) -> dict:
    """權威側欄卡沒有本文時的索引列；不套用 no-messages 垃圾規則。"""
    title = meta.title or sid
    cwd = meta.cwd or ""
    archived = bool(meta.archived)
    in_app = bool(meta.in_app)
    entry = {
        "id": f"{tool}__{sid}", "tool": tool, "toolLabel": label,
        "sessionId": sid, "title": title,
        "project": classify(f"{cwd} {title}"), "projectDir": cwd,
        "path": meta.metadata_path, "size": 0,
        "mtime": _numeric(meta.updated_at), "lastTs": "", "msgCount": 0,
        "subagent": subagent, "inApp": in_app, "archived": archived,
        "trashed": archived or not in_app,
        "trashReason": "archived" if archived else "not-in-app" if not in_app else "",
        "dispatch": subagent or is_dispatch(title, ""), "resume": resume,
        "hasMessages": False, "metadataOnly": True,
    }
    _surface_metadata(entry, meta)
    return entry


def _mark_duplicates(conversations: list[dict]) -> int:
    """同工具副本去重，但保留不同工具各自真正在側欄的同 UUID 對話。"""
    priority = {"codex": 0, "kimi": 1, "claude": 2,
                "grok": 3, "cursor": 4, "qwen": 5}
    by_sid = {}
    for c in conversations:
        by_sid.setdefault(c["sessionId"], []).append(c)
    dup_count = 0

    def canonical_rank(c):
        return (bool(c.get("inApp")), not bool(c.get("subagent")),
                bool(c.get("hasMessages")), _numeric(c.get("mtime")),
                -priority.get(c.get("tool"), 9), str(c.get("id", "")))

    def mark(dup, canonical):
        nonlocal dup_count
        if dup is canonical or dup.get("dup"):
            return
        dup["dup"] = True
        dup["dupOf"] = canonical["id"]
        dup["dupOfTool"] = canonical["toolLabel"]
        canonical["dupCount"] = canonical.get("dupCount", 0) + 1
        dup_count += 1

    for group in by_sid.values():
        if len(group) < 2:
            continue
        keepers = []
        by_tool = {}
        for item in group:
            by_tool.setdefault(item["tool"], []).append(item)
        for same_tool in by_tool.values():
            canonical = max(same_tool, key=canonical_rank)
            keepers.append(canonical)
            for dup in same_tool:
                mark(dup, canonical)
        active = [c for c in keepers if c.get("inApp") and not c.get("subagent")]
        if active:
            canonical = max(active, key=canonical_rank)
            # 多個工具都真的有這張側欄卡時全部保留；只壓掉 CLI-only 副本。
            for dup in keepers:
                if not dup.get("inApp"):
                    mark(dup, canonical)
        elif len(keepers) > 1:
            canonical = max(keepers, key=canonical_rank)
            for dup in keepers:
                mark(dup, canonical)
    return dup_count


def merge_discovered_sources(base_sources: list[dict], discovered_rows: list[dict],
                             *, reserved_roots=()):
    """合併自動發現來源；敏感 cached row 與任一方向重疊都拒絕。"""
    sources = list(base_sources)
    accepted_roots = [Path(src["root"]) for src in base_sources]
    accepted_roots.extend(Path(p) for p in reserved_roots)
    labels = []
    for row in discovered_rows:
        try:
            root = Path(row["root"])
            pattern = str(row["pattern"])
            tool = str(row["tool"])
            label = str(row["label"])
            hits = int(row.get("hits", 0))
        except (KeyError, TypeError, ValueError):
            continue
        if not root.is_dir() or not pattern or not tool:
            continue
        # 快取可能由舊版掃描器產生，必須重新套用目前的完整政策。
        real_root = Path(os.path.realpath(os.path.abspath(os.fspath(root))))
        if scan_excluded_candidate(root.name) or any(
                scan_excluded_dir(part) for part in (*root.parts, *real_root.parts)):
            continue
        if not any(ch in pattern for ch in "*?[") and scan_excluded_file(pattern):
            continue
        if any(source_roots_overlap(root, known) for known in accepted_roots):
            continue
        sources.append({"tool": tool, "label": label, "root": root,
                        "pattern": pattern, "resume": lambda sid, cwd: ""})
        accepted_roots.append(root)  # 後續 cached row 也要與剛接受的來源比對
        labels.append(f"{label}（{hits} 個對話檔）")
    return sources, labels


def _atomic_write_json(path: Path, value) -> None:
    """同目錄唯一暫存檔 + fsync + os.replace，讀者只會看到完整 JSON。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_name = ""
    try:
        with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="", delete=False,
                dir=path.parent, prefix=f".{path.name}.", suffix=".tmp") as fh:
            tmp_name = fh.name
            json.dump(value, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, path)
        tmp_name = ""
        if os.name != "nt":
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            dir_fd = os.open(path.parent, flags)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    finally:
        if tmp_name:
            try:
                Path(tmp_name).unlink()
            except OSError:
                pass


def _build_index():
    t0 = time.time()
    CONV_DIR.mkdir(parents=True, exist_ok=True)
    # 清掉舊匯出
    for old in CONV_DIR.glob("*.json"):
        old.unlink()

    conversations = []
    used_ids = set()
    codex_threads, codex_children, codex_cards, codex_state = load_codex_threads()
    claude_desktop = load_claude_desktop()
    kimi_desktop, kimi_catalog_ok = load_kimi_desktop()
    kimi_catalog, _kimi_state_available = load_kimi_catalog(
        desktop=kimi_desktop, desktop_ok=kimi_catalog_ok)
    qwen_catalog, qwen_catalog_available = load_qwen_catalog()
    seen_codex_cards = set()
    seen_codex_state = set()
    seen_claude_cards = set()
    seen_kimi_cards = set()
    seen_qwen_cards = set()

    # 自動發現：掃描全機，把已知來源沒涵蓋到的補進來
    sources, discovered = merge_discovered_sources(
        list(SOURCES), discover_sources("--rescan" in sys.argv),
        # Qwen Desktop header 是 metadata catalog，不可當成對話本文。
        reserved_roots=(HOME / ".craft-agent" / "workspaces",))

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
            in_app = True
            source_meta = None
            codex_meta = None
            if src["tool"] == "codex":
                th = codex_threads.get(path.name)
                if th:
                    codex_meta = th
                    official_title = th.get("title", "")
                    cwd = th.get("cwd") or cwd
                    archived = th.get("archived", False)
                    in_app = th.get("in_app", False)
                    sid = th.get("session_id") or normalize_session_id(sid)
                    seen_codex_state.add(sid)
                    if in_app:
                        seen_codex_cards.add(sid)
                else:
                    in_app = False
                    sid = normalize_session_id(sid)
                if sid in codex_children or (
                        th and "subagent" in str(th.get("thread_source") or "").casefold()):
                    is_subagent = True
            if src["tool"] == "claude":
                # Desktop 卡 membership 是權威來源；單獨存在的 CLI JSONL 收進垃圾桶。
                th = claude_metadata_for(sid, claude_desktop)
                source_meta = th
                if th.source == "claude-desktop-card":
                    official_title = th.title
                    cwd = th.cwd or cwd
                    archived = th.archived
                    in_app = th.in_app
                    sid = th.session_id or normalize_session_id(sid)
                    seen_claude_cards.add(sid)
                else:
                    in_app = False
            if src["tool"] == "grok":
                source_meta = load_sidecar(
                    path, src["tool"])
                if source_meta.session_id:
                    sid = source_meta.session_id
                official_title = source_meta.title
                cwd = source_meta.cwd or cwd
                archived = source_meta.archived
                in_app = source_meta.in_app
            if src["tool"] == "qwen":
                sid = normalize_session_id(sid)
                source_meta = qwen_metadata_for(
                    sid, qwen_catalog, qwen_catalog_available)
                if sid in qwen_catalog:
                    seen_qwen_cards.add(sid)
                official_title = source_meta.title
                cwd = source_meta.cwd or cwd
                archived = source_meta.archived
                in_app = source_meta.in_app
            if src["tool"] == "kimi":
                sid = normalize_session_id(sid)
                source_meta = kimi_catalog.get(
                    sid, SessionMetadata(
                        in_app=False, session_id=sid, source="kimi-wire-without-state",
                        metadata_errors=["missing-state-card"]))
                if path.parent.name == "main" and sid in kimi_catalog:
                    seen_kimi_cards.add(sid)
                elif path.parent.name != "main":
                    source_meta = replace(source_meta, in_app=False)
                official_title = source_meta.title
                cwd = source_meta.cwd or cwd
                archived = source_meta.archived
                in_app = source_meta.in_app
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
            authoritative_source = bool(
                codex_meta and in_app
                or source_meta and source_meta.source in {
                    "claude-desktop-card", "qwen-desktop-header",
                    "kimi-state+desktop"} and in_app)
            authoritative_active = bool(
                authoritative_source and not archived
                and not (source_meta and source_meta.metadata_errors))
            policy_reason = "" if authoritative_active else trash_reason(
                src["tool"], mtime, t0)
            if authoritative_active:
                effective_trash_reason = ""
            elif archived:
                effective_trash_reason = "archived"
            elif not in_app:
                effective_trash_reason = "not-in-app"
            elif not count:
                effective_trash_reason = "no-messages"
            else:
                effective_trash_reason = policy_reason
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
                "inApp": bool(in_app),
                # 在來源工具裡被封存的：控制台預設收進垃圾桶，但不刪檔
                "archived": archived,
                # 控制台自己的垃圾桶判定（規則見 trash_reason）。
                # 來源工具已經封存的一律進垃圾桶，優先於其他規則。
                # 一則訊息都沒有的不是對話，是被誤判成對話的設定檔／schema。
                # 實測 studio_plan.schema、AUTOPILOT_MANIFEST、studio-plan.example
                # 都是這樣混進來的。一樣只收進垃圾桶，不刪檔。
                "trashed": bool(effective_trash_reason),
                "trashReason": effective_trash_reason,
                "dispatch": no_human_turn or is_dispatch(title, first_user_msg),
                "resume": src["resume"](sid, cwd),
                "hasMessages": bool(msgs),
            }
            _surface_metadata(entry, source_meta, codex_meta)
            conversations.append(entry)
            if msgs:
                (CONV_DIR / f"{conv_id}.json").write_text(
                    json.dumps({"id": conv_id, "tool": src["tool"], "title": entry["title"],
                                "messages": msgs, "truncated": count > MAX_MSGS},
                               ensure_ascii=False), encoding="utf-8")

    # Codex 側欄可能已有 catalog 卡，但本機 rollout 尚未同步/已不在 sessions。
    # 仍輸出 metadata-only row 才能與側欄筆數對齊；這不是「空對話誤判」。
    for sid, meta in codex_cards.items():
        if sid in seen_codex_cards:
            continue
        title = meta.get("title") or meta.get("preview") or sid
        cwd = meta.get("cwd") or ""
        project = classify(f"{cwd} {title}")
        archived = bool(meta.get("archived"))
        is_subagent = sid in codex_children or (
            "subagent" in str(meta.get("thread_source") or "").casefold())
        mtime = max(_unix_seconds(meta.get("catalog_updated_at")),
                    _unix_seconds(meta.get("updated_at")))
        conv_id = f"codex__{sid}"
        if conv_id in used_ids:
            conv_id += "-catalog"
        used_ids.add(conv_id)
        entry = {
            "id": conv_id, "tool": "codex", "toolLabel": "Codex CLI",
            "sessionId": sid, "title": title, "project": project,
            "projectDir": cwd, "path": meta.get("rollout_path") or "",
            "size": 0, "mtime": mtime, "lastTs": "", "msgCount": 0,
            "subagent": is_subagent, "inApp": True, "archived": archived,
            "trashed": archived, "trashReason": "archived" if archived else "",
            "dispatch": is_subagent or is_dispatch(title, meta.get("preview") or ""),
            "resume": f"codex resume {sid}", "hasMessages": False,
            "metadataOnly": True,
        }
        _surface_metadata(entry, codex_meta=meta)
        conversations.append(entry)

    # Codex 已封存、rollout 又不在 sessions 的列仍要留在 archive/trash 檢視；
    # 非 catalog 且未封存的 state 歷史則不冒充側欄卡。
    for sid, meta in codex_state.items():
        if sid in seen_codex_state or sid in codex_cards or not meta.get("archived"):
            continue
        title = meta.get("title") or meta.get("preview") or sid
        cwd = meta.get("cwd") or ""
        is_subagent = sid in codex_children or (
            "subagent" in str(meta.get("thread_source") or "").casefold())
        entry = {
            "id": f"codex__{sid}", "tool": "codex", "toolLabel": "Codex CLI",
            "sessionId": sid, "title": title,
            "project": classify(f"{cwd} {title}"), "projectDir": cwd,
            "path": meta.get("rollout_path") or "", "size": 0,
            "mtime": _unix_seconds(meta.get("updated_at")), "lastTs": "", "msgCount": 0,
            "subagent": is_subagent, "inApp": False, "archived": True,
            "trashed": True, "trashReason": "archived",
            "dispatch": is_subagent or is_dispatch(title, meta.get("preview") or ""),
            "resume": f"codex resume {sid}", "hasMessages": False,
            "metadataOnly": True,
        }
        _surface_metadata(entry, codex_meta=meta)
        conversations.append(entry)
        used_ids.add(entry["id"])

    # 其餘三家也以官方卡片目錄補齊沒有本文（或本文過小）的側欄列。
    metadata_catalogs = (
        ("claude", "Claude Code", claude_desktop, seen_claude_cards,
         lambda sid: f"claude --resume {sid}"),
        ("qwen", "Qwen", qwen_catalog, seen_qwen_cards, lambda sid: ""),
        ("kimi", "Kimi CLI", kimi_catalog, seen_kimi_cards,
         lambda sid: f"kimi -r {sid}"),
    )
    for tool, label, catalog, seen, resume_for in metadata_catalogs:
        for sid, meta in catalog.items():
            if sid in seen:
                continue
            entry = _metadata_only_entry(
                tool, label, sid, meta, resume=resume_for(sid))
            if entry["id"] in used_ids:
                entry["id"] += "-metadata"
            used_ids.add(entry["id"])
            conversations.append(entry)

    conversations.sort(key=lambda c: c["mtime"], reverse=True)

    dup_count = _mark_duplicates(conversations)
    # 必須從完成所有後置重分類的最終列計算；例如 <codex_delegation>
    # 會在初次 parse 之後才改成 subagent，累加計數會漏算或重算。
    subagent_count = sum(1 for c in conversations if c.get("subagent"))

    hub_projects, hub_tools = read_hub_projects()

    index = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()),
        "projects": hub_projects,
        "tools": hub_tools,
        "projectTitles": PROJECT_TITLES,
        "conversations": conversations,
        "stats": {
            "total": len(conversations),
            "subagent": subagent_count,
            "duplicates": dup_count,
            "archived": sum(1 for c in conversations if c.get("archived")),
            "trashed": sum(1 for c in conversations if c.get("trashed")),
            "pinned": sum(1 for c in conversations if c.get("pinned")),
            "inApp": sum(1 for c in conversations if c.get("inApp")),
            "metadataConflict": sum(1 for c in conversations if c.get("metadataConflict")),
            "dispatch": sum(1 for c in conversations if c.get("dispatch") and not c["subagent"] and not c.get("dup")),
            "unique": len(conversations) - dup_count,
            "elapsed_sec": round(time.time() - t0, 1),
            "discovered_sources": discovered,
        },
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(DATA_DIR / "index.json", index)
    print(f"indexed {len(conversations)} conversations ({subagent_count} subagent, {dup_count} duplicates), "
          f"exported {len(list(CONV_DIR.glob('*.json')))} message files, "
          f"{time.time()-t0:.1f}s")


def main():
    with conversation_index_lock(timeout=60.0):
        return _build_index()


if __name__ == "__main__":
    main()
