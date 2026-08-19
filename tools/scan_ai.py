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
import sys
import time
from pathlib import Path

HOME = Path(os.path.expanduser("~"))

# ── 掃描範圍與上限 ─────────────────────────────────
MAX_DEPTH = 6              # 從候選目錄往下最多幾層
MAX_DIRS_PER_CAND = 3000   # 每個候選最多走訪幾個目錄
MAX_FILES_SNIFF = 400      # 每個候選最多嗅探幾個檔案（每個只讀 16KB，很便宜）
SNIFF_BYTES = 16384        # 每個檔案只讀前 16KB
MIN_HITS = 2               # 至少幾個檔案像對話，才認定是 AI 工具
TIME_BUDGET = 25.0         # 整體掃描秒數上限

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
    "augment": "Augment Code", "craft-agent": "craft-agent", "gemini": "Gemini CLI",
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
# SQLite 裡面像對話的表名
DB_TABLE_RE = re.compile(r"thread|session|conversation|message|chat", re.I)


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
    env_extra = os.environ.get("AI_CONSOLE_SCAN_DIRS", "")
    for chunk in env_extra.split(os.pathsep):
        if chunk and Path(chunk).is_dir():
            out.append(Path(chunk))
    return out


def is_noise(name: str) -> bool:
    return name in NOISE_DIRS or bool(NOISE_RE.match(name))


def looks_like_message(obj) -> bool:
    """一個 JSON 物件像不像一則對話訊息"""
    if not isinstance(obj, dict):
        return False
    # 直接帶 role
    role = obj.get("role") or obj.get("type") or obj.get("sender")
    if isinstance(role, str) and role.lower() in ROLE_WORDS:
        return True
    # 包一層的：{"message": {"role": ...}}
    inner = obj.get("message") or obj.get("payload") or obj.get("data")
    if isinstance(inner, dict):
        r = inner.get("role") or inner.get("type")
        if isinstance(r, str) and r.lower() in ROLE_WORDS:
            return True
    # 有 content/text 又有時間戳，通常也是訊息流
    has_text = any(k in obj for k in ("content", "text", "input_text", "output_text", "parts"))
    has_time = any(k in obj for k in ("timestamp", "ts", "createdAt", "created_at", "time"))
    return has_text and has_time


def sniff_jsonl(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            head = f.read(SNIFF_BYTES)
    except OSError:
        return False
    text = head.decode("utf-8", "ignore")
    lines = [l for l in text.splitlines() if l.strip().startswith("{")][:6]
    if not lines:
        return False
    hits = 0
    for l in lines:
        try:
            if looks_like_message(json.loads(l)):
                hits += 1
        except json.JSONDecodeError:
            continue          # 最後一行可能被 SNIFF_BYTES 切斷，正常
    return hits >= max(1, len(lines) // 2)


def sniff_json(path: Path) -> bool:
    try:
        if path.stat().st_size > 4 * 1024 * 1024:
            return False
        obj = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except (OSError, json.JSONDecodeError):
        return False
    arr = obj if isinstance(obj, list) else None
    if isinstance(obj, dict):
        for k in ("messages", "history", "conversation", "turns", "entries"):
            if isinstance(obj.get(k), list):
                arr = obj[k]
                break
    if not isinstance(arr, list) or not arr:
        return False
    return sum(1 for x in arr[:6] if looks_like_message(x)) >= 1


def sniff_db(path: Path) -> bool:
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True, timeout=1)
        try:
            names = [r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")]
        finally:
            con.close()
    except sqlite3.Error:
        return False
    return any(DB_TABLE_RE.search(n) for n in names)


def sniff(path: Path) -> bool:
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


def scan_candidate(cand: Path, deadline: float, deep: bool) -> dict | None:
    """走訪一個候選目錄，回傳偵測結果（不像 AI 工具就回 None）"""
    hits: list[Path] = []
    exts: set[str] = set()
    dirs_seen = 0
    files_sniffed = 0
    max_dirs = MAX_DIRS_PER_CAND * (4 if deep else 1)
    max_files = MAX_FILES_SNIFF * (4 if deep else 1)

    for dirpath, dirnames, filenames in os.walk(cand):
        if time.time() > deadline:
            break
        d = Path(dirpath)
        depth = len(d.relative_to(cand).parts)
        if depth >= MAX_DEPTH:
            dirnames[:] = []
        dirnames[:] = [n for n in dirnames if not is_noise(n)]
        # 像對話目錄的先走，雜項後走
        dirnames.sort(key=lambda n: (0 if PRIORITY_RE.match(n) else 1, n.lower()))
        dirs_seen += 1
        if dirs_seen > max_dirs:
            break
        for fn in filenames:
            ext = Path(fn).suffix.lower()
            if ext not in CONV_EXT and ext not in DB_EXT:
                continue
            f = d / fn
            try:
                if f.stat().st_size < 120:
                    continue
            except OSError:
                continue
            files_sniffed += 1
            if files_sniffed > max_files:
                break
            if sniff(f):
                hits.append(f)
                exts.add(ext)
                if len(hits) >= 40:
                    break
        if len(hits) >= 40 or files_sniffed > max_files:
            break

    if len(hits) < MIN_HITS:
        return None

    raw = cand.name.lstrip(".").lower()
    tool = TOOL_ALIASES.get(raw, raw)
    root = common_root(hits, cand)
    # 從命中的檔名歸納出一個 glob
    if all(h.suffix.lower() in (".jsonl", ".ndjson") for h in hits):
        names = {h.name for h in hits}
        pattern = next(iter(names)) if len(names) == 1 else "*.jsonl"
    elif all(h.suffix.lower() == ".json" for h in hits):
        pattern = "*.json"
    else:
        pattern = "*.json*"

    return {
        "tool": tool,
        "label": KNOWN_LABELS.get(tool, cand.name.lstrip(".").replace("-", " ").title()),
        "root": str(root),
        "pattern": pattern,
        "hits": len(hits),
        "kind": "sqlite" if exts & DB_EXT else "jsonl",
        "from": str(cand),
    }


def scan(deep: bool = False) -> list[dict]:
    """掃描全機，回傳偵測到的 AI 對話來源（依命中數排序）"""
    deadline = time.time() + (TIME_BUDGET * (4 if deep else 1))
    found: dict[str, dict] = {}
    seen_dirs: set[Path] = set()

    for parent in candidate_parents():
        try:
            children = sorted(p for p in parent.iterdir() if p.is_dir())
        except OSError:
            continue
        for cand in children:
            if time.time() > deadline:
                break
            if cand in seen_dirs or is_noise(cand.name):
                continue
            # 家目錄底下只看 dot 資料夾，不然會把 Documents 之類整個翻一遍
            if parent == HOME and not cand.name.startswith("."):
                continue
            seen_dirs.add(cand)
            try:
                res = scan_candidate(cand, deadline, deep)
            except (OSError, PermissionError):
                continue
            if not res:
                continue
            key = res["root"]
            if key not in found or res["hits"] > found[key]["hits"]:
                found[key] = res

    return sorted(found.values(), key=lambda r: (-r["hits"], r["tool"]))


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
