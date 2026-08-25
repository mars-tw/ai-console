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


if __name__ == "__main__":
    unittest.main()
