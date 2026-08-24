# -*- coding: utf-8 -*-
"""安全地讀取索引對話的真正尾端。

這個模組刻意只接受「索引檔 + 對話 id」。呼叫端不能提供來源路徑，
避免把本機 API 變成任意檔案讀取器。來源內容只在記憶體中解析，不另存副本。
"""
from __future__ import annotations

import json
import re
from collections import deque
from pathlib import Path
from typing import Any


MAX_TAIL_MESSAGES = 120
MAX_MESSAGE_CHARS = 2_000
MAX_SCAN_BYTES = 16 * 1024 * 1024
MAX_RECORD_BYTES = 4 * 1024 * 1024
MAX_INDEX_BYTES = 32 * 1024 * 1024

_CONVERSATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$")
_SUPPORTED_SUFFIXES = {".jsonl"}


class ConversationTailError(Exception):
    """可安全回給介面的已分類錯誤。"""

    def __init__(self, code: str, message: str, status: int = 422,
                 *, resume_available: bool = False):
        super().__init__(message)
        self.code = code
        self.status = status
        self.resume_available = resume_available


def _normalise_role(value: Any) -> str:
    role = str(value or "").lower()
    if role in ("user", "human"):
        return "user"
    if role in ("assistant", "model", "ai"):
        return "assistant"
    return ""


def _extract_text(node: Any, depth: int = 0) -> str:
    """容忍各家 JSONL 的 content/message/parts 包裝，但限制遞迴深度。"""
    if depth > 6:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        parts: list[str] = []
        for item in node:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif isinstance(item.get("content"), (str, list, dict)):
                    parts.append(_extract_text(item["content"], depth + 1))
        return "\n".join(part for part in parts if part)
    if isinstance(node, dict):
        if isinstance(node.get("text"), str):
            return node["text"]
        for key in ("content", "message", "parts"):
            if key in node:
                text = _extract_text(node[key], depth + 1)
                if text:
                    return text
    return ""


def _message_from_record(record: dict[str, Any]) -> dict[str, str] | None:
    """一個 JSONL record 最多產生一則對話，避免外層與 message 內層重複。"""
    timestamp: Any = ""
    for key in ("timestamp", "ts", "created_at", "time"):
        if record.get(key) not in (None, ""):
            timestamp = record[key]
            break

    candidates = [record]
    candidates.extend(
        record[key] for key in ("message", "payload", "record")
        if isinstance(record.get(key), dict)
    )
    for candidate in candidates:
        role = _normalise_role(candidate.get("role"))
        if not role:
            kind = str(candidate.get("type") or "").lower()
            if kind in ("user", "human") or "user_message" in kind:
                role = "user"
            elif kind in ("assistant", "model", "ai") or "assistant_message" in kind:
                role = "assistant"
        if role not in ("user", "assistant"):
            continue
        body = _extract_text(candidate.get("content") if "content" in candidate else candidate)
        if not body or not body.strip():
            continue
        return {
            "role": role,
            "text": body[:MAX_MESSAGE_CHARS],
            "ts": timestamp if isinstance(timestamp, str) else "",
        }
    return None


