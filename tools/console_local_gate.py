#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Portable, read-only local-model admission gate for AI Console.

It deliberately never loads/unloads models, changes LM Studio runtime, starts a
server, calls providers, or touches credentials.  API code owns lifecycle
mutations and invokes this executable immediately before/after those actions.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


RUNTIME_ID = "llama.cpp-win-x86_64-avx2@2.24.0"
_MAX_JSON = 128 * 1024
_MAX_OUTPUT = 16 * 1024
_OWNER = re.compile(r"[0-9a-f]{10}\Z")
_BAD = re.compile(r"[^A-Za-z0-9._-]+")
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_HEADER = re.compile(r"\s*LLM ENGINE\s+SELECTED\s+MODEL FORMAT\s*\Z")
_RUNTIME_ROW = re.compile(
    r"\s*(?P<engine>[^\s]+)(?:\s+(?P<selected>✓))?\s+(?P<format>GGUF)\s*\Z"
)
_DIGITS = re.compile(r"[0-9]{1,10}")
_GPU_UUID = re.compile(
    r"GPU-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
)
_PCI_VENDOR = re.compile(r"\APCI\\VEN_([0-9A-Fa-f]{4})(?:&|\Z)", re.IGNORECASE)
_NVIDIA_VENDOR_ID = "10DE"
_NON_NVIDIA_VENDOR_IDS = frozenset({"8086", "1002"})
_NVIDIA_VENDOR_NAMES = frozenset({"nvidia", "nvidia corporation"})
_LM_TOKENS = ("lm studio", "lmstudio", "lm-studio", "lm_studio",
              "llama.cpp", "llama-server", "llama_server")
_MANIFEST_NAME = "llama.cpp-win-x86_64-avx2"
_MANIFEST_VERSION = "2.24.0"
_MIN_LMSTUDIO_VERSION = "0.4.0+15"
_ENGINE_EXECUTABLE = "llama-server.exe"
_DISPLAY_NAME = "CPU llama.cpp (Windows)"
_DISPLAY_DESCRIPTION = "CPU-only llama.cpp engine"
# nvidia-smi reports unavailable per-process memory as N/A or [N/A]; neither is
# a zero-usage or safety proof.
_MEMORY_UNAVAILABLE = frozenset({"n/a", "[n/a]"})
# Constant ASCII command: no interpolation of external data, explicit UTF-8
# stdout and one explicitly serialized array for 0/1/many controller rows.
# Output is emitted verbatim: blank or non-array serialization stays unknown and
# is never rewritten into an empty (headless) array.
_ADAPTER_PS_COMMAND = (
    "$ErrorActionPreference='Stop'; "
    "[Console]::OutputEncoding=(New-Object System.Text.UTF8Encoding $false); "
    "$taskSpecificRows=@(Get-CimInstance -ClassName Win32_VideoController | "
    "Select-Object -Property Name,PNPDeviceID,AdapterCompatibility,ConfigManagerErrorCode); "
    "$taskSpecificJson=ConvertTo-Json -InputObject $taskSpecificRows -Depth 3 -Compress; "
    "[Console]::Out.Write($taskSpecificJson)"
)


def _result(ok, phase, code, reason, *, step=None, runtime=None,
            adapter="unknown", gpu_verification="unavailable", hardware=False):
    return {
        "ok": bool(ok), "verdict": "CPU_ONLY" if ok else "BLOCKED", "phase": phase,
        "code": code, "reason": reason, "nextAction": None if ok else "setup",
        "setupStep": step, "runtime": runtime or {
            "id": RUNTIME_ID, "installed": False, "selected": False, "verified": False,
        },
        "adapterClass": adapter, "gpuVerification": gpu_verification,
        "hardwareVerified": bool(hardware),
    }


def _run(argv, timeout, runner=subprocess.run):
    return runner(argv, capture_output=True, text=True, encoding="utf-8",
                  errors="replace", timeout=timeout,
                  **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))


