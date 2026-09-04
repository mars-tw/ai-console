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
import base64
import binascii
import datetime as _dt
import hashlib
import io
import json
import math
import mimetypes
import os
import re
import shutil
import stat
import signal
import subprocess
import sys
import tempfile
import hmac
import secrets
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath

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
sys.path.insert(0, str(APP_ROOT / "tools"))
from index_lock import conversation_index_lock  # noqa: E402
import planner   # noqa: E402
import rules     # noqa: E402
import schedule  # noqa: E402
from conversation_tail import ConversationTailError, load_indexed_tail  # noqa: E402

PORT = 5177

# 技能中心只會接觸這六個公開技能根目錄。這份表不含登入、帳號、
# token 或瀏覽器 profile，也不會從設定檔推測使用者身分。
SKILL_TARGETS = {
    "governance": {"label": "全域治理（唯讀來源）", "parts": (".agents", "skills")},
    "claude": {"label": "Claude", "parts": (".claude", "skills")},
    "codex": {"label": "Codex", "parts": (".codex", "skills")},
    "grok": {"label": "Grok", "parts": (".grok", "skills")},
    "qwen": {"label": "Qwen", "parts": (".qwen", "skills")},
    "kimi": {"label": "Kimi", "parts": (".kimi-code", "skills")},
}
# 全域治理技能會被所有派工工具共同讀取，風險範圍不同於單一 AI。
# 新手匯入精靈只允許安裝到單一工具根目錄；治理根目錄保留為唯讀來源。
SKILL_IMPORT_TARGETS = ("claude", "codex", "grok", "qwen", "kimi")

# 對話同步卡片只探測對話／側欄資料根，不碰 auth、帳號、瀏覽器 profile。
# 每個來源保留兩條安全路徑，讓「工具沒安裝」「真的 0 份」「讀取失敗」
# 能夠分開呈現，而不是一律猜成 0。
CONVERSATION_SOURCE_ROOTS = {
    "codex": ((".codex", "sessions"), (".codex", "state_5.sqlite")),
    "claude": ((".claude", "projects"),
               ("AppData", "Roaming", "Claude", "claude-code-sessions"),
               ("AppData", "Local", "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache",
                "Roaming", "Claude", "claude-code-sessions")),
    "qwen": ((".qwen", "projects"), (".craft-agent", "workspaces")),
    "kimi": ((".kimi-code", "sessions"),
              ("AppData", "Roaming", "kimi-desktop", "kimi-agent")),
}
CONVERSATION_SOURCE_LABELS = {
    "codex": "Codex", "claude": "Claude", "qwen": "Qwen", "kimi": "Kimi",
}

# JSON body 的總上限為 2 MiB；base64 會多約 1/3，所以壓縮檔再收緊。
# 這些上限是技能說明與少量輔助檔的尺度，不是一般檔案上傳器。
MAX_SKILL_ARCHIVE_BYTES = 768 * 1024
MAX_SKILL_UNPACKED_BYTES = 1024 * 1024
MAX_SKILL_FILE_BYTES = 512 * 1024
MAX_SKILL_FILES = 80
MAX_SKILL_PATH_CHARS = 220
MAX_SKILL_PATH_DEPTH = 8
MAX_SKILL_ZIP_RATIO = 40

_SKILL_IMPORT_LOCK = threading.Lock()
_WINDOWS_RESERVED_NAMES = {
    "con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}
_SENSITIVE_SKILL_NAMES = {
    ".env", "auth.json", "credentials.json", "credential.json", "secrets.json",
    "secret.json", "token.json", "tokens.json", "id_rsa", "id_ed25519",
    "private_key", "private-key", "key.pem", "account.json", "accounts.json",
    "cookie", "cookies", "cookies.json",
}
_NESTED_ARCHIVE_SUFFIXES = {".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz"}
_PRIVATE_KEY_MARKERS = (
    b"-----BEGIN PRIVATE KEY-----",
    b"-----BEGIN RSA PRIVATE KEY-----",
    b"-----BEGIN EC PRIVATE KEY-----",
    b"-----BEGIN OPENSSH PRIVATE KEY-----",
    b"-----BEGIN PGP PRIVATE KEY BLOCK-----",
)
_PROVIDER_TOKEN_RE = re.compile(
    r"(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|"
    r"AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|xai-[A-Za-z0-9_-]{16,})"
)
_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?im)[\"']?\b(?:[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|PRIVATE_KEY))"
    r"\b[\"']?\s*[:=]\s*[\"']?([A-Za-z0-9_./+=:-]{8,})"
)
_PLACEHOLDER_MARKERS = (
    "example", "placeholder", "replace", "your-", "your_", "changeme", "dummy",
    "<secret", "${", "process.env", "os.getenv", "%",
)


def _placeholder_secret(value: str) -> bool:
    folded = value.casefold()
    return not value or any(marker in folded for marker in _PLACEHOLDER_MARKERS)


def _json_contains_secret(value: object) -> bool:
    if isinstance(value, dict):
        for raw_key, item in value.items():
            key = re.sub(r"[^a-z0-9]+", "_", str(raw_key).casefold()).strip("_")
            compact = key.replace("_", "")
            sensitive = (compact in {"password", "secret", "token", "apikey", "accesstoken",
                                     "authtoken", "privatekey", "clientsecret"}
                         or compact.endswith(("password", "secret", "token", "apikey")))
            if sensitive and isinstance(item, str) and not _placeholder_secret(item):
                return True
            if _json_contains_secret(item):
                return True
    elif isinstance(value, list):
        return any(_json_contains_secret(item) for item in value)
    return False


