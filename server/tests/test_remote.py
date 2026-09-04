# -*- coding: utf-8 -*-
"""手機遙控埠：token、白名單、鎖定、啟停

主控台假設 127.0.0.1 上的頁面就是自己人；遙控埠沒有這個假設。
所以每一個請求都要帶配對 token、只開放派工相關的路徑、猜 token 猜太多次就擋，
而且整個埠只綁在 Tailscale 位址（測試裡用 127.0.0.1 代替）。
"""
from __future__ import annotations

import json
import shutil
import socket
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TestRemoteServer(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="acremote_"))
        self._orig_file, self._orig_port = api.REMOTE_FILE, api.REMOTE_PORT
        api.REMOTE_FILE = self.tmp / "_remote.json"
        api.REMOTE_PORT = _free_port()
        api._AUTH_FAILS.clear()
        self._ts = mock.patch.object(api, "_tailscale_ip", lambda: "127.0.0.1")
        self._ts.start()
        got = api._remote_start()
        self.assertTrue(got["ok"], got)
        self.token = api._REMOTE["token"]
        self.base = f"http://127.0.0.1:{api.REMOTE_PORT}"

    def tearDown(self):
        api._remote_stop(forget=True)
        self._ts.stop()
        api.REMOTE_FILE, api.REMOTE_PORT = self._orig_file, self._orig_port
        api._AUTH_FAILS.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _req(self, path, token=None, method="GET", body=None, origin=True):
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if origin:
            headers["Origin"] = self.base
        data = json.dumps(body).encode("utf-8") if body is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                raw = r.read() or b"{}"
                try:
                    return r.status, json.loads(raw)
                except ValueError:
                    return r.status, {"raw": raw[:80]}      # 靜態頁是 HTML 不是 JSON
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"raw": raw[:80]}

    # ── token ──
    def test_沒帶token就401(self):
        code, obj = self._req("/api/dispatches")
        self.assertEqual(code, 401)
        self.assertIn("配對", obj["error"])

    def test_錯的token也401(self):
        code, _ = self._req("/api/dispatches", token="x" * 32)
        self.assertEqual(code, 401)

    def test_對的token過得去(self):
        code, obj = self._req("/api/dispatch/tools", token=self.token)
        self.assertEqual(code, 200)
        self.assertTrue(obj.get("ok"))

    def test_health不用token(self):
        code, _ = self._req("/api/health")
        self.assertEqual(code, 200)

    # ── 白名單 ──
    def test_對話索引與其他路徑一律不給(self):
        for path in ("/api/status", "/api/index", "/api/conv/tail?id=x", "/api/skills", "/data/index.json"):
            with self.subTest(path=path):
                code, obj = self._req(path, token=self.token)
                self.assertEqual(code, 403, obj)
                self.assertIn("不開放", obj["error"])

    def test_根路徑不給_那是整個桌面主控台(self):
        code, _ = self._req("/", token=self.token)
        self.assertEqual(code, 403)

    def test_遙控埠不能操作遙控設定(self):
        for path in ("/api/remote/enable", "/api/remote/disable", "/api/remote/rotate"):
            with self.subTest(path=path):
                code, _ = self._req(path, token=self.token, method="POST", body={})
                self.assertEqual(code, 403)
        code, _ = self._req("/api/remote", token=self.token)
        self.assertEqual(code, 403)

    def test_手機頁面本身不用token(self):
        code, _ = self._req("/m/")
        self.assertNotEqual(code, 401)       # 沒 dist 時是 404，有 dist 時 200；重點是不擋在 token

    # ── 鎖定 ──
    def test_猜十次就鎖(self):
        for _ in range(api._AUTH_FAIL_MAX):
            self._req("/api/dispatches", token="nope")
        code, obj = self._req("/api/dispatches", token=self.token)     # 連對的都不收
        self.assertEqual(code, 429)
        self.assertIn("十分鐘", obj["error"])

    # ── 狀態與啟停 ──
    def test_狀態含配對網址而token只在井號後面(self):
        st = api._remote_status()
        self.assertTrue(st["enabled"])
        self.assertTrue(st["url"].startswith(f"http://127.0.0.1:{api.REMOTE_PORT}/m/#t="))
        self.assertTrue(st["url"].endswith(self.token))
        self.assertEqual(st["tokenTail"], self.token[-4:])

    def test_關掉就連不上_token也作廢(self):
        api._remote_stop(forget=True)
        self.assertFalse(api.REMOTE_FILE.exists())
        self.assertFalse(api._remote_status()["enabled"])
        with self.assertRaises(urllib.error.URLError):
            urllib.request.urlopen(self.base + "/api/health", timeout=2)

    def test_重開沿用同一把token(self):
        tok = self.token
        api._remote_stop(forget=False)
        got = api._remote_start()
        self.assertTrue(got["ok"])
        self.assertEqual(api._REMOTE["token"], tok)

    def test_再開一次只回already(self):
        got = api._remote_start()
        self.assertTrue(got.get("already"))


class TestRemoteNoTailscale(unittest.TestCase):

    def test_沒有Tailscale就不開_並說清楚(self):
        with mock.patch.object(api, "_tailscale_ip", lambda: ""):
            got = api._remote_start()
        self.assertFalse(got["ok"])
        self.assertIn("Tailscale", got["error"])
        self.assertIsNone(api._REMOTE["server"])

    def test_config可以指定綁定位址(self):
        with mock.patch.dict(api._CFG, {"remote_bind": "10.9.8.7"}):
            self.assertEqual(api._tailscale_ip(), "10.9.8.7")


if __name__ == "__main__":
    unittest.main()