def _parse_json_text(text):
    if not isinstance(text, str) or len(text) > _MAX_JSON:
        raise ValueError("empty")
    text = text.lstrip(chr(0xFEFF)).strip()
    if not text:
        raise ValueError("empty")
    value = json.loads(text)
    return value


def _strict_loaded(lms_bin: Path, runner=subprocess.run):
    try:
        result = _run([str(lms_bin), "ps", "--json"], 15, runner)
    except Exception:
        raise ValueError("MODEL_STATE_UNKNOWN") from None
    if result.returncode != 0:
        raise ValueError("MODEL_STATE_UNKNOWN")
    try:
        data = _parse_json_text(result.stdout)
    except (ValueError, TypeError, json.JSONDecodeError):
        raise ValueError("MODEL_STATE_UNKNOWN") from None
    if isinstance(data, dict):
        if isinstance(data.get("models"), list):
            data = data["models"]
        elif isinstance(data.get("data"), list):
            data = data["data"]
        else:
            raise ValueError("MODEL_STATE_UNKNOWN")
    if not isinstance(data, list):
        raise ValueError("MODEL_STATE_UNKNOWN")
    rows = []
    for row in data:
        if not isinstance(row, dict):
            raise ValueError("MODEL_STATE_UNKNOWN")
        model, identifier = row.get("modelKey"), row.get("identifier")
        if (not isinstance(model, str) or not model or not isinstance(identifier, str)
                or not identifier or any(ord(ch) < 32 for ch in model + identifier)):
            raise ValueError("MODEL_STATE_UNKNOWN")
        rows.append({"modelKey": model, "identifier": identifier})
    return rows


def _runtime_table(lms_bin: Path, runner=subprocess.run):
    try:
        result = _run([str(lms_bin), "runtime", "ls"], 30, runner)
    except Exception:
        raise ValueError("RUNTIME_READBACK_UNKNOWN") from None
    if result.returncode != 0:
        raise ValueError("RUNTIME_READBACK_UNKNOWN")
    text = _ANSI.sub("", result.stdout or "").strip()
    if not text:
        raise ValueError("RUNTIME_READBACK_UNKNOWN")
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    if not lines or not _HEADER.fullmatch(lines[0]):
        raise ValueError("RUNTIME_READBACK_UNKNOWN")
    rows, selected = [], []
    for line in lines[1:]:
        match = _RUNTIME_ROW.fullmatch(line)
        if not match:
            raise ValueError("RUNTIME_READBACK_UNKNOWN")
        row = {"id": match.group("engine"), "selected": bool(match.group("selected")),
               "format": match.group("format")}
        rows.append(row)
        if row["selected"]:
            selected.append(row)
    if len(selected) != 1:
        raise ValueError("RUNTIME_READBACK_UNKNOWN")
    return rows, selected[0]


def _bounded_file_json(path: Path):
    try:
        if not path.is_file() or path.stat().st_size > _MAX_JSON:
            raise ValueError()
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
        raise ValueError("CPU_RUNTIME_METADATA_INVALID") from None


def _exact(value, expected):
    return isinstance(value, str) and value == expected


def _list_contains(value, expected):
    """Array membership only: a plain string such as "AVX2 AVX512" never passes."""
    return isinstance(value, list) and any(_exact(item, expected) for item in value)


def _valid_manifest(manifest):
    """backend-manifest.json keeps the executable path nested under the engine
    protocol server block, never at the top level."""
    if not isinstance(manifest, dict):
        return False
    cpu = manifest.get("cpu")
    protocol = manifest.get("engine_protocol_server")
    if not isinstance(cpu, dict) or not isinstance(protocol, dict):
        return False
    return bool(
        _exact(manifest.get("name"), _MANIFEST_NAME)
        and _exact(manifest.get("version"), _MANIFEST_VERSION)
        and _exact(manifest.get("platform"), "win")
        and _exact(manifest.get("engine"), "llama.cpp")
        and _exact(manifest.get("extension_type"), "engine")
        and _exact(manifest.get("minimum_lmstudio_version"), _MIN_LMSTUDIO_VERSION)
        and _exact(cpu.get("architecture"), "x86_64")
        and _list_contains(cpu.get("instruction_set_extensions"), "AVX2")
        and _list_contains(manifest.get("domains"), "llm")
        and _list_contains(manifest.get("supported_model_formats"), "gguf")
        and _exact(protocol.get("runtime_kind"), "llama-server")
        and _exact(protocol.get("executable_relative_path"), _ENGINE_EXECUTABLE)
    )


