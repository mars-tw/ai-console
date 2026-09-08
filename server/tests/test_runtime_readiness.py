# -*- coding: utf-8 -*-
"""runtime_readiness 的行為測試：全部是純函式，不需要任何 fixture。"""

import os
import sys
import unittest

_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)

import runtime_readiness as rr  # noqa: E402

CLOUD_CHAIN = ["claude", "codex", "gemini"]
TERMINAL_TOOLS = ["warp", "aider"]
LABELS = {
    "claude": "Claude Code",
    "codex": "Codex",
    "gemini": "Gemini CLI",
    "aider": "Aider",
    "warp": "Warp",
    "local": "本機模型",
}

# 本機 API 可能回報的幾種樣子（唯讀，測試只是複製它的輸出）
LOCAL_COLD = {
    "models": [],
    "available": False,
    "installed": False,
    "ready": False,
    "model": None,
    "loaded": [],
    "state": "unknown",
    "reason": "找不到本機模型服務",
}
LOCAL_NEEDS_START = {
    "models": ["qwen3-8b"],
    "available": True,
    "installed": True,
    "ready": True,
    "model": "qwen3-8b",
    "loaded": [],
    "state": "needs_start",
    "reason": "送出時才會載入模型",
}
LOCAL_READY = {
    "models": ["qwen3-8b"],
    "available": True,
    "installed": True,
    "ready": True,
    "model": "qwen3-8b",
    "loaded": ["qwen3-8b"],
    "state": "ready",
    "reason": "已載入 qwen3-8b",
}


def build(installed=(), limited=(), reasons=None, local=LOCAL_COLD,
          cloud_chain=None, terminal_tools=None):
    installed = set(installed)
    return rr.build_snapshot(
        cloud_chain=CLOUD_CHAIN if cloud_chain is None else cloud_chain,
        terminal_tools=TERMINAL_TOOLS if terminal_tools is None else terminal_tools,
        labels=LABELS,
        available=lambda tool: tool in installed,
        limited=set(limited),
        reasons=reasons or {},
        local=local,
    )


def row_of(snapshot, tool):
    for row in snapshot["tools"]:
        if row["id"] == tool:
            return row
    return None


