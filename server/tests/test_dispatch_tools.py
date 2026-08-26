# -*- coding: utf-8 -*-
"""派得出去的工具清單，以及取消一件還沒被按下去的派工。

兩件事都來自同一次實際操作：派給 kimi 的兩張工單擺了半小時，
畫面上一直寫「進行中」，實際上是「那個終端視窗沒有人按」。
把其中一件改派給會自己跑的 gemini 之後，同一份工單有了兩個持有者，
而介面上沒有任何辦法把前一件收掉。
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402


class _Fake(api.Handler):
    """只借方法、不跑 HTTP。

    BaseHTTPRequestHandler 的 __init__ 會直接開始處理一個真的請求，
    所以這裡整個蓋掉 —— 要測的是決策，不是 socket。
    """

    def __init__(self, body=None):          # noqa: D107 - 見 class docstring
        self.sent = None
        self._data = body or {}

    def _json(self, obj, code=200):
        self.sent = (code, obj)
        return obj

    def _body(self):
        return self._data


class TestCloudChain(unittest.TestCase):

    def test_自動路由不會挑到要人手動按的工具(self):
        """這是使用者「不會自動切換有額度的模型」的真正病因。

        原本 CLOUD_CHAIN = [claude, codex, gemini, grok, qwen]，grok 排在
        qwen 前面 —— 而 grok 只會開一個終端等人按。於是前三個都限流那天，
        auto 挑中 grok，開一個視窗擺著，工單一步都不會動；
        qwen 明明有額度也會自己跑完，卻永遠輪不到。

        這條規則只有一行，改回去不會有任何測試失敗、畫面也完全正常 ——
        要等到某天前三個同時限流才會發作。所以釘在這裡。
        """
        for tool in api.Handler.CLOUD_CHAIN:
            self.assertNotIn(tool, api.Handler.TERMINAL_TOOLS,
                             f"{tool} 只會開終端等人按，不該出現在自動路由裡")

    def test_自動路由裡的每一個都真的派得出去(self):
        # 不在 DISPATCHES_TOOLS 裡的話，do_dispatch 會讓它掉進終端分支 ——
        # 等於繞過上面那條規則
        for tool in api.Handler.CLOUD_CHAIN:
            self.assertIn(tool, api.Handler.DISPATCH_TOOLS)


class TestDispatchTools(unittest.TestCase):
    """/api/dispatch/tools：畫面上要看得出「派出去之後還需不需要你」"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="actools_"))
        self._status = api.STATUS_JSON
        self._bin = dict(api.BIN)

    def tearDown(self):
        api.STATUS_JSON = self._status
        api.BIN.clear()
        api.BIN.update(self._bin)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _status_file(self, limited=()):
        p = self.tmp / "status.json"
        p.write_text(json.dumps({"tools": {t: {"rate_limited": True} for t in limited}}),
                     encoding="utf-8")
        api.STATUS_JSON = p

    def _call(self):
        f = _Fake()
        f.do_dispatch_tools()
        return f.sent[1]

    def test_終端工具要標成終端(self):
        self._status_file()
        api.BIN.update({"gemini": "gemini.cmd", "kimi": "kimi.cmd"})
        got = {x["id"]: x["mode"] for x in self._call()["tools"]}
        self.assertEqual(got.get("kimi"), "terminal")
        self.assertEqual(got.get("gemini"), "headless")

    def test_沒裝的工具不列出來(self):
        # 列出來的話使用者會選，選了才發現派不出去
        self._status_file()
        api.BIN.clear()
        api.BIN["gemini"] = "gemini.cmd"
        ids = [x["id"] for x in self._call()["tools"]]
        self.assertIn("gemini", ids)
        self.assertNotIn("claude", ids)

    def test_限流的工具照列但標記出來(self):
        """不是把它藏起來 —— 使用者知道自己裝了 claude，
        清單裡突然沒有它，比寫著「額度用完」更讓人困惑。"""
        self._status_file(limited=["claude"])
        api.BIN.update({"claude": "claude.cmd", "gemini": "gemini.cmd"})
        by = {x["id"]: x for x in self._call()["tools"]}
        self.assertTrue(by["claude"]["limited"])
        self.assertFalse(by["gemini"]["limited"])

    def test_地端永遠在清單裡而且不會限流(self):
        self._status_file(limited=["claude", "codex", "gemini", "qwen"])
        api.BIN.clear()
        by = {x["id"]: x for x in self._call()["tools"]}
        self.assertIn("local", by)
        self.assertFalse(by["local"]["limited"])

    def test_直接講出自動現在會挑到誰(self):
        self._status_file(limited=["claude", "codex"])
        api.BIN.update({"claude": "c", "codex": "c", "gemini": "g", "qwen": "q"})
        self.assertEqual(self._call()["auto"], "gemini")

    def test_全部限流時自動退回地端(self):
        self._status_file(limited=["claude", "codex", "gemini", "qwen"])
        api.BIN.update({"claude": "c", "codex": "c", "gemini": "g", "qwen": "q"})
        self.assertEqual(self._call()["auto"], "local")


