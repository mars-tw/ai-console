"""Desktop adapter for an existing DevSpace installation (1.0.8 CLI contract).

No installation, configuration mutation, tunnel control, or arbitrary shell is
performed here. Inspection uses a read-only SQLite connection so refreshing the
UI never starts DevSpace's agent daemon. Only explicit run/continue may do that.
"""
from __future__ import annotations

import ipaddress
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import urllib.request


PROVIDERS = frozenset(("codex", "claude", "local"))
DISPATCH_PROVIDER = "codex"
MODEL_OPTIONS = (
    {"id": "gpt-5.6-sol", "label": "GPT-5.6 SOL"},
    {"id": "gpt-6-astra", "label": "GPT-6 ASTRA"},
)
MODEL_IDS = frozenset(option["id"] for option in MODEL_OPTIONS)
DEFAULT_MODEL = "gpt-5.6-sol"
_ID = re.compile(r"agt_[A-Za-z0-9_-]{4,100}\Z")
_VERSION = re.compile(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\Z")
_STATUS = {"starting": "running", "running": "running", "idle": "completed",
           "error": "failed", "stopped": "stopped"}
_WINDOWS_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


class _Failure(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _read_jsonc(source: str):
    """Remove only JSONC comments/trailing commas, preserving quoted strings."""
    output = []
    index = 0
    quoted = False
    while index < len(source):
        char = source[index]
        if quoted:
            output.append(char)
            if char == "\\" and index + 1 < len(source):
                index += 1
                output.append(source[index])
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
            output.append(char)
        elif source[index:index + 2] == "//":
            end = source.find("\n", index + 2)
            index = len(source) if end == -1 else end
            output.append("\n")
            continue
        elif source[index:index + 2] == "/*":
            end = source.find("*/", index + 2)
            if end == -1:
                raise ValueError("Unterminated comment")
            output.append(" ")
            index = end + 2
            continue
        else:
            output.append(char)
        index += 1
    source = "".join(output)
    output = []
    quoted = False
    index = 0
    while index < len(source):
        char = source[index]
        if quoted:
            output.append(char)
            if char == "\\" and index + 1 < len(source):
                index += 1
                output.append(source[index])
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
            output.append(char)
        elif char == ",":
            next_index = index + 1
            while next_index < len(source) and source[next_index].isspace():
                next_index += 1
            if next_index == len(source) or source[next_index] not in "}]":
                output.append(char)
        else:
            output.append(char)
        index += 1
    return json.loads("".join(output))


def _error(code: str, message: str) -> dict:
    return {"ok": False, "code": code, "error": message}


def _guard(method):
    """Never serialize arbitrary subprocess exceptions or credential-bearing text."""
    def guarded(self, *args, **kwargs):
        try:
            return method(self, *args, **kwargs)
        except _Failure as exc:
            return _error(exc.code, exc.message)
        except Exception:
            return _error("DEVSPACE_FAILED", "DevSpace 操作未完成，請執行環境診斷。")
    return guarded


class DevSpaceConsole:
    def __init__(self, *, env: dict | None = None, home: Path | None = None):
        self.env = dict(os.environ if env is None else env)
        self.home = Path.home() if home is None else Path(home)
        self._child: subprocess.Popen | None = None
        self._lock = threading.RLock()
        self._http = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def _config(self) -> dict:
        config_dir = Path(self.env.get("DEVSPACE_CONFIG_DIR", str(self.home / ".devspace"))).expanduser().resolve()
        config_path = config_dir / "config.json"
        if (config_dir / "config.jsonc").is_file():
            config_path = config_dir / "config.jsonc"
        elif not config_path.is_file() and any((config_dir / name).is_file() for name in ("config.yaml", "config.yml")):
            raise _Failure("UNSUPPORTED_CONFIG", "請使用 DevSpace 的 config.json 或 config.jsonc 設定檔。")
        raw = {}
        if config_path.is_file():
            try:
                if config_path.stat().st_size > 1024 * 1024:
                    raise ValueError()
                source = config_path.read_text(encoding="utf-8-sig")
                raw = _read_jsonc(source) if config_path.suffix == ".jsonc" else json.loads(source)
                if not isinstance(raw, dict):
                    raise ValueError()
            except Exception:
                raise _Failure("INVALID_CONFIG", "DevSpace 設定檔無法讀取，請先修正設定。")
        if "configVersion" in raw and (type(raw["configVersion"]) is not int or raw["configVersion"] != 1):
            raise _Failure("UNSUPPORTED_CONFIG", "此 DevSpace 設定版本尚未支援；控制台支援 configVersion 1 與舊版 JSON。")
        # Nested projections accept the newer JSON shape without executing a
        # migration or treating arbitrary unknown fields as console settings.
        server = raw.get("server") if isinstance(raw.get("server"), dict) else raw
        workspaces = raw.get("workspaces") if isinstance(raw.get("workspaces"), dict) else raw
        roots = workspaces.get("allowedRoots", [])
        if "DEVSPACE_ALLOWED_ROOTS" in self.env:
            roots = self.env["DEVSPACE_ALLOWED_ROOTS"].split(",")
        if not isinstance(roots, list) or any(not isinstance(p, str) for p in roots):
            raise _Failure("INVALID_CONFIG", "DevSpace 的 allowedRoots 必須是資料夾路徑清單。")
        allowed = []
        for value in roots:
            if not value.strip():
                continue
            root = Path(value.strip()).expanduser()
            if not root.is_absolute():
                raise _Failure("INVALID_CONFIG", "DevSpace 的 allowedRoots 必須使用完整路徑。")
            resolved = root.resolve()
            if resolved not in allowed:
                allowed.append(resolved)
        host = self.env.get("HOST", server.get("host", "127.0.0.1"))
        port = self.env.get("PORT", server.get("port", 7676))
        try:
            if isinstance(port, bool) or not re.fullmatch(r"\d{1,5}", str(port)):
                raise ValueError()
            port = int(port)
            if not 1 <= port <= 65535:
                raise ValueError()
        except (TypeError, ValueError):
            raise _Failure("INVALID_CONFIG", "DevSpace 的連接埠設定無效。")
        if not isinstance(host, str):
            raise _Failure("INVALID_CONFIG", "DevSpace 的主機設定無效。")
        # Network probes are loopback only, with no proxy or redirects.
        local_host = "127.0.0.1" if host in ("localhost", "0.0.0.0", "::") else host
        try:
            if not ipaddress.ip_address(local_host).is_loopback:
                raise ValueError()
        except ValueError:
            raise _Failure("NONLOCAL_HOST", "桌面控制台只連線到本機 DevSpace。")
        host_part = f"[{local_host}]" if ":" in local_host else local_host
        subagents = raw.get("subagents", {})
        if isinstance(subagents, bool):
            enabled = subagents
            entries = [{"id": p, "enabled": True} for p in sorted(PROVIDERS)]
        elif isinstance(subagents, dict):
            enabled = subagents.get("enabled") is True
            entries = subagents.get("providers", [])
        else:
            enabled, entries = False, []
        if "DEVSPACE_SUBAGENTS" in self.env:
            enabled = self.env["DEVSPACE_SUBAGENTS"].lower() in ("1", "true", "yes", "on")
        targets = []
        if enabled and isinstance(entries, list):
            for entry in entries:
                if (not isinstance(entry, dict) or entry.get("id") != DISPATCH_PROVIDER
                        or entry.get("enabled") is not True):
                    continue
                # Configuration only enables the provider. It is not evidence
                # that either permitted model is currently available upstream.
                targets.append({"name": DISPATCH_PROVIDER, "kind": "provider"})
                break
        storage = raw.get("storage") if isinstance(raw.get("storage"), dict) else raw
        state_dir = self.env.get("DEVSPACE_STATE_DIR", storage.get("stateDir", str(self.home / ".local" / "share" / "devspace")))
        if not isinstance(state_dir, str):
            raise _Failure("INVALID_CONFIG", "DevSpace 的資料目錄設定無效。")
        return {"path": config_path, "dir": config_dir, "allowed": allowed,
                "configured": config_path.is_file() and ((config_dir / "auth.json").is_file()
                    or bool(self.env.get("DEVSPACE_OAUTH_OWNER_TOKEN"))),
                "endpoint": f"http://{host_part}:{port}/mcp", "host": host,
                "configFormat": "jsonc" if config_path.suffix == ".jsonc" else "json",
                "stateDir": Path(state_dir).expanduser().resolve(), "targets": targets}

    def _cli(self) -> list[str] | None:
        """Resolve npm's JS entry directly; never execute .cmd/.ps1 via a shell."""
        override = self.env.get("AI_CONSOLE_DEVSPACE_BIN")
        path_env = self.env.get("PATH", "")
        node = shutil.which("node", path=path_env)
        if override:
            candidate = Path(override).expanduser()
            if not candidate.is_absolute() or not candidate.is_file():
                raise _Failure("INVALID_CLI", "AI_CONSOLE_DEVSPACE_BIN 必須指向現有執行檔或 cli.js 的完整路徑。")
            if candidate.suffix.lower() in (".js", ".mjs", ".cjs"):
                if not node:
                    return None
                return [node, str(candidate.resolve())]
            if candidate.suffix.lower() in (".cmd", ".bat", ".ps1"):
                raise _Failure("INVALID_CLI", "請將 AI_CONSOLE_DEVSPACE_BIN 指向 DevSpace 的 cli.js 或原生執行檔。")
            if (os.name == "nt" and candidate.suffix.lower() != ".exe") or not os.access(candidate, os.X_OK):
                raise _Failure("INVALID_CLI", "DevSpace 指定檔案無法直接執行。")
            return [str(candidate.resolve())]
        located = shutil.which("devspace", path=path_env)
        candidates = []
        if located:
            path = Path(located)
            # npm's POSIX bin is a symlink to the JavaScript entry.
            candidates.extend((path.resolve(), path.parent / "node_modules" / "@waishnav" / "devspace" / "dist" / "cli.js"))
        appdata = self.env.get("APPDATA")
        if appdata:
            candidates.append(Path(appdata) / "npm" / "node_modules" / "@waishnav" / "devspace" / "dist" / "cli.js")
        for candidate in candidates:
            if candidate.is_file() and candidate.suffix.lower() in (".js", ".mjs", ".cjs") and node:
                return [node, str(candidate.resolve())]
            if candidate.is_file() and candidate.suffix.lower() == ".exe":
                return [str(candidate.resolve())]
        return None

    def _child_env(self) -> dict:
        env = dict(self.env)
        # A console operation must never inherit another MCP workspace identity.
        env.pop("DEVSPACE_WORKSPACE_ID", None)
        env.pop("DEVSPACE_WORKSPACE_ROOT", None)
        env["NO_COLOR"] = "1"
        return env

    def _migration_required(self, cfg: dict, cli: list[str] | None = None) -> bool:
        """Newer builds reused 1.0.8 and migrate on reads; inspect their layout."""
        if cfg["configFormat"] != "json" or not cfg["path"].is_file():
            return False
        cli = cli or self._cli()
        if not cli or len(cli) != 2:
            return False
        module = Path(cli[1]).parent / "user-config.js"
        try:
            if module.stat().st_size > 1024 * 1024:
                return False
            return '"config.jsonc"' in module.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            return False

    def _no_migration(self, cfg: dict, cli: list[str]):
        if self._migration_required(cfg, cli):
            raise _Failure("CONFIG_MIGRATION_REQUIRED", "此 DevSpace 版本需要新版設定；請先在終端機執行 devspace init 完成轉換，再回到控制台。")

    def _execute(self, args: list[str], *, cwd: Path | None = None, timeout: float = 20) -> subprocess.CompletedProcess:
        cli = self._cli()
        if not cli:
            raise _Failure("NOT_INSTALLED", "尚未找到 DevSpace，請先安裝 @waishnav/devspace。")
        if args != ["--version"]:
            self._no_migration(self._config(), cli)
        try:
            child = subprocess.Popen(cli + args, cwd=str(cwd or self.home), env=self._child_env(),
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     shell=False, creationflags=_WINDOWS_FLAGS)
        except OSError:
            raise _Failure("CLI_UNAVAILABLE", "DevSpace 無法啟動，請檢查 Node.js 與安裝路徑。")
        buffers = [bytearray(), bytearray()]
        exceeded = threading.Event()

        def drain(stream, buffer):
            try:
                while True:
                    chunk = stream.read(8192)
                    if not chunk:
                        break
                    if len(buffer) + len(chunk) > 2 * 1024 * 1024:
                        exceeded.set()
                        with contextlib.suppress(OSError):
                            child.kill()
                        break
                    buffer.extend(chunk)
            finally:
                stream.close()

        readers = [threading.Thread(target=drain, args=(stream, buffers[i]), daemon=True)
                   for i, stream in enumerate((child.stdout, child.stderr))]
        for reader in readers:
            reader.start()
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
            for reader in readers:
                reader.join(timeout=1)
            raise _Failure("CLI_TIMEOUT", "DevSpace 回應逾時，請重新整理後確認任務狀態。")
        for reader in readers:
            reader.join(timeout=1)
        if exceeded.is_set():
            raise _Failure("OUTPUT_TOO_LARGE", "DevSpace 回應過長，請使用原本的工具查看完整內容。")
        if any(reader.is_alive() for reader in readers):
            raise _Failure("CLI_FAILED", "DevSpace 尚未釋放輸出連線，請重新整理確認狀態。")
        return subprocess.CompletedProcess(cli + args, child.returncode,
            buffers[0].decode("utf-8", errors="replace"), buffers[1].decode("utf-8", errors="replace"))

    def _json(self, args: list[str], *, cwd: Path | None = None, timeout: float = 20):
        result = self._execute(args, cwd=cwd, timeout=timeout)
        try:
            value = json.loads(result.stdout.strip())
        except (ValueError, TypeError):
            raise _Failure("CLI_FAILED", "DevSpace 指令未完成，請執行環境診斷。")
        if result.returncode != 0 or (isinstance(value, dict) and "error" in value):
            payload = value.get("error") if isinstance(value, dict) else None
            code = payload.get("code") if isinstance(payload, dict) else None
            # Only a machine code crosses this boundary; upstream messages may
            # embed provider stderr, prompts, tokens, or inherited environment.
            safe_code = code if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{1,80}", code) else "CLI_FAILED"
            raise _Failure(safe_code, "DevSpace 未完成這項操作，請確認設定及代理程式狀態。")
        return value

    def _version(self, cli: list[str] | None) -> str | None:
        if not cli:
            return None
        if len(cli) == 2:
            try:
                value = json.loads((Path(cli[1]).parent.parent / "package.json").read_text(encoding="utf-8"))
                version = value.get("version")
                if isinstance(version, str) and _VERSION.fullmatch(version):
                    return version
            except (OSError, ValueError, AttributeError):
                pass
        try:
            result = self._execute(["--version"], timeout=5)
            value = result.stdout.strip()
            return value if result.returncode == 0 and _VERSION.fullmatch(value) else None
        except _Failure:
            return None

    def _health(self, cfg: dict) -> bool:
        try:
            request = urllib.request.Request(cfg["endpoint"].removesuffix("/mcp") + "/healthz")
            with self._http.open(request, timeout=1) as response:
                body = json.loads(response.read(4097))
                return response.status == 200 and body.get("ok") is True and body.get("name") == "devspace"
        except Exception:
            return False

    def _daemon(self, cfg: dict) -> dict:
        inactive = {"running": False, "state": "unavailable", "activeTurns": 0}
        if not cfg["configured"] or not self._cli():
            return inactive
        try:
            value = self._json(["agents", "daemon", "status", "--json"], timeout=5)
            if not isinstance(value, dict) or value.get("state") not in ("ready", "stopping"):
                return inactive
            active = value.get("activeTurns")
            return {"running": value["state"] == "ready", "state": value["state"],
                    "activeTurns": active if type(active) is int and active >= 0 else 0}
        except _Failure:
            return inactive

    def _owned_child(self):
        if self._child is not None and self._child.poll() is not None:
            self._child = None
        return self._child

    @_guard
    def status(self) -> dict:
        cfg = self._config()
        cli = self._cli()
        with self._lock:
            child = self._owned_child()
            service = {"running": self._health(cfg), "managed": child is not None}
            if child is not None:
                service["pid"] = child.pid
        return {"ok": True, "installed": cli is not None, "version": self._version(cli),
                "configured": cfg["configured"], "configPath": str(cfg["path"]),
                "allowedRoots": [str(p) for p in cfg["allowed"]], "endpoint": cfg["endpoint"],
                "service": service, "daemon": self._daemon(cfg), "targets": cfg["targets"],
                "models": [dict(option) for option in MODEL_OPTIONS], "defaultModel": DEFAULT_MODEL,
                "capabilities": {"perTaskStop": False},
                "compatibility": {"testedVersion": "1.0.8", "configFormat": cfg["configFormat"],
                                  "historySchema": "local_agent_sessions",
                                  "migrationRequired": self._migration_required(cfg, cli)}}

    @_guard
    def doctor(self, body: dict | None = None) -> dict:
        self._body(body or {})
        result = self._execute(["doctor"], timeout=25)
        # Do not echo config URLs, errors, paths from stderr, or auth contents.
        allowed = ("Node:", "Node ABI:", "Platform:", "Git:", "Bash shell:",
                   "SQLite native dependency:", "Subagents:", "Subagent providers:")
        lines = []
        for line in result.stdout.splitlines():
            if not line.startswith(allowed):
                continue
            if "unavailable" in line.lower() or "error" in line.lower():
                lines.append(line.split(":", 1)[0] + ": unavailable")
            elif len(line) <= 600 and not re.search(r"(?i)(token|secret|password|bearer|api.?key)", line):
                lines.append(line)
        if result.returncode != 0 or not lines:
            raise _Failure("DOCTOR_FAILED", "DevSpace 診斷未完成，請在終端機執行 devspace doctor。")
        return {"ok": True, "output": "\n".join(lines)}

    @_guard
    def start(self, body: dict | None = None) -> dict:
        self._body(body or {})
        cfg = self._config()
        cli = self._cli()
        if not cli:
            raise _Failure("NOT_INSTALLED", "尚未找到 DevSpace，請先安裝 @waishnav/devspace。")
        if not cfg["configured"]:
            raise _Failure("NOT_CONFIGURED", "請先在終端機執行 devspace init，完成本機設定。")
        self._no_migration(cfg, cli)
        with self._lock:
            if self._health(cfg):
                return {"ok": True, "attached": self._owned_child() is None, "status": self.status()}
            if self._owned_child() is not None:
                return {"ok": True, "attached": False, "status": self.status()}
            if cfg["host"] in ("0.0.0.0", "::"):
                raise _Failure("NONLOCAL_BIND", "請先將 DevSpace host 設為 127.0.0.1，再從桌面啟動。")
            # Discard service output: it can contain private prompts and tool
            # arguments. The native DevSpace diagnostic command stays available.
            self._child = subprocess.Popen(cli + ["serve"], cwd=str(self.home), env=self._child_env(),
                                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, shell=False, creationflags=_WINDOWS_FLAGS)
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline:
                if self._owned_child() is None:
                    raise _Failure("START_FAILED", "DevSpace 未能啟動，請執行環境診斷並確認連接埠。")
                if self._health(cfg):
                    return {"ok": True, "attached": False, "status": self.status()}
                time.sleep(0.15)
            # Preserve the owned handle even when startup is slow; retrying
            # cannot create a duplicate and stop can still terminate this child.
            raise _Failure("START_TIMEOUT", "DevSpace 尚未回應，請稍後重新整理或停止本次啟動。")

    @_guard
    def stop(self, body: dict | None = None) -> dict:
        self._body(body or {})
        with self._lock:
            child = self._owned_child()
            if child is None:
                raise _Failure("NOT_MANAGED", "這個 DevSpace 服務不是由控制台啟動，請到原本的啟動工具停止。")
            # Popen owns an OS process handle on Windows. No PID files, port
            # matching, taskkill, or global agent-daemon stop are used.
            child.terminate()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)
            self._child = None
        return {"ok": True, "status": self.status()}

    def _body(self, body) -> dict:
        if not isinstance(body, dict):
            raise _Failure("INVALID_INPUT", "請提供有效的操作內容。")
        return body

    def _cwd(self, body: dict, cfg: dict) -> Path:
        value = body.get("cwd")
        if not isinstance(value, str) or not value.strip() or len(value) > 4096 or "\x00" in value:
            raise _Failure("INVALID_WORKSPACE", "請選擇 DevSpace 可存取的專案資料夾。")
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise _Failure("INVALID_WORKSPACE", "專案資料夾必須使用完整路徑。")
        path = path.resolve()
        self._assert_root(path, cfg)
        if not path.is_dir():
            raise _Failure("INVALID_WORKSPACE", "找不到這個專案資料夾。")
        # DevSpace itself expands a subdirectory to its Git root. Validate that
        # effective root as well; a permitted child must not grant its ancestor.
        git = shutil.which("git", path=self.env.get("PATH", ""))
        if git:
            try:
                result = subprocess.run([git, "-C", str(path), "rev-parse", "--show-toplevel"],
                                        env=self._child_env(), capture_output=True, stdin=subprocess.DEVNULL,
                                        text=True, encoding="utf-8", errors="replace", timeout=5,
                                        shell=False, creationflags=_WINDOWS_FLAGS)
            except (OSError, subprocess.TimeoutExpired):
                raise _Failure("WORKSPACE_CHECK_FAILED", "無法確認 Git 專案範圍，請稍後再試。")
            if result.returncode == 0:
                path = Path(result.stdout.strip()).resolve()
                self._assert_root(path, cfg)
        return path

    @staticmethod
    def _assert_root(path: Path, cfg: dict):
        if not any(path == root or root in path.parents for root in cfg["allowed"]):
            raise _Failure("WORKSPACE_NOT_ALLOWED", "此專案不在 DevSpace 設定的 allowedRoots 範圍內。")

    def _records(self, cfg: dict, cwd: Path, agent_id: str | None = None) -> list[dict]:
        database = cfg["stateDir"] / "devspace.sqlite"
        if not database.is_file():
            return []
        # Selected columns avoid unrelated tables (including OAuth and loaded
        # instruction content). No library import that could migrate the DB.
        columns = "id, profile_name, provider, model, status"
        required = {"id", "workspace_root", "profile_name", "provider", "model", "status", "updated_at"}
        if agent_id:
            columns += ", substr(latest_response, 1, 1048576) AS latest_response, error_code, error_retryable"
            required.update(("latest_response", "error_code", "error_retryable"))
        query = f"SELECT {columns} FROM local_agent_sessions WHERE workspace_root = ?"
        values = [str(cwd)]
        if agent_id:
            query += " AND id = ?"
            values.append(agent_id)
        query += " ORDER BY updated_at DESC LIMIT 200"
        try:
            with contextlib.closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)) as conn:
                schema = {row[1] for row in conn.execute("PRAGMA table_info(local_agent_sessions)")}
                if not required.issubset(schema):
                    raise _Failure("HISTORY_UNAVAILABLE", "DevSpace 任務紀錄格式不相容，請更新 DevSpace 後再試。")
                conn.row_factory = sqlite3.Row
                rows = conn.execute(query, values).fetchall()
            return [dict(row) for row in rows if row["provider"] in PROVIDERS
                    and isinstance(row["id"], str) and _ID.fullmatch(row["id"])]
        except sqlite3.Error:
            raise _Failure("HISTORY_UNAVAILABLE", "無法讀取 DevSpace 任務紀錄，請確認版本與資料庫狀態。")

    @staticmethod
    def _task(record: dict, *, detail: bool = False) -> dict:
        task = {"id": record["id"], "target": record["profile_name"], "provider": record["provider"],
                "status": _STATUS.get(record["status"], "failed")}
        model = record.get("model")
        if (isinstance(model, str) and 0 < len(model) <= 200
                and not any(char in model for char in "\r\n\x00")):
            task["model"] = model
        if detail and task["status"] == "completed" and isinstance(record.get("latest_response"), str):
            task["response"] = record["latest_response"][:1024 * 1024]
        if detail and task["status"] == "failed":
            code = record.get("error_code")
            task["error"] = {"code": code if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{1,80}", code) else "AGENT_FAILED",
                             "message": "代理程式未完成任務，請在原本的工具查看錯誤。",
                             "retryable": record.get("error_retryable") in (True, "true")}
        return task

    @_guard
    def tasks(self, body: dict) -> dict:
        cfg = self._config()
        cwd = self._cwd(self._body(body), cfg)
        daemon = self._daemon(cfg)
        tasks = [self._task(row) for row in self._records(cfg, cwd)]
        if not daemon["running"]:
            for task in tasks:
                if task["status"] == "running":
                    task["stale"] = True
        return {"ok": True, "cwd": str(cwd), "daemonRunning": daemon["running"], "tasks": tasks}

    def _find(self, body: dict, cfg: dict, cwd: Path) -> dict:
        agent_id = body.get("id")
        if not isinstance(agent_id, str) or not _ID.fullmatch(agent_id):
            raise _Failure("INVALID_TASK", "DevSpace 任務識別碼無效。")
        records = self._records(cfg, cwd, agent_id)
        if not records:
            raise _Failure("TASK_NOT_FOUND", "此專案內找不到這個 DevSpace 任務。")
        return records[0]

    @_guard
    def show(self, body: dict) -> dict:
        cfg = self._config()
        cwd = self._cwd(self._body(body), cfg)
        task = self._task(self._find(body, cfg, cwd), detail=True)
        if task["status"] == "running" and not self._daemon(cfg)["running"]:
            task["stale"] = True
        return {"ok": True, "cwd": str(cwd), "task": task}

    @staticmethod
    def _model(body: dict) -> str:
        value = body.get("model", DEFAULT_MODEL)
        if not isinstance(value, str) or value not in MODEL_IDS:
            raise _Failure("MODEL_NOT_ALLOWED", "請選擇 GPT-5.6 SOL 或 GPT-6 ASTRA。")
        return value

    @staticmethod
    def _prompt_args(body: dict, model: str) -> list[str]:
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 24000 or "\x00" in prompt:
            raise _Failure("INVALID_PROMPT", "請輸入 1 到 24,000 字的任務內容。")
        if model not in MODEL_IDS:
            raise _Failure("MODEL_NOT_ALLOWED", "請選擇 GPT-5.6 SOL 或 GPT-6 ASTRA。")
        # The selected model is always explicit. Configuration defaults cannot
        # silently reroute a task, and a provider failure is never retried with
        # the other model.
        args = ["--model", model, "--json"]
        effort = body.get("effort")
        if effort is not None and effort != "":
            if (not isinstance(effort, str) or len(effort) > 200 or not effort.strip()
                    or effort.startswith("-") or any(c in effort for c in "\r\n\x00")):
                raise _Failure("INVALID_OPTIONS", "推理設定無效。")
            args.extend(("--effort", effort))
        # Prompt is one argv item and follows the option terminator. Shell
        # metacharacters and a prompt containing --model stay ordinary text.
        return args + ["--", prompt]

    @staticmethod
    def _receipt(value, model: str) -> dict:
        if (not isinstance(value, dict) or not isinstance(value.get("id"), str)
                or not _ID.fullmatch(value["id"]) or value.get("status") not in set(_STATUS.values())):
            raise _Failure("INVALID_RESPONSE", "DevSpace 未回傳有效的任務識別碼，請重新整理任務清單。")
        # This is the submitted selection. Polling history later returns the
        # model actually recorded by DevSpace for the session.
        return {"id": value["id"], "status": value["status"], "model": model}

    @staticmethod
    def _enabled(target: str, cfg: dict):
        if target != DISPATCH_PROVIDER or target not in {t["name"] for t in cfg["targets"]}:
            raise _Failure("TARGET_NOT_ALLOWED", "只允許使用已啟用的 Codex 代理程式。")
        if not cfg["configured"]:
            raise _Failure("NOT_CONFIGURED", "請先執行 devspace init，完成本機設定。")

    @_guard
    def run(self, body: dict) -> dict:
        body = self._body(body)
        target = body.get("target")
        if target != DISPATCH_PROVIDER:
            raise _Failure("TARGET_NOT_ALLOWED", "只允許使用已啟用的 Codex 代理程式。")
        model = self._model(body)
        cfg = self._config()
        cwd = self._cwd(body, cfg)
        self._enabled(target, cfg)
        catalog = self._json(["agents", "targets", "--json"], cwd=cwd, timeout=10)
        entries = catalog.get("targets", []) if isinstance(catalog, dict) else []
        if any(isinstance(t, dict) and t.get("name") == target and t.get("kind") == "profile" for t in entries):
            raise _Failure("TARGET_SHADOWED", "專案的同名代理設定覆蓋了此提供者，請先更改代理設定名稱。")
        if not any(isinstance(t, dict) and t.get("name") == target and t.get("kind") == "provider" for t in entries):
            raise _Failure("TARGET_UNAVAILABLE", "Codex 目前無法使用，請先完成安裝與登入。")
        value = self._json(["agents", "run", target] + self._prompt_args(body, model), cwd=cwd, timeout=40)
        return {"ok": True, "cwd": str(cwd), "task": self._receipt(value, model)}

    @_guard
    def continue_task(self, body: dict) -> dict:
        body = self._body(body)
        model = self._model(body)
        cfg = self._config()
        cwd = self._cwd(body, cfg)
        record = self._find(body, cfg, cwd)
        self._enabled(record["provider"], cfg)
        if record["status"] in ("starting", "running"):
            raise _Failure("TASK_RUNNING", "這個任務仍在執行，完成後才能接續。")
        value = self._json(["agents", "continue", record["id"]] + self._prompt_args(body, model), cwd=cwd, timeout=40)
        return {"ok": True, "cwd": str(cwd), "task": self._receipt(value, model)}
