# -*- coding: utf-8 -*-
"""Pure, fail-closed dispatch-readiness contract.

Callers collect passive facts (CLI discovery and LM Studio readback) and pass
them here. This module never loads a model, starts a server, reads a config,
or performs an inference request. Keeping the eligibility decision here
prevents setup, planning, quota, and dispatch surfaces from disagreeing.
"""

from __future__ import annotations


# Public execution modes. ``headless`` is the established API/UI spelling;
# CLOUD remains an alias so importers do not reintroduce the old ``cloud`` value.
HEADLESS = "headless"
CLOUD = HEADLESS
TERMINAL = "terminal"
LOCAL = "local"

LOCAL_ID = "local"
LOCAL_LABEL = "本機模型"
AUTO = "auto"

READINESS_INSTALLED_UNVERIFIED = "installed_unverified"
READINESS_PREPARE_ON_SEND = "prepare_on_send"
READINESS_NEEDS_SETUP = "needs_setup"
READINESS_READY = "ready"
READINESS_UNKNOWN = "unknown"

STATE_LOGIN_UNVERIFIED = "login_unverified"
STATE_LIMITED = "limited"
STATE_MISSING_TOOL = "missing_tool"
STATE_NEEDS_MODEL = "needs_model"
STATE_UNKNOWN = "unknown"
STATE_BUSY = "busy"
STATE_NEEDS_MEMORY = "needs_memory"
STATE_NEEDS_START = "needs_start"
STATE_READY = "ready"

AUTH_UNKNOWN = "unknown"
AUTH_NOT_REQUIRED = "not_required"
NEXT_ACTION_SETUP = "setup"

NEUTRAL_CLI_REASON = "已安裝，登入狀態要送出時才知道"
LIMITED_FALLBACK_REASON = "額度已用完，等重置或換一個工具"
NO_TOOL_REASON = "沒有可用的工具：先安裝並登入一個 CLI，或啟動本機模型"

_LOCAL_STATES = {
    STATE_MISSING_TOOL,
    STATE_NEEDS_MODEL,
    STATE_UNKNOWN,
    STATE_BUSY,
    STATE_NEEDS_MEMORY,
    STATE_NEEDS_START,
    STATE_READY,
}
_LOCAL_READINESS = {
    STATE_NEEDS_START: READINESS_PREPARE_ON_SEND,
    STATE_READY: READINESS_READY,
    STATE_UNKNOWN: READINESS_UNKNOWN,
}
_LOCAL_REASONS = {
    STATE_MISSING_TOOL: "找不到 LM Studio；先安裝或重新檢查。",
    STATE_NEEDS_MODEL: "尚未找到完整的支援模型。",
    STATE_UNKNOWN: "本機模型狀態不明。",
    STATE_BUSY: "LM Studio 正在使用其他或混合模型。",
    STATE_NEEDS_MEMORY: "目前可用記憶體不足以安全準備本機模型。",
    STATE_NEEDS_START: "本機模型會在送出時安全準備。",
    STATE_READY: "本機模型已載入。",
}
_READY_STATES = {STATE_NEEDS_START, STATE_READY}
_EXECUTION_MODES = {HEADLESS, TERMINAL, LOCAL}


def _error(message: str) -> dict:
    return {
        "ok": False,
        "error": message,
        "ready": False,
        "nextAction": NEXT_ACTION_SETUP,
    }


def _cli_row(tool: str, label: str, mode: str, is_limited: bool, reason: object) -> dict:
    if is_limited:
        return {
            "id": tool,
            "label": label,
            "mode": mode,
            "installed": True,
            "ready": False,
            "state": STATE_LIMITED,
            "readiness": READINESS_NEEDS_SETUP,
            "authStatus": AUTH_UNKNOWN,
            "limited": True,
            "reason": reason if isinstance(reason, str) and reason else LIMITED_FALLBACK_REASON,
            "nextAction": NEXT_ACTION_SETUP,
        }
    return {
        "id": tool,
        "label": label,
        "mode": mode,
        "installed": True,
        "ready": True,
        "state": STATE_LOGIN_UNVERIFIED,
        "readiness": READINESS_INSTALLED_UNVERIFIED,
        "authStatus": AUTH_UNKNOWN,
        "limited": False,
        "reason": NEUTRAL_CLI_REASON,
    }


def _clean_string_list(value: object) -> tuple[list[str], bool]:
    """Return a safe public list plus whether the original value was valid."""
    if not isinstance(value, list):
        return [], False
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip() or item in out:
            return [], False
        out.append(item)
    return out, True


