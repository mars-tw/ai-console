# -*- coding: utf-8 -*-
"""派得出去的工具清單，以及取消一件還沒被按下去的派工。

兩件事都來自同一次實際操作：派給 kimi 的兩張工單擺了半小時，
畫面上一直寫「進行中」，實際上是「那個終端視窗沒有人按」。
把其中一件改派給會自己跑的工具之後，同一份工單有了兩個持有者，
而介面上沒有任何辦法把前一件收掉。
"""
from __future__ import annotations

import datetime
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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

    def test_agy_gemini不在工作派工或接力路由(self):
        self.assertNotIn("gemini", api.Handler.CLOUD_CHAIN)
        self.assertNotIn("gemini", api.Handler.DISPATCH_TOOLS)
        self.assertNotIn("gemini", api.Handler.FOLLOWUP_TOOLS)
        self.assertNotIn("gemini", api.Handler.KNOWN_TOOLS)


class TestBinAvailability(unittest.TestCase):
    def test_fallback_tool_name_does_not_claim_installed(self):
        with mock.patch.dict(api.BIN, {"ghost": "ghost"}, clear=False), \
                mock.patch("shutil.which", return_value=None):
            self.assertFalse(api._bin_available("ghost"))

    def test_existing_resolved_executable_is_available(self):
        with tempfile.TemporaryDirectory(prefix="acbin_") as tmp:
            exe = Path(tmp) / "tool.exe"
            exe.write_bytes(b"MZ")
            with mock.patch.dict(api.BIN, {"ghost": str(exe)}, clear=False):
                self.assertTrue(api._bin_available("ghost"))