def _english_display(display):
    """display-data.json is a list of [languageKey, entry] pairs, not a dict.

    Exactly one well-formed English entry must exist; duplicates, malformed
    pairs, wrong types or missing fields fail closed.
    """
    if not isinstance(display, list) or not display:
        return None
    english = None
    for pair in display:
        if not isinstance(pair, list) or len(pair) != 2:
            return None
        key, entry = pair
        if not isinstance(key, str) or not key or not isinstance(entry, dict):
            return None
        notes = entry.get("releaseNotes")
        if notes is not None and not isinstance(notes, list):
            return None
        lang = entry.get("langKey")
        if lang is not None and not isinstance(lang, str):
            return None
        if key != "en":
            continue
        if english is not None:
            return None
        english = entry
    if english is None or not _exact(english.get("langKey"), "en"):
        return None
    if not (_exact(english.get("displayName"), _DISPLAY_NAME)
            and _exact(english.get("description"), _DISPLAY_DESCRIPTION)):
        return None
    return english


def runtime_metadata(home=None):
    home = Path.home() if home is None else Path(home)
    root = home / ".lmstudio" / "extensions" / "backends" / "llama.cpp-win-x86_64-avx2-2.24.0"
    manifest = _bounded_file_json(root / "backend-manifest.json")
    display = _bounded_file_json(root / "display-data.json")
    if not _valid_manifest(manifest) or _english_display(display) is None:
        raise ValueError("CPU_RUNTIME_METADATA_INVALID")
    return {"id": RUNTIME_ID, "installed": True, "selected": False, "verified": True,
            "displayName": _DISPLAY_NAME, "minimumLMStudioVersion": _MIN_LMSTUDIO_VERSION,
            "helpUrl": "https://lmstudio.ai/docs/app"}


def _adapter_field(row, key):
    """Scalar string or absent; dict/list/number/control text is malformed."""
    value = row.get(key)
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > 512 or any(ord(ch) < 32 for ch in value):
        return None
    return value


def _pci_vendor_id(pnp):
    match = _PCI_VENDOR.match(pnp or "")
    return match.group(1).upper() if match else None


def _adapter_row_kind(row):
    if not isinstance(row, dict):
        return "unknown"
    name = _adapter_field(row, "Name")
    pnp = _adapter_field(row, "PNPDeviceID")
    vendor = _adapter_field(row, "AdapterCompatibility")
    if name is None or pnp is None or vendor is None:
        return "unknown"
    vendor_id = _pci_vendor_id(pnp)
    if vendor_id == _NVIDIA_VENDOR_ID or vendor.strip().casefold() in _NVIDIA_VENDOR_NAMES:
        return "nvidia"
    if vendor_id in _NON_NVIDIA_VENDOR_IDS:
        return "non_nvidia"
    return "unknown"


def _adapter_class(runner=subprocess.run):
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    powershell = system_root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    try:
        result = _run([str(powershell), "-NoProfile", "-NonInteractive", "-Command",
                       _ADAPTER_PS_COMMAND], 15, runner)
        if result.returncode != 0:
            raise ValueError()
        rows = _parse_json_text(result.stdout)
    except Exception:
        return "unknown"
    if not isinstance(rows, list) or len(rows) > 64:
        return "unknown"
    if not rows:
        return "headless"
    kinds = {_adapter_row_kind(row) for row in rows}
    if "nvidia" in kinds:
        return "nvidia"
    return "non_nvidia" if kinds == {"non_nvidia"} else "unknown"


def _canonical_gpu_uuid(value):
    text = (value or "").strip()
    if not _GPU_UUID.fullmatch(text):
        return None
    return "GPU-" + text[4:].casefold()