def _local_row(local: object, labels: dict) -> dict:
    """Normalize local facts and reject contradictory optimistic payloads."""
    data = local() if callable(local) else local
    if not isinstance(data, dict):
        data = {}

    models, models_valid = _clean_string_list(data.get("models"))
    loaded, loaded_valid = _clean_string_list(data.get("loaded"))
    installed = data.get("installed") is True
    available = data.get("available") is True
    raw_state = data.get("state")
    state = raw_state if raw_state in _LOCAL_STATES else STATE_UNKNOWN
    selected = data.get("model") if isinstance(data.get("model"), str) else None
    selected = selected if selected in models else None
    raw_reason = data.get("reason")
    reason = raw_reason.strip() if isinstance(raw_reason, str) and raw_reason.strip() else ""

    coherent = (
        installed
        and available
        and models_valid
        and bool(models)
        and selected is not None
        and loaded_valid
        and data.get("ready") is True
        and state in _READY_STATES
        and ((state == STATE_READY and loaded == [selected])
             or (state == STATE_NEEDS_START and not loaded))
    )
    # A malformed optimistic payload is not merely "not ready". Expose it as
    # unknown so a legacy consumer cannot paint the original ready state green.
    if state in _READY_STATES and not coherent:
        state = STATE_UNKNOWN
        reason = "本機模型回報不完整或互相矛盾，已停止派工。"

    readiness = _LOCAL_READINESS.get(state, READINESS_NEEDS_SETUP)
    ready = bool(coherent and state in _READY_STATES)
    row = {
        "id": LOCAL_ID,
        "label": labels.get(LOCAL_ID) or LOCAL_LABEL,
        "mode": LOCAL,
        "installed": installed,
        "ready": ready,
        "state": state,
        "readiness": readiness,
        "authStatus": AUTH_NOT_REQUIRED,
        "limited": False,
        "reason": reason or _LOCAL_REASONS[state],
        "available": available,
        "models": models,
        "model": selected,
        "loaded": loaded,
    }
    # Portable/runtime probes may add only these bounded public diagnostics.
    # Paths, raw gate output, and machine-specific command details stay private.
    for key in ("reasonCode", "setupStep", "gateSource"):
        value = data.get(key)
        if isinstance(value, str) and value:
            row[key] = value
    runtime = data.get("runtime")
    if isinstance(runtime, dict):
        allowed = ("id", "installed", "selected", "verified", "displayName",
                   "minimumLMStudioVersion", "helpUrl")
        row["runtime"] = {key: runtime[key] for key in allowed if key in runtime
                          and isinstance(runtime[key], (str, bool, int, float, type(None)))}
    if not ready:
        row["nextAction"] = NEXT_ACTION_SETUP
    return row


def build_snapshot(cloud_chain, terminal_tools, labels, available, limited, reasons, local) -> dict:
    """Build the one shared, passive readiness snapshot.

    ``available`` only answers whether a CLI executable exists. It deliberately
    does not claim login or inference proof; a present, non-limited CLI remains
    an attemptable but neutral ``login_unverified`` target.
    """
    labels = labels or {}
    limited = set(limited or ())
    reasons = reasons or {}
    ordered_cloud = list(cloud_chain or ())
    ordered_terminal = sorted(set(terminal_tools or ()))

    tools: list[dict] = []
    seen: set[str] = set()
    for mode, group in ((HEADLESS, ordered_cloud), (TERMINAL, ordered_terminal)):
        for tool in group:
            if not isinstance(tool, str) or tool in seen or tool == LOCAL_ID:
                continue
            try:
                installed = bool(available and available(tool))
            except Exception:
                installed = False
            if not installed:
                continue
            seen.add(tool)
            tools.append(_cli_row(tool, labels.get(tool) or tool, mode,
                                  tool in limited, reasons.get(tool)))

    local_row = _local_row(local, labels)
    tools.append(local_row)

    auto = next((row["id"] for row in tools
                 if row["mode"] == HEADLESS and row["ready"] is True
                 and row["limited"] is not True), None)
    if auto is None and local_row["ready"] is True:
        auto = LOCAL_ID

    selected = next((row for row in tools if row["id"] == auto), None)
    snapshot = {
        "ok": True,
        "tools": tools,
        "auto": auto,
        "ready": auto is not None,
        "reason": selected["reason"] if selected else NO_TOOL_REASON,
        "local": local_row,
    }
    if auto is None:
        snapshot["nextAction"] = NEXT_ACTION_SETUP
    return snapshot


def _find_row(rows: object, tool: object) -> dict | None:
    if not isinstance(rows, list) or not isinstance(tool, str):
        return None
    for row in rows:
        if isinstance(row, dict) and row.get("id") == tool:
            return row
    return None


def _row_attemptable(row: dict | None, *, auto: bool = False) -> bool:
    if not isinstance(row, dict):
        return False
    if row.get("ready") is not True or row.get("limited") is True:
        return False
    mode = row.get("mode")
    if mode not in _EXECUTION_MODES:
        return False
    return not auto or mode in {HEADLESS, LOCAL}


def resolve_dispatch(snapshot: object, requested: object):
    """Resolve one dispatch without silently rerouting an explicit target.

    Auto is revalidated against its actual row rather than trusting a stale or
    malformed ``snapshot.auto``. Explicit targets receive the same strict
    ready/limited checks and cannot escape through a legacy row.
    """
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    rows = snapshot.get("tools")
    want = requested.strip() if isinstance(requested, str) else requested
    if not want or want == AUTO:
        selected = snapshot.get("auto")
        row = _find_row(rows, selected)
        if not selected or not _row_attemptable(row, auto=True):
            return None, _error(snapshot.get("reason") or NO_TOOL_REASON)
        return selected, None

    row = _find_row(rows, want)
    if row is None:
        return None, _error("找不到「%s」：先安裝它，或在設定裡改選其他工具" % want)
    label = row.get("label") or want
    if row.get("limited") is True:
        return None, _error("「%s」%s" % (label, row.get("reason") or LIMITED_FALLBACK_REASON))
    if not _row_attemptable(row):
        return None, _error("「%s」還沒準備好：%s" % (label, row.get("reason") or NO_TOOL_REASON))
    return want, None