class SkillPackageError(ValueError):
    """可直接轉成給新手看的技能包錯誤。"""

    def __init__(self, code: str, message: str, status: int = 400,
                 help_text: str = "請重新選擇完整的技能資料夾或 ZIP。",
                 details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.help = help_text
        self.details = details or {}


def _skill_roots(home: Path | None = None) -> dict[str, Path]:
    base = home or Path.home()
    return {key: base.joinpath(*meta["parts"])
            for key, meta in SKILL_TARGETS.items()}


def _skill_link_like(path: Path) -> bool:
    """Windows junctions escape roots just like symlinks and must fail closed."""
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def _relative_skill_root(target: str) -> str:
    return "/".join(SKILL_TARGETS[target]["parts"])


def _sensitive_skill_component(component: str) -> bool:
    low = component.casefold().rstrip(". ")
    if low in _SENSITIVE_SKILL_NAMES or low.startswith(".env."):
        return True
    stem = Path(low).stem
    if stem in {"auth", "account", "accounts", "cookie", "cookies", "credential",
                "credentials", "secret", "secrets", "token", "tokens",
                "private_key", "private-key"}:
        return True
    return Path(low).suffix in {".pfx", ".p12", ".key"}


def _safe_package_path(raw: object) -> str:
    """把來自 JSON/ZIP 的檔名收斂成單一、跨平台的相對路徑。"""
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise SkillPackageError("INVALID_PATH", "技能包裡有空白或無效檔名。")
    if "\\" in raw or raw.startswith(("/", "~")) or re.match(r"^[A-Za-z]:", raw):
        raise SkillPackageError("PATH_TRAVERSAL", "技能包只能使用資料夾內的相對路徑。")
    if len(raw) > MAX_SKILL_PATH_CHARS:
        raise SkillPackageError("PATH_TOO_LONG", "技能包裡有過長的檔名。")
    raw_parts = raw.split("/")
    if any(p in ("", ".", "..") for p in raw_parts):
        raise SkillPackageError("PATH_TRAVERSAL", "技能包包含 ../ 或其他不安全路徑。")
    path = PurePosixPath(raw)
    parts = path.parts
    if len(parts) > MAX_SKILL_PATH_DEPTH:
        raise SkillPackageError("PATH_TOO_DEEP", "技能包的資料夾層級過深。")
    for part in parts:
        if ":" in part or part.endswith((".", " ")):
            raise SkillPackageError("INVALID_PATH", f"不支援的檔名：{part}")
        if part.split(".", 1)[0].casefold() in _WINDOWS_RESERVED_NAMES:
            raise SkillPackageError("INVALID_PATH", f"不支援的檔名：{part}")
        if _sensitive_skill_component(part):
            raise SkillPackageError(
                "SENSITIVE_FILENAME", f"技能包不可包含憑證或私鑰檔名：{part}",
                help_text="請移除憑證、token、.env 與私鑰；技能只能引用安全的憑證位置。")
        if Path(part.casefold()).suffix in _NESTED_ARCHIVE_SUFFIXES:
            raise SkillPackageError("NESTED_ARCHIVE", f"技能包裡不可再嵌套壓縮檔：{part}")
    return path.as_posix()


def _decode_skill_bytes(value: object, *, field: str, allow_empty: bool = False) -> bytes:
    if not isinstance(value, str) or (not value and not allow_empty):
        raise SkillPackageError("INVALID_BASE64", f"{field} 沒有可讀取的 base64 內容。")
    if value.startswith("data:"):
        marker = ";base64,"
        if marker not in value:
            raise SkillPackageError("INVALID_BASE64", f"{field} 不是 base64 資料。")
        value = value.split(marker, 1)[1]
    # 先用 base64 長度估算原始大小，避免先配置一個過大 bytes
    # 才說它超限。ZIP 與目錄檔案都不可能合法地超過 1 MiB。
    if len(value) > ((MAX_SKILL_UNPACKED_BYTES + 2) // 3 * 4 + 8):
        raise SkillPackageError("PACKAGE_TOO_LARGE", f"{field} 超過技能包上限。", 413)
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise SkillPackageError("INVALID_BASE64", f"{field} 的 base64 內容已損壞。")


def _add_skill_file(files: dict[str, bytes], raw_path: object, data: bytes) -> None:
    path = _safe_package_path(raw_path)
    folded = path.casefold()
    if any(existing.casefold() == folded for existing in files):
        raise SkillPackageError("DUPLICATE_PATH", f"技能包有重複檔案：{path}")
    if len(files) >= MAX_SKILL_FILES:
        raise SkillPackageError("TOO_MANY_FILES", f"技能包最多 {MAX_SKILL_FILES} 個檔案。", 413)
    if len(data) > MAX_SKILL_FILE_BYTES:
        raise SkillPackageError("FILE_TOO_LARGE", f"檔案 {path} 超過單檔上限。", 413)
    if sum(len(v) for v in files.values()) + len(data) > MAX_SKILL_UNPACKED_BYTES:
        raise SkillPackageError("PACKAGE_TOO_LARGE", "技能包解壓後超過 1 MiB 上限。", 413)
    upper = data.upper()
    if any(marker in upper for marker in _PRIVATE_KEY_MARKERS):
        raise SkillPackageError(
            "PRIVATE_KEY_CONTENT", f"檔案 {path} 含私鑰內容，已停止匯入。",
            help_text="請移除私鑰與憑證內容；技能只能引用安全的憑證位置。",
        )
    text = data.decode("utf-8", errors="ignore")
    assignments = (match.group(1) for match in _SECRET_ASSIGNMENT_RE.finditer(text))
    json_secret = False
    if Path(path).suffix.casefold() == ".json":
        try:
            json_secret = _json_contains_secret(json.loads(text))
        except (json.JSONDecodeError, UnicodeError):
            pass
    if (_PROVIDER_TOKEN_RE.search(text) or json_secret
            or any(not _placeholder_secret(value) for value in assignments)):
        raise SkillPackageError(
            "SECRET_CONTENT", f"檔案 {path} 疑似包含明文金鑰、token 或密碼，已停止匯入。",
            help_text="請移除明文憑證，改成只引用環境變數或安全的憑證位置。",
        )
    files[path] = data


def _files_from_zip(encoded: object) -> dict[str, bytes]:
    raw = _decode_skill_bytes(encoded, field="ZIP")
    if len(raw) > MAX_SKILL_ARCHIVE_BYTES:
        raise SkillPackageError("ARCHIVE_TOO_LARGE", "ZIP 壓縮檔超過 768 KiB 上限。", 413)
    files: dict[str, bytes] = {}
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_SKILL_FILES * 2:
                raise SkillPackageError("TOO_MANY_FILES", f"技能包最多 {MAX_SKILL_FILES} 個檔案。", 413)
            for info in infos:
                path = _safe_package_path(info.filename.rstrip("/"))
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise SkillPackageError("SYMLINK_REJECTED", f"技能包不可包含符號連結：{path}")
                if info.is_dir():
                    continue
                # Windows/Python 產生的 ZIP 常只寫 0600 權限，沒有檔案類型位元。
                # 只有類型位元真的存在時才能拿它擋特殊檔；symlink 已在上面先擋。
                file_type = stat.S_IFMT(mode)
                if file_type and file_type != stat.S_IFREG:
                    raise SkillPackageError("SPECIAL_FILE_REJECTED", f"技能包不可包含特殊檔案：{path}")
                if info.flag_bits & 0x1:
                    raise SkillPackageError("ENCRYPTED_ZIP", "不支援加密 ZIP。")
                if info.file_size > MAX_SKILL_FILE_BYTES:
                    raise SkillPackageError("FILE_TOO_LARGE", f"檔案 {path} 超過單檔上限。", 413)
                if info.file_size > max(1, info.compress_size) * MAX_SKILL_ZIP_RATIO:
                    raise SkillPackageError("ZIP_BOMB", f"檔案 {path} 的壓縮比異常，已停止匯入。", 413)
                _add_skill_file(files, path, archive.read(info))
    except SkillPackageError:
        raise
    except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
        raise SkillPackageError("INVALID_ZIP", f"ZIP 無法讀取：{exc}")
    return files


def _files_from_json(entries: object) -> dict[str, bytes]:
    if not isinstance(entries, list) or not entries:
        raise SkillPackageError("EMPTY_PACKAGE", "資料夾裡沒有可匯入的檔案。")
    files: dict[str, bytes] = {}
    for index, item in enumerate(entries):
        if not isinstance(item, dict) or item.get("type") in {"symlink", "link"} \
                or item.get("symlink") or item.get("link"):
            raise SkillPackageError("SYMLINK_REJECTED", "技能包不可包含符號連結。")
        raw_path = item.get("path")
        _safe_package_path(raw_path)  # 先驗檔名，敏感檔連 base64 都不解碼
        encoded = item.get("data", item.get("contentBase64", item.get("base64")))
        _add_skill_file(files, raw_path,
                        _decode_skill_bytes(encoded, field=f"第 {index + 1} 個檔案",
                                            allow_empty=True))
    return files


def _read_installed_skill_dir(root: Path) -> dict[str, bytes]:
    if not root.is_dir() or _skill_link_like(root):
        raise SkillPackageError("SOURCE_NOT_FOUND", "找不到可安全讀取的已安裝技能。", 404)
    files: dict[str, bytes] = {}
    try:
        for item in sorted(root.rglob("*"), key=lambda p: str(p).casefold()):
            if _skill_link_like(item):
                raise SkillPackageError("SYMLINK_REJECTED", f"已安裝技能包含符號連結：{item.name}")
            if item.is_dir():
                continue
            if not item.is_file():
                raise SkillPackageError("SPECIAL_FILE_REJECTED", f"已安裝技能包含特殊檔案：{item.name}")
            rel = item.relative_to(root).as_posix()
            _safe_package_path(rel)  # 敏感檔名在讀內容前就擋下
            if item.stat().st_size > MAX_SKILL_FILE_BYTES:
                raise SkillPackageError("FILE_TOO_LARGE", f"檔案 {rel} 超過單檔上限。", 413)
            _add_skill_file(files, rel, item.read_bytes())
    except SkillPackageError:
        raise
    except OSError as exc:
        raise SkillPackageError("SOURCE_READ_FAILED", f"無法讀取已安裝技能：{exc}", 500)
    return files


def _find_installed_skill(source: object, wanted: object,
                          home: Path | None = None) -> dict[str, bytes]:
    if source not in SKILL_TARGETS or not isinstance(wanted, str) or not wanted.strip():
        raise SkillPackageError("INVALID_SOURCE", "請從技能清單選擇有效的來源。")
    root = _skill_roots(home)[str(source)]
    home_path = home or Path.home()
    _assert_safe_skill_target(root, home_path)
    if not root.is_dir() or _skill_link_like(root):
        raise SkillPackageError("SOURCE_NOT_FOUND", "這個工具目前沒有可匯出的技能。", 404)
    for child in sorted(root.iterdir(), key=lambda p: p.name.casefold()):
        if not child.is_dir() or _skill_link_like(child):
            continue
        skill_file = child / "SKILL.md"
        try:
            if not skill_file.is_file() or _skill_link_like(skill_file) \
                    or skill_file.stat().st_size > MAX_SKILL_FILE_BYTES:
                continue
            head = skill_file.read_bytes()[:65536].decode("utf-8-sig", errors="strict")
        except (OSError, UnicodeError):
            continue
        name = rules._frontmatter(head).get("name") or child.name
        if name.casefold() == wanted.strip().casefold():
            return _read_installed_skill_dir(child)
    raise SkillPackageError("SOURCE_NOT_FOUND", f"找不到已安裝技能：{wanted}", 404)


def _strip_skill_wrapper(files: dict[str, bytes]) -> dict[str, bytes]:
    all_skill_paths = [PurePosixPath(p) for p in files
                       if PurePosixPath(p).name.casefold() == "skill.md"]
    if "SKILL.md" in files and len(all_skill_paths) == 1:
        return files
    skill_paths = [p for p in all_skill_paths if len(p.parts) > 1]
    if len(skill_paths) != 1 or len(skill_paths[0].parts) != 2:
        raise SkillPackageError("SKILL_MD_REQUIRED", "技能包根目錄必須有一份 SKILL.md。")
    wrapper = skill_paths[0].parts[0]
    if any(PurePosixPath(p).parts[0].casefold() != wrapper.casefold() for p in files):
        raise SkillPackageError("MULTIPLE_ROOTS", "ZIP 裡只能放一個技能資料夾。")
    stripped = {PurePosixPath(p).relative_to(PurePosixPath(p).parts[0]).as_posix(): data
                for p, data in files.items()}
    if "SKILL.md" not in stripped:
        raise SkillPackageError("SKILL_MD_CASE", "主說明檔必須正確命名為 SKILL.md。")
    return stripped


def _safe_skill_folder(name: str) -> str:
    folder = re.sub(r"\s+", "-", unicodedata.normalize("NFKC", name.strip()))
    if not folder or len(folder) > 80 or folder.startswith(".") or folder.endswith(".") \
            or any(not (ch.isalnum() or ch in "-_.") for ch in folder):
        raise SkillPackageError(
            "INVALID_SKILL_NAME", "SKILL.md 的 name 只能包含文字、數字、- _ .，且不能以點開頭。")
    if folder.split(".", 1)[0].casefold() in _WINDOWS_RESERVED_NAMES:
        raise SkillPackageError("INVALID_SKILL_NAME", "SKILL.md 的 name 是 Windows 保留名稱。")
    return folder


def _skill_package(body: object, *, home: Path | None = None) -> dict:
    if not isinstance(body, dict):
        raise SkillPackageError("INVALID_REQUEST", "匯入資料必須是 JSON 物件。")
    kind = body.get("kind")
    if kind == "zip":
        files = _files_from_zip(body.get("data", body.get("zipBase64")))
    elif kind in {"files", "directory"}:
        files = _files_from_json(body.get("files"))
    elif kind == "installed":
        files = _find_installed_skill(body.get("source"), body.get("name"), home)
    else:
        raise SkillPackageError("INVALID_KIND", "請選擇 ZIP、資料夾，或已安裝技能。")
    files = _strip_skill_wrapper(files)
    try:
        text = files["SKILL.md"].decode("utf-8-sig", errors="strict").replace("\r\n", "\n")
    except (KeyError, UnicodeError):
        raise SkillPackageError("INVALID_SKILL_MD", "SKILL.md 必須是 UTF-8 純文字。")
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---" \
            or not any(line.strip() == "---" for line in lines[1:]):
        raise SkillPackageError("INVALID_FRONTMATTER", "SKILL.md 開頭必須有完整的 YAML frontmatter。")
    fm = rules._frontmatter(text)
    name = fm.get("name", "").strip()
    description = fm.get("description", "").strip()
    if not name or not description or description in {">", "|", ">-", "|-", ">+", "|+"}:
        raise SkillPackageError("INVALID_FRONTMATTER", "SKILL.md frontmatter 必須同時有 name 與 description。")
    if len(description) > 2000:
        raise SkillPackageError("DESCRIPTION_TOO_LONG", "技能 description 過長，請收斂到 2,000 字以內。")
    folder = _safe_skill_folder(name)
    return {"name": name, "description": description, "folder": folder,
            "files": files, "fileCount": len(files),
            "totalBytes": sum(len(v) for v in files.values()),
            "digest": _skill_digest(files)}


def _skill_digest(files: dict[str, bytes]) -> str:
    """技能版本包含所有檔案；不能只看 SKILL.md 而漏掉被換掉的 script。"""
    digest = hashlib.sha256()
    for path in sorted(files, key=str.casefold):
        digest.update(path.casefold().encode("utf-8"))
        digest.update(b"\x00")
        digest.update(files[path])
        digest.update(b"\x00")
    return digest.hexdigest()


def _skill_summary(package: dict) -> dict:
    return {key: package[key] for key in
            ("name", "description", "folder", "fileCount", "totalBytes", "digest")} | {
                "files": sorted(package["files"], key=str.casefold),
            }


def _existing_skill_dir(root: Path, folder: str) -> Path | None:
    if not root.is_dir() or _skill_link_like(root):
        return None
    try:
        return next((p for p in root.iterdir()
                     if p.is_dir() and not _skill_link_like(p)
                     and p.name.casefold() == folder.casefold()), None)
    except OSError:
        return None


def _governance_name_state(package: dict, home: Path) -> dict | None:
    """治理技能名稱跨所有 AI 保留，避免工具根以同名內容冒充治理規則。"""
    root = _skill_roots(home)["governance"]
    _assert_safe_skill_target(root, home)
    if not root.exists():
        return None
    if not root.is_dir() or _skill_link_like(root):
        raise SkillPackageError("UNSAFE_TARGET", "全域治理技能目錄不安全，無法確認保留名稱。", 409)
    wanted = {package["name"].casefold(), package["folder"].casefold()}
    try:
        children = sorted(root.iterdir(), key=lambda item: item.name.casefold())
    except OSError:
        raise SkillPackageError("UNSAFE_TARGET", "全域治理技能目錄無法讀取，無法確認保留名稱。", 409)
    for child in children:
        if not child.is_dir():
            continue
        if _skill_link_like(child):
            if child.name.casefold() in wanted:
                return {"status": "conflict", "reason": "名稱已由連結形式的全域治理技能保留"}
            continue
        skill_file = child / "SKILL.md"
        try:
            if not skill_file.is_file():
                continue
            if _skill_link_like(skill_file):
                if child.name.casefold() in wanted:
                    return {"status": "conflict", "reason": "名稱已由全域治理技能保留"}
                continue
            head = skill_file.read_bytes()[:65536].decode("utf-8-sig", errors="strict")
        except (OSError, UnicodeError):
            continue
        installed_name = (rules._frontmatter(head).get("name") or child.name).strip()
        if child.name.casefold() not in wanted and installed_name.casefold() not in wanted:
            continue
        try:
            digest = _skill_digest(_read_installed_skill_dir(child))
        except SkillPackageError:
            digest = ""
        same = bool(digest) and digest == package["digest"]
        return {
            "status": "installed" if same else "conflict",
            "reason": ("全域治理已提供相同技能，所有 AI 都會共用"
                       if same else "名稱與全域治理技能衝突，禁止在單一 AI 目錄冒名"),
        }
    return None


def _skill_target_states(package: dict, home: Path | None = None) -> list[dict]:
    states = []
    home_path = home or Path.home()
    roots = _skill_roots(home_path)
    try:
        governance_state = _governance_name_state(package, home_path)
    except SkillPackageError as exc:
        governance_state = {"status": "unavailable", "reason": str(exc)}
    for target in SKILL_IMPORT_TARGETS:
        root = roots[target]
        existing = _existing_skill_dir(root, package["folder"])
        state = {"id": target, "label": SKILL_TARGETS[target]["label"],
                 "location": f"{_relative_skill_root(target)}/{package['folder']}"}
        try:
            _assert_safe_skill_target(root, home_path)
            target_safe = not root.exists() or (root.is_dir() and not _skill_link_like(root))
        except SkillPackageError:
            target_safe = False
        if governance_state:
            state.update(governance_state)
        elif not target_safe:
            state["status"] = "unavailable"
            state["reason"] = "技能目錄不安全或無法使用"
        elif not existing:
            state["status"] = "available"
        else:
            try:
                same = _skill_package({"kind": "installed", "source": target,
                                       "name": package["name"]}, home=home)["digest"] == package["digest"]
            except SkillPackageError:
                same = False
            state["status"] = "installed" if same else "conflict"
            state["reason"] = ("相同版本已安裝" if same
                               else "同名技能已存在，內容不同")
        states.append(state)
    return states


def _skill_choices() -> list[dict]:
    return [
        {"id": "select-available-target", "label": "改選尚未安裝的 AI"},
        {"id": "cancel", "label": "取消，保留現有技能"},
    ]


def _write_skill_stage(stage: Path, package: dict) -> None:
    for rel, data in package["files"].items():
        dest = stage.joinpath(*PurePosixPath(rel).parts)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)


def _atomic_skill_rename(stage: Path, destination: Path) -> None:
    """單一目標的最後一步；獨立函式也讓回滾情境可被測試。"""
    os.rename(stage, destination)


def _assert_safe_skill_target(root: Path, home: Path) -> None:
    """目標必須真的在 HOME 內，不可透過 symlink/junction 跳到別處。"""
    try:
        home_resolved = home.resolve(strict=False)
        root_resolved = root.resolve(strict=False)
        root_resolved.relative_to(home_resolved)
    except (OSError, ValueError):
        raise SkillPackageError("UNSAFE_TARGET", "技能目錄不在允許的使用者資料夾內。", 409)
    current = home
    for part in root.relative_to(home).parts:
        current = current / part
        is_junction = getattr(current, "is_junction", lambda: False)
        if current.exists() and (current.is_symlink() or is_junction()):
            raise SkillPackageError("UNSAFE_TARGET", "技能目錄不可經過符號連結或 junction。", 409)


def _install_skill(package: dict, selected: object,
                   home: Path | None = None) -> list[dict]:
    if not isinstance(selected, list) or not selected:
        raise SkillPackageError("TARGET_REQUIRED", "請至少選擇一個要匯入的 AI。")
    if any(not isinstance(target, str) for target in selected) \
            or len(selected) != 1 or len(set(selected)) != len(selected) \
            or any(target not in SKILL_IMPORT_TARGETS for target in selected):
        raise SkillPackageError("INVALID_TARGET", "每次只能選擇一個允許的 AI 匯入技能。")
    home_path = home or Path.home()
    roots = _skill_roots(home_path)
    for target in selected:
        _assert_safe_skill_target(roots[target], home_path)
    states = {s["id"]: s for s in _skill_target_states(package, home)}
    conflicts = [{"target": target, "status": states[target]["status"],
                  "reason": states[target].get("reason", "同名技能已存在")}
                 for target in selected if states[target]["status"] != "available"]
    if conflicts:
        raise SkillPackageError(
            "SKILL_CONFLICT", "選取的 AI 已有同名技能，本次沒有寫入任何檔案。", 409,
            help_text="請改選顯示「可匯入」的 AI，或取消以保留原版。",
            details={"results": conflicts, "choices": _skill_choices()})

    staged: list[tuple[str, Path, Path]] = []
    committed: list[tuple[str, Path]] = []
    created_roots: list[Path] = []
    with _SKILL_IMPORT_LOCK:
        try:
            if _governance_name_state(package, home_path):
                raise SkillPackageError(
                    "GOVERNANCE_NAME_RESERVED",
                    "此名稱已由全域治理技能保留，本次沒有寫入任何檔案。", 409,
                    details={"results": [{"target": selected[0], "status": "conflict",
                                            "reason": "名稱與全域治理技能衝突"}]},
                )
            # 進入鎖後再查一次，避免兩個匯入同時通過預覽。
            for target in selected:
                if _existing_skill_dir(roots[target], package["folder"]):
                    raise SkillPackageError("SKILL_CONFLICT", "同名技能剛剛已被安裝，本次已取消。", 409,
                                            details={"results": [{"target": target, "status": "conflict"}],
                                                     "choices": _skill_choices()})
            for target in selected:
                root = roots[target]
                if root.exists() and (not root.is_dir() or _skill_link_like(root)):
                    raise SkillPackageError("UNSAFE_TARGET", f"{SKILL_TARGETS[target]['label']} 技能目錄不安全。", 409)
                if not root.exists():
                    root.mkdir(parents=True, exist_ok=True)
                    created_roots.append(root)
                stage = Path(tempfile.mkdtemp(prefix=".skill-import-", dir=root))
                destination = root / package["folder"]
                staged.append((target, stage, destination))
                _write_skill_stage(stage, package)
            # 逐個 stage 讀回比對。這裡不可走 source/name 索引，
            # 因為它尚未更名。整個過程只讀檔，不執行其中任何 script。
            for _, stage, _ in staged:
                staged_files = _read_installed_skill_dir(stage)
                checked = _skill_package({"kind": "files", "files": [
                    {"path": p, "data": base64.b64encode(data).decode("ascii")}
                    for p, data in staged_files.items()
                ]})
                if checked["digest"] != package["digest"]:
                    raise SkillPackageError("STAGE_VERIFY_FAILED", "技能暫存檔驗證失敗，本次已取消。", 500)
            for target, stage, destination in staged:
                if destination.exists():
                    raise SkillPackageError("SKILL_CONFLICT", "同名技能剛剛已被安裝，本次已取消。", 409)
                _atomic_skill_rename(stage, destination)
                committed.append((target, destination))
        except Exception as exc:
            rollback_failed = []
            for _, destination in reversed(committed):
                try:
                    shutil.rmtree(destination)
                except OSError:
                    rollback_failed.append(str(destination))
            for _, stage, _ in staged:
                if stage.exists():
                    shutil.rmtree(stage, ignore_errors=True)
            for root in reversed(created_roots):
                with contextlib.suppress(OSError):
                    root.rmdir()
            if rollback_failed:
                raise SkillPackageError("ROLLBACK_FAILED", "匯入失敗，且有暫存檔無法自動清理。", 500,
                                        details={"paths": rollback_failed})
            if isinstance(exc, SkillPackageError):
                raise
            raise SkillPackageError("IMPORT_ROLLED_BACK", "匯入失敗；已回復原狀，沒有留下半套技能。", 500)
    return [{"target": target, "status": "installed",
             "location": f"{_relative_skill_root(target)}/{package['folder']}"}
            for target in selected]


def _installed_skill_inventory(home: Path | None = None) -> dict:
    home_path = home or Path.home()
    roots = _skill_roots(home_path)
    grouped: dict[str, dict] = {}
    target_counts = {target: 0 for target in SKILL_TARGETS}
    for target, root in roots.items():
        try:
            _assert_safe_skill_target(root, home_path)
        except SkillPackageError:
            continue
        if not root.is_dir() or _skill_link_like(root):
            continue
        try:
            children = sorted(root.iterdir(), key=lambda p: p.name.casefold())
        except OSError:
            continue
        for child in children:
            if not child.is_dir():
                continue
            skill_file = child / "SKILL.md"
            linked = _skill_link_like(child) or _skill_link_like(skill_file)
            if not skill_file.is_file():
                continue
            text = ""
            raw = b""
            if not linked:
                try:
                    with skill_file.open("rb") as stream:
                        raw = stream.read(65536)
                    text = raw.decode("utf-8-sig", errors="strict")
                except (OSError, UnicodeError):
                    text = ""
            fm = rules._frontmatter(text) if text else {}
            name = (fm.get("name") or child.name).strip()
            description = fm.get("description", "").strip()[:600]
            key = name.casefold()
            try:
                digest = None if linked else _skill_digest(_read_installed_skill_dir(child))
            except SkillPackageError:
                digest = None
            rec = grouped.setdefault(key, {"name": name, "description": description,
                                            "source": target, "installedTargets": [],
                                            "digests": {}, "folders": {},
                                            "digestUnavailable": []})
            rec["installedTargets"].append(target)
            rec["digests"][target] = digest
            rec["folders"][target] = child.name
            if digest is None:
                rec["digestUnavailable"].append(target)
            if not rec["description"] and description:
                rec["description"] = description
            target_counts[target] += 1
    compatible = list(SKILL_IMPORT_TARGETS)
    skills = []
    for rec in grouped.values():
        digests = rec.pop("digests")
        rec.pop("folders")
        first_digest = next((digest for digest in digests.values() if digest is not None), None)
        rec["targets"] = compatible
        rec["conflicts"] = [
            {"target": target, "reason": "技能完整內容與主要來源不同"}
            for target, digest in digests.items()
            if first_digest is not None and digest is not None and digest != first_digest
        ]
        skills.append(rec)
    target_info = []
    for target, meta in SKILL_TARGETS.items():
        root = roots[target]
        read_only = target == "governance"
        try:
            _assert_safe_skill_target(root, home_path)
            available = (not read_only) and (
                (not root.exists()) or (root.is_dir() and not _skill_link_like(root)))
        except SkillPackageError:
            available = False
        target_info.append({
            "id": target,
            "label": meta["label"],
            "root": _relative_skill_root(target),
            "installedCount": target_counts[target],
            "ready": root.is_dir() and available,
            "readOnly": read_only,
            # 目錄尚未建立時匯入會建立它；若路徑經過 symlink/junction
            # 或被非目錄佔用，則一律回報不可用。
            "available": available,
        })
    return {"skills": sorted(skills, key=lambda s: s["name"].casefold()),
            "targets": target_info}

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
    "kimi": ["~/.kimi-code/bin/kimi.exe", "%LOCALAPPDATA%/Programs/kimi/kimi.exe", "~/.local/bin/kimi"],
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


def _tasklist_run(*, timeout: int):
    """Windows ``tasklist`` 跟著系統 ANSI code page 輸出。

    測試以 ``python -X utf8`` 執行時，單用 ``text=True`` 會誤拿 UTF-8
    解讀 CP950，reader thread 被中文行程名擊潰後 stdout 變空，
    存活中的派工就會被當成已結束。``mbcs`` 明確跟 Windows ANSI
    code page 對齊；其他平台不會走 tasklist。
    """
    return _run(
        ["tasklist", "/fo", "csv", "/nh"], capture_output=True, text=True,
        encoding="mbcs" if os.name == "nt" else None, errors="replace",
        timeout=timeout,
    )


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
        r = _tasklist_run(timeout=15)
        for line in r.stdout.splitlines():
            parts = [p.strip('"') for p in line.split('","')]
            if len(parts) > 1 and parts[1].strip().isdigit():
                alive.add(int(parts[1].strip()))
    except Exception:
        return set()
    _ALIVE_CACHE["at"] = now
    _ALIVE_CACHE["pids"] = alive
    return {p for p in pids if p in alive}

def _kill_tree(pid: int) -> None:
    """連子行程一起停：CLI 底下還掛著 node／git，只殺頂層會留孤兒繼續改檔。"""
    pid = int(pid)
    if os.name == "nt":
        script = ('function KT($p){ Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" '
                  '| ForEach-Object { KT $_.ProcessId }; '
                  'Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; '
                  f'KT {pid}')
        try:
            subprocess.run(["powershell", "-NoProfile", "-Command", script],
                           capture_output=True, timeout=30, **_NO_WINDOW)
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    # 存活快取三秒內還會說它活著；停掉的當下就拿掉，畫面不用等下一次快照
    try:
        _ALIVE_CACHE["pids"].discard(pid)
    except (AttributeError, KeyError):
        pass


# ── PID 被回收的假存活 ─────────────────────────────────
#
# 實際案例（2026-09-03）：08-26 派出的一筆 claude 派工，八天後畫面還顯示
# 「執行中」。查下去 pid 4588 現在是 tailscale-ipn.exe —— 原本的行程早就
# 結束，Windows 把同一個號碼發給了別人，而 _alive_pids 只問「這個 pid
# 存不存在」。序列派工的 worker 也會被它卡住：它等的那個 pid 永遠不會消失。
#
# 判斷依據是行程的建立時間：晚於派工開始時間的，就不是我們派的那個。
# 只對「開始超過 6 小時還宣稱活著」的紀錄查，不在每 8 秒的輪詢裡對每筆
# 開 PowerShell —— 那比假訊號本身更貴。答案依 pid 快取：
# 被回收的判定不會變回來；真的還活著的，tasklist 那一層本來就會處理它結束。
_RECYCLE_AFTER_SEC = 6 * 3600
# 負向答案（「這個 pid 還是原本那個」）只能信一小段時間。
# 第一版把第一次查到的建立時間永久快取 —— 稽核者（qwen）指出那正好讓防線失效：
# 只要第一次查詢發生在原行程還活著時（建立時間≈派工時間 → 判「沒回收」），
# 或落在原行程已死、號碼還沒被認領的空窗（查到 None），
# 之後這個號碼被誰拿走都永遠判「沒回收」。八天前的派工照樣顯示執行中，
# 而且是在「修好之後」。
_CREATED_TTL_SEC = 10 * 60
_CREATED_CACHE: dict = {}      # pid → (建立時間 epoch, 查詢時刻)
_CREATED_LOCK = threading.Lock()


def _proc_created_at(pid: int, now: float = None):
    """行程的建立時間（epoch 秒）。查不到回 None —— 查不到不等於死了。

    快取規則：查到的時間存 10 分鐘就重查；查不到（None）**不存**。
    回收是不可逆的，但「還沒被回收」隨時會變 —— 所以只有正向結論可以久留，
    而那個結論是 _recycled 自己算出來的，這裡只負責提供新鮮的建立時間。
    """
    if os.name != "nt":
        return None
    t = now if now is not None else time.time()
    with _CREATED_LOCK:
        hit = _CREATED_CACHE.get(pid)
        if hit is not None and t - hit[1] < _CREATED_TTL_SEC:
            return hit[0]
    got = None
    try:
        r = _run(["powershell", "-NoProfile", "-Command",
                  f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}')"
                  ".CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')"],
                 capture_output=True, text=True, encoding="utf-8",
                 errors="replace", timeout=20)
        s = (r.stdout or "").strip()
        if s:
            got = _dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ") \
                .replace(tzinfo=_dt.timezone.utc).timestamp()
    except Exception:
        got = None
    if got is not None:
        with _CREATED_LOCK:
            if len(_CREATED_CACHE) > 500:
                _CREATED_CACHE.clear()
            _CREATED_CACHE[pid] = (got, t)
    return got