def _is_lm_process(name):
    text = (name or "").replace("/", "\\").strip().casefold()
    return any(token in text for token in _LM_TOKENS)


def _blank_row(row):
    return not row or (len(row) == 1 and not row[0].strip())


def _nvidia_clean(runner=subprocess.run, *, has_loaded=True):
    """GPU0 protection.  ``has_loaded`` must be supplied by the caller; the
    default fails closed so an accidental call still blocks GPU0 LM context."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return False, "GPU_TELEMETRY_UNAVAILABLE"
    try:
        gpus = _run([exe, "--query-gpu=index,uuid", "--format=csv,noheader,nounits"], 10, runner)
        apps = _run([exe, "--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"], 10, runner)
    except Exception:
        return False, "GPU_TELEMETRY_UNAVAILABLE"
    if gpus.returncode != 0 or apps.returncode != 0:
        return False, "GPU_TELEMETRY_UNAVAILABLE"
    gpu_text, app_text = gpus.stdout or "", apps.stdout or ""
    if not isinstance(gpu_text, str) or not isinstance(app_text, str):
        return False, "GPU_TELEMETRY_UNAVAILABLE"
    if len(gpu_text) > _MAX_OUTPUT or len(app_text) > _MAX_OUTPUT:
        return False, "GPU_TELEMETRY_UNAVAILABLE"
    try:
        gpu_rows = list(csv.reader(gpu_text.splitlines()))
        app_rows = list(csv.reader(app_text.splitlines()))
    except (csv.Error, ValueError):
        return False, "GPU_TELEMETRY_UNAVAILABLE"
    uuid_to_index, seen_index = {}, set()
    for row in gpu_rows:
        if _blank_row(row):
            continue
        if len(row) != 2:
            return False, "GPU_TELEMETRY_UNAVAILABLE"
        index, uuid = row[0].strip(), _canonical_gpu_uuid(row[1])
        if (uuid is None or not _DIGITS.fullmatch(index)
                or (len(index) > 1 and index.startswith("0"))
                or uuid in uuid_to_index or index in seen_index):
            return False, "GPU_TELEMETRY_UNAVAILABLE"
        uuid_to_index[uuid] = index
        seen_index.add(index)
    if not uuid_to_index or "0" not in seen_index:
        return False, "GPU_TELEMETRY_UNAVAILABLE"
    for row in app_rows:
        if _blank_row(row):
            continue
        if len(row) != 4:
            return False, "GPU_TELEMETRY_UNAVAILABLE"
        uuid = _canonical_gpu_uuid(row[0])
        pid, process, memory = row[1].strip(), row[2].strip(), row[3].strip()
        if (uuid is None or uuid not in uuid_to_index
                or not _DIGITS.fullmatch(pid) or int(pid) <= 0 or not process
                or not (_DIGITS.fullmatch(memory)
                        or memory.casefold() in _MEMORY_UNAVAILABLE)):
            return False, "GPU_TELEMETRY_UNAVAILABLE"
        if uuid_to_index[uuid] == "0" and _is_lm_process(process) and has_loaded:
            return False, "GPU0_LM_PROCESS_ACTIVE"
    return True, "GPU0_VERIFIED_IDLE"


def _owned_identifier(model_key, nonce):
    key = _BAD.sub("-", model_key).strip("-")[:48] or "model"
    return f"ai-console-{nonce}-{key}"


def evaluate(args, runner=subprocess.run, home=None):
    runtime = {"id": RUNTIME_ID, "installed": False, "selected": False, "verified": False}
    if args.runtime != RUNTIME_ID:
        return _result(False, args.phase, "RUNTIME_NOT_ALLOWED", "必須使用指定的 CPU runtime。", step="runtime", runtime=runtime)
    lms = Path(args.lms_bin)
    if not lms.is_absolute() or lms.name.casefold() != "lms.exe" or not lms.is_file():
        return _result(False, args.phase, "LMS_EXECUTABLE_UNAVAILABLE", "找不到可驗證的 LM Studio 執行檔。", step="runtime", runtime=runtime)
    if not _OWNER.fullmatch(args.owner_nonce or ""):
        return _result(False, args.phase, "OWNER_NONCE_INVALID", "本機模型所有權無法確認。", step="model", runtime=runtime)
    if (args.identifier and (len(args.identifier) > 160 or any(ord(ch) < 32 for ch in args.identifier))
            or args.model_key and (len(args.model_key) > 512 or any(ord(ch) < 32 for ch in args.model_key))):
        return _result(False, args.phase, "GATE_ARGUMENT_INVALID", "地端安全把關參數無效。", step="gate", runtime=runtime)
    try:
        runtime = runtime_metadata(home)
    except ValueError:
        return _result(False, args.phase, "CPU_RUNTIME_METADATA_INVALID", "找不到指定的 CPU runtime 2.24.0。", step="runtime", runtime=runtime)
    try:
        loaded = _strict_loaded(lms, runner)
    except ValueError:
        return _result(False, args.phase, "MODEL_STATE_UNKNOWN", "無法確認目前本機模型狀態。", step="model", runtime=runtime)
    if args.phase == "pre":
        if args.identifier or args.model_key or loaded:
            return _result(False, args.phase, "MODEL_STATE_NOT_EMPTY", "LM Studio 已有模型，不能安全準備新模型。", step="model", runtime=runtime)
    else:
        if (not args.identifier or not args.model_key
                or args.identifier != _owned_identifier(args.model_key, args.owner_nonce)
                or len(loaded) != 1 or loaded[0]["identifier"] != args.identifier
                or loaded[0]["modelKey"] != args.model_key):
            return _result(False, args.phase, "MODEL_OWNERSHIP_UNVERIFIED", "本機模型所有權無法確認。", step="model", runtime=runtime)
    try:
        _, selected = _runtime_table(lms, runner)
        runtime["selected"] = selected["id"] == RUNTIME_ID
    except ValueError:
        if args.phase != "pre":
            return _result(False, args.phase, "RUNTIME_READBACK_UNKNOWN", "無法確認 CPU runtime 是否已選取。", step="runtime", runtime=runtime)
        selected = None
    if args.phase != "pre" and (selected is None or selected["id"] != RUNTIME_ID):
        return _result(False, args.phase, "CPU_RUNTIME_NOT_SELECTED", "請在 LM Studio Runtime Manager 選擇 CPU llama.cpp (Windows) 2.24.0。", step="runtime", runtime=runtime)
    adapter = _adapter_class(runner)
    if adapter == "unknown":
        return _result(False, args.phase, "ADAPTER_STATE_UNKNOWN", "無法確認顯示卡狀態。", step="hardware", runtime=runtime, adapter=adapter)
    if adapter == "nvidia":
        clean, code = _nvidia_clean(runner, has_loaded=bool(loaded))
        if not clean:
            return _result(False, args.phase, code, "GPU0 狀態無法安全確認。", step="hardware", runtime=runtime, adapter=adapter)
        runtime["verified"] = True
        return _result(True, args.phase, "CPU_RUNTIME_VERIFIED", "CPU runtime 與 GPU0 保護已驗證。", runtime=runtime, adapter=adapter, gpu_verification="verified", hardware=True)
    runtime["verified"] = True
    return _result(True, args.phase, "CPU_RUNTIME_VERIFIED", "CPU runtime 已驗證。", runtime=runtime, adapter=adapter, gpu_verification="not_applicable", hardware=False)


def main(argv=None):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--lms-bin", required=True)
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--phase", required=True, choices=("pre", "post", "reuse"))
    parser.add_argument("--owner-nonce", required=True)
    parser.add_argument("--identifier")
    parser.add_argument("--model-key")
    try:
        args = parser.parse_args(argv)
        if not args.json:
            raise ValueError()
        out = evaluate(args)
    except Exception:
        out = _result(False, "pre", "GATE_ARGUMENT_INVALID", "地端安全把關參數無效。", step="gate")
    print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    return 0 if out["ok"] and out["verdict"] == "CPU_ONLY" else 2


if __name__ == "__main__":
    raise SystemExit(main())