class BuildSnapshotTest(unittest.TestCase):
    def test_no_installed_tool_and_cold_local_gives_no_auto(self):
        snap = build(installed=(), local=LOCAL_COLD)

        self.assertTrue(snap["ok"])
        self.assertIsNone(snap["auto"])
        self.assertFalse(snap["ready"])
        self.assertEqual(snap["nextAction"], rr.NEXT_ACTION_SETUP)
        self.assertEqual(snap["reason"], rr.NO_TOOL_REASON)
        # 只剩本機那一列
        self.assertEqual([row["id"] for row in snap["tools"]], ["local"])

    def test_not_limited_is_not_the_same_as_ready(self):
        """沒有限額只代表沒被擋，不代表可以用。"""
        snap = build(installed=(), limited=(), local=LOCAL_COLD)
        local = snap["local"]

        self.assertFalse(local["limited"])
        self.assertFalse(local["ready"])
        self.assertEqual(local["readiness"], rr.READINESS_UNKNOWN)
        self.assertEqual(local["nextAction"], rr.NEXT_ACTION_SETUP)
        self.assertIsNone(snap["auto"])

    def test_local_ready_flag_alone_does_not_win_when_state_unknown(self):
        odd = dict(LOCAL_COLD, ready=True, state="unknown")
        snap = build(installed=(), local=odd)

        self.assertFalse(snap["local"]["ready"])
        self.assertIsNone(snap["auto"])

    def test_installed_cli_row_stays_neutral_about_login(self):
        snap = build(installed={"claude"})
        row = row_of(snap, "claude")

        self.assertTrue(row["installed"])
        self.assertTrue(row["ready"])
        self.assertFalse(row["limited"])
        self.assertEqual(row["mode"], rr.CLOUD)
        self.assertEqual(row["mode"], "headless")
        self.assertEqual(row["state"], rr.STATE_LOGIN_UNVERIFIED)
        self.assertEqual(row["readiness"], rr.READINESS_INSTALLED_UNVERIFIED)
        self.assertEqual(row["authStatus"], rr.AUTH_UNKNOWN)
        self.assertEqual(row["reason"], rr.NEUTRAL_CLI_REASON)
        self.assertNotIn("nextAction", row)
        self.assertEqual(snap["auto"], "claude")

    def test_limited_tool_is_never_chosen(self):
        snap = build(
            installed={"claude", "codex"},
            limited={"claude"},
            reasons={"claude": "額度用完，凌晨重置"},
        )
        row = row_of(snap, "claude")

        self.assertFalse(row["ready"])
        self.assertTrue(row["limited"])
        self.assertEqual(row["state"], rr.STATE_LIMITED)
        self.assertEqual(row["readiness"], rr.READINESS_NEEDS_SETUP)
        self.assertEqual(row["reason"], "額度用完，凌晨重置")
        self.assertEqual(row["nextAction"], rr.NEXT_ACTION_SETUP)
        # 順位往後遞補，而不是硬用被限額的那個
        self.assertEqual(snap["auto"], "codex")

    def test_limited_row_falls_back_to_default_reason(self):
        snap = build(installed={"claude"}, limited={"claude"}, reasons={})

        self.assertEqual(row_of(snap, "claude")["reason"], rr.LIMITED_FALLBACK_REASON)

    def test_terminal_tool_is_listed_but_never_auto(self):
        snap = build(installed={"aider"}, local=LOCAL_COLD)
        row = row_of(snap, "aider")

        self.assertEqual(row["mode"], rr.TERMINAL)
        self.assertTrue(row["ready"])
        # 就緒也不會被自動選中
        self.assertIsNone(snap["auto"])
        self.assertFalse(snap["ready"])
        self.assertEqual(snap["nextAction"], rr.NEXT_ACTION_SETUP)

    def test_local_needs_start_is_prepare_on_send_and_ready(self):
        snap = build(installed=(), local=LOCAL_NEEDS_START)
        local = snap["local"]

        self.assertEqual(local["state"], rr.STATE_NEEDS_START)
        self.assertEqual(local["readiness"], rr.READINESS_PREPARE_ON_SEND)
        self.assertTrue(local["ready"])
        self.assertEqual(local["mode"], rr.LOCAL)
        self.assertEqual(local["authStatus"], rr.AUTH_NOT_REQUIRED)
        self.assertFalse(local["limited"])
        self.assertNotIn("nextAction", local)
        self.assertEqual(snap["auto"], "local")
        self.assertTrue(snap["ready"])

    def test_local_ready_state_keeps_ready_readiness(self):
        snap = build(installed=(), local=LOCAL_READY)

        self.assertEqual(snap["local"]["readiness"], rr.READINESS_READY)
        self.assertTrue(snap["local"]["ready"])
        self.assertEqual(snap["auto"], "local")

    def test_contradictory_ready_local_without_models_fails_closed(self):
        odd = dict(LOCAL_READY, models=[], available=False)
        snap = build(installed=(), local=odd)

        self.assertFalse(snap["local"]["ready"])
        self.assertEqual(snap["local"]["state"], rr.STATE_UNKNOWN)
        self.assertEqual(snap["local"]["loaded"], ["qwen3-8b"])
        self.assertIsNone(snap["auto"])

    def test_local_ready_requires_a_list_shaped_loaded_field(self):
        odd = dict(LOCAL_READY, loaded=True)
        snap = build(installed=(), local=odd)

        self.assertFalse(snap["local"]["ready"])
        self.assertEqual(snap["local"]["loaded"], [])

    def test_local_ready_requires_loaded_model_key_to_match_selected_model(self):
        odd = dict(LOCAL_READY, loaded=["some-other-model"])
        snap = build(installed=(), local=odd)

        self.assertFalse(snap["local"]["ready"])
        self.assertEqual(snap["local"]["state"], rr.STATE_UNKNOWN)

    def test_local_accepts_callback(self):
        snap = build(installed=(), local=lambda: LOCAL_NEEDS_START)

        self.assertTrue(snap["local"]["ready"])
        self.assertEqual(snap["auto"], "local")

    def test_cloud_beats_ready_local(self):
        snap = build(installed={"codex"}, local=LOCAL_READY)

        self.assertEqual(snap["auto"], "codex")

    def test_rows_follow_cloud_chain_then_sorted_terminal_without_duplicates(self):
        snap = build(
            installed={"claude", "codex", "gemini", "aider", "warp"},
            terminal_tools=["warp", "aider", "codex"],
        )

        self.assertEqual(
            [row["id"] for row in snap["tools"]],
            ["claude", "codex", "gemini", "aider", "warp", "local"],
        )
        self.assertEqual(row_of(snap, "codex")["mode"], rr.CLOUD)

    def test_uninstalled_tools_are_left_out(self):
        snap = build(installed={"gemini"})

        self.assertEqual([row["id"] for row in snap["tools"]], ["gemini", "local"])

    def test_every_row_carries_the_full_contract(self):
        snap = build(installed={"claude", "aider"}, limited={"aider"}, local=LOCAL_READY)
        keys = {"id", "label", "mode", "installed", "ready", "state",
                "readiness", "authStatus", "limited", "reason"}

        for row in snap["tools"]:
            self.assertTrue(keys.issubset(row), row["id"])