def _stamp_epoch(stamp: str):
    """派工編號 YYYYMMDD-HHMMSS（本機時間）→ epoch 秒；認不出來回 None"""
    m = re.match(r"^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})", stamp or "")
    if not m:
        return None
    try:
        return _dt.datetime(*map(int, m.groups())).timestamp()
    except ValueError:
        return None


_RECYCLED_PIDS: dict = {}       # (pid, started) → True；回收是不可逆的，正向結論可以久留


def _recycled(pid: int, started: str, now: float = None, force: bool = False) -> bool:
    """這個 pid 是不是已經被發給別的行程了。

    只有在派工開始超過 _RECYCLE_AFTER_SEC 之後才會真的去查（force=True 例外：
    已經按過停止的那件，行程是我們自己殺的，pid 幾分鐘內就可能被發給別人 ——
    實測被殺掉的 agy 十五分鐘後那個號碼變成 tail.exe，畫面又寫回「執行中」）；
    查不到建立時間一律當作沒被回收 —— 寧可多顯示一會兒「執行中」，
    也不要把還在跑的工作判成結束（那是序列派工壞掉的直接原因）。

    只有「已被回收」這個結論會永久記住（同一個 pid 不可能又變回原本那個行程）；
    「還沒被回收」不記，交給 _proc_created_at 的短 TTL 定期重看。
    """
    t0 = _stamp_epoch(started)
    if t0 is None:
        return False
    t = now if now is not None else time.time()
    if not force and t - t0 < _RECYCLE_AFTER_SEC:
        return False
    key = (int(pid), started)
    if _RECYCLED_PIDS.get(key):
        return True
    created = _proc_created_at(pid, now=t)
    if created is None:
        return False
    # 派工開始之後 5 分鐘內建立的都算同一件（Popen 到行程真的跑起來有延遲）
    if created > t0 + 300:
        if len(_RECYCLED_PIDS) > 500:
            _RECYCLED_PIDS.clear()
        _RECYCLED_PIDS[key] = True
        return True
    return False


# ── 撞額度自動換人 ──────────────────────────────────────
#
# 使用者的原話（2026-08-24）：「派工要求程式自動化，我不想每次都消耗 token
# 在重複的指令上要求我持續派工」。而 2026-09-03 一天之內：codex 撞週額度、
# qwen 做到第四張撞週額度、cursor 開了終端沒人按 —— 三次都要人手動改派，
# 每一次都是把同一份工單再送一次。這件事程式自己做得到。
#
# 只在「原因是額度」時才自動換人：真正的程式錯誤換一個 AI 再跑一次多半一樣壞，
# 而且會白花另一份額度；BLOCKED 是規範擋的，換誰都該擋。
_QUOTA_ISSUE_RE = re.compile(
    r"quota|usage\s*limit|rate[\s_-]?limit|insufficient_quota|\b429\b|credits?\s+exhaust"
    r"|額度|限流", re.IGNORECASE)
# 最多接力兩次：三個工具都撞牆的話，問題不在工具，繼續換只是把額度燒光
_HANDOFF_MAX_HOPS = 2
# 終端工具（cursor）派出去多久沒人按 Enter 就算沒人接
_TERMINAL_STALL_SEC = 10 * 60
# 只接力「這個伺服器起來之後才派出」而且「六小時內」的紀錄。
#
# 第一版沒有這兩道門，上線第一次輪詢就把最近 30 筆裡所有「撞過額度」的舊紀錄
# 全部接力出去 —— 八天前的、昨天的、今天早上已經人工改派過的，一口氣六個 agy
# 同時跑六份舊工單。那不是接力，是重播歷史。
# 「伺服器啟動之後」這道門是精確的：只有它親眼看著失敗的才算在飛行中。
_HANDOFF_MAX_AGE_SEC = 6 * 3600
_SERVER_STARTED_AT = time.time()
# 一輪輪詢最多接力一件：同時撞牆的多件本來就該一件一件來（序列派工的理由相同），
# 而且一輪爆出去五六個行程沒有人看得住
_HANDOFF_PER_PASS = 1


def _is_quota_issue(issue: str) -> bool:
    return bool(issue) and bool(_QUOTA_ISSUE_RE.search(issue))


def _pick_handoff_tool(prev: str, chain: list, dispatch_tools, limited: set,
                       available=None) -> str | None:
    """沿接力鏈挑下一個：不是原工具、能無頭跑、有執行檔、沒限流。"""
    ok = available or _bin_available
    for t in chain:
        if t == prev or t not in dispatch_tools or t in limited:
            continue
        if not ok(t):
            continue
        return t
    return None


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
    # qwen（Token Plan）撞週額度時吐的那一行，實際長這樣（2026-09-03）：
    #   Quota exhausted: Your token-plan 1-week quota has been exhausted.
    #   The quota will reset at 09-07 02:01:00 UTC. … (cause: insufficient_quota: 429 …
    # 上面那條要求片語後最多 60 字就換行，這一行有一百多字，被尾巴上限擋掉；
    # 而「quota has been exhausted」中間隔了兩個字，`quota\s+exhaust` 也對不上。
    # 後果不只是畫面：狀態偵測共用這組樣式，qwen 沒被標成限流，
    # 派工路由繼續把工單送給它，每一張都「成功」地什麼都沒做。
    re.compile(r'(?im)^[ \t]*quota\s+exhausted\b[^\r\n]*$'),
    re.compile(r'(?i)\bquota\s+(?:has\s+been\s+|is\s+|was\s+)?exhausted\b[^"\r\n]{0,80}'),
    # 供應商的機器可讀代碼。不會出現在正常的人話裡，不必限制行首。
    re.compile(r'(?i)\binsufficient_quota\b[^"\r\n]{0,80}'),
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
# agy（ANTIGRAVITY）--output-format json 的結算（2026-09-03 實測）：
#   {"status":"SUCCESS","response":"…","usage":{"input_tokens":53182,"output_tokens":2307,
#    "thinking_tokens":1876,"cache_read_tokens":12238,"total_tokens":55489}}
# 文字模式什麼用量都不印，所以 agy 的派工改走 JSON 模式。
# 一定要釘住後面的 thinking_tokens：Claude CLI 的結算也有
# "usage":{"input_tokens":…,"output_tokens":…}，但它的金額與 modelUsage 已經算過了，
# 再認一次就是重複計費。
_AGY_USAGE_RE = re.compile(
    r'"usage"\s*:\s*\{[^{}]*?"input_tokens"\s*:\s*(\d+)[^{}]*?"output_tokens"\s*:\s*(\d+)'
    r'[^{}]*?"thinking_tokens"')

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
_AGY_USAGE_BYTES_RE = re.compile(
    br'"usage"\s*:\s*\{[^{}]*?"input_tokens"\s*:\s*(\d+)[^{}]*?"output_tokens"\s*:\s*(\d+)'
    br'[^{}]*?"thinking_tokens"')

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
    if result is None:
        result = record.get("response")        # agy --output-format json 把回覆放在這裡
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


