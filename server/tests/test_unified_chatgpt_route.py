# -*- coding: utf-8 -*-
"""Unified ChatGPT Conversation routing: legacy execution endpoints fail closed."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402


class FakeHandler(api.Handler):
    def __init__(self, path: str, body=None, same_origin: bool = True):
        self.path = path
        self.payload = {} if body is None else body
        self.same_origin = same_origin
        origin = sorted(self.ALLOWED_ORIGINS)[0]
        self.headers = {
            "Origin": origin,
            "Host": urllib.parse.urlsplit(origin).netloc,
            "Content-Type": "application/json",
        }
        self.response = None

    def _body(self):
        return self.payload

    def _json(self, payload, code=200):
        self.response = code, payload
        return self.response

    def _same_origin(self):
        return self.same_origin


class UnifiedChatGPTRouteTest(unittest.TestCase):
    def setUp(self):
        self.original_dispatches = api.Handler.DISPATCHES
        self.original_registry = api.Handler.REGISTRY
        api.Handler.DISPATCHES = []
        self.tmp = tempfile.TemporaryDirectory(prefix="ac_unified_route_")
        api.Handler.REGISTRY = Path(self.tmp.name) / "registry.json"

    def tearDown(self):
        api.Handler.DISPATCHES = self.original_dispatches
        api.Handler.REGISTRY = self.original_registry
        self.tmp.cleanup()

    def test_obsolete_public_execution_routes_return_actionable_409_without_calling_handlers(self):
        routes = {
            "/api/launch": "do_launch",
            "/api/schedule/save": "do_schedule_save",
            "/api/schedule/run": "do_schedule_run",
            "/api/dispatch": "do_dispatch",
            "/api/dispatch/batch": "do_dispatch_batch",
            "/api/dispatch/followup": "do_followup",
            "/api/dispatch/retry": "do_dispatch_retry",
        }
        for path, method_name in routes.items():
            with self.subTest(path=path), mock.patch.object(
                api.Handler, method_name, create=True,
                side_effect=AssertionError("legacy executor must not run"),
            ) as executor:
                handler = FakeHandler(path, {"task": "do work", "id": "old"})
                handler.do_POST()
                code, body = handler.response
                self.assertEqual(code, 409)
                self.assertFalse(body["ok"])
                self.assertEqual(body["code"], "USE_CHATGPT_CONVERSATION")
                self.assertEqual(body["nextAction"], "chatgpt_conversation")
                self.assertEqual(body["view"], "devspace")
                self.assertIn("ChatGPT", body["error"])
                executor.assert_not_called()

    def test_devspace_run_and_continue_are_desktop_checked_then_redirected(self):
        for path in ("/api/devspace/run", "/api/devspace/continue"):
            with self.subTest(path=path), mock.patch.object(
                api, "_devspace_console",
                side_effect=AssertionError("DevSpace background task API must not run"),
            ) as console:
                handler = FakeHandler(path, {"cwd": "C:\\work", "prompt": "task"})
                handler.do_POST()
                code, body = handler.response
                self.assertEqual(code, 409)
                self.assertEqual(body["code"], "USE_CHATGPT_CONVERSATION")
                console.assert_not_called()

    def test_untrusted_devspace_run_is_rejected_before_route_guidance(self):
        handler = FakeHandler("/api/devspace/run", {"prompt": "task"})
        handler.headers["Origin"] = "https://evil.example"
        handler.do_POST()
        code, body = handler.response
        self.assertEqual(code, 403)
        self.assertEqual(body["code"], "DESKTOP_ONLY")

    def test_cross_origin_legacy_execution_is_rejected_before_actionable_route(self):
        handler = FakeHandler("/api/dispatch", {"task": "work"}, same_origin=False)
        handler.do_POST()
        code, body = handler.response
        self.assertEqual(code, 403)
        self.assertNotEqual(body.get("code"), "USE_CHATGPT_CONVERSATION")

    def test_dispatch_history_get_is_observational_only(self):
        api.Handler.DISPATCHES = [{
            "id": "old-1", "tool": "claude", "task": "old", "started": "20260921-100000",
            "log": str(Path(self.tmp.name) / "missing.log"), "mode": "headless", "pid": None,
            "pending": ["must stay queued but must not run"],
        }]
        handler = FakeHandler("/api/dispatches")
        with mock.patch.object(api, "_alive_pids", return_value=set()), \
                mock.patch.object(api, "_has_git", return_value=False), \
                mock.patch.object(api.Handler, "_flush_pending") as flush, \
                mock.patch.object(api.Handler, "_auto_handoff") as handoff:
            handler.do_dispatches()
        code, body = handler.response
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["dispatches"][0]["pending"], ["must stay queued but must not run"])
        flush.assert_not_called()
        handoff.assert_not_called()

    def test_stop_and_cancel_existing_records_remain_routable(self):
        for path, method in (("/api/dispatch/stop", "do_dispatch_stop"),
                             ("/api/dispatch/cancel", "do_dispatch_cancel")):
            with self.subTest(path=path), mock.patch.object(
                api.Handler, method, return_value=("called", method),
            ) as action:
                handler = FakeHandler(path, {"id": "old"})
                result = handler.do_POST()
                self.assertEqual(result, ("called", method))
                action.assert_called_once_with()

    def test_server_source_does_not_start_background_schedule_dispatcher(self):
        source = Path(api.__file__).read_text(encoding="utf-8")
        main = source[source.index('if __name__ == "__main__":'):]
        self.assertNotIn("sched.start()", main)
        self.assertNotIn("schedule.Scheduler(", main)
        self.assertIn("已停用自動執行", main)


if __name__ == "__main__":
    unittest.main()