class TestDispatchTools(unittest.TestCase):
    """/api/dispatch/tools：畫面上要看得出「派出去之後還需不需要你」"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="actools_"))
        self._status = api.STATUS_JSON
        self._bin = dict(api.BIN)
        self.available = set()
        self._available_patch = mock.patch.object(
            api, "_bin_available", side_effect=lambda tool: tool in self.available)
        self._available_patch.start()

    def tearDown(self):
        self._available_patch.stop()
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
        self.available = {"kimi"}
        got = {x["id"]: x["mode"] for x in self._call()["tools"]}
        self.assertEqual(got.get("kimi"), "terminal")
        self.assertNotIn("gemini", got, "agy/Gemini 不可從工作派工 UI 繞過治理")

    def test_沒裝的工具不列出來(self):
        # 列出來的話使用者會選，選了才發現派不出去
        self._status_file()
        self.available = {"qwen"}
        ids = [x["id"] for x in self._call()["tools"]]
        self.assertIn("qwen", ids)
        self.assertNotIn("claude", ids)
        self.assertNotIn("gemini", ids)

    def test_限流的工具照列但標記出來(self):
        """不是把它藏起來 —— 使用者知道自己裝了 claude，
        清單裡突然沒有它，比寫著「額度用完」更讓人困惑。"""
        self._status_file(limited=["claude"])
        self.available = {"claude", "qwen"}
        by = {x["id"]: x for x in self._call()["tools"]}
        self.assertTrue(by["claude"]["limited"])
        self.assertFalse(by["qwen"]["limited"])

    def test_地端永遠在清單裡而且不會限流(self):
        self._status_file(limited=["claude", "codex", "qwen"])
        self.available = set()
        by = {x["id"]: x for x in self._call()["tools"]}
        self.assertIn("local", by)
        self.assertFalse(by["local"]["limited"])

    def test_直接講出自動現在會挑到誰(self):
        self._status_file(limited=["claude", "codex"])
        self.available = {"claude", "codex", "qwen"}
        self.assertEqual(self._call()["auto"], "qwen")

    def test_全部限流時自動退回地端(self):
        self._status_file(limited=["claude", "codex", "qwen"])
        self.available = {"claude", "codex", "qwen"}
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



class TestDetectRateLimits(unittest.TestCase):
    """從派工 log 認出「這個工具沒額度了」。

    真實事件：codex 的 log 裡明明白白寫著
      「You've hit your usage limit... try again at Sep 1st, 2026 10:37 PM」
    但 status.json 的 rate_limited 還是 false，於是工單照樣送過去撞牆，
    改派邏輯（本來就寫好了）完全沒有觸發。

    原因是 enrich_reset_times 只替**已經被標成限流**的工具補恢復時間，
    它從來不會自己加上那個標記 —— 而它的註解卻寫著
    「真的還在限流的話，下次派工失敗會寫進 log 再被抓到」。
    那個「被抓到」在程式裡不存在。
    """

    QUOTA = ("ERROR: You've hit your usage limit. Visit https://example/usage "
             "to purchase more credits or try again at {when}.")

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="acrl_"))
        self._home = api.Path.home
        api.Path.home = staticmethod(lambda: self.tmp)      # log 目錄跟著搬
        (self.tmp / "ai-hub" / "dispatch-log").mkdir(parents=True)

    def tearDown(self):
        api.Path.home = self._home
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _log(self, tool: str, text: str, stamp="20260826-224319"):
        p = self.tmp / "ai-hub" / "dispatch-log" / f"{stamp}_{tool}.log"
        p.write_text(text, encoding="utf-8")
        return p

    @staticmethod
    def _data(**tools):
        return {"tools": {k: dict(v) for k, v in tools.items()}}

    def _future(self, days=6):
        return (datetime.datetime.now() + datetime.timedelta(days=days)).strftime("%b %d, %Y %I:%M %p")

    def test_認出限流並記下恢復時間(self):
        self._log("codex", self.QUOTA.format(when=self._future()))
        d = self._data(codex={"rate_limited": False, "status": "active"})
        api.detect_rate_limits(d)
        self.assertTrue(d["tools"]["codex"]["rate_limited"])
        self.assertEqual(d["tools"]["codex"]["status"], "rate_limited")
        self.assertTrue(d["tools"]["codex"]["reset_at"])

    def test_恢復時間已經過了就不算限流(self):
        past = (datetime.datetime.now() - datetime.timedelta(days=3)).strftime("%b %d, %Y %I:%M %p")
        self._log("codex", self.QUOTA.format(when=past))
        d = self._data(codex={"rate_limited": False})
        api.detect_rate_limits(d)
        self.assertFalse(d["tools"]["codex"].get("rate_limited"))

    def test_工單裡提到usage_limit不算(self):
        """工單本文會被寫進 log 開頭，而工單裡交代「撞到 usage limit 就回報」
        是家常便飯。把它當成真的撞牆，等於每一件成功的派工都會把工具關掉。"""
        self._log("gemini",
                  "【工單】如果撞到 usage limit 就停下來回報。\n"
                  "（這只是範例，不是本次執行）\n跑完了，改了三個檔案\n")
        d = self._data(gemini={"rate_limited": False})
        api.detect_rate_limits(d)
        self.assertFalse(d["tools"]["gemini"].get("rate_limited"))

    def test_沒有恢復時間就不標記(self):
        """沒有恢復時間 = 沒有證據證明現在還在限流。
        寧可讓它被派一次工再失敗，也不要把一個其實可用的工具永久關在門外
        —— 這跟 enrich_reset_times 的既有政策是同一條。"""
        self._log("qwen", "ERROR: quota exhausted\n")
        d = self._data(qwen={"rate_limited": False})
        api.detect_rate_limits(d)
        self.assertFalse(d["tools"]["qwen"].get("rate_limited"))

    def test_只看最近一次派工(self):
        """幾天前撞過一次牆不代表現在還在牆裡。
        只有最新那一份 log 算數，否則旗標會永遠黏著。"""
        self._log("gemini", self.QUOTA.format(when=self._future()), stamp="20260820-100000")
        self._log("gemini", "跑完了，一切正常\n", stamp="20260826-224320")
        d = self._data(gemini={"rate_limited": False})
        api.detect_rate_limits(d)
        self.assertFalse(d["tools"]["gemini"].get("rate_limited"))

    def test_已經標了就不覆蓋原本的證據(self):
        self._log("codex", self.QUOTA.format(when=self._future()))
        d = self._data(codex={"rate_limited": True, "evidence": "上游掃描器標的"})
        api.detect_rate_limits(d)
        self.assertEqual(d["tools"]["codex"]["evidence"], "上游掃描器標的")

    def test_沒有這個工具的狀態就不憑空生一個(self):
        self._log("cursor", self.QUOTA.format(when=self._future()))
        d = self._data(codex={"rate_limited": False})
        api.detect_rate_limits(d)
        self.assertNotIn("cursor", d["tools"])


class TestParseReset(unittest.TestCase):

    def test_跨年不會被當成已經過期(self):
        """12/31 的限流在 1/1 讀到時，補上「今年」會得到一個十二個月前的時間，
        於是旗標被清掉 —— 明明還在限流卻一直被派工。"""
        now = datetime.datetime(2027, 1, 1, 9, 0)
        when = api._parse_reset("12/31 23:00", now)
        self.assertIsNotNone(when)
        self.assertGreater(when, now)
        self.assertEqual(when.year, 2027)

    def test_解析不了就回None(self):
        self.assertIsNone(api._parse_reset("下週三", datetime.datetime.now()))
if __name__ == "__main__":
    unittest.main()
