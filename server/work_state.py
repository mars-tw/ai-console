"""Passive registered-work metadata. No provider, conversation, or execution APIs.

The bounded registry/log/STATE reads never mutate the source. PID absence and a
provider's successful response are deliberately not task-completion evidence.
"""
from __future__ import annotations

import datetime as dt
import codecs
import hashlib
import json
import math
import os
import re
import stat
import time
from pathlib import Path

from work_terminal_evidence import MAX_TERMINAL_BYTES, parse_terminal_metadata

TOOL_LABELS = {"claude": "Claude Code", "codex": "Codex", "grok": "Grok",
               "qwen": "Qwen", "kimi": "Kimi", "gemini": "Antigravity",
               "cursor": "Cursor", "muse": "Muse"}
_EXES = {"claude": {"claude.exe", "node.exe"}, "codex": {"codex.exe", "node.exe"},
         "grok": {"grok.exe", "node.exe"}, "qwen": {"node.exe", "cmd.exe"},
         "kimi": {"kimi.exe", "python.exe", "python3.exe"},
         "gemini": {"agy.exe", "node.exe"}, "cursor": {"cursor.exe", "node.exe"},
         "muse": {"muse.exe", "node.exe"}}
_ID = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
MAX_REGISTRY_BYTES = 2 * 1024 * 1024
MAX_PROJECTS = 64


def _iso(epoch=None):
    return dt.datetime.fromtimestamp(time.time() if epoch is None else epoch,
                                     dt.timezone.utc).isoformat()


def _regular(path):
    for parent in path.parents:
        info = parent.lstat()
        if parent.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise OSError("reparse_source_parent")
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
        raise OSError("non_regular_source")
    return info


def _bounded(path, limit, *, tail=False, prefix=False):
    before = _regular(path)
    if not tail and not prefix and before.st_size > limit:
        raise ValueError("source_too_large")
    with path.open("rb") as handle:
        if tail:
            handle.seek(max(0, before.st_size - limit))
        data = handle.read(limit + (0 if tail or prefix else 1))
    after = _regular(path)
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise OSError("source_changed_during_read")
    return data, after


