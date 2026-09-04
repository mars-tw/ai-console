# -*- coding: utf-8 -*-
"""額度與用量：工具清單要有 agy、用量端點、規劃器的預設執行者

2026-09-04 看到的：/api/dispatch/tools 寫死 claude、codex 在前而且沒有 gemini ——
「自動」會挑到 agy，下拉卻選不到它。規劃器拆不出來時預設交給 claude（最貴、
而且依使用者的規則是派工平台不是工人）。用量統計本來不存在：使用者只在撞牆
之後才看到紅字，派之前不知道誰還有額度、今天燒了多少。
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402
import planner  # noqa: E402

AGY_OK = json.dumps({
    "conversation_id": "x", "status": "SUCCESS", "response": "做完了",
    "duration_seconds": 10.0, "num_turns": 1,
    "usage": {"input_tokens": 53182, "output_tokens": 2307, "thinking_tokens": 1876,
              "cache_read_tokens": 12238, "total_tokens": 55489},
}, ensure_ascii=False)


def _stamp(ago_sec: float) -> str:
    return time.strftime("%Y%m%d-%H%M%S", time.localtime(time.time() - ago_sec))


class _Base(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="acusage_"))
        self.h = api.Handler.__new__(api.Handler)
        self._orig = {k: api.Handler.__dict__[k]
                      for k in ("DISPATCHES", "_json", "_limited_tools", "_load_registry")}
        api.Handler.DISPATCHES = []
        # 登錄空的時候端點會去讀真的登錄檔；測試裡的「空」就是空
        api.Handler._load_registry = lambda _self: None
        api.Handler._json = lambda _self, obj, code=200: (obj, code)
        api.Handler._limited_tools = staticmethod(lambda: set())
        self._status = api.STATUS_JSON
        api.STATUS_JSON = self.tmp / "status.json"
        api.STATUS_JSON.write_text(json.dumps({"tools": {}}), encoding="utf-8")
        self.available = {"gemini", "qwen", "codex", "claude", "cursor"}
        self._patches = [mock.patch.object(api, "_bin_available", side_effect=lambda t: t in self.available),
                         mock.patch.object(api, "_alive_pids", lambda pids: set())]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        api.STATUS_JSON = self._status
        for k, v in self._orig.items():
            setattr(api.Handler, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _log(self, name: str, text: str) -> str:
        p = self.tmp / name
        p.write_text(text, encoding="utf-8")
        return str(p)


class TestToolsList(_Base):

    def test_agy排第一而且標籤講清楚(self):
        obj, _ = api.Handler.do_dispatch_tools(self.h)
        ids = [x["id"] for x in obj["tools"]]
        self.assertEqual(ids[0], "gemini")
        self.assertEqual(obj["tools"][0]["label"], "ANTIGRAVITY（agy）")
        self.assertEqual(obj["tools"][0]["mode"], "headless")
        self.assertEqual(obj["auto"], "gemini")
        # 順序照接力鏈：便宜的在前，終端工具最後、地端墊底
        self.assertLess(ids.index("qwen"), ids.index("codex"))
        self.assertEqual(ids[-2:], ["cursor", "local"])

    def test_沒裝的不列(self):
        self.available = {"qwen"}
        obj, _ = api.Handler.do_dispatch_tools(self.h)
        self.assertEqual([x["id"] for x in obj["tools"]], ["qwen", "local"])


class TestUsage(_Base):

    def test_今日與七日分開算_成本從log掃(self):
        api.Handler.DISPATCHES = [
            {"id": "a", "tool": "gemini", "mode": "headless", "started": _stamp(60), "pid": None,
             "log": self._log("a.log", AGY_OK)},
            {"id": "b", "tool": "gemini", "mode": "headless", "started": _stamp(2 * 86400), "pid": None,
             "log": self._log("b.log", AGY_OK)},
            {"id": "old", "tool": "gemini", "mode": "headless", "started": _stamp(10 * 86400), "pid": None,
             "log": self._log("old.log", AGY_OK)},
            {"id": "s", "tool": "qwen", "mode": "headless", "started": _stamp(120), "pid": 99,
             "stopped": _stamp(60), "log": self._log("s.log", "跑到一半")},
            {"id": "f", "tool": "qwen", "mode": "headless", "started": _stamp(180), "pid": None,
             "log": self._log("f.log", "ERROR: You've hit your usage limit\n")},
        ]
        obj, code = api.Handler.do_dispatch_usage(self.h)
        self.assertEqual(code, 200)
        by = {x["id"]: x for x in obj["tools"]}
        g, q = by["gemini"], by["qwen"]
        self.assertEqual((g["today"]["jobs"], g["today"]["ok"]), (1, 1))
        self.assertEqual(g["today"]["in"], 53182)
        self.assertEqual(g["today"]["out"], 2307)
        self.assertEqual(g["week"]["jobs"], 2)              # 十天前的不算
        self.assertEqual(g["week"]["in"], 53182 * 2)
        self.assertEqual((q["today"]["stopped"], q["today"]["failed"]), (1, 1))
        self.assertEqual(q["today"]["in"], 0)
        self.assertEqual(obj["auto"], "gemini")
        self.assertRegex(obj["day"], r"^\d{4}-\d{2}-\d{2}$")

    def test_沒派過也回完整的零(self):
        obj, _ = api.Handler.do_dispatch_usage(self.h)
        for x in obj["tools"]:
            self.assertEqual(x["today"]["jobs"], 0)
            self.assertIn("week", x)

    def test_限流的有原因(self):
        api.Handler._limited_tools = staticmethod(lambda: {"codex"})
        api.STATUS_JSON.write_text(json.dumps({"tools": {"codex": {
            "rate_limited": True, "reset_at": "09/07 10:30"}}}), encoding="utf-8")
        obj, _ = api.Handler.do_dispatch_usage(self.h)
        c = next(x for x in obj["tools"] if x["id"] == "codex")
        self.assertTrue(c["limited"])
        self.assertIn("09/07 10:30", c["reason"])
        self.assertNotEqual(obj["auto"], "codex")


class TestPlannerDefault(unittest.TestCase):

    def test_預設執行者照便宜順序(self):
        self.assertEqual(planner.default_tool({"claude", "codex", "qwen"}), "qwen")
        self.assertEqual(planner.default_tool({"claude", "gemini"}), "gemini")
        self.assertEqual(planner.default_tool({"claude"}), "claude")
        self.assertEqual(planner.default_tool(set()), "local")

    def test_拆不出來時整件交給便宜的(self):
        got = planner.plan("把 README 的錯字修一修", model="", available=["claude", "codex", "gemini"])
        self.assertEqual(got["steps"][0]["tool"], "gemini")

    def test_指名仍然優先(self):
        got = planner.plan("用 codex 把 README 的錯字修一修", model="", available=["claude", "codex", "gemini"])
        self.assertEqual(got["steps"][0]["tool"], "codex")

    def test_拆解提示講了價差(self):
        self.assertIn("價差", planner.PROMPT)
        self.assertIn("gemini、qwen 最便宜", planner.PROMPT)


if __name__ == "__main__":
    unittest.main()
