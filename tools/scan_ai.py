# -*- coding: utf-8 -*-
"""全機 AI 工具掃描器：靠「內容長相」找出對話紀錄，而不是靠寫死的名單

為什麼不能用名單：
    原本的做法是把 ~/.claude、~/.codex… 逐一寫進程式，「存在才納入」。
    這在自己機器上很好用，但開源之後別人裝的是清單外的工具、或在 macOS /
    Linux 上路徑完全不同，就整個掃不到 —— 使用者會以為程式壞了。

所以這裡改成三步：
    1. 列舉「可能放工具設定的父目錄」（家目錄的 dot 資料夾、XDG、AppData、
       macOS Application Support），每個子項都當成一個候選工具
    2. 進去有限度地走訪，嗅探檔案內容：JSONL 每行是不是帶 role/content 的訊息？
       SQLite 有沒有 thread / session / message 之類的表？
    3. 像對話紀錄的才認定，並回推「對話到底放在哪個子目錄」

掃描一律只讀不寫，而且有深度、檔案數、時間三重上限，不會把整台硬碟翻一遍。

用法：
    python tools/scan_ai.py              # 印出掃描結果
    python tools/scan_ai.py --json       # 輸出 JSON（給 indexer 用）
    python tools/scan_ai.py --deep       # 放寬上限，掃得更徹底
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import stat
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HOME = Path(os.path.expanduser("~"))

# ── 掃描範圍與上限 ─────────────────────────────────
MAX_DEPTH = 6              # 從候選目錄往下最多幾層
MAX_DIRS_PER_CAND = 3000   # 每個候選最多走訪幾個目錄
MAX_FILES_SNIFF = 400      # 每個候選最多嗅探幾個檔案（每個只讀 16KB，很便宜）
SNIFF_BYTES = 16384        # 每個檔案只讀前 16KB
MIN_HITS = 1               # 一份含角色及本文的對話已足夠；role-only 不算
TIME_BUDGET = 25.0         # 整體掃描秒數上限
MAX_ROOTS = 32
MAX_EXTRA_ROOTS = 8
MAX_CANDIDATES = 512
JSON_BYTES = 8 * 1024 * 1024
MAX_RECORDS = 10000
MESSAGE_ARRAY_KEYS = ("messages", "history", "conversation", "turns", "entries")
MESSAGE_WRAPPERS = ("message", "payload", "record", "data")
TEXT_KEYS = ("content", "text", "input_text", "output_text", "parts")
SQLITE_MESSAGE_TABLES = {"messages", "message", "chat_messages", "conversation_messages",
                         "session_messages", "thread_messages"}
SQLITE_ROLE_COLUMNS = ("role", "sender", "type")
SQLITE_TEXT_COLUMNS = ("content", "text", "message", "body")
SQLITE_ID_COLUMNS = ("conversation_id", "session_id", "thread_id", "chat_id")
SQLITE_TIME_COLUMNS = ("timestamp", "created_at", "createdAt", "ts", "time")

# 這些目錄一定不是對話紀錄，直接不進去（省下大量時間）
NOISE_DIRS = {
    "node_modules", ".git", ".svn", "__pycache__", "venv", ".venv", "site-packages",
    "dist", "build", "target", "bin", "obj", "tmp", "temp", "Crashpad",
    "GPUCache", "Code Cache", "blob_storage", "IndexedDB", "Service Worker",
    "Local Storage", "Session Storage", "extensions", "shader_cache",
    "CacheStorage", "DawnCache", "GrShaderCache", "component_crx_cache",
}
NOISE_RE = re.compile(r"^(cache|caches|logs?|crash|telemetry|metrics|updates?|"
                      r"backups?|downloads?|models?|images?|screenshots?)$", re.I)

# 這些不只是雜訊，而是可能帶有 cookie、token、密碼或瀏覽器
# session 的儲存區。掃描器的原則是「找對話」，不是「所有 JSON / SQLite
# 都看一眼」；因此這些名稱必須 fail closed，連目錄都不進入。
#
# 不可把一般的 sessions / session-state 放進來，它們正是 Claude、Kimi
# 等工具的正常對話來源。只擋「Session Storage」與 Chromium 專有名稱。
SENSITIVE_DIR_NAMES = {
    "bridge store",
    "auth", "authentication", "authorization", "oauth", "oauth2",
    "token", "tokens", "credential", "credentials", "secret", "secrets",
    "cookie", "cookies", "cookie store",
    "network", "indexeddb", "local storage", "session storage",
    "browser storage", "web storage", "webstorage",
    "login data", "safe storage", "secure storage",
    "keychain", "keychains", "keyring", "keyrings", "password store",
    "service worker", "shared dictionary", "trust tokens",
    "extension state", "extension rules", "sync extension settings",
    "safe browsing",
    # HOME 下的密鑰／雲端憑證儲存，以及會被另外當成 parent
    # 列舉的聚合設定目錄。排除聚合根不會阻止其子工具被單獨掃到。
    "ssh", "gnupg", "aws", "azure", "kube", "docker", "pki",
    "password-store",
}
# ~/.config 與 ~/.local 是候選父目錄，其內各工具會被另外列舉。
# 只排除這兩個「點開頭的聚合根」，不能排除一般名為 local /
# config 的子目錄，否則可能會遺漏工具的正常對話。
AGGREGATE_CANDIDATE_DIRS = {".config", ".local"}
SENSITIVE_DIR_RE = re.compile(
    r"^(?:bridge|auth(?:entication|orization)?|oauth2?|tokens?|credentials?|"
    r"secrets?|cookies?|keychains?|keyrings?|password)[ ._-]?"
    r"(?:store|storage|cache|data|database|db)$",
    re.I,
)

# 有些 Chromium 檔案（例如 Cookies）沒有副檔名，目前不會被 sniff；
# 仍在這裡明確拒絕，避免未來放寬副檔名時悄悄讀到。
SENSITIVE_FILE_NAMES = {
    "bridge store", "cookies", "cookies journal", "cookie store",
    "login data", "login data journal", "web data", "web data journal",
    "network persistent state", "transport security", "trust tokens",
    "local state", "preferences", "secure preferences",
    "indexeddb", "local storage", "session storage", "browser storage",
    "web storage", "webstorage",
}
SENSITIVE_FILE_RE = re.compile(
    r"^\.?(?:(?:access|refresh|id|api|bearer|session)[ ._-])?"
    r"(?:auth(?:entication|orization)?|oauth2?|tokens?|credentials?|"
    r"secrets?|api[ ._-]?keys?|keychains?|keyrings?)"
    r"(?:[ ._-].*)?(?:\.(?:jsonl?|ndjson|sqlite3?|db))?$",
    re.I,
)
SENSITIVE_SESSION_FILE_RE = re.compile(
    r"^(?:current|last)[ ._-](?:session|tabs)(?:[ ._-].*)?$|"
    r"^session[ ._-](?:token|cookie|secret|key)(?:[ ._-].*)?$",
    re.I,
)


def _normalise_store_name(name: str) -> str:
    """把儲存區名稱正規化，讓 Local_Storage / local-storage 也擋得住。"""
    return re.sub(r"[\s._-]+", " ", name.casefold()).strip()


def is_excluded_dir(name: str) -> bool:
    """敏感儲存目錄必須在 os.walk 進入前被剪掉。"""
    normal = _normalise_store_name(name)
    return (
        normal in SENSITIVE_DIR_NAMES
        or bool(SENSITIVE_DIR_RE.fullmatch(name))
    )


def is_excluded_candidate(name: str) -> bool:
    """不可直接掃描的候選；聚合根仍可作為 parent 列舉子工具。"""
    return name.casefold() in AGGREGATE_CANDIDATE_DIRS or is_excluded_dir(name)


def is_excluded_file(name: str) -> bool:
    """檔名顯示它是憑證或瀏覽器儲存時，連 stat 都不做。"""
    normal = _normalise_store_name(name)
    stem = name
    for suffix in (".sqlite3", ".sqlite", ".ndjson", ".jsonl", ".json", ".db"):
        if stem.casefold().endswith(suffix):
            stem = stem[:-len(suffix)]
            break
    normal_stem = _normalise_store_name(stem)
    return (
        normal in SENSITIVE_FILE_NAMES
        or normal_stem in SENSITIVE_FILE_NAMES
        or bool(SENSITIVE_FILE_RE.fullmatch(name))
        or bool(SENSITIVE_SESSION_FILE_RE.fullmatch(name))
    )

# 名字看起來就像放對話的目錄 —— 走訪時優先進去。
# 沒有這個排序，嗅探預算會被 .claude/plugins、.grok/bundled 之類的雜檔吃光，
# 還沒走到 projects/、sessions/ 就沒額度了（實測就是這樣漏掉 Claude 與 Grok）。
PRIORITY_RE = re.compile(
    r"^(sessions?|projects?|conversations?|chats?|history|threads?|"
    r"session-state|workspaces?|agents?|rollouts?)$", re.I)

CONV_EXT = {".jsonl", ".ndjson", ".json"}
DB_EXT = {".sqlite", ".sqlite3", ".db"}

# 顯示名稱：純粹是門面，掃不到的工具會用目錄名自動產生一個
KNOWN_LABELS = {
    "claude": "Claude Code", "codex": "Codex CLI", "grok": "Grok CLI",
    "qwen": "Qwen", "cursor": "Cursor", "kimi-code": "Kimi CLI", "kimi": "Kimi",
    "copilot": "GitHub Copilot", "opencode": "OpenCode", "aider": "Aider",
    "goose": "Goose", "continue": "Continue.dev", "codebuddy": "CodeBuddy",
    "vibe": "Mistral Vibe", "kiro": "Kiro", "openclaw": "OpenClaw",
    "augment": "Augment Code", "craft-agent": "craft-agent",
    # ~/.gemini 底下裝的是 Antigravity 的 CLI（執行檔叫 agy），不是 Google 的 Gemini CLI。
    # 介面上那隻龍也叫 ANTIGRAVITY，名稱要一致才不會以為是兩個工具。
    "gemini": "Antigravity",
    "windsurf": "Windsurf", "cline": "Cline", "zed": "Zed",
}
# 目錄名 → 統一的工具 id（同一個工具可能有多個資料夾）
TOOL_ALIASES = {
    "kimi-code": "kimi", "kimi-desktop": "kimi",
    "claude-code": "claude", "github-copilot": "copilot",
    "continue.dev": "continue",
}

# 對話訊息常見的角色值
ROLE_WORDS = {"user", "assistant", "system", "tool", "human", "model", "ai",
              "developer", "function"}
# SQLite 裡面像對話的表名。
#
# trajector 是後來補的：Antigravity（agy）把每一場對話存成一個獨立的 .db，
# 表名是 trajectory_meta / steps / gen_metadata，一個「對話」字樣都沒有。
# 這個掃描器的前提是「看內容判斷，不寫死工具清單」，認不出它就是這個前提的漏洞
# —— 同一系列的工具（Windsurf / Cascade）也用 trajectory 這個詞。
DB_TABLE_RE = re.compile(r"thread|session|conversation|message|chat|trajector", re.I)


def candidate_parents() -> list[Path]:
    """可能放工具設定的父目錄。每個「子項」會被當成一個候選工具。"""
    out: list[Path] = []
    # 家目錄底下的 dot 資料夾（~/.claude、~/.codex …）
    out.append(HOME)
    for rel in (".config", ".local/share", "AppData/Roaming", "AppData/Local",
                "Library/Application Support"):
        p = HOME / rel
        if p.is_dir():
            out.append(p)
    return out


def is_noise(name: str) -> bool:
    # NOISE_DIRS 原先是大小寫敏感，例如 indexeddb 會漏掉。
    return (
        any(name.casefold() == item.casefold() for item in NOISE_DIRS)
        or bool(NOISE_RE.fullmatch(name))
        or is_excluded_candidate(name)
    )


def looks_like_message(obj, depth=0) -> bool:
    """一個 JSON 物件像不像一則對話訊息"""
    if not isinstance(obj, dict) or depth > 6:
        return False
    # 角色本身常出現在設定；必须同時具有可解析的非空文字。
    role = obj.get("role") or obj.get("type") or obj.get("sender")
    if (isinstance(role, str) and role.lower() in ROLE_WORDS
            and any(_has_text(obj.get(k)) for k in TEXT_KEYS)):
        return True
    for key in MESSAGE_WRAPPERS:
        inner = obj.get(key)
        if isinstance(inner, dict) and looks_like_message(inner, depth + 1):
            return True
    return False


def _has_text(value, depth=0) -> bool:
    if depth > 6:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return any(_has_text(x, depth + 1) for x in value)
    if isinstance(value, dict):
        return any(_has_text(value.get(k), depth + 1) for k in TEXT_KEYS)
    return False


def is_link(path: Path) -> bool:
    """Windows junctions are reparse points, even on Python without is_junction()."""
    try:
        info = path.lstat()
        return stat.S_ISLNK(info.st_mode) or bool(
            getattr(info, "st_file_attributes", 0) & 0x400)
    except OSError:
        return True


def safe_path(path: Path, *, file=False) -> bool:
    path = Path(os.path.abspath(path))
    if file and is_excluded_file(path.name):
        return False
    dirs = path.parents if file else (path, *path.parents)
    for part in dirs:
        if is_excluded_dir(part.name) or is_link(part):
            return False
    return not (file and is_link(path))


def _json_records(obj, depth=0):
    if depth > 6:
        return
    if isinstance(obj, list):
        for row in obj:
            yield from _json_records(row, depth + 1)
    elif isinstance(obj, dict):
        for key in MESSAGE_ARRAY_KEYS:
            if isinstance(obj.get(key), list):
                yield from _json_records(obj[key], depth + 1)
                return
        # Export wrappers can contain messages arrays one or two levels below data.
        for key in MESSAGE_WRAPPERS:
            inner = obj.get(key)
            if isinstance(inner, dict) and any(k in inner for k in MESSAGE_ARRAY_KEYS):
                yield from _json_records(inner, depth + 1)
                return
        yield obj


def _quoted(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _read_sqlite(path: Path, max_bytes: int, max_records: int, deadline=None) -> dict:
    """Read only allowlisted message columns; never SELECT * or inspect auth tables."""
    result = {"records": [], "status": "unsupported", "reasons": [], "format": "sqlite"}
    stop = min(deadline or float("inf"), time.time() + 2.0)
    try:
        # mode=ro sees committed WAL rows. query_only forbids writes; no immutable stale view.
        con = sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True, timeout=0.2)
        try:
            con.execute("PRAGMA query_only=ON")
            con.set_progress_handler(lambda: int(time.time() > stop), 1000)
            names = [r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN (" +
                ",".join("?" for _ in SQLITE_MESSAGE_TABLES) + ")", tuple(SQLITE_MESSAGE_TABLES))]
            used = 0
            for table in sorted(names):
                columns = {r[1] for r in con.execute(f"PRAGMA table_info({_quoted(table)})")}
                role = next((c for c in SQLITE_ROLE_COLUMNS if c in columns), None)
                body = next((c for c in SQLITE_TEXT_COLUMNS if c in columns), None)
                if not role or not body:
                    continue
                result["status"] = "ok"
                sid = next((c for c in SQLITE_ID_COLUMNS if c in columns), None)
                ts = next((c for c in SQLITE_TIME_COLUMNS if c in columns), None)
                # substr bounds even a maliciously huge cell before transferring it to Python.
                selected = [f"substr({_quoted(role)}, 1, 32)",
                            f"substr({_quoted(body)}, 1, ?)"]
                selected += [f"substr({_quoted(sid)}, 1, 256)" if sid else "NULL",
                             f"substr({_quoted(ts)}, 1, 128)" if ts else "NULL"]
                query = f"SELECT {', '.join(selected)} FROM {_quoted(table)} LIMIT ?"
                for r, text, doc_id, timestamp in con.execute(query, (max_bytes + 1, max_records + 1)):
                    if len(result["records"]) >= max_records:
                        result["reasons"].append("record-limit")
                        break
                    if not isinstance(text, str):
                        continue
                    used += len(text.encode("utf-8"))
                    if used > max_bytes:
                        result["reasons"].append("byte-limit")
                        break
                    if text.lstrip().startswith(("[", "{")):
                        try:
                            text = json.loads(text)
                        except (ValueError, RecursionError):
                            pass
                    rec = {"role": r, "content": text, "timestamp": timestamp or ""}
                    if sid:
                        rec["_conversation_id"] = str(doc_id or "")
                    if looks_like_message(rec):
                        result["records"].append(rec)
                if result["reasons"]:
                    break
        finally:
            con.close()
    except sqlite3.Error:
        result["status"] = "unreadable"
        result["reasons"].append("sqlite-read-error")
    return result


def read_conversation_records(path: Path, *, max_bytes=JSON_BYTES,
                              max_records=MAX_RECORDS, deadline=None) -> dict:
    """Shared bounded format reader used by discovery and indexing."""
    path = Path(path)
    ext = path.suffix.lower()
    result = {"records": [], "status": "unsupported", "reasons": [], "format": ext.lstrip(".")}
    if not safe_path(path, file=True):
        result["status"] = "excluded"
        return result
    if ext in DB_EXT:
        return _read_sqlite(path, max_bytes, max_records, deadline)
    if ext not in CONV_EXT:
        return result
    try:
        with path.open("rb") as fh:
            raw = fh.read(max_bytes + 1)
        limited = len(raw) > max_bytes
        if limited:
            result["reasons"].append("byte-limit")
        text = raw[:max_bytes].decode("utf-8-sig", "replace")
        result["status"] = "ok"
        if ext == ".json":
            if limited:
                return result
            rows = _json_records(json.loads(text))
        else:
            def lines():
                for line in text.splitlines():
                    if deadline and time.time() > deadline:
                        result["reasons"].append("time-limit")
                        return
                    try:
                        yield from _json_records(json.loads(line))
                    except (ValueError, RecursionError):
                        continue
            rows = lines()
        for row in rows:
            if len(result["records"]) >= max_records:
                result["reasons"].append("record-limit")
                break
            result["records"].append(row)
    except (OSError, ValueError, RecursionError):
        result["status"] = "unreadable"
        result["reasons"].append("file-read-error")
    return result


def sniff_jsonl(path: Path) -> bool:
    return any(looks_like_message(r) for r in
               read_conversation_records(path, max_bytes=SNIFF_BYTES)["records"])


def sniff_json(path: Path) -> bool:
    return any(looks_like_message(r) for r in read_conversation_records(path)["records"])


def sniff_db(path: Path) -> bool:
    return bool(read_conversation_records(path, max_bytes=SNIFF_BYTES)["records"])


def sniff(path: Path) -> bool:
    # 防止其他呼叫者繞過 scan_candidate() 的檔名過濾。
    if is_excluded_file(path.name):
        return False
    ext = path.suffix.lower()
    if ext in DB_EXT:
        return sniff_db(path)
    if ext in (".jsonl", ".ndjson"):
        return sniff_jsonl(path)
    if ext == ".json":
        return sniff_json(path)
    return False


def common_root(paths: list[Path], cand: Path) -> Path:
    """所有對話檔的共同上層目錄（不會淺過候選目錄本身）"""
    if not paths:
        return cand
    parts = [p.parent.parts for p in paths]
    base = parts[0]
    for other in parts[1:]:
        i = 0
        while i < min(len(base), len(other)) and base[i] == other[i]:
            i += 1
        base = base[:i]
    root = Path(*base) if base else cand
    try:
        root.relative_to(cand)
    except ValueError:
        return cand
    return root


def _report(deep=False) -> dict:
    return {"complete": True, "reasons": [], "deep": deep,
            "startedAt": datetime.now(timezone.utc).isoformat(), "durationMs": 0,
            "candidates": 0, "directories": 0, "filesInspected": 0,
            "matchedFiles": 0, "skippedFiles": 0, "skippedDirectories": 0,
            "unsupportedFiles": 0, "roots": [], "cached": False, "cacheAgeSeconds": 0}


def report_reason(report: dict | None, reason: str) -> None:
    if report is not None:
        report["complete"] = False
        if reason not in report["reasons"]:
            report["reasons"].append(reason)


def scan_candidate(cand: Path, deadline: float, deep: bool, report=None) -> dict | None:
    """走訪一個候選目錄，回傳偵測結果（不像 AI 工具就回 None）"""
    # scan_candidate 也是可公開呼叫的單元，不能只倚賴 scan() 的上層過濾。
    if is_excluded_candidate(cand.name) or not safe_path(cand):
        return None

    report = report if report is not None else _report(deep)

    hits: list[Path] = []
    exts: set[str] = set()
    dirs_seen = 0
    files_sniffed = 0
    max_dirs = MAX_DIRS_PER_CAND * (4 if deep else 1)
    max_files = MAX_FILES_SNIFF * (4 if deep else 1)
    max_depth = MAX_DEPTH * (2 if deep else 1)

    def onerror(_error):
        report_reason(report, "directory-read-error")

    for dirpath, dirnames, filenames in os.walk(cand, followlinks=False, onerror=onerror):
        if time.time() > deadline:
            report_reason(report, "time-limit")
            break
        d = Path(dirpath)
        depth = len(d.relative_to(cand).parts)
        # os.walk 只會在這份清單保留目錄後才往下 scandir；必須在
        # 這裡原地剪枝，不可等進入後才略過檔案。
        kept = [n for n in dirnames if not is_noise(n) and not is_link(d / n)]
        report["skippedDirectories"] += len(dirnames) - len(kept)
        dirnames[:] = kept
        if depth >= max_depth and dirnames:
            report_reason(report, "depth-limit")
            report["skippedDirectories"] += len(dirnames)
            dirnames[:] = []
        # 像對話目錄的先走，雜項後走
        dirnames.sort(key=lambda n: (0 if PRIORITY_RE.match(n) else 1, n.lower()))
        dirs_seen += 1
        if dirs_seen > max_dirs:
            report_reason(report, "directory-limit")
            break
        report["directories"] += 1
        for fn in sorted(filenames, key=str.casefold):
            if time.time() > deadline:
                report_reason(report, "time-limit")
                break
            # 擋在副檔名、stat 與 sniff 之前，保證敏感檔不會被開啟。
            if is_excluded_file(fn):
                report["skippedFiles"] += 1
                continue
            ext = Path(fn).suffix.lower()
            if ext not in CONV_EXT and ext not in DB_EXT:
                report["skippedFiles"] += 1
                continue
            f = d / fn
            if is_link(f):
                report["skippedFiles"] += 1
                continue
            if files_sniffed >= max_files:
                report_reason(report, "file-limit")
                break
            files_sniffed += 1
            report["filesInspected"] += 1
            parsed = read_conversation_records(
                f, max_bytes=JSON_BYTES if ext == ".json" else SNIFF_BYTES, deadline=deadline)
            matched = any(looks_like_message(r) for r in parsed["records"])
            if parsed["status"] == "unsupported":
                report["unsupportedFiles"] += 1
                report_reason(report, "unsupported-format")
            elif parsed["status"] == "unreadable":
                report["skippedFiles"] += 1
                report_reason(report, "file-read-error")
            for reason in parsed["reasons"]:
                # A sufficient sample establishes the format; it does not claim full parsing.
                if not matched or reason not in ("byte-limit", "record-limit"):
                    report_reason(report, reason)
            if matched:
                hits.append(f)
                report["matchedFiles"] += 1
                exts.add(ext)
        if files_sniffed >= max_files:
            # There may be unexplored sibling directories even at an exact file boundary.
            report_reason(report, "file-limit")
            break

    if len(hits) < MIN_HITS:
        return None

    raw = cand.name.lstrip(".").lower()
    tool = TOOL_ALIASES.get(raw, re.sub(r"[^\w.-]+", "-", raw).strip("-") or "imported")
    # Keep the candidate root: a partial sample's common parent can hide siblings.
    root = common_root(hits, cand) if report["complete"] else cand
    patterns = ["*" + ext for ext in sorted(exts)]
    pattern = patterns[0] if len(patterns) == 1 else "*"

    return {
        "tool": tool,
        "label": KNOWN_LABELS.get(tool, cand.name.lstrip(".").replace("-", " ").title()),
        "root": str(root),
        "pattern": pattern,
        "patterns": patterns,
        "hits": len(hits),
        "kind": "mixed" if len(exts) > 1 else ("sqlite" if exts & DB_EXT else next(iter(exts))[1:]),
        "from": str(cand),
    }


def validate_extra_roots(extra_roots=None, *, include_env=True) -> list[Path]:
    """Explicit roots are individual tool/export folders, never drive/home/storage roots."""
    chunks = list(extra_roots or [])
    if include_env:
        chunks.extend(c for c in os.environ.get("AI_CONSOLE_SCAN_DIRS", "").split(os.pathsep) if c)
    if len(chunks) > MAX_EXTRA_ROOTS:
        raise ValueError(f"At most {MAX_EXTRA_ROOTS} extra scan roots are allowed")
    roots = []
    broad = {HOME, HOME / "Documents", HOME / "Desktop", HOME / "Downloads",
             HOME / "AppData", HOME / "AppData/Roaming", HOME / "AppData/Local",
             HOME / ".config", HOME / ".local", HOME / ".local/share"}
    for key in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "PUBLIC"):
        if os.environ.get(key):
            broad.add(Path(os.environ[key]))
    broad.add(HOME.parent)
    broad_keys = {os.path.normcase(os.path.abspath(p)) for p in broad}
    for value in chunks:
        if not isinstance(value, (str, os.PathLike)):
            raise ValueError("Scan root must be an absolute tool/export directory")
        root = Path(value)
        # Reject traversal before normalization; then validate the actual canonical root.
        # C:\Users\.. must never become an accepted whole-drive scan.
        if not root.is_absolute() or ".." in root.parts or not safe_path(root):
            raise ValueError("Scan root must be a safe, existing, specific tool/export directory")
        try:
            root = root.resolve(strict=True)
        except (OSError, RuntimeError):
            raise ValueError("Scan root must be a safe, existing, specific tool/export directory") from None
        if (root == Path(root.anchor)
                or os.path.normcase(os.path.abspath(root)) in broad_keys
                or not safe_path(root) or is_noise(root.name) or not root.is_dir()):
            raise ValueError("Scan root must be a safe, existing, specific tool/export directory")
        root = Path(os.path.abspath(root))
        if root not in roots:
            roots.append(root)
    return roots


def scan_with_report(deep: bool = False, extra_roots=None) -> dict:
    """Completeness is scoped to the listed safe roots, never a claim about whole disks."""
    t0 = time.time()
    report = _report(deep)
    deadline = time.time() + (TIME_BUDGET * (4 if deep else 1))
    found: dict[str, dict] = {}
    seen_dirs: set[Path] = set()
    explicit = validate_extra_roots(extra_roots)

    def add(cand):
        if cand in seen_dirs or is_noise(cand.name) or not safe_path(cand):
            return
        if len(seen_dirs) >= MAX_CANDIDATES:
            report_reason(report, "candidate-limit")
            return
        seen_dirs.add(cand)
        report["candidates"] += 1
        res = scan_candidate(cand, deadline, deep, report)
        if res:
            key = res["root"]
            if key not in found or res["hits"] > found[key]["hits"]:
                found[key] = res

    # User-selected roots run first, while the same global time/candidate budgets apply.
    for cand in explicit:
        report["roots"].append(str(cand))
        add(cand)

    for i, parent in enumerate(candidate_parents()):
        # AI_CONSOLE_SCAN_DIRS 也可能被指到過寬或敏感的根；即使是
        # 顯式設定，憑證儲存仍不可被當成 parent 列舉。
        if i >= MAX_ROOTS:
            report_reason(report, "root-limit")
            break
        if time.time() > deadline:
            report_reason(report, "time-limit")
            break
        if is_excluded_dir(parent.name) or not safe_path(parent):
            continue
        report["roots"].append(str(parent))
        try:
            children = []
            with os.scandir(parent) as entries:
                for entry in entries:
                    if time.time() > deadline:
                        report_reason(report, "time-limit")
                        break
                    if len(children) >= MAX_CANDIDATES:
                        report_reason(report, "candidate-limit")
                        break
                    if (not is_noise(entry.name) and not is_link(Path(entry.path))
                            and entry.is_dir(follow_symlinks=False)):
                        children.append(Path(entry.path))
            children.sort()
        except OSError:
            report_reason(report, "directory-read-error")
            continue
        for cand in children:
            if time.time() > deadline:
                report_reason(report, "time-limit")
                break
            if cand in seen_dirs or is_noise(cand.name):
                continue
            # 家目錄底下只看 dot 資料夾，不然會把 Documents 之類整個翻一遍
            if parent == HOME and not cand.name.startswith("."):
                continue
            try:
                add(cand)
            except (OSError, PermissionError):
                report_reason(report, "directory-read-error")
                continue

    report["durationMs"] = round((time.time() - t0) * 1000)
    return {"sources": sorted(found.values(), key=lambda r: (-r["hits"], r["tool"])),
            "scan": report}


def scan(deep: bool = False, extra_roots=None) -> list[dict]:
    """Backward-compatible list-only discovery API."""
    return scan_with_report(deep, extra_roots)["sources"]


def main():
    deep = "--deep" in sys.argv
    t0 = time.time()
    results = scan(deep)
    if "--json" in sys.argv:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return
    if not results:
        print("沒有掃到任何 AI 對話紀錄。")
        print("可用 AI_CONSOLE_SCAN_DIRS 指定額外目錄（多個用路徑分隔符隔開），或加 --deep 掃得更徹底。")
        return
    print(f"掃到 {len(results)} 個 AI 對話來源（{time.time() - t0:.1f}s）：\n")
    for r in results:
        print(f"  {r['label']:20} {r['tool']:12} {r['hits']:3} 個對話檔  {r['kind']:6} {r['root']}")


if __name__ == "__main__":
    main()
