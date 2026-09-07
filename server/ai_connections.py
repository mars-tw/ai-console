"""Explicit, answer-only connections. Credentials never enter the config file.

The catalog is passive. Only probe() performs GET /models; test() and chat()
perform inference after a user action. LM Studio uses the separate gated API.
The injectable transport is a callable(method, url, headers, body, timeout,
max_bytes) returning (HTTP status, decoded JSON). It must not follow redirects.
"""
from __future__ import annotations

import http.client
import ipaddress
import json
import os
from pathlib import Path
import queue
import re
import socket
import ssl
import tempfile
import threading
import time
from urllib.parse import urlsplit, urlunsplit
import uuid


MAX_CONFIG_BYTES = 128 * 1024
MAX_RESPONSE_BYTES = 512 * 1024
MAX_CONNECTIONS = 50
REQUEST_TIMEOUT = 20
CHAT_TIMEOUT = 45
_DNS_SLOTS = threading.BoundedSemaphore(4)
_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\Z")
_ENV = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]{0,127}\Z")
_CLI_NAMES = {"codex": "Codex", "claude": "Claude Code", "qwen": "Qwen Code",
              "grok": "Grok", "agy": "Antigravity", "kimi": "Kimi Code"}
_FIELDS = ("id", "type", "label", "baseUrl", "model", "apiKeyEnv")


class ConnectionError(Exception):
    """Only fixed, non-provider messages are permitted in public failures."""

    def __init__(self, status, error, next_action):
        super().__init__(error)
        self.status, self.error, self.next_action = status, error, next_action

    def result(self):
        return {"ok": False, "status": self.status, "error": self.error,
                "nextAction": self.next_action}


def _invalid(message="連線設定格式不正確。"):
    return ConnectionError("invalid_config", message, "檢查網址、名稱與模型後再試一次。")


def _text(value, limit, required=True):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise _invalid()
    value = value.strip()
    if required and not value:
        raise _invalid()
    return value


def normalize_base_url(value):
    """Validate syntactically without DNS/network; reject ambiguous URL forms."""
    value = _text(value, 2048)
    if any(c in value for c in ("@", "?", "#", "\\", "%")) or any(c.isspace() for c in value):
        raise _invalid("API 網址不可含帳密、查詢參數、片段或編碼字元。")
    try:
        parts = urlsplit(value)
        host, port = parts.hostname, parts.port
    except ValueError:
        raise _invalid("API 網址或連接埠格式不正確。") from None
    if not host or parts.scheme not in ("http", "https") or port == 0:
        raise _invalid("請填入完整的 HTTP 或 HTTPS API 網址。")
    host = host.lower()
    local = host in ("localhost", "127.0.0.1", "::1")
    if port == 1234:
        raise ConnectionError("use_builtin_lmstudio", "LM Studio 請使用內建的地端模型入口。",
                              "回到「問 AI」選擇地端模型；內建入口會檢查 CPU 與模型載入。")
    if parts.scheme == "http" and not local:
        raise _invalid("外部 API 必須使用 HTTPS；HTTP 僅允許本機回送位址。")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if host.endswith(".") or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host):
            raise _invalid("API 主機名稱格式不正確。")
        if not local and ("." not in host or any(not label or len(label) > 63 or
                label.startswith("-") or label.endswith("-") for label in host.split("."))):
            raise _invalid("外部 API 請使用完整的公開主機名稱。")
    else:
        if not local and not address.is_global:
            raise _invalid("不允許私有網路或中繼資料位址；本機服務請使用 localhost。")
    path = parts.path.rstrip("/")
    if not re.fullmatch(r"[/a-zA-Z0-9._~-]*", path) or "//" in path or any(
            p in (".", "..") for p in path.split("/")):
        raise _invalid("API 路徑格式不正確。")
    if not path.endswith("/v1"):
        path += "/v1"
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc += f":{port}"
    return urlunsplit((parts.scheme, netloc, path, "", ""))