def probe_process(pid, *, record=None):
    """Windows native limited-information query; no shell, subprocess or scan.

    CommandLine is used only for an exact work-order-path binding and never
    leaves this function's caller. Failure/denial remains unavailable.
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or not 0 < pid <= 0xffffffff:
        return {"status": "unavailable", "reason": "invalid_pid"}
    if os.name != "nt":
        return {"status": "unavailable", "reason": "process_probe_unsupported"}
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    native = ctypes.WinDLL("ntdll")
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
    native.NtQueryInformationProcess.argtypes = [wintypes.HANDLE, wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG)]
    native.NtQueryInformationProcess.restype = wintypes.LONG

    class UnicodeString(ctypes.Structure):
        _fields_ = [("Length", wintypes.USHORT), ("MaximumLength", wintypes.USHORT), ("Buffer", ctypes.c_void_p)]

    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        error = ctypes.get_last_error()
        return {"status": "absent" if error == 87 else "unavailable",
                "reason": "pid_absent" if error == 87 else "process_query_denied"}
    try:
        created, exited, system, user = (wintypes.FILETIME() for _ in range(4))
        image = ctypes.create_unicode_buffer(32768)
        length = wintypes.DWORD(len(image))
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(system), ctypes.byref(user)):
            return {"status": "unavailable", "reason": "process_time_unavailable"}
        if exited.dwHighDateTime or exited.dwLowDateTime:
            return {"status": "absent", "reason": "process_exit_observed"}
        if not kernel.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(length)):
            return {"status": "unavailable", "reason": "process_image_unavailable"}
        required = wintypes.ULONG()
        ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
        stamp = ticks / 1e7 - 11644473600
        expected = _started(record.get("started")) if record else None
        image_name = _norm(image.value).rsplit("/", 1)[-1]
        bound_identity = (record is not None and expected is not None and abs(stamp - expected) <= 5
                          and image_name in _EXES.get(record.get("tool"), set()))
        if bound_identity:
            native.NtQueryInformationProcess(handle, 60, None, 0, ctypes.byref(required))
        command = ""
        if ctypes.sizeof(UnicodeString) <= required.value <= 128 * 1024:
            buffer = ctypes.create_string_buffer(required.value)
            if native.NtQueryInformationProcess(handle, 60, buffer, len(buffer), ctypes.byref(required)) >= 0:
                value = UnicodeString.from_buffer(buffer)
                start, end = ctypes.addressof(buffer), ctypes.addressof(buffer) + len(buffer)
                if value.Buffer and value.Length % 2 == 0 and start <= value.Buffer <= end - value.Length:
                    command = ctypes.wstring_at(value.Buffer, value.Length // 2)
        return {"status": "observed", "created": stamp, "createdFileTime": str(ticks), "executable": image.value, "commandLine": command}
    finally:
        kernel.CloseHandle(handle)


def _started(value):
    if not isinstance(value, str):
        return None
    try:
        if re.match(r"^\d{8}-\d{6}", value):
            return dt.datetime.strptime(value[:15], "%Y%m%d-%H%M%S").timestamp()
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, OverflowError, OSError):
        return None


def _norm(value):
    return str(value).replace("\\", "/").removeprefix("//?/").casefold()


def process_evidence(record, facts, registry):
    status = facts.get("status")
    if status != "observed":
        return {"process": status if status in {"absent", "unavailable"} else "unavailable",
                "reason": facts.get("reason", "process_query_unavailable")}
    started = _started(record.get("started"))
    created = facts.get("created")
    if started is None or not isinstance(created, (int, float)):
        return {"process": "unverified", "reason": "creation_time_unverified"}
    if abs(created - started) > 5:
        return {"process": "reused", "reason": "creation_time_mismatch"}
    image = _norm(facts.get("executable", "")).rsplit("/", 1)[-1]
    if image not in _EXES.get(record.get("tool"), set()):
        return {"process": "unverified", "reason": "executable_identity_unverified"}
    identifier = record.get("id", "")
    if not isinstance(identifier, str) or not _ID.fullmatch(identifier):
        return {"process": "unverified", "reason": "task_identity_unverified"}
    command = _norm(facts.get("commandLine", ""))
    orders = [registry.parent / f"{identifier}_task.md", registry.parent / f"{identifier}_followup.md"]
    # Full normalized path and both boundaries; foo.md.other is not foo.md.
    bound = any(re.search(r"(?:^|[\s\"'])" + re.escape(_norm(path.resolve())) + r"(?=$|[\s\"'])", command) for path in orders)
    if not bound:
        return {"process": "unverified", "reason": "work_order_binding_unverified"}
    return {"process": "verified", "reason": "creation_executable_work_order_verified"}


def _terminal(record, registry):
    identifier, raw = record.get("id"), record.get("log")
    if not isinstance(identifier, str) or not _ID.fullmatch(identifier) or not isinstance(raw, str) or not raw:
        return parse_terminal_metadata(b"", record.get("tool"))
    path = Path(raw)
    # Only a direct registered log in the canonical registry directory.
    names = {f"{identifier}_{record.get('tool')}.log"}
    if record.get("followupOf"):
        names.add(f"{identifier}_{record.get('tool')}_followup.log")
    if path.parent.resolve() != registry.parent.resolve() or path.name not in names:
        return parse_terminal_metadata(None, record.get("tool"))
    try:
        data, info = _bounded(path, MAX_TERMINAL_BYTES, tail=True)
        result = parse_terminal_metadata(data, record.get("tool"), truncated=info.st_size > len(data))
        result["logModifiedAt"] = _iso(info.st_mtime)
        return result
    except (OSError, ValueError):
        return {**parse_terminal_metadata(None, record.get("tool")), "reason": "terminal_source_unreadable"}


def _task(record, registry, process_probe):
    pid = record.get("pid")
    facts = process_probe(pid, record=record) if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0 else {"status": "unavailable", "reason": "pid_not_recorded"}
    evidence = process_evidence(record, facts, registry)
    terminal = _terminal(record, registry)
    phase, outcome, state = "not_observed", "unknown", "unknown"
    if evidence["process"] == "verified":
        phase, state = "running", "running"
    elif evidence["process"] in {"unverified", "unavailable"}:
        phase = "unverified"
    if state != "running" and terminal["runtimePhase"] == "terminal_receipt":
        phase, outcome = "ended", terminal["taskOutcome"]
        state = "failed" if outcome == "failed" else "unknown"
    stop = record.get("stopped")
    if _started(stop) is not None and evidence["process"] != "verified":
        phase = "ended" if evidence["process"] in {"absent", "reused"} else "unverified"
        outcome, state = "stopped", "stopped"
        terminal = {**terminal, "receiptKind": "recorded_stop", "reason": "recorded_stop_original_process_exit_unverified" if phase == "unverified" else "recorded_stop_and_original_process_not_observed"}
    if record.get("cancelOrderPending") is True:
        phase, outcome, state = "unverified", "unknown", "unknown"
        evidence = {**evidence, "reason": "cancellation_pending"}
    return {"id": record["id"], "tool": record.get("tool") if isinstance(record.get("tool"), str) else "",
            "task": "已登錄工作 " + record["id"], "origin": "registry",
            "started": record.get("started", "") if isinstance(record.get("started"), str) else "",
            "mode": record.get("mode") if record.get("mode") in {"headless", "sync", "terminal"} else "headless",
            "state": state, "alive": state == "running", "runtimePhase": phase,
            "taskOutcome": outcome, "providerOutcome": terminal["providerOutcome"],
            "cancelOrderPending": record.get("cancelOrderPending") is True,
            "evidence": {**evidence, "terminal": terminal["receiptKind"], "terminalReason": terminal["reason"],
                         "logModifiedAt": terminal.get("logModifiedAt")}}


def _projects(directory):
    result = []
    try:
        if not directory.exists():
            return None, {"state": "missing"}
        paths = sorted(directory.glob("*/STATE.md"))
        errors = 0
        for path in paths[:MAX_PROJECTS]:
            try:
                raw, info = _bounded(path, 16 * 1024, prefix=True)
                # A capped prefix may end inside one otherwise valid UTF-8
                # character. Buffer only that incomplete suffix; malformed
                # interior bytes and incomplete complete-file tails still fail.
                text = codecs.getincrementaldecoder("utf-8-sig")("strict").decode(
                    raw, final=info.st_size <= len(raw))
                header = re.split(r"(?m)^##\s", text, maxsplit=1)[0]
                fields = dict(re.findall(r"(?m)^\s*-?\s*([a-z_]+):\s*(.*?)\s*$", header))
                identifier = fields.get("project_id") or path.parent.name
                title = re.search(r"(?m)^#\s+(?:STATE:\s*)?(.+)$", header)
                result.append({"project_id": identifier, "title": title.group(1) if title else identifier,
                               "status": fields.get("status", "unknown"), "updated_at": fields.get("updated_at", ""),
                               "updated_by": fields.get("updated_by", ""), "next_step": fields.get("next_step", ""),
                               "needs_handoff": fields.get("needs_handoff", "").lower() == "true",
                               "sourceModifiedAt": _iso(info.st_mtime)})
            except (OSError, ValueError, UnicodeError, OverflowError):
                errors += 1
        return result if result or not errors else None, {"state": "partial" if errors or len(paths) > MAX_PROJECTS else "ready",
                        "rowCount": len(result), "unreadableCount": errors, "omittedCount": max(0, len(paths) - MAX_PROJECTS)}
    except OSError:
        return None, {"state": "unreadable"}


def _runtime_sessions(directory, process_probe):
    records, errors = [], 0
    try:
        if not directory.exists():
            return [], {"state": "missing", "rowCount": 0}
        paths = sorted(directory.glob("*.json"))
        for path in paths[:64]:
            try:
                raw, info = _bounded(path, 16 * 1024)
                row = json.loads(raw.decode("utf-8-sig"))
                if not isinstance(row, dict):
                    raise ValueError("invalid_runtime_metadata")
                identifier, pid, start = row.get("sessionId"), row.get("pid"), row.get("procStart")
                if not isinstance(identifier, str) or not _ID.fullmatch(identifier) or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
                    raise ValueError("invalid_runtime_identity")
                if isinstance(start, str) and start.isdigit() and len(start) == 18:
                    expected = int(start) / 1e7 - 11644473600
                else:
                    expected = _started(start)
                facts = process_probe(pid)
                created = facts.get("created")
                executable = _norm(facts.get("executable", ""))
                official_bin = _norm(Path.home() / ".local" / "bin")
                image_matches = (executable.rsplit("/", 1)[0] == official_bin
                                 and re.fullmatch(r"claude\.exe(?:\.old\.\d{13}\.\d+)?", executable.rsplit("/", 1)[-1]) is not None)
                start_matches = (str(facts.get("createdFileTime", "")) == start if isinstance(start, str) and start.isdigit() and len(start) == 18
                                 else isinstance(created, (int, float)) and expected is not None and abs(created - expected) <= .001)
                identity = (facts.get("status") == "observed" and start_matches
                            and image_matches)
                status = row.get("status")
                status = status if status in {"busy", "shell", "idle", "waiting", "waiting_for_input", "starting"} else "unknown"
                producer = row.get("statusUpdatedAt")
                producer_time = (producer / 1000 if producer > 10**11 else producer) if isinstance(producer, (int, float)) and not isinstance(producer, bool) else _started(producer)
                if producer_time is not None and (not math.isfinite(producer_time) or not 0 <= producer_time <= time.time() + 300):
                    producer_time = None
                age = time.time() - producer_time if producer_time is not None else None
                fresh = age is not None and 0 <= age <= 120 and 0 <= time.time() - info.st_mtime <= 120
                active = identity and fresh and status in {"busy", "shell"}
                phase = "running" if active else "idle" if identity and status == "idle" else "unverified"
                records.append({"id": "claude-runtime:" + hashlib.sha256(identifier.encode()).hexdigest()[:16], "tool": "claude", "task": "Claude 工作階段",
                                "started": _iso(expected) if expected is not None else "", "mode": "headless",
                                "state": "running" if active else "unknown", "alive": active,
                                "runtimePhase": phase, "runtimeStatus": status, "origin": "runtime_session",
                                "taskOutcome": "unknown", "providerOutcome": "unknown", "cancelOrderPending": False,
                                "evidence": {"process": "verified" if identity else "absent" if facts.get("status") == "absent" else "unverified",
                                             "reason": "runtime_metadata_pid_creation_executable_bound" if identity else "runtime_identity_unverified",
                                             "terminal": None, "terminalReason": "runtime_metadata_has_no_task_outcome",
                                             "producerUpdatedAt": _iso(producer_time) if producer_time is not None else None,
                                             "producerAgeSeconds": round(age) if age is not None else None,
                                             "activityFresh": fresh,
                                             "sourceModifiedAt": _iso(info.st_mtime)}})
            except (OSError, ValueError, UnicodeError, OverflowError):
                errors += 1
        return records, {"state": "partial" if errors or len(paths) > 64 else "ready", "rowCount": len(records),
                         "unreadableCount": errors, "omittedCount": max(0, len(paths) - 64)}
    except OSError:
        return [], {"state": "unreadable", "rowCount": None}


def work_state_snapshot(registry, *, process_probe=probe_process, runtime_dir=None):
    registry = Path(registry)
    checked = _iso()
    tasks = None
    source = {"state": "unreadable", "rowCount": None, "selectedCount": None}
    try:
        data, info = _bounded(registry, MAX_REGISTRY_BYTES)
        records = json.loads(data.decode("utf-8-sig"))
        if not isinstance(records, list) or any(not isinstance(row, dict) or not isinstance(row.get("id"), str) or not _ID.fullmatch(row["id"]) or row.get("tool") not in {*TOOL_LABELS, "local"} for row in records):
            raise ValueError("invalid_registry")
        recent = records[-30:]
        tasks = [_task(record, registry, process_probe) for record in reversed(recent)]
        source = {"state": "ready", "rowCount": len(records), "selectedCount": len(recent),
                  "omittedCount": max(0, len(records) - 30), "modifiedAt": _iso(info.st_mtime)}
    except FileNotFoundError:
        source["state"] = "missing"
    except (OSError, ValueError, UnicodeError):
        pass
    projects, project_source = _projects(registry.parent.parent / "projects")
    runtime, runtime_source = _runtime_sessions(Path(runtime_dir) if runtime_dir is not None else Path.home() / ".claude" / "sessions", process_probe)
    tools = {key: {"label": label, "status": "unknown", "last_active": "", "rate_limited": False,
                   "role": "", "availability": "not_checked", "activity": "not_reported",
                   "connectionEvidence": "provider_not_contacted"} for key, label in TOOL_LABELS.items()}
    for task in [*(tasks or []), *runtime]:
        if task["tool"] and task["tool"] not in tools:
            tools[task["tool"]] = {**tools["codex"], "label": task["tool"]}
    active_expiry = [dt.datetime.fromisoformat(row["evidence"]["producerUpdatedAt"]).timestamp() + 120
                     for row in runtime if row["state"] == "running"]
    valid_for = min([15000, *[max(1, int((expires - dt.datetime.fromisoformat(checked).timestamp()) * 1000)) for expires in active_expiry]])
    return {"ok": True, "schemaVersion": 1, "checkedAt": checked, "validForMs": valid_for,
            "coverage": "recent_30_registered_work_and_claude_runtime_metadata_only",
            "sources": {"registry": source, "projects": project_source, "runtimeSessions": runtime_source},
            "tools": tools, "projects": projects, "dispatches": tasks, "runtimeSessions": runtime,
            "taskDataAvailable": source["state"] == "ready" or runtime_source["state"] in {"ready", "partial"}}
