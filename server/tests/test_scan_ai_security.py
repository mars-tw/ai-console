# -*- coding: utf-8 -*-
"""AI 對話掃描器不可踩進憑證與瀏覽器儲存。

這些測試只使用臨時假資料；不會查看本機任何真實的 auth、token、
cookie、IndexedDB 或 Local Storage。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

TOOLS_DIR = Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS_DIR))

import scan_ai  # noqa: E402


def _write_conversation(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        {"role": "user", "content": "這是臨時測試訊息" * 8, "timestamp": "2026-08-29T00:00:00Z"},
        {"role": "assistant", "content": "這是臨時測試回覆" * 8, "timestamp": "2026-08-29T00:00:01Z"},
    ]
    path.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in rows) + "\n",
                    encoding="utf-8")


class TestSensitiveStorePruning(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="scan_ai_security_")
        self.root = Path(self._tmp.name)
        self.cand = self.root / ".example-ai"
        _write_conversation(self.cand / "sessions" / "one.jsonl")
        _write_conversation(self.cand / "sessions" / "two.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def test_敏感目錄在走訪前就剪枝(self):
        protected = [
            "bridge-store", "Auth", "tokens", "credentials", "Network",
            "IndexedDB", "Local Storage", "Session Storage", "Browser Storage",
            "Cookies", "keyring",
        ]
        blocked_paths: set[str] = set()
        for name in protected:
            d = self.cand / name
            _write_conversation(d / "must-not-open.jsonl")
            blocked_paths.add(os.path.normcase(os.path.abspath(d)))

        real_scandir = os.scandir

        def guarded_scandir(path):
            actual = os.path.normcase(os.path.abspath(os.fspath(path)))
            if actual in blocked_paths:
                raise AssertionError(f"掃描器進入了敏感目錄：{actual}")
            return real_scandir(path)

        # os.walk 內部也呼叫 os.scandir。若沒有先原地剪掉 dirnames，
        # 這個 sentinel 會在它企圖進入敏感目錄的當下失敗。
        with mock.patch.object(scan_ai.os, "scandir", side_effect=guarded_scandir):
            result = scan_ai.scan_candidate(self.cand, time.time() + 5, deep=False)

        self.assertIsNotNone(result)
        self.assertEqual(result["hits"], 2)
        self.assertIn("sessions", result["root"])

    def test_敏感檔名在_stat_與開檔前就略過(self):
        sensitive = [
            self.cand / "auth.json",
            self.cand / "access-token.json",
            self.cand / "credentials.sqlite",
            self.cand / "cookies.json",
            self.cand / "session_token.json",
            self.cand / "Network Persistent State.json",
        ]
        for path in sensitive:
            _write_conversation(path)
        blocked_paths = {os.path.normcase(os.path.abspath(p)) for p in sensitive}

        real_stat = Path.stat
        real_open = Path.open

        def guarded_stat(path, *args, **kwargs):
            actual = os.path.normcase(os.path.abspath(path))
            if actual in blocked_paths:
                raise AssertionError(f"掃描器 stat 了敏感檔：{actual}")
            return real_stat(path, *args, **kwargs)

        def guarded_open(path, *args, **kwargs):
            actual = os.path.normcase(os.path.abspath(path))
            if actual in blocked_paths:
                raise AssertionError(f"掃描器開啟了敏感檔：{actual}")
            return real_open(path, *args, **kwargs)

        with mock.patch.object(Path, "stat", new=guarded_stat), \
             mock.patch.object(Path, "open", new=guarded_open):
            result = scan_ai.scan_candidate(self.cand, time.time() + 5, deep=False)

        self.assertIsNotNone(result)
        self.assertEqual(result["hits"], 2)

    def test_一般_sessions_目錄仍會被發現(self):
        self.assertFalse(scan_ai.is_excluded_dir("sessions"))
        self.assertFalse(scan_ai.is_excluded_dir("session-state"))
        self.assertFalse(scan_ai.is_excluded_dir("local"))
        self.assertFalse(scan_ai.is_excluded_dir("config"))
        result = scan_ai.scan_candidate(self.cand, time.time() + 5, deep=False)
        self.assertIsNotNone(result)
        self.assertEqual(Path(result["root"]), self.cand / "sessions")

    def test_敏感候選根本不會交給掃描器(self):
        parent = self.root / "parent"
        parent.mkdir()
        for name in ("bridge-store", "auth", "Network", "Local Storage"):
            (parent / name).mkdir()
        (parent / "example-ai").mkdir()

        visited: list[str] = []

        def fake_scan_candidate(path, _deadline, _deep):
            visited.append(path.name)
            return None

        with mock.patch.object(scan_ai, "candidate_parents", return_value=[parent]), \
             mock.patch.object(scan_ai, "scan_candidate", side_effect=fake_scan_candidate):
            scan_ai.scan()

        self.assertEqual(visited, ["example-ai"])

    def test_config_聚合根可列舉子工具但不會被直接掃描(self):
        config = self.root / ".config"
        tool = config / "valid-ai"
        _write_conversation(tool / "sessions" / "one.jsonl")
        _write_conversation(tool / "sessions" / "two.jsonl")

        self.assertFalse(scan_ai.is_excluded_dir(".config"))
        self.assertTrue(scan_ai.is_excluded_candidate(".config"))
        self.assertIsNone(scan_ai.scan_candidate(config, time.time() + 5, deep=False))

        # candidate_parents() 把 ~/.config 當 parent；scan() 應列舉其子目錄，
        # 而不是把整個 ~/.config 丟掉或直接往內深掃。
        with mock.patch.object(scan_ai, "candidate_parents", return_value=[config]):
            results = scan_ai.scan()

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["tool"], "valid-ai")
        self.assertEqual(Path(results[0]["root"]), tool / "sessions")


if __name__ == "__main__":
    unittest.main(verbosity=2)