def _resolve_addresses(host, port, timeout):
    # Explicit loopback names never go through DNS, including hosts-file aliases.
    if host in ("localhost", "127.0.0.1", "::1"):
        return ["::1" if host == "::1" else "127.0.0.1"]
    if not _DNS_SLOTS.acquire(blocking=False):
        raise ConnectionError("busy", "連線檢查正在忙碌中。", "稍後再試一次。")
    result = queue.Queue(maxsize=1)

    def resolve():
        try:
            result.put((True, socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
        except OSError:
            result.put((False, None))
        finally:
            _DNS_SLOTS.release()

    threading.Thread(target=resolve, daemon=True).start()
    try:
        ok, records = result.get(timeout=min(timeout, 5))
    except queue.Empty:
        raise ConnectionError("timeout", "API 主機解析逾時。", "檢查網路與 API 網址後再試。") from None
    if not ok:
        raise ConnectionError("unreachable", "無法解析 API 主機。", "檢查網路與 API 網址後再試。")
    addresses = list(dict.fromkeys(row[4][0] for row in records))
    if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
        raise ConnectionError("unsafe_address", "API 主機指向非公開位址。",
                              "使用公開 HTTPS API；本機服務請明確填 localhost。")
    return addresses


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, port, address, timeout):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self._address = address

    def connect(self):
        # Pin the validated IP while retaining hostname verification and TLS SNI.
        sock = socket.create_connection((self._address, self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def http_transport(method, url, headers, body, timeout, max_bytes):
    """No redirects, proxies, retries, cookies, or unbounded response reads."""
    parts = urlsplit(url)
    host = parts.hostname
    port = parts.port or (443 if parts.scheme == "https" else 80)
    deadline = time.monotonic() + timeout
    address = _resolve_addresses(host, port, timeout)[0]
    remaining = max(0.1, deadline - time.monotonic())
    if parts.scheme == "https":
        conn = _PinnedHTTPSConnection(host, port, address, remaining)
    else:
        conn = http.client.HTTPConnection(address, port, timeout=remaining)
    timer = None
    try:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        conn.connect()
        live_socket = conn.sock

        def expire():
            try:
                live_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            live_socket.close()

        timer = threading.Timer(max(0.1, deadline - time.monotonic()), expire)
        timer.daemon = True
        timer.start()
        conn.sock.settimeout(max(0.1, deadline - time.monotonic()))
        conn.request(method, parts.path, body=data, headers=headers)
        response = conn.getresponse()
        # Never read error bodies: they may echo Authorization or remote secrets.
        if not 200 <= response.status < 300:
            return response.status, {}
        length = response.getheader("Content-Length")
        if length is not None and (not length.isdigit() or int(length) > max_bytes):
            raise ConnectionError("response_too_large", "API 回應超過大小上限。", "使用較小的模型清單或回覆。")
        if response.getheader("Content-Encoding", "identity").lower() not in ("", "identity"):
            raise ConnectionError("invalid_response", "API 傳回不支援的壓縮格式。", "確認 API 支援未壓縮的 JSON 回應。")
        chunks, size = [], 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            # HTTP/1.0 may detach conn.sock, while response still owns it.
            response_socket = conn.sock or getattr(getattr(response.fp, "raw", None), "_sock", None)
            if response_socket is not None:
                response_socket.settimeout(remaining)
            chunk = response.read1(min(16384, max_bytes + 1 - size))
            if not chunk:
                if time.monotonic() >= deadline:
                    raise TimeoutError()
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > max_bytes:
                raise ConnectionError("response_too_large", "API 回應超過大小上限。", "使用較小的模型清單或回覆。")
        try:
            decoded = json.loads(b"".join(chunks).decode("utf-8"))
        except (UnicodeError, ValueError, RecursionError):
            raise ConnectionError("invalid_response", "API 未傳回有效 JSON。", "確認網址是 OpenAI 相容 API。") from None
        return response.status, decoded
    except (OSError, http.client.HTTPException):
        if time.monotonic() >= deadline:
            raise TimeoutError() from None
        raise
    finally:
        if timer is not None:
            timer.cancel()
        conn.close()


class AIConnections:
    def __init__(self, config_path=None, env=None, transport=None):
        self.config_path = Path(config_path) if config_path is not None else Path.home() / ".ai-console" / "connections.json"
        self._env = os.environ if env is None else env
        self._transport = http_transport if transport is None else transport
        self._lock = threading.RLock()
        self._connections = {}
        self._keys = {}
        self._verified = {}
        self._load_error = None
        self._load()

    def _validate(self, payload, require_model=False, create_id=True):
        if not isinstance(payload, dict):
            raise _invalid()
        cid = payload.get("id") or (uuid.uuid4().hex if create_id else "")
        if not isinstance(cid, str) or not _ID.fullmatch(cid):
            raise _invalid("連線識別碼格式不正確。")
        if payload.get("type", "openai-compatible") != "openai-compatible":
            raise _invalid("目前僅支援 OpenAI 相容的聊天 API。")
        ref = _text(payload.get("apiKeyEnv", ""), 128, required=False)
        if ref and not _ENV.fullmatch(ref):
            raise _invalid("金鑰環境變數名稱格式不正確。")
        return {"id": cid, "type": "openai-compatible",
                "label": _text(payload.get("label", ""), 100),
                "baseUrl": normalize_base_url(payload.get("baseUrl", "")),
                "model": _text(payload.get("model", ""), 256, required=require_model),
                "apiKeyEnv": ref}

    def _load(self):
        try:
            with self.config_path.open("rb") as handle:
                raw = handle.read(MAX_CONFIG_BYTES + 1)
            if len(raw) > MAX_CONFIG_BYTES:
                raise ValueError()
            saved = json.loads(raw.decode("utf-8"))
            if not isinstance(saved, dict) or saved.get("version") != 1 or not isinstance(saved.get("connections"), list):
                raise ValueError()
            rows = saved["connections"]
            if len(rows) > MAX_CONNECTIONS:
                raise ValueError()
            clean = {}
            for row in rows:
                if not isinstance(row, dict) or set(row) - set(_FIELDS):
                    raise ValueError()
                item = self._validate(row, require_model=True, create_id=False)
                if item["id"] in clean:
                    raise ValueError()
                clean[item["id"]] = item
            self._connections = clean
        except FileNotFoundError:
            return
        except (OSError, UnicodeError, ValueError, RecursionError, ConnectionError):
            self._load_error = "已存連線設定無法讀取；原檔保留，請修正設定檔後重啟。"

    def _persist(self, connections):
        if self._load_error:
            raise ConnectionError("config_unavailable", self._load_error, "修正 connections.json 後重新啟動。")
        data = json.dumps({"version": 1, "connections": list(connections.values())}, ensure_ascii=False, indent=2).encode("utf-8")
        if len(data) > MAX_CONFIG_BYTES:
            raise _invalid("已存連線設定超過大小上限。")
        temp_path = None
        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_path = tempfile.mkstemp(prefix=".connections-", suffix=".tmp", dir=self.config_path.parent)
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, self.config_path)
        except OSError:
            raise ConnectionError("save_failed", "無法儲存連線設定。", "檢查設定資料夾的寫入權限後再試。") from None
        finally:
            if temp_path is not None:
                try:
                    os.unlink(temp_path)
                except FileNotFoundError:
                    pass

    @staticmethod
    def _transient_key(payload):
        if "apiKey" not in payload:
            return None
        key = payload["apiKey"]
        if not isinstance(key, str) or len(key) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in key):
            if key == "":
                return ""
            raise _invalid("金鑰格式不正確，請重新貼入。")
        return key

    def _key(self, item, transient=None):
        if transient is not None:
            return transient
        # Keys belong to a saved endpoint, never merely to a caller-selected ID.
        saved = self._connections.get(item["id"])
        same_auth_target = saved and (saved["baseUrl"], saved["apiKeyEnv"]) == (item["baseUrl"], item["apiKeyEnv"])
        if same_auth_target and item["id"] in self._keys:
            return self._keys[item["id"]]
        ref = item["apiKeyEnv"]
        if ref:
            key = self._env.get(ref, "")
            if not key:
                raise ConnectionError("missing_key", "指定的金鑰環境變數尚未設定。", "設定該環境變數並重啟，或重新輸入本次使用的金鑰。")
            return self._transient_key({"apiKey": key})
        return ""

    def _require_original_endpoint(self, item):
        """An existing connection cannot silently authorize credentials elsewhere.

        A new connection is an explicit new destination and requires users to
        enter its own key/reference. This also covers references to environment
        keys, whose values must not follow an edited Base URL.
        """
        saved = self._connections.get(item["id"])
        if saved is not None and saved["baseUrl"] != item["baseUrl"]:
            raise ConnectionError(
                "endpoint_change_requires_new_connection",
                "已存連線的服務網址不可直接更換。",
                "選擇「新增另一個 AI」，重新填入服務網址與該服務的金鑰或環境變數名稱。",
            )

    def _public(self, item):
        ref = item["apiKeyEnv"]
        has_memory = bool(self._keys.get(item["id"]))
        credential = "memory" if has_memory else ("environment" if ref and self._env.get(ref) else "missing" if ref else "not_set")
        verified_model = self._verified.get(item["id"], "")
        return {**item, "status": "reply_verified" if verified_model == item["model"] else "saved",
                "credentialStatus": credential, "verifiedModel": verified_model,
                "hasKey": credential in ("memory", "environment")}

    def catalog(self, cli_available=None):
        available = cli_available if isinstance(cli_available, dict) else {}
        with self._lock:
            result = {"ok": not bool(self._load_error), "connections": [self._public(item) for item in self._connections.values()],
                      "cli": [{"id": name, "label": label, "available": bool(available.get(name)),
                               "status": "installed_unverified" if available.get(name) else "not_installed"}
                              for name, label in _CLI_NAMES.items()]}
            if self._load_error:
                result["loadError"] = self._load_error
            return result

    def save(self, payload):
        try:
            item = self._validate(payload, require_model=True)
            key = self._transient_key(payload)
            with self._lock:
                self._require_original_endpoint(item)
                if item["id"] not in self._connections and len(self._connections) >= MAX_CONNECTIONS:
                    raise _invalid("最多可儲存 50 個連線。")
                # Reject accidental placement of a known credential in public fields.
                known = [key, *self._keys.values()]
                if item["apiKeyEnv"]:
                    known.append(self._env.get(item["apiKeyEnv"], ""))
                serialized = json.dumps(item, ensure_ascii=False)
                if any(secret and secret in serialized for secret in known):
                    raise _invalid("名稱、網址與模型不可包含金鑰。")
                updated = {**self._connections, item["id"]: item}
                self._persist(updated)
                old = self._connections.get(item["id"])
                same_auth_target = old and (old["baseUrl"], old["apiKeyEnv"]) == (item["baseUrl"], item["apiKeyEnv"])
                if not same_auth_target or key == "":
                    self._keys.pop(item["id"], None)
                if key:
                    self._keys[item["id"]] = key
                if old != item or key is not None:
                    self._verified.pop(item["id"], None)
                self._connections = updated
                return {"ok": True, "status": "saved", "connection": self._public(item)}
        except ConnectionError as error:
            return error.result()

    def delete(self, payload):
        try:
            with self._lock:
                item = self._saved(payload)
                updated = dict(self._connections)
                del updated[item["id"]]
                self._persist(updated)
                self._connections = updated
                self._keys.pop(item["id"], None)
                self._verified.pop(item["id"], None)
                return {"ok": True, "status": "deleted", "id": item["id"]}
        except ConnectionError as error:
            return error.result()

    def _saved(self, payload):
        if not isinstance(payload, dict) or not isinstance(payload.get("id"), str):
            raise _invalid()
        item = self._connections.get(payload["id"])
        if item is None:
            raise ConnectionError("not_found", "找不到這個連線。", "重新選擇或新增連線。")
        return dict(item)

    def _request(self, item, key, endpoint, body=None):
        headers = {"Accept": "application/json", "Content-Type": "application/json", "Accept-Encoding": "identity"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        try:
            status, data = self._transport("POST" if body is not None else "GET", item["baseUrl"] + endpoint,
                                           headers, body, CHAT_TIMEOUT if body is not None else REQUEST_TIMEOUT,
                                           MAX_RESPONSE_BYTES)
        except ConnectionError:
            raise
        except (TimeoutError, socket.timeout):
            raise ConnectionError("timeout", "API 回應逾時。", "確認服務可用，或改用較小的模型後再試。") from None
        except ssl.SSLError:
            raise ConnectionError("tls_error", "API 的 HTTPS 憑證驗證失敗。", "檢查網址與伺服器憑證；不可關閉憑證驗證。") from None
        except (OSError, ValueError, http.client.HTTPException):
            raise ConnectionError("unreachable", "無法連上 API 服務。", "確認服務已啟動、網址與連接埠正確。") from None
        if not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599:
            raise ConnectionError("invalid_response", "API 回應格式不正確。", "確認服務提供 OpenAI 相容 API。")
        if 300 <= status < 400:
            raise ConnectionError("redirect_rejected", "API 要求重新導向，已停止連線。", "填入服務官方提供的最終 HTTPS API 網址。")
        if status in (401, 403):
            raise ConnectionError("authentication_failed", "API 拒絕驗證或目前金鑰沒有權限。", "確認金鑰、環境變數與模型存取權限。")
        if status == 429:
            raise ConnectionError("rate_limited", "API 已達使用限制。", "稍後再試，或向供應商確認額度。")
        if status == 404:
            raise ConnectionError("not_supported", "API 找不到這個端點或模型。", "確認 API 網址與模型名稱支援 OpenAI 相容聊天。")
        if not 200 <= status < 300:
            raise ConnectionError("provider_error", f"API 請求失敗（HTTP {status}）。", "檢查模型是否支援此 API 與目前請求參數。")
        if not isinstance(data, dict):
            raise ConnectionError("invalid_response", "API 回應格式不正確。", "確認服務提供 OpenAI 相容 API。")
        return data

    def probe(self, payload):
        try:
            item = self._validate(payload)
            with self._lock:
                self._require_original_endpoint(item)
                key = self._key(item, self._transient_key(payload))
            data = self._request(item, key, "/models")
            if not isinstance(data.get("data"), list):
                raise ConnectionError("invalid_response", "API 沒有傳回模型清單。", "確認網址提供 GET /v1/models。")
            models = []
            for row in data["data"][:200]:
                mid = row.get("id") if isinstance(row, dict) else None
                if isinstance(mid, str) and mid.strip() and len(mid) <= 256 and not any(ord(c) < 32 for c in mid):
                    if key and key in mid:
                        continue
                    if mid not in models:
                        models.append(mid)
            if not models:
                raise ConnectionError("no_models", "API 可連線，但沒有可選的模型。", "向供應商確認模型權限，或在模型服務啟用可用模型。")
            return {"ok": True, "status": "models_available", "models": models,
                    "nextAction": "選擇模型並儲存，再測試一則回覆；讀到清單尚未驗證推論。"}
        except ConnectionError as error:
            return {**error.result(), "models": []}

    def _inference(self, payload, testing):
        item = None
        succeeded = False
        try:
            with self._lock:
                item = self._saved(payload)
                key = self._key(item)
            model = _text(payload.get("model") or item["model"], 256)
            if key and key in model:
                raise _invalid("模型名稱不可包含金鑰。")
            if testing:
                messages = [{"role": "user", "content": "Reply with a short greeting."}]
            else:
                raw = payload.get("messages")
                if not isinstance(raw, list) or not 1 <= len(raw) <= 40:
                    raise _invalid("請提供 1 到 40 則文字訊息。")
                messages, length = [], 0
                for message in raw:
                    if not isinstance(message, dict) or message.get("role") not in ("system", "user", "assistant"):
                        raise _invalid("僅支援一般文字對話訊息。")
                    content = message.get("content")
                    if not isinstance(content, str) or not content.strip():
                        raise _invalid("訊息內容不可為空白。")
                    length += len(content)
                    if length > 64000:
                        raise _invalid("對話內容太長，請縮短後再試。")
                    messages.append({"role": message["role"], "content": content})
            data = self._request(item, key, "/chat/completions", {"model": model, "messages": messages,
                                 "stream": False, "max_tokens": 32 if testing else 512})
            choices = data.get("choices")
            message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
            if not isinstance(message, dict):
                raise ConnectionError("invalid_response", "API 沒有傳回聊天訊息。", "確認模型支援 chat/completions。")
            content, reasoning = message.get("content"), message.get("reasoning_content", "")
            content = content.strip() if isinstance(content, str) else ""
            reasoning = reasoning.strip() if isinstance(reasoning, str) else ""
            if key:
                content = content.replace(key, "[redacted]")
                reasoning = reasoning.replace(key, "[redacted]")
            if message.get("tool_calls") or message.get("function_call"):
                raise ConnectionError("unsupported_tools", "模型要求執行工具，尚未完成文字回答。", "改用可直接回答的聊天模型；此連線不會執行工具。")
            if not content:
                failure = ConnectionError("reasoning_only" if reasoning else "empty_reply",
                                          "模型只有推理過程，沒有給出答案。" if reasoning else "模型沒有傳回答案。",
                                          "改用可直接回答的聊天模型後再測試。")
                return {**failure.result(), "content": "", "reasoning": reasoning, "model": model}
            with self._lock:
                # A late response cannot validate a replaced or deleted connection.
                if self._connections.get(item["id"]) == item and self._key(item) == key:
                    self._verified[item["id"]] = model
            succeeded = True
            return {"ok": True, "status": "reply_verified", "content": content,
                    "reasoning": reasoning, "model": model}
        except ConnectionError as error:
            return error.result()
        finally:
            # A failed response must not leave an earlier green test badge behind.
            if item is not None:
                with self._lock:
                    if self._connections.get(item["id"]) == item and not succeeded:
                        self._verified.pop(item["id"], None)

    def test(self, payload):
        return self._inference(payload, testing=True)

    def chat(self, payload):
        return self._inference(payload, testing=False)
