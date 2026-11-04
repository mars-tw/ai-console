"""Pure, bounded parsing of terminal metadata; never returns input prose.

Callers must bind input to a whitelisted dispatch log before calling this.
Provider completion, task completion, and live process identity are separate.
This parser cannot establish filesystem delivery acceptance or descendant exit.
"""
from __future__ import annotations

import json
import re

MAX_TERMINAL_BYTES = 64 * 1024
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_EXIT_KEYS = ("exit_code", "exitCode", "returncode", "return_code")
_USAGE_LIMIT = re.compile(r"^(?:ERROR:\s*)?(?:You've|You have) hit your usage limit\b", re.I)
_QWEN_QUOTA = re.compile(r"(?im)^[^\r\n]{0,40}Quota exhausted:\s+Your token-plan\b[^\r\n]*quota has been exhausted\b")
_AUTH = re.compile(r"^(?:ERROR:\s*)?Failed to authenticate:\s*OAuth session expired\b", re.I)


def _empty(reason="no_trusted_terminal_receipt"):
    return {"runtimePhase": "not_observed", "taskOutcome": "unknown", "providerOutcome": "unknown", "reason": reason, "receiptKind": None, "structuredExitCode": None}


def _metadata(kind, provider, task, reason=None, code=None):
    return {"runtimePhase": "terminal_receipt", "taskOutcome": task, "providerOutcome": provider, "reason": reason or kind, "receiptKind": kind, "structuredExitCode": code}


def parse_terminal_metadata(data, tool, *, truncated=False, trusted_wrapper_receipt=False, trusted_claude_json_protocol=False):
    """Return only allowlisted enums and integer exit codes from <=64KiB.

    `truncated` says the caller supplied a suffix rather than a complete log.
    AGY's single JSON envelope requires a complete log, so a suffix cannot
    spoof a new top-level envelope. Last-line CLI diagnostics remain bounded.
    No bare PID absence, result string, nonempty log, or SUCCESS status alone
    is treated as proof that the requested work was completed.
    """
    if not isinstance(data, (bytes, str)):
        return _empty("invalid_log_input")
    raw = data.encode("utf-8") if isinstance(data, str) else data
    if len(raw) > MAX_TERMINAL_BYTES:
        raw = raw[-MAX_TERMINAL_BYTES:]
        truncated = True
    text = _ANSI.sub("", raw.decode("utf-8-sig", errors="replace")).strip()
    if not text:
        return _empty("empty_log_no_terminal_receipt")
    # These dispatches historically used a single AGY JSON envelope. A model
    # quotation of JSON embedded inside prose is deliberately not an envelope.
    envelope = None
    if not truncated and text.startswith("{"):
        try:
            candidate = json.loads(text)
            if isinstance(candidate, dict):
                envelope = candidate
        except (ValueError, TypeError):
            pass
    if envelope is not None:
        status = str(envelope.get("status") or "").upper()
        duration = envelope.get("duration_seconds")
        usage = envelope.get("usage")
        agy_shape = (tool == "gemini" and status in {"SUCCESS", "ERROR"}
                     and ("response" in envelope or "error" in envelope)
                     and (isinstance(duration, (int, float)) or isinstance(usage, dict)))
        if agy_shape:
            if status == "ERROR":
                return _metadata("agy_terminal_json", "failed", "failed")
            # Provider SUCCESS merely proves that a response was returned.
            # Payload acceptance must come from a separate validated receipt.
            response = envelope.get("response")
            if isinstance(response, str):
                embedded = parse_terminal_metadata(response, "worker", truncated=False)
                if embedded["taskOutcome"] in {"failed", "blocked"}:
                    return _metadata("agy_terminal_json", "succeeded", embedded["taskOutcome"], "provider_return_with_task_failure_receipt")
            return _metadata("agy_terminal_json", "succeeded", "unknown", "provider_return_without_task_completion_receipt")
        if (tool == "claude" and trusted_claude_json_protocol and envelope.get("type") == "result"
                and isinstance(envelope.get("is_error"), bool)
                and any(k in envelope for k in ("session_id", "duration_ms", "num_turns"))):
            if envelope["is_error"]:
                return _metadata("claude_terminal_json", "failed", "failed")
            return _metadata("claude_terminal_json", "succeeded", "unknown", "provider_return_without_task_completion_receipt")
        if trusted_wrapper_receipt and envelope.get("type") in {"process_exit", "dispatch_exit", "terminal_receipt"}:
            for key in _EXIT_KEYS:
                code = envelope.get(key)
                if isinstance(code, int) and not isinstance(code, bool):
                    return _metadata("structured_process_exit", "exited", "failed" if code else "unknown", "process_exit_without_task_completion_receipt", code)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    last = lines[-1]
    # A quoted/code-fenced diagnostic is not the current CLI's terminal report.
    if "```" in "\n".join(lines[-8:]) or last.startswith((">", "\"", "'")):
        return _empty("quoted_or_fenced_terminal_text")
    if tool == "codex" and _USAGE_LIMIT.search(last):
        return _metadata("codex_terminal_usage_limit", "failed", "failed")
    if tool == "qwen":
        suffix = "\n".join(lines[-8:])
        # Three jointly required machine-diagnostic features prevent a task's
        # ordinary discussion of quotas from masquerading as terminal failure.
        if (_QWEN_QUOTA.search(suffix)
                and re.search(r"\bcause:\s*insufficient_quota:\s*429\b", last, re.I)
                and re.search(r"\bquota\b.*\breset\b", last, re.I)):
            return _metadata("qwen_terminal_quota_exhausted", "failed", "failed")
    if tool in {"claude", "qwen", "grok", "kimi"} and _AUTH.search(last):
        return _metadata("cli_terminal_authentication_failure", "failed", "failed")
    return _empty()
