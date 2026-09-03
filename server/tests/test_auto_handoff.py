# -*- coding: utf-8 -*-
"""撞額度自動換人

使用者的原話（2026-08-24）：「派工要求程式自動化，我不想每次都消耗 token
在重複的指令上要求我持續派工」。2026-09-03 一天之內三次要人手動改派：
codex 撞週額度、qwen 做到第四張撞週額度、cursor 開了終端沒人按。
每一次都是把同一份工單再送一次 —— 程式自己做得到。

這一份守三件事：
  1. 接力順序：Claude／Codex 是派工平台不是工人，要排最後（使用者定的規則）
  2. 只在「額度」原因時換人：程式錯誤換誰都一樣壞，BLOCKED 是規範擋的
  3. 認領與上限：同一件不能被接力兩次，換到第三手就停
  4. 時間門（2026-09-03 17:22 的教訓）：只接「這個伺服器起來之後才派出、六小時內」的；
     第一版沒有這道門，上線第一次輪詢就把最近 30 筆裡八天前、昨天、今早已人工改派
     過的舊失敗全部接力出去，六個 agy 同時跑六份舊工單。一輪也只准接一手。
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402


class TestChainOrder(unittest.TestCase):

    def test_agy與qwen在前_claude與codex在最後(self):
        """使用者：「CLAUDE CODEX 是主要派工平台，優先使用其他 AI 工作，AGY 可以先用」"""
        chain = api.Handler.CLOUD_CHAIN
        self.assertEqual(chain[0], "gemini")
        self.assertLess(chain.index("qwen"), chain.index("codex"))
        self.assertLess(chain.index("kimi"), chain.index("codex"))
        self.assertEqual(set(chain[-2:]), {"codex", "claude"})

    def test_鏈上的每一個都能無頭跑(self):
        """cursor 只會開終端等人按，不能出現在自動接力的鏈上"""
        for t in api.Handler.CLOUD_CHAIN:
            self.assertIn(t, api.Handler.DISPATCH_TOOLS, t)
        self.assertNotIn("cursor", api.Handler.CLOUD_CHAIN)

    def test_agy是無頭派工工具而且帶權限旗標(self):
        """實測：不帶 --dangerously-skip-permissions 的 -p 模式一個檔都不寫"""
        argv = api.Handler.DISPATCH_TOOLS["gemini"]("做點事")
        self.assertIn("--dangerously-skip-permissions", argv)
        self.assertIn("-p", argv)


class TestQuotaIssue(unittest.TestCase):

    def test_額度類的原因要認得(self):
        for s in ("ERROR: You've hit your usage limit. Visit …",
                  "Quota exhausted: Your token-plan 1-week quota has been exhausted",
                  "(cause: insufficient_quota: 429 …)",
                  "rate limit exceeded",
                  "額度已用盡"):
            with self.subTest(s=s):
                self.assertTrue(api._is_quota_issue(s))

    def test_一般錯誤不換人(self):
        """程式錯誤換一個 AI 再跑多半一樣壞，還白花另一份額度"""
        for s in ("Traceback (most recent call last)", "TypeError: x is undefined",
                  "API Error: 529 Overloaded", "blocked", ""):
            with self.subTest(s=s):
                self.assertFalse(api._is_quota_issue(s))


class TestPick(unittest.TestCase):
    CHAIN = ["gemini", "qwen", "kimi", "grok", "codex", "claude"]
    TOOLS = {"gemini", "qwen", "kimi", "grok", "codex", "claude"}

    def test_跳過原工具與限流的(self):
        pick = api._pick_handoff_tool("qwen", self.CHAIN, self.TOOLS,
                                      limited={"gemini", "codex"}, available=lambda t: True)
        self.assertEqual(pick, "kimi")

    def test_沒安裝的不挑(self):
        pick = api._pick_handoff_tool("gemini", self.CHAIN, self.TOOLS, set(),
                                      available=lambda t: t not in ("qwen", "kimi"))
        self.assertEqual(pick, "grok")

    def test_全部不能用回None(self):
        pick = api._pick_handoff_tool("qwen", self.CHAIN, self.TOOLS,
                                      limited=set(self.CHAIN), available=lambda t: True)
        self.assertIsNone(pick)


class TestAutoHandoff(unittest.TestCase):
    """跑 Handler._auto_handoff 本體：用假的 DISPATCHES、假的送出。"""

    def setUp(self):
        self.h = api.Handler.__new__(api.Handler)      # 不經 BaseHTTPRequestHandler 的 __init__
        # 換掉的類別屬性要在 tearDown 還原：同一個行程裡後面還有別的測試會起真的 server
        self._orig = {k: api.Handler.__dict__[k] for k in
                      ("DISPATCHES", "_save_registry", "_limited_tools", "_handoff_order")}
        # 時間門：測試裡的紀錄都當成「這個伺服器起來之後才派出的」
        self._started_at = api._SERVER_STARTED_AT
        api._SERVER_STARTED_AT = 0
        api.Handler.DISPATCHES = []
        self.saved = 0
        self.sent = []
        api.Handler._save_registry = lambda _self: setattr(self, "saved", self.saved + 1)
        api.Handler._limited_tools = staticmethod(lambda: {"codex"})
        api.Handler._handoff_order = lambda _self, target, text, why: f"接力：{target['id']}｜{why}"

    def tearDown(self):
        api._SERVER_STARTED_AT = self._started_at
        for k, v in self._orig.items():
            setattr(api.Handler, k, v)

    @staticmethod
    def _stamp(ago_sec):
        return time.strftime("%Y%m%d-%H%M%S", time.localtime(time.time() - ago_sec))

    def _rec(self, **kw):
        # 預設五分鐘前派出：夠新、過得了六小時的門
        base = {"id": "20260903-100000", "tool": "codex", "started": self._stamp(5 * 60),
                "alive": False, "state": "failed", "outcome": "error",
                "issue": "ERROR: You've hit your usage limit", "mode": "headless", "pid": 1}
        base.update(kw)
        api.Handler.DISPATCHES.append(dict(base))
        return base

    def _run(self, rows, new_id="20260903-100100"):
        class R:
            def __init__(self, body): self._b = body
            def read(self): return self._b
            def __enter__(self): return self
            def __exit__(self, *a): return False
        def fake_open(req, timeout=0):
            self.sent.append(json.loads(req.data.decode("utf-8")))
            return R(json.dumps({"ok": bool(new_id), "id": new_id}).encode("utf-8"))
        with mock.patch.object(api.urllib.request, "urlopen", side_effect=fake_open), \
             mock.patch.object(api, "_bin_available", lambda t: True):
            api.Handler._auto_handoff(self.h, rows)

    def test_撞額度就換下一個並記在原紀錄上(self):
        rec = self._rec()
        self._run([dict(rec)])
        src = api.Handler.DISPATCHES[0]
        self.assertEqual(src["handedOffTo"], "20260903-100100")
        self.assertEqual(src["handoffHops"], 1)
        self.assertIn("額度", src["handoffWhy"])
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]["tool"], "gemini")      # 鏈的第一個、沒限流
        self.assertIn("接力：20260903-100000", self.sent[0]["task"])
        self.assertGreaterEqual(self.saved, 1)

    def test_一般錯誤不換(self):
        rec = self._rec(issue="TypeError: boom")
        self._run([dict(rec)])
        self.assertNotIn("handedOffTo", api.Handler.DISPATCHES[0])
        self.assertEqual(self.sent, [])

    def test_同一件不會被接力兩次(self):
        rec = self._rec()
        self._run([dict(rec)])
        again = dict(api.Handler.DISPATCHES[0])
        self._run([again])
        self.assertEqual(len(self.sent), 1)

    def test_換到第三手就停(self):
        rec = self._rec(handoffHops=api._HANDOFF_MAX_HOPS)
        self._run([dict(rec)])
        self.assertEqual(self.sent, [])

    def test_終端十分鐘沒人按也換(self):
        old = time.strftime("%Y%m%d-%H%M%S", time.localtime(time.time() - 15 * 60))
        rec = self._rec(id=old, started=old, tool="cursor", mode="terminal",
                        state="waiting", outcome=None, issue="", pid=None)
        self._run([dict(rec)])
        self.assertEqual(len(self.sent), 1)
        self.assertIn("沒有人按", api.Handler.DISPATCHES[0]["handoffWhy"])

    def test_終端剛開不算(self):
        now = time.strftime("%Y%m%d-%H%M%S")
        rec = self._rec(id=now, started=now, tool="cursor", mode="terminal",
                        state="waiting", outcome=None, issue="", pid=None)
        self._run([dict(rec)])
        self.assertEqual(self.sent, [])

    def test_全部都不能用就標起來等額度(self):
        api.Handler._limited_tools = staticmethod(lambda: set(api.Handler.CLOUD_CHAIN))
        rec = self._rec()
        self._run([dict(rec)])
        self.assertEqual(api.Handler.DISPATCHES[0]["handedOffTo"], "none")
        self.assertEqual(self.sent, [])

    def test_送出失敗就放掉認領_下一輪再試(self):
        rec = self._rec()
        self._run([dict(rec)], new_id="")
        self.assertNotIn("handedOffTo", api.Handler.DISPATCHES[0])

    # ── 時間門：不接歷史 ─────────────────────────────────────────────

    def test_伺服器起來之前派出的不接(self):
        """上線第一次輪詢把八天前的舊失敗全接出去 —— 只有它親眼看著失敗的才算在飛行中"""
        api._SERVER_STARTED_AT = time.time() - 60          # 伺服器一分鐘前才起來
        rec = self._rec(started=self._stamp(5 * 60))       # 這筆五分鐘前就派出了
        self._run([dict(rec)])
        self.assertEqual(self.sent, [])
        self.assertNotIn("handedOffTo", api.Handler.DISPATCHES[0])

    def test_超過六小時的不接(self):
        rec = self._rec(started=self._stamp(7 * 3600))
        self._run([dict(rec)])
        self.assertEqual(self.sent, [])

    def test_沒有時間戳的不接(self):
        rec = self._rec(started="")
        self._run([dict(rec)])
        self.assertEqual(self.sent, [])

    def test_一輪只接一手_下一輪再接第二件(self):
        """同時撞牆的兩件要一件一件來：一輪爆出五六個行程沒有人看得住"""
        a = self._rec(id="a")
        b = self._rec(id="b")
        self._run([dict(a), dict(b)])
        self.assertEqual(len(self.sent), 1)
        done = [x for x in api.Handler.DISPATCHES if x.get("handedOffTo")]
        self.assertEqual(len(done), 1)
        # 下一輪：已接的那件被跳過，另一件才接
        self._run([dict(x) for x in api.Handler.DISPATCHES])
        self.assertEqual(len(self.sent), 2)
        self.assertEqual({x["id"] for x in api.Handler.DISPATCHES if x.get("handedOffTo")}, {"a", "b"})


if __name__ == "__main__":
    unittest.main()