class TestCancel(unittest.TestCase):
    """/api/dispatch/cancel：把一件沒人按的終端派工收掉"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="accancel_"))
        self._reg, self._disp = api.Handler.REGISTRY, api.Handler.DISPATCHES
        api.Handler.REGISTRY = self.tmp / "_registry.json"
        self.log = self.tmp / "20260101-000000_kimi.log"
        self.log.write_text("[20260101] kimi 開啟可見終端\n指令：做某事", encoding="utf-8")
        self.order = self.tmp / "20260101-000000_task.md"
        self.order.write_text("【工單】\n把某個檔案改好", encoding="utf-8")
        api.Handler.DISPATCHES = [{
            "id": "20260101-000000", "tool": "kimi", "mode": "terminal",
            "log": str(self.log), "pid": None,
            "echo_size": self.log.stat().st_size,
        }]

    def tearDown(self):
        api.Handler.REGISTRY, api.Handler.DISPATCHES = self._reg, self._disp
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _cancel(self, did="20260101-000000"):
        f = _Fake({"id": did})
        f.do_dispatch_cancel()
        return f.sent

    def test_取消之後狀態變成已取消(self):
        code, out = self._cancel()
        self.assertEqual(code, 200)
        self.assertTrue(out["ok"])
        rec = api.Handler.DISPATCHES[0]
        self.assertTrue(rec.get("cancelled"))
        self.assertEqual(api.Handler._dispatch_state(api.Handler, rec, False), "cancelled")

    def test_工單檔內容會被換成不要做任何事(self):
        """只標記登錄是不夠的。

        那個終端視窗還開著，指令也還帶在裡面 —— 半小時後有人回到桌面
        看到它、順手按下去，工單照樣會被執行一次。換掉檔案內容之後，
        就算被按下去，agent 讀到的是「不要做任何動作」。
        """
        self._cancel()
        text = self.order.read_text(encoding="utf-8")
        self.assertIn("已經取消", text)
        self.assertNotIn("把某個檔案改好", text)

    def test_還在跑的不給取消(self):
        # 中途砍掉一個正在改檔案的 agent，比讓它跑完更危險
        api.Handler.DISPATCHES[0]["mode"] = "headless"
        api.Handler.DISPATCHES[0]["log"] = str(self.log)
        self.log.write_text("x" * 9000, encoding="utf-8")   # 有實際輸出 → 不是 waiting
        code, out = self._cancel()
        self.assertEqual(code, 409)
        self.assertFalse(out["ok"])
        self.assertNotIn("cancelled", api.Handler.DISPATCHES[0])

    def test_找不到的派工回404(self):
        code, out = self._cancel("沒有這一筆")
        self.assertEqual(code, 404)
        self.assertFalse(out["ok"])

    def test_重複取消不會出錯(self):
        # 兩個分頁都開著的時候一定會發生
        self._cancel()
        code, out = self._cancel()
        self.assertEqual(code, 200)
        self.assertTrue(out["ok"])
        self.assertTrue(out.get("already"))

    def test_工單檔已經不在時要講出來(self):
        """檔案不在就沒辦法讓它 fail safe，那個視窗仍然是危險的 ——
        這種時候要明講「請直接關掉」，不能只回一個 ok。"""
        self.order.unlink()
        code, out = self._cancel()
        self.assertEqual(code, 200)
        self.assertTrue(out["ok"])
        self.assertIn("關掉", out["note"])


if __name__ == "__main__":
    unittest.main()