class ResolveDispatchTest(unittest.TestCase):
    def test_auto_resolves_exactly_the_snapshot_auto(self):
        snap = build(installed={"claude", "codex"})

        for requested in ("auto", None, "", "  auto  "):
            tool, err = rr.resolve_dispatch(snap, requested)
            self.assertIsNone(err)
            self.assertEqual(tool, snap["auto"])

    def test_auto_rechecks_its_row_not_just_the_snapshot_value(self):
        snap = build(installed={"claude"})
        row = row_of(snap, "claude")
        row["ready"] = False
        tool, err = rr.resolve_dispatch(snap, "auto")

        self.assertIsNone(tool)
        self.assertFalse(err["ok"])

    def test_auto_never_accepts_a_terminal_row_even_if_snapshot_is_corrupt(self):
        snap = build(installed={"aider"})
        snap["auto"] = "aider"
        tool, err = rr.resolve_dispatch(snap, "auto")

        self.assertIsNone(tool)
        self.assertFalse(err["ok"])

    def test_auto_without_any_ready_tool_fails_closed(self):
        snap = build(installed=(), local=LOCAL_COLD)
        tool, err = rr.resolve_dispatch(snap, "auto")

        self.assertIsNone(tool)
        self.assertFalse(err["ok"])
        self.assertFalse(err["ready"])
        self.assertEqual(err["nextAction"], rr.NEXT_ACTION_SETUP)
        self.assertTrue(err["error"])

    def test_explicit_ready_tool_is_used(self):
        snap = build(installed={"claude", "codex"})
        tool, err = rr.resolve_dispatch(snap, "codex")

        self.assertIsNone(err)
        self.assertEqual(tool, "codex")

    def test_explicit_terminal_tool_is_allowed_when_asked_for(self):
        """終端機工具不會被自動挑中，但明講就照做。"""
        snap = build(installed={"aider"})
        tool, err = rr.resolve_dispatch(snap, "aider")

        self.assertIsNone(err)
        self.assertEqual(tool, "aider")

    def test_explicit_local_allowed_when_ready(self):
        snap = build(installed={"claude"}, local=LOCAL_NEEDS_START)
        tool, err = rr.resolve_dispatch(snap, "local")

        self.assertIsNone(err)
        self.assertEqual(tool, "local")

    def test_explicit_limited_tool_never_reroutes(self):
        snap = build(
            installed={"claude", "codex"},
            limited={"claude"},
            reasons={"claude": "額度用完"},
            local=LOCAL_READY,
        )
        tool, err = rr.resolve_dispatch(snap, "claude")

        self.assertIsNone(tool)
        self.assertNotEqual(tool, "local")
        self.assertNotEqual(tool, "codex")
        self.assertFalse(err["ok"])
        self.assertFalse(err["ready"])
        self.assertEqual(err["nextAction"], rr.NEXT_ACTION_SETUP)
        self.assertIn("額度用完", err["error"])

    def test_unknown_tool_fails_closed_and_names_it(self):
        snap = build(installed={"claude"}, local=LOCAL_READY)
        tool, err = rr.resolve_dispatch(snap, "nope")

        self.assertIsNone(tool)
        self.assertFalse(err["ok"])
        self.assertFalse(err["ready"])
        self.assertEqual(err["nextAction"], rr.NEXT_ACTION_SETUP)
        self.assertIn("nope", err["error"])

    def test_uninstalled_tool_is_not_silently_replaced(self):
        snap = build(installed={"codex"}, local=LOCAL_READY)
        tool, err = rr.resolve_dispatch(snap, "gemini")

        self.assertIsNone(tool)
        self.assertIsNotNone(err)

    def test_missing_ready_flag_fails_closed(self):
        snap = build(installed={"claude"})
        row = row_of(snap, "claude")
        del row["ready"]

        tool, err = rr.resolve_dispatch(snap, "claude")

        self.assertIsNone(tool)
        self.assertFalse(err["ok"])
        self.assertFalse(err["ready"])
        self.assertEqual(err["nextAction"], rr.NEXT_ACTION_SETUP)

    def test_empty_snapshot_fails_closed(self):
        tool, err = rr.resolve_dispatch({}, "auto")

        self.assertIsNone(tool)
        self.assertEqual(err["error"], rr.NO_TOOL_REASON)

        tool, err = rr.resolve_dispatch(None, "claude")
        self.assertIsNone(tool)
        self.assertFalse(err["ok"])


if __name__ == "__main__":
    unittest.main()