def _display_log(text: str) -> str:
    """agy 的 JSON 結算拆開來給人看：回覆原文 + 一行用量。不是那種 JSON 就原樣回。

    改走 JSON 模式是為了拿到用量；代價本來是控制台裡看到一整坨跳脫過的 JSON。
    這裡把代價吃掉：使用者看到的還是回覆原文，多一行「多少 token、幾秒」。
    """
    s = text.strip()
    if not (s.startswith("{") and s.endswith("}")):
        return text
    try:
        rec = json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return text
    if not isinstance(rec, dict) or "status" not in rec \
            or not ("response" in rec or "error" in rec):
        return text
    parts = []
    if rec.get("response"):
        parts.append(str(rec["response"]).rstrip())
    if rec.get("error"):
        parts.append("⚠ " + str(rec["error"]).strip())
    meta = [f"status={rec.get('status')}"]
    usage = rec.get("usage") or {}
    if isinstance(usage, dict) and usage.get("input_tokens") is not None:
        try:
            meta.append(f"{int(usage.get('input_tokens') or 0):,} 進 / "
                        f"{int(usage.get('output_tokens') or 0):,} 出 token")
        except (TypeError, ValueError):
            pass
    if rec.get("duration_seconds") is not None:
        try:
            meta.append(f"{float(rec['duration_seconds']):.0f} 秒")
        except (TypeError, ValueError):
            pass
    parts.append("— agy：" + "，".join(meta))
    return "\n\n".join(parts)


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
    for match in _AGY_USAGE_RE.finditer(text):
        yield match.start(), match.end(), "usage", ("gemini", match.group(1), match.group(2))


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
    for match in _AGY_USAGE_BYTES_RE.finditer(data):
        yield (match.start(), match.end(), "usage",
               ("gemini", match.group(1).decode("ascii"), match.group(2).decode("ascii")))


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
    """讀出一份對話的訊息。回傳 [(role, text)]；讀壞時回 None。"""
    try:
        st = f.stat()
    except OSError:
        return None
    key = (str(f), st.st_mtime_ns, st.st_size)
    with _SEARCH_LOCK:
        hit = _SEARCH_CACHE.get(key)
        if hit is not None:
            return hit
    try:
        d = json.loads(f.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return None
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
        return {"ok": False, "code": "SEARCH_INDEX_UNAVAILABLE",
                "error": "對話內容索引尚未建立。", "q": q, "hits": [],
                "scanned": 0, "truncated": False}

    pat = re.compile(re.escape(q), re.I)
    needle = q.encode("utf-8")
    needle_lower = q.lower().encode("utf-8")
    hits, scanned, truncated, errors = [], 0, False, 0
    # 先看新的：找東西的人通常在找最近做過的事
    files = sorted(conv_dir.glob("*.json"),
                   key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    for f in files:
        scanned += 1
        try:
            raw = f.read_bytes()
        except OSError:
            errors += 1
            continue
        # bytes 粗篩：大部分檔案在這裡就被刷掉，不必解碼也不必跑正規表示式
        if needle not in raw and needle_lower not in raw.lower():
            continue
        messages = _conv_text(f)
        if messages is None:
            errors += 1
            continue
        snippets = []
        for role, text in messages:
            if role not in {"user", "assistant"}:
                continue
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
    if scanned and errors >= scanned:
        return {"ok": False, "code": "SEARCH_CONTENT_UNREADABLE",
                "error": "對話內容目前無法讀取。", "q": q, "hits": [],
                "scanned": scanned, "truncated": False, "errorCount": errors}
    return {"ok": True, "q": q, "hits": hits, "scanned": scanned,
            "truncated": truncated, "partial": errors > 0, "errorCount": errors}


def _conversation_source_health(index_data: dict, home: Path | None = None) -> list[dict]:
    """回報四個同步來源的可讀狀態；不把讀取失敗偽裝成 0 份。"""
    home_path = home or Path.home()
    conversations = index_data.get("conversations")
    if not isinstance(conversations, list):
        conversations = []
    rows = []
    for source, parts_list in CONVERSATION_SOURCE_ROOTS.items():
        count = sum(
            1 for item in conversations
            if isinstance(item, dict) and item.get("tool") == source
            and item.get("inApp") and not item.get("subagent") and not item.get("dup")
        )
        metadata_errors = sum(
            1 for item in conversations
            if isinstance(item, dict) and item.get("tool") == source
            and item.get("metadataErrors") and not item.get("trashed")
            and not item.get("archived") and not item.get("subagent") and not item.get("dup")
        )
        found = False
        probe_errors = []
        for parts in parts_list:
            root = home_path.joinpath(*parts)
            try:
                mode = root.stat().st_mode
                if stat.S_ISDIR(mode):
                    next(root.iterdir(), None)
                elif stat.S_ISREG(mode):
                    with root.open("rb") as stream:
                        head = stream.read(16)
                    if root.suffix.casefold() in {".sqlite", ".db"} \
                            and head != b"SQLite format 3\x00":
                        raise OSError("invalid sqlite header")
                else:
                    raise OSError("unsupported source node")
                found = True
            except FileNotFoundError:
                continue
            except OSError as exc:
                probe_errors.append(type(exc).__name__)

        if probe_errors:
            status = "error"
            reason = "對話來源無法讀取；原對話沒有被修改。"
        elif not found:
            status = "missing"
            reason = "找不到這個 AI 的對話資料夾。"
        elif metadata_errors:
            status = "warning" if count else "error"
            reason = "部分側欄資料無法確認。"
        elif count:
            status = "ok"
            reason = ""
        else:
            status = "empty"
            reason = "來源可讀，但尚未找到可在原 AI 開啟的主對話。"
        rows.append({"id": source, "label": CONVERSATION_SOURCE_LABELS[source],
                     "status": status, "count": count, "reason": reason,
                     "errorCount": len(probe_errors) or metadata_errors})
    return rows


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


def _bin_available(tool: str) -> bool:
    """BIN 的 fallback 工具名字串不等於已安裝；必須有真實檔案或 PATH 命中。"""
    import shutil
    value = BIN.get(tool, "")
    if not value:
        return False
    path = Path(value)
    if path.is_absolute() or path.parent != Path("."):
        return path.is_file()
    return shutil.which(value) is not None


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


def canonical_claude_session_id(cli_id: object) -> str:
    """回傳 Claude Desktop 使用的 canonical UUID。

    Desktop metadata 偶爾會把 UUID 寫成大寫或加上大括號；那仍是同一個
    session。其他任意字串則不可拿來掃卡片或當交易鎖的 key。
    """
    raw = str(cli_id or "").strip()
    if not raw:
        raise ValueError("Claude 對話 id 為空")
    try:
        return str(uuid.UUID(raw))
    except (ValueError, AttributeError, TypeError) as exc:
        raise ValueError("Claude 對話 id 不是有效 UUID") from exc


def _physical_file_identity(path: Path) -> tuple:
    """辨識同一實體檔案的 Win32／Store alias，不靠路徑字串猜測。"""
    st = path.stat()
    # Windows 的 Python 會把 NTFS file id 放在 st_ino。測不到 file id 的
    # 檔案系統才退回 real path；normcase 讓磁碟機代號大小寫不造成假副本。
    if st.st_ino:
        return ("inode", int(st.st_dev), int(st.st_ino))
    return ("path", os.path.normcase(os.path.realpath(path)))


def _claude_card_semantics(data: dict) -> dict:
    """只比較會影響控制台側欄呈現的欄位。"""
    return {
        "archived": bool(data.get("isArchived")),
        "title": str(data.get("title") or ""),
        "cwd": str(data.get("cwd") or data.get("originCwd") or ""),
    }


def discover_claude_desktop_cards(cli_id: object) -> dict:
    """找出一個 Claude session 的所有實體卡片與 metadata 衝突。

    相同 inode 的 Store／Win32 alias 只回傳一次；真正不同的卡片則全部
    保留。若這些卡片對側欄欄位的說法不一致，呼叫端會拿到明確的
    ``metadataConflict``，而不是由 rglob 順序偷偷決定哪一份算數。
    """
    canonical = canonical_claude_session_id(cli_id)
    seen: set[tuple] = set()
    records: list[tuple[Path, dict]] = []
    for root in _claude_desktop_session_roots():
        if not root.is_dir():
            continue
        for path in root.rglob("local_*.json"):
            try:
                d = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(d, dict):
                continue
            try:
                card_sid = canonical_claude_session_id(d.get("cliSessionId"))
            except ValueError:
                continue
            if card_sid != canonical:
                continue
            try:
                key = _physical_file_identity(path)
            except OSError:
                continue
            if key in seen:
                continue
            seen.add(key)
            records.append((path, d))

    records.sort(key=lambda row: os.path.normcase(os.path.abspath(row[0])))
    conflicts: dict[str, list[object]] = {}
    for field in ("archived", "title", "cwd"):
        values = {_claude_card_semantics(data)[field] for _, data in records}
        if len(values) > 1:
            conflicts[field] = sorted(values, key=lambda value: str(value))
    return {
        "sessionId": canonical,
        "cards": [path for path, _ in records],
        "metadataConflict": bool(conflicts),
        "conflicts": conflicts,
    }


def claude_desktop_cards(cli_id: object) -> list[Path]:
    """相容舊呼叫端：回傳已按實體檔案去重的 Claude Desktop 卡片。"""
    return discover_claude_desktop_cards(cli_id)["cards"]


_INDEX_LOCK = threading.RLock()
_CLAUDE_LOCKS_GUARD = threading.Lock()
_CLAUDE_SESSION_LOCKS: dict[str, threading.RLock] = {}


def _claude_session_lock(session_id: str) -> threading.RLock:
    """同一個 Claude session 的 archive/delete 必須序列化。"""
    with _CLAUDE_LOCKS_GUARD:
        return _CLAUDE_SESSION_LOCKS.setdefault(session_id, threading.RLock())


def _load_index_data() -> dict:
    data, _ = _load_index_snapshot()
    return data


def _load_index_snapshot() -> tuple[dict, bytes]:
    raw = INDEX_JSON.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("conversations"), list):
        raise ValueError("index.json 格式不合法")
    return data, raw


def _recompute_index_stats(data: dict) -> None:
    """由目前 conversations 重算所有可由列資料推出的 aggregate。"""
    conversations = data.get("conversations") or []
    stats = data.setdefault("stats", {})
    stats.update({
        "total": len(conversations),
        "subagent": sum(bool(c.get("subagent")) for c in conversations),
        "duplicates": sum(bool(c.get("dup")) for c in conversations),
        "archived": sum(bool(c.get("archived")) for c in conversations),
        "trashed": sum(bool(c.get("trashed")) for c in conversations),
        "dispatch": sum(
            bool(c.get("dispatch")) and not bool(c.get("subagent")) and not bool(c.get("dup"))
            for c in conversations
        ),
    })
    stats["unique"] = stats["total"] - stats["duplicates"]
    optional = {
        "pinned": "pinned",
        "inApp": "inApp",
        "metadataConflict": "metadataConflict",
    }
    for stat_name, field in optional.items():
        if stat_name in stats or any(field in c for c in conversations):
            stats[stat_name] = sum(bool(c.get(field)) for c in conversations)


def _duplicate_survivor_rank(entry: dict) -> tuple:
    """刪除正本後挑選新正本；排序必須穩定且偏好可用的桌面對話。"""
    tool_priority = {"codex": 0, "kimi": 1, "claude": 2,
                     "grok": 3, "cursor": 4, "qwen": 5}
    return (
        bool(entry.get("inApp")),
        not bool(entry.get("subagent")),
        bool(entry.get("hasMessages")),
        float(entry.get("mtime") or 0),
        -tool_priority.get(str(entry.get("tool") or ""), 9),
        str(entry.get("id") or ""),
    )


def _repair_orphan_duplicate_links(conversations: list[dict]) -> None:
    """刪除正本後，提升一個 survivor 並重建所有 dupCount。

    索引器會讓副本用 ``dupOf`` 指向正本。直接刪掉正本會留下不可達的
    副本，前端又預設隱藏 dup，結果整組像被刪光。這裡只修 orphan 群組，
    不重新判定原本彼此獨立的跨工具 active cards。
    """
    by_id = {str(c.get("id")): c for c in conversations if c.get("id")}
    orphan_groups: dict[str, list[dict]] = {}
    for entry in conversations:
        target = str(entry.get("dupOf") or "")
        if entry.get("dup") and target not in by_id:
            key = str(entry.get("sessionId") or f"missing:{target}")
            orphan_groups.setdefault(key, []).append(entry)

    for group in orphan_groups.values():
        promoted = max(group, key=_duplicate_survivor_rank)
        promoted.pop("dup", None)
        promoted.pop("dupOf", None)
        promoted.pop("dupOfTool", None)
        promoted.pop("dupCount", None)
        for survivor in group:
            if survivor is promoted:
                continue
            survivor["dup"] = True
            survivor["dupOf"] = promoted["id"]
            survivor["dupOfTool"] = promoted.get("toolLabel") or promoted.get("tool") or ""

    # 非副本不該殘留舊指標；所有正本的 dupCount 一律由目前連結重算。
    for entry in conversations:
        entry.pop("dupCount", None)
        if not entry.get("dup"):
            entry.pop("dup", None)
            entry.pop("dupOf", None)
            entry.pop("dupOfTool", None)

    by_id = {str(c.get("id")): c for c in conversations if c.get("id")}
    for entry in conversations:
        if not entry.get("dup"):
            continue
        canonical = by_id.get(str(entry.get("dupOf") or ""))
        if canonical is None:
            # 缺 sessionId 的異常資料仍 fail-open：提升它，不能讓 UI 永久隱藏。
            entry.pop("dup", None)
            entry.pop("dupOf", None)
            entry.pop("dupOfTool", None)
            continue
        canonical["dupCount"] = int(canonical.get("dupCount") or 0) + 1


def _stage_bytes(path: Path, payload: bytes) -> Path:
    """在目標同目錄建立唯一暫存檔，供 os.replace 原子換入。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(raw_tmp)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        return tmp
    except Exception:
        with contextlib.suppress(OSError):
            os.close(fd)
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise


def _replace_file(staged: Path, target: Path) -> None:
    os.replace(staged, target)


def _atomic_write_json(path: Path, data: dict) -> None:
    staged = _stage_bytes(
        path, json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
    )
    try:
        _replace_file(staged, path)
    finally:
        with contextlib.suppress(OSError):
            staged.unlink()


def _preflight_claude_cards(cards: list[Path], session_id: str) -> list[dict]:
    """在任何寫入前完整讀過所有卡片，並保留 rollback 所需原始 bytes。"""
    snapshots = []
    for card in cards:
        raw = card.read_bytes()
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError(f"Claude 卡片不是 JSON object：{card.name}")
        if canonical_claude_session_id(data.get("cliSessionId")) != session_id:
            raise ValueError(f"Claude 卡片在交易前已換成別的 session：{card.name}")
        if "isArchived" in data and not isinstance(data["isArchived"], bool):
            raise ValueError(f"Claude 卡片的 isArchived 不是布林值：{card.name}")
        snapshots.append({"path": card, "raw": raw, "data": data})
    return snapshots


def _rollback_replaced_files(snapshots: list[dict]) -> list[str]:
    failed: list[str] = []
    for snapshot in reversed(snapshots):
        path = snapshot["path"]
        try:
            _atomic_write_bytes(path, snapshot["raw"])
        except Exception:
            failed.append(str(path))
    return failed


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    staged = _stage_bytes(path, payload)
    try:
        _replace_file(staged, path)
    finally:
        with contextlib.suppress(OSError):
            staged.unlink()


def _set_index_archive_state(entry: dict, archived: bool) -> None:
    entry["archived"] = archived
    if archived:
        previous = str(entry.get("trashReason") or "")
        if previous and previous != "archived":
            entry["archivePreviousTrashReason"] = previous
        entry["trashed"] = True
        entry["trashReason"] = "archived"
        return

    # 解除封存只移除「因封存而進垃圾桶」的狀態；原本就是 stale、
    # not-in-app 等原因的仍然留在垃圾桶。
    if entry.get("trashReason") != "archived":
        return
    previous = str(entry.pop("archivePreviousTrashReason", "") or "")
    if (not previous and not entry.get("metadataOnly")
            and not entry.get("hasMessages", True)):
        previous = "no-messages"
    if not previous and entry.get("inApp") is False:
        previous = "not-in-app"
    entry["trashReason"] = previous
    entry["trashed"] = bool(previous)


def drop_index_conv(conv_id: str) -> bool:
    """原子移除索引列；失敗會往外拋，禁止回報假成功。"""
    # 鎖順序固定：process RLock → cross-process lock。refresh 只拿前者再
    # 等待會自行拿後者的 indexer child，因此不可反過來造成 ABBA deadlock。
    with _INDEX_LOCK, conversation_index_lock(timeout=60.0):
        data, original = _load_index_snapshot()
        try:
            _index_without_conversation(data, conv_id)
        except KeyError:
            return False
        if INDEX_JSON.read_bytes() != original:
            raise RuntimeError("index.json 在交易期間已變更")
        _atomic_write_json(INDEX_JSON, data)
        return True


def _move_path(source: Path, destination: Path) -> None:
    import shutil
    shutil.move(str(source), str(destination))


def _rollback_moves(moves: list[tuple[Path, Path]]) -> list[str]:
    """把已搬入控制台回收區的檔案盡力搬回原位。"""
    failed: list[str] = []
    for original, moved in reversed(moves):
        if not moved.exists():
            continue
        try:
            original.parent.mkdir(parents=True, exist_ok=True)
            _move_path(moved, original)
        except Exception:
            failed.append(str(original))
    return failed


def _index_without_conversation(data: dict, conv_id: str) -> dict:
    before = len(data["conversations"])
    data["conversations"] = [c for c in data["conversations"] if c.get("id") != conv_id]
    if len(data["conversations"]) == before:
        raise KeyError(conv_id)
    _repair_orphan_duplicate_links(data["conversations"])
    _recompute_index_stats(data)
    return data


def lms_installed_model_records():
    """磁碟上已安裝、而且路由表認得的模型（保留 lms 的精確大小）。

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
            size = None
        if size is not None and size > 0:
            if size < rule["min_gb"] * (1024 ** 3) * 0.9:
                continue
        elif not model_complete(key):
            # 舊版 lms 不一定回 sizeBytes；缺欄位時改用既有的磁碟門檻驗證，
            # 兩邊都驗不出完整檔案就 fail closed，不把半套模型放進白名單。
            continue
        seen.add(key)
        # 不用 min_gb 或檔案掃描值代填大小。RAM 准入只能相信 lms 回報的
        # sizeBytes；缺值仍可出現在「已安裝」清單，但冷載入會 fail closed。
        out.append({"modelKey": key, "sizeBytes": size if size and size > 0 else None})
    return out


def lms_installed_models():
    """相容既有 API：只回傳 lms 的 modelKey 原字串。"""
    return [r["modelKey"] for r in lms_installed_model_records()]


def lms_models():
    """可用的模型清單固定回傳磁碟上的完整 modelKey。

    /v1/models 回的是已載入實例的 identifier；它可能叫 ``copy-line``，
    不是可交給 ``lms load`` 的 modelKey。若把兩種名字混在同一個下拉選單，
    使用者選到的值會被後端白名單拒絕。因此這裡永遠以唯讀的 ``lms ls``
    為準；API 伺服器開沒開不再影響模型是否「存在」。
    """
    return lms_installed_models()


def _lms_ps_strict():
    """嚴格讀取已載入模型；任何未知狀態都往外拋。

    mutation 路徑不能把逾時、非零退出或壞 JSON 當成「目前沒載模型」，
    否則下一步冷載入就可能取代外來實例。唯讀 UI 可用下面的 fail-soft
    wrapper，但載入、卸載與清理一律用這個版本。
    """
    if not LMS_BIN.exists():
        raise RuntimeError(f"找不到 lms 執行檔（{LMS_BIN}）")
    try:
        r = _lms_run([str(LMS_BIN), "ps", "--json"], capture_output=True, timeout=15)
    except Exception as exc:
        raise RuntimeError(f"無法讀取 LM Studio 載入狀態：{exc}") from exc
    if r.returncode != 0:
        detail = ((r.stderr or r.stdout) or "").strip()[-300:]
        raise RuntimeError(f"無法讀取 LM Studio 載入狀態（rc={r.returncode}）："
                           f"{detail or 'lms ps 非零退出'}")
    raw = (r.stdout or "").strip()
    if not raw:
        raise RuntimeError("LM Studio 載入狀態為空白輸出，狀態未知")
    try:
        data = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("LM Studio 載入狀態不是合法 JSON，狀態未知") from exc
    if isinstance(data, dict):
        if isinstance(data.get("models"), list):
            data = data["models"]
        elif isinstance(data.get("data"), list):
            data = data["data"]
        else:
            raise RuntimeError("LM Studio 載入狀態格式未知（預期 model list）")
    if not isinstance(data, list):
        raise RuntimeError("LM Studio 載入狀態格式未知（預期 model list）")
    out = []
    for row in data:
        if not isinstance(row, dict):
            raise RuntimeError("LM Studio 載入狀態含非物件項目，狀態未知")
        model_key = row.get("modelKey")
        identifier = row.get("identifier")
        if not isinstance(model_key, str) or not model_key.strip():
            raise RuntimeError("LM Studio 載入實例缺少 modelKey，狀態未知")
        if not isinstance(identifier, str) or not identifier.strip():
            raise RuntimeError("LM Studio 載入實例缺少可驗證的 identifier，狀態未知")
        out.append(row)
    return out


def _lms_ps():
    """唯讀 UI 探測用的 fail-soft wrapper；mutation 不得使用。"""
    try:
        return _lms_ps_strict()
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
LMS_COLD_LOAD_TIMEOUT_S = 180
LMS_COLD_LOAD_OVERHEAD = 1.15
LMS_COLD_LOAD_RESERVE_GIB = 8.0
_GIB = 1024 ** 3
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


def available_physical_ram_bytes() -> int | None:
    """回傳作業系統目前可用的實體 RAM；測不到就回 None。

    Windows 直接問 GlobalMemoryStatusEx，不把總 RAM 或 swap 誤當成可冷載入
    的空間。Linux 等平台先讀 MemAvailable，再退到 POSIX sysconf。所有後備
    都是標準庫且唯讀；任何不明狀態由呼叫端 fail closed。
    """
    if os.name == "nt":
        try:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = MEMORYSTATUSEX()
            status.dwLength = ctypes.sizeof(status)
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GlobalMemoryStatusEx.argtypes = (ctypes.POINTER(MEMORYSTATUSEX),)
            kernel32.GlobalMemoryStatusEx.restype = ctypes.c_int
            if kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                available = int(status.ullAvailPhys)
                if available > 0:
                    return available
        except Exception:
            pass

    # Linux 的 MemAvailable 包含可回收 page cache，比 MemFree 更貼近「現在能
    # 給模型多少」。讀不到再試 POSIX 的 available physical pages。
    try:
        for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
            if line.startswith("MemAvailable:"):
                available = int(line.split()[1]) * 1024
                if available > 0:
                    return available
                break
    except (OSError, ValueError, IndexError):
        pass
    try:
        pages = int(os.sysconf("SC_AVPHYS_PAGES"))
        page_size = int(os.sysconf("SC_PAGE_SIZE"))
        available = pages * page_size
        return available if available > 0 else None
    except (AttributeError, OSError, TypeError, ValueError):
        return None


_RAM_AUTO = object()


def cold_load_admission(record: dict | None, available_bytes=_RAM_AUTO) -> dict:
    """判斷一個尚未載入的模型能否在目前 RAM 下安全冷載入。"""
    if available_bytes is _RAM_AUTO:
        available_bytes = available_physical_ram_bytes()
    try:
        available = int(available_bytes) if available_bytes is not None else None
    except (TypeError, ValueError):
        available = None
    if available is not None and available <= 0:
        available = None

    model = str((record or {}).get("modelKey") or "")
    try:
        size = int((record or {}).get("sizeBytes"))
    except (TypeError, ValueError):
        size = 0
    required = (math.ceil(size * LMS_COLD_LOAD_OVERHEAD
                          + LMS_COLD_LOAD_RESERVE_GIB * _GIB)
                if size > 0 else None)
    admitted = bool(required is not None and available is not None and available >= required)
    if required is None:
        reason = "lms 未回報 sizeBytes，冷載入准入失敗"
    elif available is None:
        reason = "無法取得目前可用實體記憶體，冷載入准入失敗"
    elif not admitted:
        reason = (f"可用實體記憶體 {available / _GIB:.2f} GiB，"
                  f"冷載入至少需要 {required / _GIB:.2f} GiB")
    else:
        reason = (f"可用實體記憶體 {available / _GIB:.2f} GiB，"
                  f"冷載入至少需要 {required / _GIB:.2f} GiB")
    return {
        "model": model,
        "model_size_bytes": size if size > 0 else None,
        "model_size_gib": round(size / _GIB, 2) if size > 0 else None,
        "available_ram_bytes": available,
        "available_ram_gib": round(available / _GIB, 2) if available is not None else None,
        "required_ram_bytes": required,
        "required_ram_gib": round(required / _GIB, 2) if required is not None else None,
        "admitted": admitted,
        "reason": reason,
    }


def _require_cold_load_admission(record: dict | None) -> dict:
    admission = cold_load_admission(record)
    if not admission["admitted"]:
        model = admission["model"] or "未知模型"
        raise RuntimeError(f"{model} 未通過 RAM 冷載入准入：{admission['reason']}；未嘗試載入")
    return admission


def _cleanup_owned_lms_load(identifier: str) -> str:
    """清理本次 cold load 的 owned identifier，並做嚴格事後 readback。"""
    before_error = ""
    try:
        before = _lms_ps_strict()
    except Exception as exc:
        before = None
        before_error = str(exc)
    if before is not None and not any(
            str(row.get("identifier") or "") == identifier for row in before):
        return (f"清理確認：嚴格 readback 已確認 owned 實例 {identifier} 不存在，"
                "未執行卸載")

    unload_error = ""
    try:
        result = _lms_run([str(LMS_BIN), "unload", identifier],
                          capture_output=True, timeout=60)
    except Exception as exc:
        result = None
        unload_error = f"lms unload 發生例外：{exc}"
    if result is not None and result.returncode != 0:
        detail = ((result.stderr or result.stdout) or "").strip()[-200:]
        unload_error = (f"lms unload rc={result.returncode}："
                        f"{detail or '非零退出'}")

    try:
        after = _lms_ps_strict()
    except Exception as exc:
        prefix = f"；清理前 readback 也失敗：{before_error}" if before_error else ""
        return (f"清理未驗證：owned 實例 {identifier} 的事後 readback 失敗：{exc}"
                f"{prefix}"
                + (f"；{unload_error}" if unload_error else ""))
    still_present = any(str(row.get("identifier") or "") == identifier for row in after)
    if unload_error:
        state = "且嚴格 readback 顯示仍存在" if still_present else "；嚴格 readback 顯示目前不存在"
        return f"清理失敗：owned 實例 {identifier} 的 {unload_error}{state}"
    if still_present:
        return (f"清理失敗：lms unload 回報成功，但嚴格 readback 顯示 owned 實例 "
                f"{identifier} 仍存在")
    return f"清理成功：已卸載 owned 實例 {identifier}，且嚴格 readback 已確認不存在"


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
    installed_records = lms_installed_model_records()
    installed = [record["modelKey"] for record in installed_records]
    if not installed:
        raise RuntimeError("lms ls 列不出任何已登錄的模型")
    if model not in installed:
        raise ValueError(f"模型不在本機已安裝清單內，拒絕載入：{str(model)[:80]!r}")
    record = next(record for record in installed_records if record["modelKey"] == model)

    with _lifecycle_lock():
        # 鎖外面看到的狀態可能已經過期（別的流程剛載完或剛卸載），重問一次
        loaded = _lms_ps_strict()
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
        # 要放在 gate/runtime/server 之前：RAM 明顯不足時不能先產生任何載入
        # 相關寫入。之後在真正 lms load 前還會再量一次，避免等待把關期間
        # 記憶體已被其他工作吃掉。
        _require_cold_load_admission(record)
        ok, note = _run_gate()
        if not ok:
            raise RuntimeError(f"地端把關未放行：{note}")

        _lms_runtime_select()
        _lms_server_start()
        ident = _owned_identifier(model)
        _require_cold_load_admission(record)
        try:
            # --ttl 300：閒置五分鐘自動釋放，不會讓這次對話永久佔住記憶體
            r = _lms_run([str(LMS_BIN), "load", model, "-y", "--gpu", "off",
                          "-c", "8192", "--ttl", "300", "--identifier", ident],
                         capture_output=True, timeout=LMS_COLD_LOAD_TIMEOUT_S)
        except Exception as e:
            cleanup = _cleanup_owned_lms_load(ident)
            raise RuntimeError(f"載入模型失敗：{e}；{cleanup}")
        if r.returncode != 0:
            cleanup = _cleanup_owned_lms_load(ident)
            raise RuntimeError("載入模型失敗："
                               + ((r.stderr or r.stdout) or "").strip()[-300:]
                               + f"；{cleanup}")

        ok, note = _run_gate("--post-load-identifier", ident)
        if not ok:
            cleanup = _cleanup_owned_lms_load(ident)
            raise RuntimeError(f"載入後把關未放行：{note}；{cleanup}")
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
        r = _tasklist_run(timeout=20)
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

    刻意不走 route_model()：拆解端只會呼叫已經可用的 API 模型，不負責
    冷載入；選擇順序仍與 ai-hub 的一般工作路由一致。

    但「有能力」要讓位給「已經載入」。lms_models() 列的是磁碟上有的，
    照偏好清單挑等於常常點到一個沒載入的 —— LM Studio 就得臨時載，
    這台機器載一個 27B 要好幾分鐘，而拆解的逾時是 120 秒。
    結果就是每一次拆解都逾時、每一次都退回「整句話原封不動派出去」。
    實測踩到：note 回「地端模型呼叫失敗：timed out」。
    所以先看 lms ps，已經載入的又夠格就直接用它。
    """
    available = [m for m in lms_models() if model_complete(m)]
    # 一般結構化工作依 ai-hub/ROUTER.md：3.6 → 4B。Kimi 只屬於
    # long 路徑，不再因為曾經跑得快就被一般拆解冷載入。
    capable = ("qwen3.6-35b", "qwen3.5-4b", "qwen3-coder-next", "qwen3.8-27b")
    loaded = [m for m in lms_loaded_keys() if m]
    for m in loaded:
        if any(c in m for c in capable):
            return m
    if loaded:
        return loaded[0]  # 有外來常駐模型時不另挑冷模型去互踢
    for want in capable:
        for m in available:
            if want in m:
                return m
    # 偏好清單全落空時，已載入的還是比要重新載的好
    return (loaded[0] if loaded else (available[0] if available else ""))


# 任務鏈以 ai-hub/ROUTER.md §5 為準；Kimi 僅在 long 路徑。
_CHAINS = {
    "coding": ["qwen3-coder-next", "qwen3.8-27b", "qwen3.6-35b", "qwen3.5-4b"],
    "long": ["kimi-linear-48b"],
    "general": ["qwen3.6-35b", "qwen3.5-4b"],
}


def chains_all():
    return _CHAINS


def chains_for(task: str):
    order = list(_CHAINS.get(task, []))
    if task != "general":
        order.extend(_CHAINS["general"])
    return list(dict.fromkeys(order))


def route_model(task: str = "general"):
    """依任務類型 + 系統狀態自動選模型，回傳 (model, reason, signals)"""
    records = lms_installed_model_records()
    available = [record["modelKey"] for record in records]
    loaded = lms_loaded_keys()          # 比對模型名，不是識別碼
    heavy = detect_heavy_job()
    available_ram = available_physical_ram_bytes()
    admissions = {
        record["modelKey"]: cold_load_admission(record, available_ram)
        for record in records if record["modelKey"] not in loaded
    }
    cold_available = [model for model in available
                      if model in loaded or admissions[model]["admitted"]]
    rejected = [admission for admission in admissions.values()
                if not admission["admitted"]]
    signals = {
        "loaded": loaded,
        "heavy_job": heavy,
        "available": len(available),
        "available_ram_bytes": available_ram,
        "available_ram_gib": round(available_ram / _GIB, 2) if available_ram else None,
        "cold_load_overhead": LMS_COLD_LOAD_OVERHEAD,
        "cold_load_reserve_gib": LMS_COLD_LOAD_RESERVE_GIB,
        "cold_admitted": [m for m, admission in admissions.items() if admission["admitted"]],
        "cold_rejected": rejected,
    }

    def pick(cands):
        for c in cands:
            for m in cold_available:
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
        if len(loaded) == 1:
            current = loaded[0]
            if current in available and any(c in current for c in chains_for(task)):
                return current, "沿用已載入的模型（避免冷載入與互踢）", signals
            if current in available:
                return current, "沿用目前唯一已載入的模型（不冷載入其他模型取代它）", signals
        names = "、".join(str(model) for model in loaded[:3])
        return "", f"LM Studio 已載入外來或混合模型（{names}），不會冷載入另一個模型取代它", signals

    # 2. 大型工作進行中且手上沒有現成模型 → 挑輕量的，避免搶資源
    if heavy:
        m = pick(["qwen3.5-4b"])
        if m:
            return m, f"偵測到大型工作進行中（{heavy}），自動改用輕量模型避免搶資源", signals

    # 3. 任務鏈；long 的 Kimi 若過不了 RAM，會自然接 general 的 3.6/4B。
    order = chains_for(task)
    m = pick(order)
    if m:
        note = next((x["note"] for x in MODEL_TABLE if x["match"] in m), "")
        skipped = []
        for want in order:
            if want in m:
                break
            skipped.extend(a for key, a in admissions.items()
                           if want in key and not a["admitted"])
        if skipped:
            first = skipped[0]
            return m, (f"RAM 准入排除 {first['model']}（{first['reason']}），"
                       f"改用 {m}（{note}）"), signals
        return m, f"依任務鏈選擇（{note}）", signals
    if cold_available:
        return cold_available[0], "僅存且通過 RAM 准入的可用模型", signals
    if rejected:
        return "", f"沒有模型通過 RAM 冷載入准入：{rejected[0]['reason']}", signals
    return "", "找不到可用模型（LM Studio 未啟動或無完整模型）", signals


def lms_chat_request_payload(model: str, messages: list, max_tokens: int = 1024) -> dict:
    """建立 `/api/chat` 第一發送給 LM Studio 的 payload。"""
    return {
        "model": model,
        "messages": [
            {"role": message.get("role", "user"),
             "content": str(message.get("content", ""))[:4000]}
            for message in messages[-14:]
            if isinstance(message, dict)
            and message.get("role") in ("user", "assistant", "system")
        ],
        "max_tokens": int(max_tokens),
        # 推理型 Qwen 的第一發若不關閉 reasoning，可能把 max_tokens 全耗在
        # reasoning_content 而 content 為空。權威路由規則要求第一發即關閉。
        "reasoning": "off",
    }


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
    # qwen（Token Plan）的寫法：「The quota will reset at 09-07 02:01:00 UTC.」
    # 沒有年份、帶秒、標 UTC。抓不到這個的後果：detect_rate_limits 找不到恢復時間
    # 就不標限流（它刻意這樣設計），於是 qwen 撞了週額度還是一直被派工，
    # 每一張都「成功」地什麼都沒做 —— 2026-09-03 實際發生。
    r"|\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:UTC|GMT|Z)?"
    r"|\d{1,2}:\d{2}\s*(?:AM|PM))",
    re.IGNORECASE)

_RESET_FORMATS = ("%b %d, %Y %I:%M %p", "%B %d, %Y %I:%M %p",
                  "%b %d %Y %I:%M %p", "%B %d %Y %I:%M %p",
                  "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M")


def _fmt_reset(raw: str) -> str:
    """把工具吐出的時間字串正規化成 MM/DD HH:MM；解析不了就原樣回傳"""
    # 「09-07 02:01:00 UTC」：沒年份、帶秒、UTC。年份補現在的（跨年由 _parse_reset 處理），
    # 時區要換成本地 —— 直接拿 02:01 當本地時間會早八小時解鎖，工單又會送進牆裡。
    # 這段要放在底下 replace("T", " ") 之前：那一行是為了拆 ISO 的 2026-09-07T02:01，
    # 但它會把 "UTC" 打成 "U C"，這裡就對不上了（第一版就是這樣失敗的）。
    m = re.fullmatch(r"(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(UTC|GMT|Z)?",
                     raw.strip().rstrip("."), re.IGNORECASE)
    if m:
        try:
            when = _dt.datetime(_dt.datetime.now().year, int(m.group(1)), int(m.group(2)),
                                int(m.group(3)), int(m.group(4)))
            if m.group(5):
                when = when.replace(tzinfo=_dt.timezone.utc).astimezone().replace(tzinfo=None)
            return when.strftime("%m/%d %H:%M")
        except ValueError:
            pass
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
        if exe and _bin_available(key):
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
        self._body_error = None
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            self._body_error = ("INVALID_CONTENT_LENGTH", "Content-Length 無效。", 400)
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
            self._body_error = ("REQUEST_TOO_LARGE", "JSON 請求超過 2 MiB 上限。", 413)
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            self._body_error = ("INVALID_JSON", "無法讀取 JSON，請重新選擇檔案。", 400)
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
                if not path or not _bin_available(name):
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
            text = _display_log(chr(10).join(lines).strip())
            return self._json({"ok": True, "text": text[-8000:], "path": str(f),
                               "task": rec.get("task", "")})

        if self.path == "/api/map":
            return self.do_map()
        if self.path == "/api/skills":
            inventory = _installed_skill_inventory()
            return self._json({
                "ok": True,
                "status": "ready",
                **inventory,
                "limits": {
                    "archiveBytes": MAX_SKILL_ARCHIVE_BYTES,
                    "unpackedBytes": MAX_SKILL_UNPACKED_BYTES,
                    "fileBytes": MAX_SKILL_FILE_BYTES,
                    "files": MAX_SKILL_FILES,
                    "maxArchiveBytes": MAX_SKILL_ARCHIVE_BYTES,
                    "maxTotalBytes": MAX_SKILL_UNPACKED_BYTES,
                    "maxFileBytes": MAX_SKILL_FILE_BYTES,
                    "maxFiles": MAX_SKILL_FILES,
                },
                "privacy": "只掃描 SKILL.md 與技能資料夾；不讀取帳號、憑證或 token。",
            })
        if self.path == "/api/dispatch/batch":
            return self._json({"ok": True, **type(self).BATCH})
        if self.path == "/api/schedules":
            return self._json({"ok": True, "jobs": [
                {**j, "desc": schedule.describe(j)} for j in schedule.load()]})
        if self.path == "/api/dispatches":
            return self.do_dispatches()
        if self.path == "/api/dispatch/usage":
            return self.do_dispatch_usage()
        if self.path == "/api/remote":
            # 含完整配對網址（token 在 # 後面，不會進任何伺服器日誌）。只給同源的桌面頁面。
            if not self._same_origin():
                return self._json({"ok": False, "error": "跨來源請求已拒絕"}, 403)
            return self._json(_remote_status())
        if self.path == "/api/dispatch/tools":
            return self.do_dispatch_tools()
        if self.path.split("?", 1)[0] == "/api/search":
            if not self._same_origin():
                return self._json({"ok": False, "error": "跨來源請求已拒絕"}, 403)
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            result = _search_conversations((q.get("q") or [""])[0])
            return self._json(result, 200 if result.get("ok") else 503)
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
            # 手機遙控頁住在 /m/，而 vite 的 base 是 './'：index.html 引用 ./assets/…，
            # 從 /m/ 開就變成 /m/assets/…。dist/m/ 底下沒有的檔，退一層到 dist/ 去找；
            # 不然會退回 index.html（text/html），瀏覽器拒絕把它當模組執行，手機頁一片白。
            if rel.startswith("m/") and not f.is_file() and (DIST_DIR / rel[2:]).is_file():
                f = DIST_DIR / rel[2:]
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
                # 同進程的 archive/delete 先結束，才啟動 indexer。父進程不能
                # 再拿 cross-process lock：child 會在整個 build 期間自行持有它。
                with _INDEX_LOCK:
                    r = _run([sys.executable, str(INDEXER)], capture_output=True,
                             text=True, timeout=300, cwd=str(APP_ROOT))
                if r.returncode != 0:
                    return self._json({"ok": False, "error": "對話同步失敗。",
                                       "out": (r.stdout or r.stderr)[-500:]}, 500)
                try:
                    index_data = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as exc:
                    return self._json({"ok": False,
                                       "error": f"同步完成，但新索引無法讀取：{exc}"}, 500)
                return self._json({"ok": True, "out": (r.stdout or r.stderr)[-500:],
                                   "sources": _conversation_source_health(index_data)})
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
                # 中文路徑那一行才讀得對（實測 C:\\Users\\<你>\\Documents\\燒雞 可以進去）。
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
                payload = json.dumps(
                    lms_chat_request_payload(
                        resolved, messages, body.get("max_tokens", 1024)),
                    ensure_ascii=False,
                ).encode("utf-8")
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

        if self.path == "/api/skills/preview":
            return self.do_skills_preview()
        if self.path == "/api/skills/import":
            return self.do_skills_import()

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
        if self.path == "/api/dispatch/stop":
            return self.do_dispatch_stop()
        if self.path == "/api/remote/enable":
            return self._json(_remote_start())
        if self.path == "/api/remote/disable":
            return self._json(_remote_stop(forget=True))
        if self.path == "/api/remote/rotate":
            # 換一把新 token：舊的手機從此連不上，要重新掃 QR
            _remote_stop(forget=True)
            return self._json(_remote_start(secrets.token_urlsafe(24)))
        if self.path == "/api/dispatch/retry":
            return self.do_dispatch_retry()
        if self.path == "/api/dispatch":
            return self.do_dispatch()

        return self._json({"ok": False, "error": "not found"}, 404)

    def _skill_error(self, exc: SkillPackageError):
        payload = {"ok": False,
                   "status": "conflict" if exc.status == 409 else "invalid",
                   "code": exc.code, "error": str(exc), "help": exc.help}
        payload.update(exc.details)
        return self._json(payload, exc.status)

    def do_skills_preview(self):
        try:
            body = self._body()
            if getattr(self, "_body_error", None):
                code, message, status = self._body_error
                raise SkillPackageError(code, message, status)
            package = _skill_package(body)
            targets = _skill_target_states(package)
            has_existing = any(t["status"] != "available" for t in targets)
            return self._json({
                "ok": True,
                "status": "conflict" if has_existing else "ready",
                "skill": _skill_summary(package),
                "targets": targets,
                "choices": _skill_choices() if has_existing else [],
                "notice": "預覽不會寫入檔案，也不會執行技能裡的程式。",
            })
        except SkillPackageError as exc:
            return self._skill_error(exc)

    def do_skills_import(self):
        body = self._body()
        try:
            if getattr(self, "_body_error", None):
                code, message, status = self._body_error
                raise SkillPackageError(code, message, status)
            package = _skill_package(body)
            results = _install_skill(package, body.get("targets"))
            return self._json({"ok": True, "status": "installed",
                               "skill": _skill_summary(package),
                               "results": results,
                               "notice": "技能已安全匯入；未執行其中任何程式。"}, 201)
        except SkillPackageError as exc:
            return self._skill_error(exc)

    # ── 中控台對接總覽：工具 / 瀏覽器能力 / 技能 / 設定是否存在 ──
    def do_map(self):
        H = Path.home()

        def names(root: Path) -> list[str]:
            try:
                _assert_safe_skill_target(root, H)
            except SkillPackageError:
                return []
            if not root.is_dir() or _skill_link_like(root):
                return []
            try:
                return sorted((p.name for p in root.iterdir()
                               if p.is_dir() and not _skill_link_like(p)), key=str.casefold)
            except OSError:
                return []

        def settings(*items: tuple[str, str]) -> list[dict]:
            return [{"label": label, "exists": (H / rel).is_file()}
                    for label, rel in items]

        roots = _skill_roots(H)
        specs = {
            "claude": {"browser": "未連接瀏覽器", "settings":
                       settings(("settings.json", ".claude/settings.json"),
                                ("CLAUDE.md", ".claude/CLAUDE.md"))},
            "codex": {"browser": "內建瀏覽器能力", "settings":
                      settings(("config.toml", ".codex/config.toml"),
                               ("AGENTS.md", ".codex/AGENTS.md"))},
            "grok": {"browser": "未連接瀏覽器", "settings":
                     settings(("autonomy.json", ".grok/autonomy.json"))},
            "gemini": {"browser": "未連接瀏覽器", "settings":
                       settings(("settings.json", ".gemini/settings.json"))},
            "qwen": {"browser": "未連接瀏覽器", "settings":
                     settings(("QWEN.md", ".qwen/QWEN.md"),
                              ("output-language.md", ".qwen/output-language.md"))},
            "kimi": {"browser": "可由桌面應用連接瀏覽器", "settings":
                     settings(("config.toml", ".kimi-code/config.toml"))},
            "cursor": {"browser": "未連接瀏覽器", "settings": []},
        }
        root_for_tool = {"claude": roots["claude"], "codex": roots["codex"],
                         "grok": roots["grok"], "qwen": roots["qwen"],
                         "kimi": roots["kimi"]}
        out = {}
        for tool, spec in specs.items():
            out[tool] = {
                "installed": _bin_available(tool),
                "browser": spec["browser"],
                "skills": names(root_for_tool[tool]) if tool in root_for_tool else [],
                "settings": spec["settings"],
            }
        out["_governance"] = {"installed": roots["governance"].is_dir(),
                              "skills": names(roots["governance"]), "settings": []}
        return self._json({
            "ok": True,
            "status": "ready",
            "privacy": "只檢查工具、技能目錄與設定檔是否存在；未讀取帳號、auth、token 或憑證內容。",
            "map": out,
        })
    DISPATCH_TOOLS = {  # tool → argv 模板；直接執行（.cmd 經 cmd /c）
        "claude": lambda task: [BIN["claude"], "-p", task],
        # ANTIGRAVITY（agy）：--print 單次非互動。實測（2026-09-03）三種旗標：
        #   不帶旗標 / --mode accept-edits → status SUCCESS 但一個檔都不寫
        #   --dangerously-skip-permissions   → 真的建了檔（53 秒、9 萬 input token）
        # 所以只有最後那種才算「派工」。b98f6cb 曾把它拿掉（怕繞過治理），
        # 但治理前置是 rules.wrap 寫進每一張工單的，跟工具無關；
        # 使用者明說「AGY 這種傻的可以先用」——它走獨立額度池，放在接力鏈最前面。
        "gemini": lambda task: [BIN["gemini"], "--dangerously-skip-permissions", "--output-format", "json", "-p", task],
        "codex": lambda task: [BIN["codex"], "exec", "--skip-git-repo-check", task],
        "qwen": lambda task: ["cmd", "/c", BIN["qwen"], "-p", task],
        # kimi 的 -p 不能與 --yolo/--auto 併用（會直接 error 退出）；
        # -p 模式本身就無人值守執行工具（實測含寫檔），也不需要 console。
        "kimi": lambda task: [BIN["kimi"], "-p", task],
        # grok 的 -p 是單回合無頭模式；沒有 --always-approve 的話，
        # 工具呼叫會停在等核准 —— 而無頭模式裡沒有人可以按。
        "grok": lambda task: [BIN["grok"], "--always-approve", "-p", task],
    }
    # 續談：對同一段對話再補一句。無人值守的工具都有這個能力，
    # 所以「工作中介入告知」不用改成互動模式也做得到。
    FOLLOWUP_TOOLS = {
        "claude": lambda p: [BIN["claude"], "--continue", "-p", p],
        # agy 的 -c 是「接續最近一段對話」；跟 kimi/grok 一樣要回到原 cwd 才接得對
        "gemini": lambda p: [BIN["gemini"], "--dangerously-skip-permissions", "--output-format", "json", "-c", "-p", p],
        "codex": lambda p: [BIN["codex"], "exec", "resume", "--last",
                            "--skip-git-repo-check", p],
        # 不要用 cmd /c。qwen 是 npm 的 .CMD 包裝殼，經過 cmd.exe 的話
        # 使用者補的那句話會被動三次手腳（實測矩陣）：
        #   · 遇到雙引號就把後面整段截掉 —— 「改用 "tools/" 那份」只送出前半
        #   · %VAR% 被展開 —— %CD% 變成本機絕對路徑，跟著送進雲端模型
        #   · 含換行就整個不執行 —— 貼一段錯誤訊息會靜默失敗
        # 直接給 argv，跟無頭派工那條走一樣的路。
        "qwen": lambda p: [BIN["qwen"], "-c", "-p", p],
        # kimi/grok 的 -c 都是「這個工作目錄的上一段對話」——
        # 續談必須回到原派工的 cwd（_send_followup 會帶），不然接錯段。
        "kimi": lambda p: [BIN["kimi"], "-c", "-p", p],
        "grok": lambda p: [BIN["grok"], "--always-approve", "-c", "-p", p],
    }
    # 只會開一個可見終端、把指令帶進去、然後等人按 Enter 的工具。
    # 對「派工」來說這個差別是致命的：派出去之後沒有人按，
    # 那件事就永遠停在原地，而畫面上它看起來已經派出去了。
    # kimi（0.36 起 -p）與 grok（--always-approve -p）已實測可無頭執行工具，
    # 移進 DISPATCH_TOOLS；cursor 的 agent 子命令尚未驗證無頭旗標，先留在這裡。
    TERMINAL_TOOLS = {"cursor"}
    # agy/Gemini：2026-09-03 起可無頭派工（見 DISPATCH_TOOLS 的說明），接力鏈排第一。
    KNOWN_TOOLS = set(DISPATCH_TOOLS) | TERMINAL_TOOLS | {"local", "auto"}
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
    #
    # kimi／grok 轉無頭之後補進鏈尾：兩者額度都寬（ai-hub/ROUTER.md），
    # 正好接住「前面的都限流」的那天；grok 排最後，把它的額度留給
    # 圖片影片主力的角色，不要被文字工單先吃掉。
    # 接力順序＝省錢順序。使用者定的規則（2026-09-03）：
    #   「Claude／Codex 是主要派工平台，優先使用其他 AI 工作，AGY 這種傻的可以先用」
    # 跟 ROUTER.md 的分級一致：T1 agy／qwen（獨立額度池、免費兜底）、
    # T2 kimi／grok（額度寬）、T3 codex／claude（週額度，多次撞線）。
    # 原本 claude 排第一 —— 自動接力會先燒最稀缺的那份額度，正好相反。
    # grok 排在 kimi 後面：它的額度留給圖片影片主力的角色，不要被文字工單先吃掉。
    CLOUD_CHAIN = ["gemini", "qwen", "kimi", "grok", "codex", "claude"]
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
        """把可安全處理的對話來源與桌面卡當成同一筆交易移到回收區。"""
        body = self._body()
        conv_id = str(body.get("id", "")).strip()
        if not conv_id:
            return self._json({"ok": False, "error": "需要 id"}, 400)
        try:
            conv = find_conv(conv_id)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            return self._json({"ok": False, "error": f"讀取索引失敗：{exc}"}, 500)
        if not conv:
            return self._json({"ok": False, "error": "找不到這個對話"}, 404)

        tool = str(conv.get("tool") or "")
        # 這三家還有 DB/catalog/state/archive 等權威側欄 metadata。只搬 jsonl
        # 會在下次掃描復活，甚至留下半份對話；控制台不直接改它們的內部狀態。
        if tool in {"codex", "qwen", "kimi"}:
            return self._json({
                "ok": False,
                "error": f"{tool} 對話含來源應用的權威側欄狀態，請在來源應用中刪除",
                "sourceAppRequired": True,
            }, 409)

        session_id = ""
        lookup = {"cards": [], "metadataConflict": False, "conflicts": {}}
        if tool == "claude":
            try:
                session_id = canonical_claude_session_id(conv.get("sessionId"))
            except ValueError as exc:
                return self._json({"ok": False, "error": str(exc)}, 400)

        lock = _claude_session_lock(session_id) if session_id else contextlib.nullcontext()
        transaction_locks = contextlib.ExitStack()
        try:
            transaction_locks.enter_context(lock)
            transaction_locks.enter_context(_INDEX_LOCK)
            transaction_locks.enter_context(conversation_index_lock(timeout=60.0))
        except TimeoutError:
            transaction_locks.close()
            return self._json({
                "ok": False, "error": "對話索引正在由其他程序更新，請稍後重試",
                "busy": True,
            }, 409)
        except OSError as exc:
            transaction_locks.close()
            return self._json({"ok": False, "error": f"無法取得對話索引鎖：{exc}"}, 500)
        with transaction_locks:
            if tool == "claude":
                lookup = discover_claude_desktop_cards(session_id)
                if lookup["metadataConflict"]:
                    return self._json({
                        "ok": False,
                        "error": "Claude Desktop 的多份側欄卡 metadata 不一致，已停止刪除",
                        "metadataConflict": True,
                        "conflicts": lookup["conflicts"],
                    }, 409)
                try:
                    card_snapshots = _preflight_claude_cards(lookup["cards"], session_id)
                except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                    return self._json({"ok": False, "error": f"Claude 卡片預檢失敗：{exc}"}, 409)
            else:
                card_snapshots = []

            raw_source = str(conv.get("path") or "").strip()
            source = Path(raw_source) if raw_source else None
            had_source = bool(source is not None and source.exists())
            home = Path.home().resolve()
            targets: list[Path] = []
            if source is not None and source.exists():
                try:
                    resolved = source.resolve()
                    if not resolved.is_relative_to(home):
                        return self._json({"ok": False, "error": "路徑不在家目錄內，拒絕"}, 400)
                    if not resolved.is_file():
                        return self._json({"ok": False, "error": "來源不是一般檔案，拒絕"}, 400)
                except (OSError, ValueError):
                    return self._json({"ok": False, "error": "路徑無法解析"}, 400)
                targets.append(source)

            targets.extend(snapshot["path"] for snapshot in card_snapshots)
            unique_targets: list[Path] = []
            seen_targets: set[tuple] = set()
            for target in targets:
                try:
                    if not target.resolve().is_relative_to(home):
                        return self._json({"ok": False, "error": "卡片路徑不在家目錄內，拒絕"}, 400)
                    identity = _physical_file_identity(target)
                except (OSError, ValueError):
                    return self._json({"ok": False, "error": "來源在交易前消失"}, 409)
                if identity not in seen_targets:
                    seen_targets.add(identity)
                    unique_targets.append(target)

            # jsonl 已不在時仍可處理 card-only；兩者都沒有才是真正找不到。
            if not unique_targets:
                return self._json({"ok": False, "error": "來源檔與桌面板卡片都不存在"}, 404)

            with _INDEX_LOCK:
                try:
                    index_data, original_index = _load_index_snapshot()
                    fresh = next(
                        (entry for entry in index_data["conversations"]
                         if entry.get("id") == conv_id), None,
                    )
                    if fresh is None:
                        raise KeyError(conv_id)
                    if (str(fresh.get("tool") or "") != tool
                            or str(fresh.get("path") or "") != str(conv.get("path") or "")
                            or str(fresh.get("sessionId") or "") != str(conv.get("sessionId") or "")):
                        return self._json({
                            "ok": False, "error": "索引列在交易期間已變更，請重新整理後再試",
                        }, 409)
                    index_data = _index_without_conversation(index_data, conv_id)
                    index_stage = _stage_bytes(
                        INDEX_JSON,
                        json.dumps(index_data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                    )
                except KeyError:
                    return self._json({"ok": False, "error": "索引已變更，請重新整理後再試"}, 409)
                except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                    return self._json({"ok": False, "error": f"索引預檢失敗：{exc}"}, 500)

                moved: list[tuple[Path, Path]] = []
                destinations: list[str] = []
                try:
                    self.TRASH.mkdir(parents=True, exist_ok=True)
                    # 卡片在 preflight 後若被 Desktop 改過，就不再碰任何來源。
                    for snapshot in card_snapshots:
                        if snapshot["path"].read_bytes() != snapshot["raw"]:
                            raise RuntimeError(f"卡片在交易期間被修改：{snapshot['path'].name}")
                    stamp = time.strftime("%Y%m%d-%H%M%S")
                    for target in unique_targets:
                        destination = self.TRASH / (
                            f"{stamp}_{uuid.uuid4().hex[:10]}_{tool or 'x'}_{target.name}"
                        )
                        _move_path(target, destination)
                        moved.append((target, destination))
                        destinations.append(str(destination))
                    if INDEX_JSON.read_bytes() != original_index:
                        raise RuntimeError("索引在交易期間被其他程序更新")
                    _replace_file(index_stage, INDEX_JSON)
                except (OSError, RuntimeError) as exc:
                    rollback_failed = _rollback_moves(moved)
                    return self._json({
                        "ok": False,
                        "error": f"刪除交易失敗：{exc}",
                        "partial": bool(rollback_failed),
                        "rolledBack": not rollback_failed,
                        "rollbackFailed": rollback_failed,
                    }, 500)
                finally:
                    with contextlib.suppress(OSError):
                        index_stage.unlink()

        return self._json({
            "ok": True,
            "trash": destinations[0] if len(destinations) == 1 else destinations,
            "cardOnly": not had_source,
        })

    def do_conv_archive(self):
        """交易式同步 Claude Desktop 卡片與控制台索引的封存狀態。"""
        body = self._body()
        conv_id = str(body.get("id", "")).strip()
        if "archived" in body and not isinstance(body["archived"], bool):
            return self._json({"ok": False, "error": "archived 必須是布林值"}, 400)
        archived = body.get("archived", True)
        if not conv_id:
            return self._json({"ok": False, "error": "需要 id"}, 400)
        try:
            conv = find_conv(conv_id)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            return self._json({"ok": False, "error": f"讀取索引失敗：{exc}"}, 500)
        if not conv:
            return self._json({"ok": False, "error": "找不到這個對話"}, 404)
        if conv.get("tool") != "claude":
            return self._json({
                "ok": False,
                "error": "此來源有自己的權威封存狀態，請在來源應用中封存",
                "sourceAppRequired": True,
            }, 409)

        try:
            session_id = canonical_claude_session_id(conv.get("sessionId"))
        except ValueError as exc:
            return self._json({"ok": False, "error": str(exc)}, 400)

        transaction_locks = contextlib.ExitStack()
        try:
            transaction_locks.enter_context(_claude_session_lock(session_id))
            transaction_locks.enter_context(_INDEX_LOCK)
            transaction_locks.enter_context(conversation_index_lock(timeout=60.0))
        except TimeoutError:
            transaction_locks.close()
            return self._json({
                "ok": False, "error": "對話索引正在由其他程序更新，請稍後重試",
                "busy": True,
            }, 409)
        except OSError as exc:
            transaction_locks.close()
            return self._json({"ok": False, "error": f"無法取得對話索引鎖：{exc}"}, 500)
        with transaction_locks:
            lookup = discover_claude_desktop_cards(session_id)
            if not lookup["cards"]:
                return self._json({"ok": False, "error": "找不到桌面板對話卡"}, 404)
            if lookup["metadataConflict"]:
                return self._json({
                    "ok": False,
                    "error": "Claude Desktop 的多份側欄卡 metadata 不一致，已停止封存",
                    "metadataConflict": True,
                    "conflicts": lookup["conflicts"],
                }, 409)

            staged_cards: list[tuple[dict, Path]] = []
            index_stage: Path | None = None
            try:
                snapshots = _preflight_claude_cards(lookup["cards"], session_id)
                index_data, original_index = _load_index_snapshot()
                index_entry = next(
                    (entry for entry in index_data["conversations"] if entry.get("id") == conv_id),
                    None,
                )
                if index_entry is None:
                    return self._json({"ok": False, "error": "索引已變更，請重新整理後再試"}, 409)
                try:
                    fresh_session_id = canonical_claude_session_id(index_entry.get("sessionId"))
                except ValueError:
                    return self._json({"ok": False, "error": "索引裡的 Claude session id 已失效"}, 409)
                if index_entry.get("tool") != "claude" or fresh_session_id != session_id:
                    return self._json({
                        "ok": False, "error": "索引列在交易期間已變更，請重新整理後再試",
                    }, 409)
                _set_index_archive_state(index_entry, archived)
                _recompute_index_stats(index_data)

                for snapshot in snapshots:
                    updated = dict(snapshot["data"])
                    updated["cliSessionId"] = session_id
                    updated["isArchived"] = archived
                    payload = json.dumps(updated, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                    staged_cards.append((snapshot, _stage_bytes(snapshot["path"], payload)))
                index_stage = _stage_bytes(
                    INDEX_JSON,
                    json.dumps(index_data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                )
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                for _, staged in staged_cards:
                    with contextlib.suppress(OSError):
                        staged.unlink()
                if index_stage is not None:
                    with contextlib.suppress(OSError):
                        index_stage.unlink()
                return self._json({"ok": False, "error": f"封存預檢失敗：{exc}"}, 500)

            replaced: list[dict] = []
            try:
                for snapshot, staged in staged_cards:
                    if snapshot["path"].read_bytes() != snapshot["raw"]:
                        raise RuntimeError(f"卡片在交易期間被修改：{snapshot['path'].name}")
                    _replace_file(staged, snapshot["path"])
                    replaced.append(snapshot)
                # 只有所有卡片都成功後才換入索引；索引失敗也會把卡片回滾。
                if INDEX_JSON.read_bytes() != original_index:
                    raise RuntimeError("索引在交易期間被其他程序更新")
                assert index_stage is not None
                _replace_file(index_stage, INDEX_JSON)
            except (OSError, RuntimeError) as exc:
                rollback_failed = _rollback_replaced_files(replaced)
                return self._json({
                    "ok": False,
                    "error": f"封存交易失敗：{exc}",
                    "partial": bool(rollback_failed),
                    "rolledBack": not rollback_failed,
                    "rollbackFailed": rollback_failed,
                }, 500)
            finally:
                for _, staged in staged_cards:
                    with contextlib.suppress(OSError):
                        staged.unlink()
                if index_stage is not None:
                    with contextlib.suppress(OSError):
                        index_stage.unlink()

        return self._json({
            "ok": True,
            "cards": len(snapshots),
            "archived": archived,
            "sessionId": session_id,
        })

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
                  if t not in limited and (t == "local" or _bin_available(t))]
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
            tool = next((t for t in self.CLOUD_CHAIN
                         if t not in limited and _bin_available(t)), "local")
        elif tool in limited:
            alt = next((t for t in self.CLOUD_CHAIN
                        if t != tool and t not in limited
                        and t in self.DISPATCH_TOOLS and _bin_available(t)), None)
            if alt:
                rerouted = {"from": tool, "to": alt, "why": f"{tool} 的額度已經用完"}
                tool = alt
            else:
                return self._json({"ok": False, "error":
                                   f"{tool} 的額度已經用完，而其他工具現在也都不能用"
                                   "（限流或沒安裝）。等額度恢復，或改用地端"}, 503)

        if tool != "local" and not _bin_available(tool):
            return self._json({"ok": False, "error": f"{tool} 尚未安裝或執行檔不可用"}, 503)

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
                ], "max_tokens": 2048, "reasoning": "off"},
                    ensure_ascii=False).encode("utf-8")
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
        # 使用者按了停止而且行程真的死了：標「已停止」。
        # 不能因為 log 裡沒有失敗訊號就算完成 —— 2026-09-03 被殺掉的六個 agy 全顯示 done／ok。
        if d.get("stopped") and not alive:
            return "stopped"
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
            # claude/qwen/kimi/grok 的續談旗標都以工作目錄為界（--continue/-c
            # 是「這個目錄的上一段對話」）。派工時帶了 cwd 的，續談要回到
            # 同一個目錄，不然接上的是家目錄那段不相干的對話。
            proc = subprocess.Popen(
                make(prompt), cwd=d.get("cwd") or str(Path.home()), stdout=lf,
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

    def do_dispatch_stop(self):
        """停掉一件還在跑的無頭派工，並老實記成「已停止」。

        原本沒有這顆按鈕（見 do_dispatch_cancel：中途砍掉正在改檔案的 agent 很危險），
        結果真的要停的時候使用者只能開工作管理員殺行程 —— 登錄裡沒有任何記號，
        log 也沒有失敗訊號，被殺掉的那件從此顯示「已完成」。2026-09-03 接力事故
        就是這樣：六個被殺掉的 agy 全部標成 done／ok。
        危險還是危險，所以前端要先確認；但停了就要記下來。
        """
        body = self._body()
        did = str(body.get("id") or "").strip()
        with self._REG_LOCK:
            if not self.DISPATCHES:
                self._load_registry()
            rec = next((d for d in self.DISPATCHES if d.get("id") == did), None)
            if not rec:
                return self._json({"ok": False, "error": "找不到這筆派工"}, 404)
            if rec.get("stopped"):
                return self._json({"ok": True, "id": did, "already": True,
                                   "note": "這件先前已經停過了"})
            pid = int(rec.get("pid") or 0)
            if not pid or pid not in _alive_pids({pid}):
                return self._json({"ok": False, "error": "這件已經不在跑了，沒有東西可以停"}, 409)
            _kill_tree(pid)
            rec["stopped"] = time.strftime("%Y%m%d-%H%M%S")
            self._save_registry()
        return self._json({"ok": True, "id": did})

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
    TOOL_LABELS = {"claude": "Claude", "codex": "Codex", "gemini": "ANTIGRAVITY（agy）",
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
        # 原因也一起給。畫面上只寫「額度用完」而不說為什麼、什麼時候恢復，
        # 使用者對著頁尾「閒置」與下拉「額度用完」兩種說法無從判斷 ——
        # 稽核者（kimi）指出這一點。status.json 裡本來就有 reset_at 與 evidence，
        # 拿出來講就好；沒有的話前端會退回通用的「額度狀態無法確認」。
        reasons = self._tool_reasons(limited)
        out = self._tool_rows(limited, reasons)
        return self._json({"ok": True, "tools": out, "auto": self._auto_pick(limited),
                           "limited": sorted(limited)})

    def _tool_reasons(self, limited) -> dict:
        """限流工具各自的原因（恢復時間或證據字樣）。拿不到就空。"""
        reasons = {}
        try:
            _st = json.loads(STATUS_JSON.read_text(encoding="utf-8"))
            detect_rate_limits(_st)
            # 上游掃描器先標過的工具，detect_rate_limits 會跳過（已標就不再認），
            # 於是拿不到恢復時間。enrich_reset_times 會從派工 log 把時間補上 ——
            # 它同時也會清掉「找不到恢復時間」的旗標，那是畫面那層的語意，
            # 所以只在這份副本上跑，不影響 limited（路由）的判定。
            _shown = json.loads(json.dumps(_st))
            enrich_reset_times(_shown)
            for _k in limited:
                _v = (_shown.get("tools") or {}).get(_k) or (_st.get("tools") or {}).get(_k) or {}
                _raw = (_st.get("tools") or {}).get(_k) or {}
                if _v.get("reset_at"):
                    reasons[_k] = f"{_v['reset_at']} 恢復"
                elif _raw.get("evidence"):
                    reasons[_k] = str(_raw["evidence"]).split("：", 1)[-1][:60]
        except Exception:
            reasons = {}
        return reasons

    def _tool_rows(self, limited, reasons) -> list:
        """畫面上的工具列。順序照接力鏈（便宜的在前）：
        原本寫死 claude、codex 在前而且**根本沒有 gemini** —— 「自動」會挑到 agy，
        下拉卻選不到它，使用者看到「自動會挑 gemini」還以為畫面壞了。"""
        out = []
        for tool in [*self.CLOUD_CHAIN, *sorted(self.TERMINAL_TOOLS)]:
            if not _bin_available(tool):
                continue          # 這台機器上沒裝，不要列出來給人選
            out.append({
                "id": tool,
                "label": self.TOOL_LABELS.get(tool, tool),
                "mode": "terminal" if tool in self.TERMINAL_TOOLS else "headless",
                "limited": tool in limited,
                "reason": reasons.get(tool, ""),
            })
        out.append({"id": "local", "label": self.TOOL_LABELS["local"],
                    "mode": "local", "limited": False})
        return out

    def _auto_pick(self, limited) -> str:
        """auto 現在會挑到誰。畫面上直接寫出來，不要讓人猜。"""
        return next((t for t in self.CLOUD_CHAIN
                     if t not in limited and _bin_available(t)), "local")

    def do_dispatch_usage(self):
        """各工具的額度狀態 + 今日／七日用量，給「額度與今日用量」那條看。

        為什麼要有：2026-09-03 一天之內三次因為撞額度要人手動改派。使用者不缺
        「已經撞牆」的紅字，缺的是**派之前**就知道誰還有額度、今天已經燒了多少。
        成本不存在登錄裡，是從 log 掃出來的（_outcome_for 有快取，結束的 log 一輩子只掃一次）。
        """
        if not self.DISPATCHES:
            self._load_registry()
        limited = self._limited_tools()
        reasons = self._tool_reasons(limited)
        rows = self._tool_rows(limited, reasons)
        now = time.time()
        day = time.strftime("%Y%m%d", time.localtime(now))
        week_floor = now - 7 * 86400
        blank = lambda: {"jobs": 0, "ok": 0, "failed": 0, "stopped": 0, "in": 0, "out": 0, "usd": 0.0}
        today = {r["id"]: blank() for r in rows}
        week = {r["id"]: blank() for r in rows}
        recent = [d for d in self.DISPATCHES
                  if (_stamp_epoch(d.get("started", "")) or 0) >= week_floor]
        alive_pids = _alive_pids({int(d["pid"]) for d in recent if d.get("pid")})
        for d in recent:
            tool = d.get("tool") or ""
            if tool not in week:
                continue
            alive = (bool(d.get("pid")) and int(d["pid"]) in alive_pids
                     and not _recycled(int(d["pid"]), d.get("started", ""),
                                       force=bool(d.get("stopped"))))
            state = self._dispatch_state(dict(d), alive)
            cost = None
            log = Path(d.get("log") or "")
            if log.is_file():
                try:
                    size = log.stat().st_size
                except OSError:
                    size = 0
                got = _outcome_for(log, size, "")
                cost = got.get("cost")
                outcome = got.get("outcome")
            else:
                outcome = None
            buckets = [week[tool]]
            if str(d.get("started", "")).startswith(day):
                buckets.append(today[tool])
            for b in buckets:
                b["jobs"] += 1
                if state == "stopped":
                    b["stopped"] += 1
                elif state == "failed" or outcome == "error":
                    b["failed"] += 1
                elif state == "done" and outcome in ("ok", "no_changes"):
                    b["ok"] += 1
                if cost:
                    b["in"] += int(cost.get("in") or 0)
                    b["out"] += int(cost.get("out") or 0)
                    b["usd"] = round(b["usd"] + float(cost.get("usd") or 0), 6)
        for r in rows:
            r["today"] = today[r["id"]]
            r["week"] = week[r["id"]]
        return self._json({"ok": True, "day": time.strftime("%Y-%m-%d", time.localtime(now)),
                           "auto": self._auto_pick(limited), "tools": rows})

    def _handoff_order(self, target: dict, text: str, why: str) -> str:
        """把一件做到一半的工作，交接給另一個 AI。

        為什麼需要：「💬 補一句」是用各家的續談旗標（--continue / -c /
        resume --last）再派一次 —— **一定是原本那個 AI 執行**。
        它撞到額度上限的時候，這條路就斷了；而 cursor 這種只能開終端的工具
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
        # 只開終端的工具（cursor，以及舊紀錄裡還是終端模式的 kimi／grok）
        # 不會把產出寫進 log，檔案裡只有「啟動時回顯的那份工單」。
        # 判準用 rules 的控制標記，那是回顯才會有的東西，不是猜的。
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
        #   · 沒有續談模式（cursor 只能開終端，沒有無頭續談）
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
                         and _bin_available(t) and t not in limited), None)
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

    def _auto_handoff(self, rows: list) -> None:
        """撞額度或終端沒人按的派工，自動用同一份工單換下一個工具。

        跟 _flush_pending 同一個樣板：先在鎖裡「認領」（寫上 handedOffTo 佔位），
        放開鎖再送。不認領的話，主控台與辦公室兩個分頁每 8 秒各打一次
        /api/dispatches，同一件會被接力兩次 —— 兩個 agent 改同一批檔案。

        接力工單由 _handoff_order 組：帶原始工單、前一個做到哪裡、為什麼換人。
        新的一筆是獨立紀錄（不覆蓋），原紀錄標 handedOffTo 指過去 ——
        「這件換了幾手、每手為什麼」本身是要看得到的資訊。
        """
        limited = None
        claimed = []
        with self._REG_LOCK:
            for d in rows:
                if d.get("alive") or d.get("handedOffTo"):
                    continue
                why = ""
                if d.get("outcome") == "error" and _is_quota_issue(d.get("issue") or ""):
                    why = f"{d.get('tool')} 的額度已經用完（{(d.get('issue') or '')[:60]}）"
                elif d.get("mode") == "terminal" and d.get("state") == "waiting" \
                        and not d.get("pid"):
                    t0 = _stamp_epoch(d.get("started", ""))
                    if t0 is not None and time.time() - t0 > _TERMINAL_STALL_SEC:
                        why = f"{d.get('tool')} 開了終端等人按 Enter，{_TERMINAL_STALL_SEC // 60} 分鐘沒有人按"
                if not why:
                    continue
                # 兩道時間門，見 _HANDOFF_MAX_AGE_SEC 的說明：只接這個伺服器親眼看著失敗、
                # 而且還算在飛行中的；歷史紀錄一律不碰
                t0 = _stamp_epoch(d.get("started", ""))
                if t0 is None or t0 < _SERVER_STARTED_AT \
                        or time.time() - t0 > _HANDOFF_MAX_AGE_SEC:
                    continue
                if len(claimed) >= _HANDOFF_PER_PASS:
                    break
                src = next((x for x in self.DISPATCHES if x.get("id") == d.get("id")), None)
                if not src or src.get("handedOffTo"):
                    continue
                if int(src.get("handoffHops") or 0) >= _HANDOFF_MAX_HOPS:
                    continue
                if limited is None:
                    limited = self._limited_tools()
                pick = _pick_handoff_tool(src.get("tool", ""), self.CLOUD_CHAIN,
                                          self.DISPATCH_TOOLS, limited)
                if not pick:
                    # 全部都不能用 —— 標起來，畫面會講「等額度恢復」，不要每 8 秒重算一次
                    src["handedOffTo"] = "none"
                    src["handoffWhy"] = why + "；其他工具也都限流或沒安裝"
                    continue
                src["handedOffTo"] = "…"          # 佔位：認領
                claimed.append((src, pick, why))
            if claimed:
                self._save_registry()
        for src, pick, why in claimed:
            payload = {"tool": pick,
                       "task": self._handoff_order(src, "", why)}
            if src.get("cwd"):
                payload["cwd"] = src["cwd"]
            req = urllib.request.Request(
                f"http://127.0.0.1:{PORT}/api/dispatch",
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json; charset=utf-8",
                         "Origin": f"http://127.0.0.1:{PORT}"})
            new_id = ""
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    out = json.loads(r.read())
                new_id = str(out.get("id") or "") if out.get("ok") else ""
            except Exception:
                new_id = ""
            with self._REG_LOCK:
                if new_id:
                    src["handedOffTo"] = new_id
                    src["handoffWhy"] = why
                    src["handoffHops"] = int(src.get("handoffHops") or 0) + 1
                    nxt = next((x for x in self.DISPATCHES if x.get("id") == new_id), None)
                    if nxt is not None:
                        nxt["handoffHops"] = src["handoffHops"]
                        nxt["handoffFrom"] = src.get("id")
                else:
                    src.pop("handedOffTo", None)     # 送不出去，下一輪再試
                self._save_registry()

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
            # pid 還在 ≠ 我們派的那個還在跑：號碼可能已經被回收給別的程式。
            # 見 _recycled 的說明（八天前的派工顯示執行中，pid 其實是 tailscale）。
            d["alive"] = (bool(d.get("pid")) and int(d["pid"]) in alive_pids
                          and not _recycled(int(d["pid"]), d.get("started", ""),
                                            force=bool(d.get("stopped"))))
            d["state"] = self._dispatch_state(d, d["alive"])
            log = Path(d.get("log", ""))
            if log.exists():
                # 只讀尾端。這個端點每 8 秒被打一次、兩個分頁都在打，
                # 而 CLI 可以吐出幾百 MB 的 log —— 整份讀進來只為了取最後一行，
                # 記憶體會被輪詢本身吃掉。
                text = _tail_text(log)
                shown = _display_log(text)      # agy 的 JSON 結算拆開給人看
                if not d["alive"]:
                    d["result"] = shown[-400:]
                # 執行中的最後一行輸出。使用者最常問的是「到底有沒有在動」——
                # 只有一個「執行中」的字樣看不出差別，看到 log 一直在變才知道還活著。
                # CLI 的輸出帶 ANSI 色碼，直接顯示會變成一串 ESC[1m[31m
                lines = [_ANSI_RE.sub("", ln).strip() for ln in shown.splitlines()]
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
                elif d["state"] == "stopped":
                    d["outcome"], d["issue"] = "stopped", "使用者停止了它，沒有跑完"
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
            # 撞額度／終端沒人按的，自動換下一個工具。也是副作用，同樣只在同源時做。
            self._auto_handoff(out)
        return self._json({"ok": True, "dispatches": out})