def read_jsonl_tail(source: Path, *, limit: int = MAX_TAIL_MESSAGES,
                    max_scan_bytes: int = MAX_SCAN_BYTES) -> dict[str, Any]:
    """從檔案尾端讀固定上限，回傳最後 N 則 user/assistant 訊息。"""
    limit = max(1, min(int(limit), MAX_TAIL_MESSAGES))
    max_scan_bytes = max(1, min(int(max_scan_bytes), MAX_SCAN_BYTES))
    try:
        size = source.stat().st_size
        offset = max(0, size - max_scan_bytes)
        with source.open("rb") as handle:
            handle.seek(offset)
            raw = handle.read(max_scan_bytes)
    except OSError as exc:
        # OSError 的字串通常包含絕對路徑；端點回應不可把私人來源路徑帶出去。
        raise ConversationTailError("source_read_failed", "無法讀取對話來源", 500) from exc

    # 從中間開始時第一列一定不完整；整列丟掉，不能拿半段 JSON 猜內容。
    if offset:
        newline = raw.find(b"\n")
        raw = raw[newline + 1:] if newline >= 0 else b""

    messages: deque[dict[str, str]] = deque(maxlen=limit)
    matched = 0
    oversized = 0
    malformed = 0
    skipped_positions: list[int] = []
    last_message_position = -1
    for position, line in enumerate(raw.splitlines()):
        line = line.strip()
        if not line or not line.startswith(b"{"):
            continue
        if len(line) > MAX_RECORD_BYTES:
            oversized += 1
            skipped_positions.append(position)
            continue
        try:
            record = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            malformed += 1
            skipped_positions.append(position)
            continue
        if not isinstance(record, dict):
            continue
        message = _message_from_record(record)
        if message:
            matched += 1
            messages.append(message)
            last_message_position = position

    if not messages:
        detail = "尾端沒有可解析的 user／assistant 訊息"
        if oversized:
            detail += "（來源紀錄超過安全上限）"
        elif malformed:
            detail += "（JSONL 格式無法解析）"
        raise ConversationTailError("unparseable_format", detail)

    # 舊訊息之後若還有無法解析／超過上限的 JSON record，就無法證明舊訊息
    # 是真正最新。寧可讓 Home 清楚退回索引前段，也不能把 stale tail 標成 latest。
    if any(position > last_message_position for position in skipped_positions):
        raise ConversationTailError(
            "incomplete_tail", "對話尾端含未完成或過大的紀錄，無法確認真正最新訊息",
        )

    return {
        "messages": list(messages),
        "truncated": bool(offset or matched > limit),
        "scanLimited": bool(offset),
        "skippedRecords": oversized + malformed,
    }


def load_indexed_tail(index_path: Path, conversation_id: str, *,
                      allowed_root: Path | None = None,
                      limit: int = MAX_TAIL_MESSAGES,
                      max_scan_bytes: int = MAX_SCAN_BYTES) -> dict[str, Any]:
    """只經由 canonical index 找來源，再驗證路徑與格式後讀尾端。"""
    conversation_id = str(conversation_id or "").strip()
    if not _CONVERSATION_ID.fullmatch(conversation_id):
        raise ConversationTailError("invalid_id", "對話 id 格式不合法", 400)

    try:
        if index_path.stat().st_size > MAX_INDEX_BYTES:
            raise ConversationTailError("index_too_large", "對話索引超過安全上限", 503)
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except ConversationTailError:
        raise
    except FileNotFoundError as exc:
        raise ConversationTailError("index_missing", "對話索引不存在，請先重新掃描", 503) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ConversationTailError("index_invalid", "對話索引無法讀取", 500) from exc

    conversations = index.get("conversations") if isinstance(index, dict) else None
    if not isinstance(conversations, list):
        raise ConversationTailError("index_invalid", "對話索引格式不正確", 500)
    conversation = next(
        (item for item in conversations
         if isinstance(item, dict) and item.get("id") == conversation_id),
        None,
    )
    if conversation is None:
        raise ConversationTailError("not_found", "索引裡找不到這個對話", 404)

    resume_available = bool(conversation.get("resume"))
    raw_path = conversation.get("path")
    if not isinstance(raw_path, str) or not raw_path:
        raise ConversationTailError(
            "source_missing", "索引沒有這個對話的來源", 404,
            resume_available=resume_available,
        )

    root = (allowed_root or Path.home()).resolve()
    try:
        source = Path(raw_path)
        if not source.is_absolute():
            raise ValueError("relative")
        resolved = source.resolve(strict=True)
        if not resolved.is_relative_to(root):
            raise ValueError("outside")
        if not resolved.is_file():
            raise OSError("not a file")
    except (OSError, ValueError) as exc:
        raise ConversationTailError(
            "unsafe_source", "索引來源不在允許的使用者目錄內，已拒絕讀取", 403,
            resume_available=resume_available,
        ) from exc

    if resolved.suffix.lower() not in _SUPPORTED_SUFFIXES:
        raise ConversationTailError(
            "unsupported_format", "這個工具的對話來源不是支援的 JSONL 格式", 422,
            resume_available=resume_available,
        )

    try:
        result = read_jsonl_tail(
            resolved, limit=limit, max_scan_bytes=max_scan_bytes,
        )
    except ConversationTailError as exc:
        exc.resume_available = resume_available
        raise
    return {
        "id": conversation_id,
        "tool": str(conversation.get("tool") or ""),
        "latest": True,
        "resumeAvailable": resume_available,
        **result,
    }
