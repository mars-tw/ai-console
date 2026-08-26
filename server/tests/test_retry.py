# -*- coding: utf-8 -*-
"""原樣重派的回歸測試

為什麼需要重派：撞上 API 529、被規範擋下、或跑完什麼都沒改的時候，
原本唯一的辦法是把整份工單重打一次 —— 而工單常常是幾十行。
529 是伺服器端的暫時性問題，重派一次就好。

這一份測的是「取回原始工單」那一步，因為那是唯一會壞的地方：
切錯的話會送出一份半截的工單，而使用者以為重跑了同一件事。
那種錯不會有任何徵兆，只會得到一個莫名其妙的結果。
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402
import rules  # noqa: E402

PREAMBLE = (
    "【執行前置｜這段是派工系統加的，請先照做再開始工作】\n"
    "1. 先讀規範。\n"
    "\n"
    "【工單】\n"
)


class TestOrderBody(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="acretry_"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, text: str) -> Path:
        p = self.tmp / "x_task.md"
        p.write_text(text, encoding="utf-8")
        return p

    def test_切在分隔線之後(self):
        got = api._order_body(self._write(PREAMBLE + "把 tools 底下的腳本補上說明。\n"))
        self.assertEqual(got, "把 tools 底下的腳本補上說明。")

    def test_多行工單要完整拿回來(self):
        task = "第一行\n第二行\n\n第四行"
        self.assertEqual(api._order_body(self._write(PREAMBLE + task + "\n")), task)

    def test_工單自己提到工單兩個字不會切錯(self):
        """使用者在工單裡寫「【工單】」會被 rules._neutralize 換成半形，
        所以檔案裡全形的那一個一定是系統加的分隔線 —— 只有一個切點。
        這是重派能原樣重現的前提，所以連著中和那一步一起測。"""
        raw = "請照【工單】格式寫一份範例，開頭要有【執行前置】字樣。"
        wrapped, _ = rules.wrap(raw, "codex")
        got = api._order_body(self._write(wrapped))
        # 拿回來的是中和後的版本（半形），內容完整，而且不含全形控制標記
        self.assertIn("格式寫一份範例", got)
        self.assertNotIn("【工單】", got)
        self.assertNotIn("【執行前置", got)

    def test_中和過的工單再包一次是冪等的(self):
        """重派會把取回的內容當成新工單再送一次 rules.wrap。
        如果那一步不是冪等的，重派幾次之後工單會愈變愈奇怪。"""
        raw = "請照【工單】格式寫一份範例。"
        once, _ = rules.wrap(raw, "codex")
        body_once = api._order_body(self._write(once))
        twice, _ = rules.wrap(body_once, "codex")
        self.assertEqual(api._order_body(self._write(twice)), body_once)

    def test_沒有分隔線就回空字串(self):
        """寧可不重派，也不要送出半截的工單 ——
        那比不能重派更糟，使用者會以為重跑了同一件事。"""
        self.assertEqual(api._order_body(self._write("完全沒有分隔線的內容\n")), "")

    def test_檔案不存在就回空字串(self):
        self.assertEqual(api._order_body(self.tmp / "沒有這個檔.md"), "")

    def test_分隔線後面是空的也算失敗(self):
        self.assertEqual(api._order_body(self._write(PREAMBLE + "\n   \n")), "")



class TestHandoffOrder(unittest.TestCase):
    """原本那個 AI 接不下去時，把工作交給另一個。

    使用者問的原話：「接續工作也是原ai去執行，問題額度就用完了怎麼執行」。

    他指出的是一個真的缺口：「💬 補一句」是用各家的續談旗標
    （--continue / -c / resume --last）再派一次 —— **一定是原本那個 AI 執行**。
    它撞到額度上限時這條路就斷了；kimi 這種只能開終端的工具從來就沒有這條路。
    以前這兩種情況都只回一句「只能重新派一件」，把問題丟回給使用者，
    而他要做的事是把整份工單重打一遍。

    對話脈絡活在原工具裡帶不走，但「原始工單」與「它做到哪裡」我們手上就有。
    這一份測的就是那份接力工單有沒有把該帶的都帶過去 ——
    少帶了接手的 AI 會重做一遍，多帶了它的注意力會被前一個 AI 的思考過程吃光。
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="achand_"))
        self.log = self.tmp / "20260101-000000_kimi.log"
        self.log.write_text("開始工作\n" * 50 + "改好了 server/api.py\n", encoding="utf-8")
        (self.tmp / "20260101-000000_task.md").write_text(
            PREAMBLE + "把 tools 底下的腳本補上使用說明。\n", encoding="utf-8")
        self.target = {"id": "20260101-000000", "tool": "kimi", "log": str(self.log)}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _order(self, text="順便跑一次測試"):
        return api.Handler._handoff_order(api.Handler, self.target, text, "kimi 沒有無頭續談模式")

    def test_帶上原始工單(self):
        # 少了它，接手的 AI 只知道「有人做過什麼」，不知道原本要做什麼
        self.assertIn("把 tools 底下的腳本補上使用說明", self._order())

    def test_帶上前一個AI做到哪裡(self):
        # 少了它，接手的會從頭再做一遍
        self.assertIn("改好了 server/api.py", self._order())

    def test_帶上使用者這次的補充(self):
        self.assertIn("順便跑一次測試", self._order())

    def test_講明原因與是誰做過(self):
        order = self._order()
        self.assertIn("接力", order)
        self.assertIn("kimi", order)

    def test_明確要求不要重做(self):
        """接手的 AI 不知道前面做過什麼就會全部重來 ——
        對已經改過的檔案再改一次，結果往往比沒接手更糟。"""
        self.assertIn("不要把它做過的事再做一次", self._order())

    def test_log太長要截掉(self):
        """太多會把接手的 AI 的注意力吃光，而且前面多半是它自己的思考過程"""
        self.log.write_text("雜訊\n" * 50_000, encoding="utf-8")
        self.assertLess(len(self._order()), 12_000)

    def test_工單檔不見了也要能組出東西(self):
        (self.tmp / "20260101-000000_task.md").unlink()
        order = self._order()
        self.assertIn("原始工單檔已經不在", order)
        self.assertIn("改好了 server/api.py", order)   # 至少還有進度

    def test_沒有log也不會炸(self):
        self.target["log"] = str(self.tmp / "沒有這個.log")
        self.assertIn("把 tools 底下的腳本", self._order())

    def test_只開終端的工具不要把回顯的工單當成進度(self):
        """kimi／grok／cursor 只開終端，log 裡只有啟動時回顯的那份工單。

        原封不動貼進來的話，接手的 AI 會在同一份工單裡看到原始工單兩次，
        而且第二次被標成「它已經做到哪裡」—— 那是假的進度，
        會讓它以為前面已經做過了什麼。
        """
        self.log.write_text(
            "[20260101] kimi 開啟可見終端\n"
            "指令：【執行前置｜這段是派工系統加的】\n【工單】\n做某件事\n",
            encoding="utf-8")
        order = self._order()
        self.assertIn("沒有留下可讀的輸出", order)
        self.assertNotIn("── kimi 已經做到哪裡", order)
        # 規則也要跟著改口 —— 叫它去讀一段不存在的東西，
        # 它會自己編一個以為的進度出來
        self.assertIn("先自己確認檔案現況", order)

    def test_真的有輸出時照常帶過去(self):
        self.log.write_text("跑完了，改了三個檔案\n", encoding="utf-8")
        order = self._order()
        self.assertIn("── kimi 已經做到哪裡", order)
        self.assertIn("改了三個檔案", order)


if __name__ == "__main__":
    unittest.main()