# ── 手機遙控 ─────────────────────────────────────────────
#
# 使用者要在手機上看派工、派工、停工。做法不是另寫一個 app，而是同一個後端再開一個埠，
# 只綁在 Tailscale 網卡上（WireGuard 已經加密、不開放區網與公網），每個請求都要帶配對
# token，而且只開放派工相關的少數路徑——對話索引、檔案、技能、設定一律不給。
# 這裡的每一條限制都對應主控台原本的安全假設：主控台假設 127.0.0.1 上的頁面就是自己人，
# 遙控埠沒有這個假設，所以 token 與白名單都不能省。
REMOTE_PORT = PORT + 1
REMOTE_FILE = Path.home() / "ai-hub" / "dispatch-log" / "_remote.json"
REMOTE_ALLOWED_GET = {"/api/health", "/api/dispatches", "/api/dispatch/tools",
                      "/api/dispatch/usage", "/api/dispatch/log"}
REMOTE_ALLOWED_POST = {"/api/dispatch", "/api/dispatch/followup", "/api/dispatch/stop",
                       "/api/dispatch/cancel", "/api/dispatch/retry"}
# 手機頁面本身與它的靜態檔。根路徑 / 不在內：那是桌面版整個主控台（含對話），遙控不開。
REMOTE_STATIC_PREFIXES = ("/m", "/assets/", "/favicon", "/icon", "/vite.svg")
_REMOTE = {"server": None, "thread": None, "bind": "", "token": ""}
_REMOTE_LOCK = threading.Lock()
# 猜 token 的擋下來：同一個來源十分鐘內錯十次就拒絕十分鐘
_AUTH_FAILS: dict = {}
_AUTH_FAIL_MAX = 10
_AUTH_FAIL_WINDOW = 600


