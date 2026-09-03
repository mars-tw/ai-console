# -*- coding: utf-8 -*-
"""停止執行中的派工，與 agy 的 JSON 模式

2026-09-03 的兩個缺口，都是接力事故之後才看見的：
  1. 被人為殺掉的無頭行程沒有失敗訊號，登錄也沒有記號，六個被殺掉的 agy 全顯示 done／ok。
     → 停止要走控制台的端點：殺整棵行程樹、在登錄記 stopped、狀態老實標「已停止」。
  2. agy 文字模式什麼用量都不印，成本欄永遠是空的。
     → 派工改走 --output-format json；判定器認得它的 status／response／error，
       成本正規式認得 usage（釘住 thinking_tokens，免得跟 Claude 的 usage 重複計費），
       日誌拆開顯示：回覆原文 + 一行用量，不讓使用者看一整坨 JSON。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402

# 2026-09-03 實測的 agy 輸出，原樣（只縮短 response）
AGY_OK = json.dumps({
    "conversation_id": "9580030a-a7cc-4dde-8324-a81d7917dc9c", "status": "SUCCESS",
    "response": "### 結果\n已在目前目錄建立 hello.txt。\n\n### 驗證\n讀取內容確認為 hi\n",
    "duration_seconds": 18.9224073, "num_turns": 1,
    "usage": {"input_tokens": 53182, "output_tokens": 2307, "thinking_tokens": 1876,
              "cache_read_tokens": 12238, "total_tokens": 55489},
}, ensure_ascii=False)
AGY_ERR = json.dumps({
    "conversation_id": "", "status": "ERROR", "response": "",
    "error": "invalid model selection (--model \"no-such-model-xyz\"): model no-such-model-xyz "
             "is not recognized as a known model\nAvailable models:\n  Gemini 3.8 Flash (High)",
}, ensure_ascii=False)


class TestAgyArgv(unittest.TestCase):

    def test_派工與續談都走JSON模式(self):
        """文字模式一個用量都不印；要成本就得 --output-format json"""
        for argv in (api.Handler.DISPATCH_TOOLS["gemini"]("做點事"),
                     api.Handler.FOLLOWUP_TOOLS["gemini"]("再一句")):
            with self.subTest(argv=argv):
                self.assertIn("--output-format", argv)
                self.assertEqual(argv[argv.index("--output-format") + 1], "json")
                self.assertIn("--dangerously-skip-permissions", argv)


class TestAgyCost(unittest.TestCase):

    def test_認得agy的usage(self):
        cost = api._parse_cost(AGY_OK)
        self.assertIsNotNone(cost)
        self.assertEqual((cost["in"], cost["out"], cost["model"]), (53182, 2307, "gemini"))
        self.assertEqual(cost["total"], 53182 + 2307)

    def test_Claude的usage不會被當成agy重複計費(self):
        """Claude 結算的 usage 沒有 thinking_tokens；它的錢與 modelUsage 已經算過了"""
        claude = ('{"type":"result","total_cost_usd":0.0123,'
                  '"usage":{"input_tokens":4,"cache_read_input_tokens":100,"output_tokens":9},'
                  '"modelUsage":{"claude-opus-5":{"inputTokens":4,"outputTokens":9}}}')
        cost = api._parse_cost(claude)
        self.assertEqual(cost["in"], 4)          # 只有 modelUsage 那一次
        self.assertEqual(cost["out"], 9)
        self.assertAlmostEqual(cost["usd"], 0.0123)

    def test_串流版本跟純字串版本一致(self):
        acc = api._new_cost_accumulator()
        for _, _, kind, values in api._byte_cost_events(AGY_OK.encode("utf-8")):
            api._apply_cost_event(acc, kind, values)
        cost = api._cost_from_accumulator(acc)
        self.assertEqual((cost["in"], cost["out"], cost["model"]), (53182, 2307, "gemini"))


class TestAgyOutcome(unittest.TestCase):

    def test_SUCCESS是完成(self):
        got = api._parse_outcome(AGY_OK)
        self.assertEqual(got["outcome"], "ok")

    def test_ERROR是失敗_原因取自error欄(self):
        got = api._parse_outcome(AGY_ERR)
        self.assertEqual(got["outcome"], "error")
        self.assertIn("invalid model selection", got["issue"])

    def test_response裡的FAILED比SUCCESS有權威(self):
        """wrapper 說 SUCCESS 只代表 agy 自己有回來；工作本身可能回報失敗"""
        rec = json.loads(AGY_OK)
        rec["response"] = "做到一半撞牆。\n\nFINAL_STATUS: FAILED\n"
        got = api._parse_outcome(json.dumps(rec, ensure_ascii=False))
        self.assertEqual(got["outcome"], "error")


class TestDisplayLog(unittest.TestCase):

    def test_成功結算拆成原文加用量(self):
        shown = api._display_log(AGY_OK)
        self.assertIn("已在目前目錄建立 hello.txt", shown)
        self.assertNotIn('"usage"', shown)
        self.assertIn("53,182 進 / 2,307 出 token", shown)
        self.assertIn("19 秒", shown)
        self.assertIn("status=SUCCESS", shown)

    def test_失敗結算顯示錯誤(self):
        shown = api._display_log(AGY_ERR)
        self.assertTrue(shown.startswith("⚠ invalid model selection"))
        self.assertIn("status=ERROR", shown)

    def test_不是agy的JSON原樣回(self):
        for text in ("普通文字\nerror: 沒事", '{"type":"result","result":"x"}', "{壞掉的", ""):
            with self.subTest(text=text):
                self.assertEqual(api._display_log(text), text)


class TestStoppedState(unittest.TestCase):

    def setUp(self):
        self.h = api.Handler.__new__(api.Handler)

    def test_停過而且死了就是已停止(self):
        d = {"mode": "headless", "log": "", "stopped": "20260903-172400", "pid": 1}
        self.assertEqual(self.h._dispatch_state(d, alive=False), "stopped")

    def test_停過但還活著仍是執行中(self):
        """殺行程有延遲；還活著就不能說它停了"""
        d = {"mode": "headless", "log": "", "stopped": "20260903-172400", "pid": 1}
        self.assertEqual(self.h._dispatch_state(d, alive=True), "running")

    def test_取消優先於停止(self):
        d = {"mode": "terminal", "cancelled": "x", "stopped": "y", "log": ""}
        self.assertEqual(self.h._dispatch_state(d, alive=False), "cancelled")


class TestStopEndpoint(unittest.TestCase):
    """跑 do_dispatch_stop 本體：假的登錄、假的存活查詢、假的殺行程。"""

    def setUp(self):
        self.h = api.Handler.__new__(api.Handler)
        self._orig = {k: api.Handler.__dict__[k] for k in ("DISPATCHES", "_save_registry", "_body", "_json")}
        api.Handler.DISPATCHES = [{"id": "a", "tool": "gemini", "mode": "headless", "pid": 4242},
                                  {"id": "dead", "tool": "gemini", "mode": "headless", "pid": 7}]
        self.saved = 0
        api.Handler._save_registry = lambda _self: setattr(self, "saved", self.saved + 1)
        api.Handler._json = lambda _self, obj, code=200: (obj, code)
        self.body = {}
        api.Handler._body = lambda _self: self.body
        self.killed = []

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(api.Handler, k, v)

    def _call(self, did):
        self.body = {"id": did}
        with mock.patch.object(api, "_alive_pids", lambda pids: {p for p in pids if p == 4242}), \
             mock.patch.object(api, "_kill_tree", lambda pid: self.killed.append(pid)):
            return api.Handler.do_dispatch_stop(self.h)

    def test_停掉活著的並記在登錄上(self):
        obj, code = self._call("a")
        self.assertEqual((code, obj["ok"]), (200, True))
        self.assertEqual(self.killed, [4242])
        self.assertTrue(api.Handler.DISPATCHES[0].get("stopped"))
        self.assertEqual(self.saved, 1)

    def test_再停一次只回報已停過(self):
        self._call("a")
        obj, code = self._call("a")
        self.assertEqual((code, obj.get("already")), (200, True))
        self.assertEqual(self.killed, [4242])

    def test_已經死的沒東西可停(self):
        obj, code = self._call("dead")
        self.assertEqual(code, 409)
        self.assertEqual(self.killed, [])
        self.assertNotIn("stopped", api.Handler.DISPATCHES[1])

    def test_找不到(self):
        obj, code = self._call("nope")
        self.assertEqual(code, 404)


class TestKillTree(unittest.TestCase):

    def test_殺整棵樹並清掉存活快取(self):
        api._ALIVE_CACHE["pids"] = {4242, 1}
        calls = []
        with mock.patch.object(api.subprocess, "run", lambda *a, **k: calls.append(a[0])), \
             mock.patch.object(api.os, "name", "nt"):
            api._kill_tree(4242)
        self.assertEqual(len(calls), 1)
        self.assertIn("ParentProcessId=$p", " ".join(calls[0]))
        self.assertIn("KT 4242", " ".join(calls[0]))
        self.assertNotIn(4242, api._ALIVE_CACHE["pids"])


if __name__ == "__main__":
    unittest.main()
