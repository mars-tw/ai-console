# -*- coding: utf-8 -*-
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# 跟其他測試檔一致：把 server/ 放進 sys.path 直接 import api。
# 原本的 `from server import api` 只有從專案根執行才 import 得到，
# 而且會產生第二份 api 模組物件，讓 mock.patch 打不到別的測試用的那份。
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402


class ConversationSourceHealthTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ac_sync_sources_")
        self.home = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_distinguishes_ok_empty_missing_and_read_error(self):
        (self.home / ".codex" / "sessions").mkdir(parents=True)
        (self.home / ".kimi-code" / "sessions").mkdir(parents=True)
        qwen_root = self.home / ".qwen" / "projects"
        qwen_root.mkdir(parents=True)
        index = {"conversations": [{
            "tool": "codex", "inApp": True, "subagent": False, "dup": False,
        }]}
        real_stat = Path.stat

        def guarded_stat(path, *args, **kwargs):
            if Path(path) == qwen_root:
                raise PermissionError("synthetic unreadable source")
            return real_stat(path, *args, **kwargs)

        with mock.patch.object(Path, "stat", guarded_stat):
            rows = api._conversation_source_health(index, self.home)
        by_id = {row["id"]: row for row in rows}
        self.assertEqual(by_id["codex"]["status"], "ok")
        self.assertEqual(by_id["codex"]["count"], 1)
        self.assertEqual(by_id["kimi"]["status"], "empty")
        self.assertEqual(by_id["claude"]["status"], "missing")
        self.assertEqual(by_id["qwen"]["status"], "error")
        self.assertNotIn(str(qwen_root), str(by_id["qwen"]))

    def test_claude_store_only_root_is_recognized_and_readable(self):
        store = (self.home / "AppData" / "Local" / "Packages" /
                 "Claude_pzs8sxrjxfjjc" / "LocalCache" / "Roaming" /
                 "Claude" / "claude-code-sessions")
        store.mkdir(parents=True)
        rows = api._conversation_source_health({"conversations": []}, self.home)
        claude = next(row for row in rows if row["id"] == "claude")
        self.assertEqual(claude["status"], "empty")

    def test_corrupt_codex_database_is_not_reported_as_readable_empty_source(self):
        database = self.home / ".codex" / "state_5.sqlite"
        database.parent.mkdir(parents=True)
        database.write_bytes(b"not sqlite")
        rows = api._conversation_source_health({"conversations": []}, self.home)
        codex = next(row for row in rows if row["id"] == "codex")
        self.assertEqual(codex["status"], "error")


if __name__ == "__main__":
    unittest.main()