def _tailscale_ip() -> str:
    """Tailscale 的 IPv4。config.json 的 remote_bind 可以覆蓋（例如測試或別的 VPN）。"""
    cfg = str(_CFG.get("remote_bind") or "").strip()
    if cfg:
        return cfg
    exe = shutil.which("tailscale") or ""
    if not exe and os.name == "nt":
        for cand in (Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tailscale" / "tailscale.exe",):
            if cand.is_file():
                exe = str(cand)
                break
    if not exe:
        return ""
    try:
        r = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=10, **_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return ""
    for line in (r.stdout or "").splitlines():
        line = line.strip()
        if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", line):
            return line
    return ""


def _load_remote() -> dict:
    try:
        d = json.loads(REMOTE_FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_remote(d: dict) -> None:
    REMOTE_FILE.parent.mkdir(parents=True, exist_ok=True)
    REMOTE_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def _auth_blocked(ip: str, now: float) -> bool:
    hits = [t for t in _AUTH_FAILS.get(ip, []) if now - t < _AUTH_FAIL_WINDOW]
    _AUTH_FAILS[ip] = hits
    return len(hits) >= _AUTH_FAIL_MAX


def _auth_failed(ip: str, now: float) -> None:
    _AUTH_FAILS.setdefault(ip, []).append(now)
    if len(_AUTH_FAILS) > 500:
        _AUTH_FAILS.clear()


def _remote_status() -> dict:
    d = _load_remote()
    on = _REMOTE["server"] is not None
    tok = _REMOTE["token"] or str(d.get("token") or "")
    bind = _REMOTE["bind"] or str(d.get("bind") or "") or _tailscale_ip()
    # 完整網址（含 token）只會經由同源的桌面端點回給桌面頁面，用來畫 QR；不寫日誌
    url = f"http://{bind}:{REMOTE_PORT}/m/#t={tok}" if (on and tok and bind) else ""
    return {"ok": True, "enabled": on, "bind": bind, "port": REMOTE_PORT, "url": url,
            "tokenTail": tok[-4:] if tok else "", "created": d.get("created", ""),
            "tailscale": bool(bind)}


def _remote_start(token: str = "") -> dict:
    with _REMOTE_LOCK:
        if _REMOTE["server"] is not None:
            return {"ok": True, "already": True, **_remote_status()}
        bind = _tailscale_ip()
        if not bind:
            return {"ok": False, "error": "找不到 Tailscale 位址：遙控只綁在 Tailscale 網卡上（不開放區網與公網）。"
                                          "先裝好並登入 Tailscale，或在 server/config.json 設 remote_bind。"}
        d = _load_remote()
        tok = token or str(d.get("token") or "") or secrets.token_urlsafe(24)
        try:
            srv = ThreadingHTTPServer((bind, REMOTE_PORT), RemoteHandler)
        except OSError as e:
            return {"ok": False, "error": f"綁不上 {bind}:{REMOTE_PORT}：{e}"}
        srv.daemon_threads = True
        RemoteHandler.ALLOWED_ORIGINS = {f"http://{bind}:{srv.server_address[1]}"}
        th = threading.Thread(target=srv.serve_forever, daemon=True, name="remote-http")
        th.start()
        _REMOTE.update(server=srv, thread=th, bind=bind, token=tok)
        _save_remote({"token": tok, "bind": bind, "enabled": True,
                      "created": d.get("created") or time.strftime("%Y%m%d-%H%M%S")})
        return {"ok": True, **_remote_status()}


def _remote_stop(forget: bool) -> dict:
    """關掉遙控埠。forget=True 連 token 一起作廢（手機上存的那份從此無效）。"""
    with _REMOTE_LOCK:
        srv = _REMOTE["server"]
        if srv is not None:
            try:
                srv.shutdown()
                srv.server_close()
            except OSError:
                pass
        _REMOTE.update(server=None, thread=None)
        if forget:
            _REMOTE["token"] = ""
            try:
                REMOTE_FILE.unlink()
            except OSError:
                pass
        else:
            d = _load_remote()
            if d:
                d["enabled"] = False
                _save_remote(d)
        return {"ok": True, **_remote_status()}


class RemoteHandler(Handler):
    """遙控埠的請求處理：先過 token 與白名單，其餘沿用主控台的邏輯（同一份登錄、同一套派工）。"""
    ALLOWED_ORIGINS = set()          # 啟動時設成遙控埠自己的來源

    def _remote_ok(self) -> bool:
        token = _REMOTE["token"]
        auth = self.headers.get("Authorization", "") or ""
        given = auth[7:].strip() if auth.startswith("Bearer ") else ""
        return bool(token) and bool(given) and hmac.compare_digest(given, token)

    def _remote_gate(self, method: str) -> bool:
        path = self.path.split("?", 1)[0]
        if method == "GET" and (path == "/api/health" or path in ("/m", "/m/")
                                or any(path.startswith(pre) for pre in REMOTE_STATIC_PREFIXES)):
            return True
        ip = str(self.client_address[0]) if self.client_address else ""
        now = time.time()
        if _auth_blocked(ip, now):
            self._json({"ok": False, "error": "錯太多次 token，十分鐘後再試"}, 429)
            return False
        if not self._remote_ok():
            _auth_failed(ip, now)
            self._json({"ok": False, "error": "需要配對 token：用桌面版的「📱 手機遙控」重新掃 QR"}, 401)
            return False
        allowed = REMOTE_ALLOWED_GET if method == "GET" else REMOTE_ALLOWED_POST
        if path not in allowed:
            self._json({"ok": False, "error": "遙控模式不開放這個路徑"}, 403)
            return False
        return True

    def do_GET(self):
        if self._remote_gate("GET"):
            return super().do_GET()

    def do_POST(self):
        if self._remote_gate("POST"):
            return super().do_POST()

    def log_message(self, *args):
        return                        # 不把遙控請求（可能帶 token 的網址）寫進終端


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
    if _load_remote().get("enabled"):
        _r = _remote_start()
        # 只印位址，不印 token
        print(f"手機遙控 於 http://{_r.get('bind')}:{REMOTE_PORT}/m/ （僅 Tailscale）" if _r.get("ok")
              else f"手機遙控沒開：{_r.get('error')}", flush=True)

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
