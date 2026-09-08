# -*- coding: utf-8 -*-
"""expectedMode guards for novice continue-work dispatch."""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402

HEADLESS_ROW = {
    "id": "claude", "label": "Claude", "mode": "headless",
    "ready": True, "limited": False, "state": "ready",
}
HEADLESS_SNAPSHOT = {
    "ok": True, "tools": [HEADLESS_ROW], "auto": "claude", "ready": True, "reason": "safe",
}


class RealJsonHandler(api.Handler):
    """契約探針：真實 Handler._json 不回傳值，mode_error 不能靠 if mode_error 擋副作用。"""

    def __init__(self, body=None):
        self.payload = body or {}
        self.last_status = None
        self.last_payload = None

    def _body(self):
        return self.payload

    def _json(self, payload, code=200):
        self.last_status = code
        self.last_payload = payload


class ContinueModeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ac_continue_mode_"))
        self.log_dir = self.tmp / "ai-hub" / "dispatch-log"
        self.log_dir.mkdir(parents=True)
        self._dispatches = api.Handler.DISPATCHES
        self._registry = api.Handler.REGISTRY
        api.Handler.DISPATCHES = []
        api.Handler.REGISTRY = self.tmp / "registry.json"
        self._orig_home = api.Path.home

    def tearDown(self):
        api.Handler.DISPATCHES = self._dispatches
        api.Handler.REGISTRY = self._registry
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _patch_home(self):
        return mock.patch.object(api.Path, 'home', return_value=self.tmp)

    def test_unknown_expected_mode_400_before_side_effects(self):
        handler = RealJsonHandler({"task": "work", "tool": "claude", "expectedMode": "sync"})
        with mock.patch.object(api.Handler, "_load_registry"), \
                mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                  return_value=(HEADLESS_SNAPSHOT, "claude", HEADLESS_ROW, None)), \
                mock.patch.object(api.rules, "wrap") as wrap, \
                mock.patch("subprocess.Popen") as spawn:
            handler.do_dispatch()
        self.assertEqual(handler.last_status, 400)
        self.assertFalse(handler.last_payload["ok"])
        wrap.assert_not_called()
        spawn.assert_not_called()

    def test_headless_mismatch_409_before_spawn_real_json_contract(self):
        handler = RealJsonHandler({"task": "work", "tool": "cursor", "expectedMode": "headless"})
        cursor_row = {**HEADLESS_ROW, "id": "cursor", "mode": "terminal"}
        snap = {**HEADLESS_SNAPSHOT, "tools": [cursor_row], "auto": None}
        with mock.patch.object(api.Handler, "_load_registry"), \
                mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                  return_value=(snap, "cursor", cursor_row, None)), \
                mock.patch.object(api.rules, "wrap") as wrap, \
                mock.patch("subprocess.Popen") as spawn:
            handler.do_dispatch()
        self.assertEqual(handler.last_status, 409)
        self.assertIn("不符合", handler.last_payload["error"])
        wrap.assert_not_called()
        spawn.assert_not_called()
        self.assertEqual(list(self.log_dir.glob("*")), [])

    def test_legacy_dispatch_without_expected_mode_unchanged(self):
        handler = RealJsonHandler({"task": "work", "tool": "claude", "raw": True})
        with self._patch_home(), \
                mock.patch.object(api.Handler, "_load_registry"), \
                mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                  return_value=(HEADLESS_SNAPSHOT, "claude", HEADLESS_ROW, None)), \
                mock.patch.object(api.Handler, "_reg_append"), \
                mock.patch("subprocess.Popen") as spawn:
            spawn.return_value.pid = 1234
            handler.do_dispatch()
        self.assertEqual(handler.last_status, 200)
        self.assertTrue(handler.last_payload["ok"])
        spawn.assert_called()
        logs = list(self.log_dir.glob("*"))
        self.assertGreaterEqual(len(logs), 2)
        task_files = [p for p in logs if p.name.endswith("_task.md")]
        self.assertEqual(len(task_files), 1)
        self.assertEqual(task_files[0].read_text(encoding="utf-8"), "work")

    def test_readonly_launch_still_409(self):
        class LaunchHandler(api.Handler):
            path = "/api/launch"

            def __init__(self):
                self.payload = {"id": "ro"}
                self.last_status = None
                self.last_payload = None

            def _body(self):
                return self.payload

            def _json(self, payload, code=200):
                self.last_status = code
                self.last_payload = payload

            def _same_origin(self):
                return True

        handler = LaunchHandler()
        with mock.patch.object(api, "find_conv", return_value={
            "id": "ro", "tool": "claude", "toolLabel": "Claude",
            "readOnly": True, "projectDir": "C:\\work",
        }), mock.patch.object(api, "build_launch") as launch:
            handler.do_POST()
        self.assertEqual(handler.last_status, 409)
        launch.assert_not_called()


class ContinueModeHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="ac_continue_http_"))
        cls.log_dir = cls.tmp / "ai-hub" / "dispatch-log"
        cls.log_dir.mkdir(parents=True)
        cls._dispatches = api.Handler.DISPATCHES
        cls._registry = api.Handler.REGISTRY
        cls._orig_home = api.Path.home
        api.Handler.DISPATCHES = []
        api.Handler.REGISTRY = cls.tmp / "registry.json"
        cls.home_patcher = mock.patch.object(api.Path, 'home', return_value=cls.tmp)
        cls.home_patcher.start()
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), api.Handler)
        cls.port = cls.srv.server_address[1]
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.home_patcher.stop()
        api.Handler.DISPATCHES = cls._dispatches
        api.Handler.REGISTRY = cls._registry
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        if self.log_dir.exists():
            shutil.rmtree(self.log_dir)
        self.log_dir.mkdir(parents=True)

    def _post_dispatch(self, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/dispatch",
            data=data,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Origin": "http://127.0.0.1:5177",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_http_headless_mismatch_409_before_disk_or_spawn(self):
        cursor_row = {**HEADLESS_ROW, "id": "cursor", "mode": "terminal"}
        snap = {**HEADLESS_SNAPSHOT, "tools": [cursor_row], "auto": None}
        with mock.patch.object(api.Handler, "_load_registry"), \
                mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                  return_value=(snap, "cursor", cursor_row, None)), \
                mock.patch.object(api.rules, "wrap") as wrap, \
                mock.patch("subprocess.Popen") as spawn:
            status, payload = self._post_dispatch({
                "task": "work", "tool": "cursor", "expectedMode": "headless",
            })
        self.assertEqual(status, 409)
        self.assertFalse(payload["ok"])
        wrap.assert_not_called()
        spawn.assert_not_called()
        self.assertEqual(list(self.log_dir.glob("*")), [])

    def test_http_headless_match_200_still_spawns(self):
        with mock.patch.object(api.Handler, "_load_registry"), \
                mock.patch.object(api.Handler, "_resolve_ready_dispatch",
                                  return_value=(HEADLESS_SNAPSHOT, "claude", HEADLESS_ROW, None)), \
                mock.patch.object(api.Handler, "_reg_append"), \
                mock.patch("subprocess.Popen") as spawn:
            spawn.return_value.pid = 4321
            status, payload = self._post_dispatch({
                "task": "work", "tool": "claude", "expectedMode": "headless", "raw": True,
            })
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        spawn.assert_called()


if __name__ == "__main__":
    unittest.main()
