# -*- coding: utf-8 -*-
"""對話內容全文搜尋

為什麼要有這個功能：側欄的搜尋原本只比對標題、路徑與專案目錄。
但人真正記得的往往是「我那時候在哪一段對話裡討論過 CP950」，
不是那段對話當初被工具自動命名成什麼 —— 標題是工具取的，
常常跟內容沒關係。實測搜「CP950」時標題比對 0 筆、內容命中 3 份。

為什麼不建索引：實測 646 份對話、12 MB，整份掃一次 31～58 ms。
建索引要多養一份會過期的狀態、要處理增量更新與索引損壞 ——
為了省 50 ms 去養一個新的失敗來源，不划算。
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


class TestSearchConversations(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="acsearch_"))
        (self.tmp / "conv").mkdir()
        self._orig = api.DATA_DIR
        api.DATA_DIR = self.tmp
        api._SEARCH_CACHE.clear()
        self.write("a", [("user", "終端在輸出簡體字時遇到 Windows CP950 編碼限制"),
                         ("assistant", "我會改用 UTF-8 重新輸出")])
        self.write("b", [("user", "幫我看一下 UnicodeDecodeError"),
                         ("assistant", "那是 subprocess 的 text=True 造成的")])
        self.write("c", [("user", "今天天氣很好"), ("assistant", "是啊")])

    def tearDown(self):
        api.DATA_DIR = self._orig
        api._SEARCH_CACHE.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, msgs, **extra):
        (self.tmp / "conv" / f"{name}.json").write_text(
            json.dumps({"messages": [{"role": r, "text": t} for r, t in msgs], **extra},
                       ensure_ascii=False), encoding="utf-8")

    def ids(self, q):
        return {h["id"] for h in api._search_conversations(q)["hits"]}

    def test_找得到中文內容(self):
        self.assertEqual(self.ids("CP950"), {"a"})

    def test_大小寫不分(self):
        """英文技術詞常常大小寫不一致。要求使用者記得原文的大小寫是刁難。"""
        self.assertEqual(self.ids("unicodedecodeerror"), {"b"})
        self.assertEqual(self.ids("UNICODEDECODEERROR"), {"b"})

    def test_摘要要看得出是不是想找的那一段(self):
        """只回 id 的話，使用者還是得一份一份點開確認 —— 那跟沒搜到差不多。"""
        hit = api._search_conversations("CP950")["hits"][0]
        self.assertTrue(hit["snippets"])
        self.assertIn("CP950", hit["snippets"][0]["text"])
        self.assertEqual(hit["snippets"][0]["role"], "user")

    def test_太短的查詢不查(self):
        """中文一個字會命中幾乎所有東西，回幾百筆等於沒回答。"""
        got = api._search_conversations("的")
        self.assertTrue(got["tooShort"])
        self.assertEqual(got["hits"], [])
        self.assertEqual(got["scanned"], 0)

    def test_只出現在metadata裡不算命中(self):
        """檔名、標題那些欄位已經由前端的標題比對負責。
        這裡再算一次的話，同一份對話會在畫面上出現兩次。"""
        self.write("d", [("user", "無關內容")], title="CP950 筆記")
        self.assertNotIn("d", self.ids("CP950"))

    def test_正規表示式的特殊字元要當成字面(self):
        """使用者搜 `a.b(c)` 是在找那串字，不是在寫正規表示式。
        沒有 escape 的話輕則搜錯，重則一個 `(` 就讓後端丟例外。"""
        self.write("e", [("user", "設定檔裡寫 foo.bar(baz) 這一行")])
        self.assertEqual(self.ids("foo.bar(baz)"), {"e"})
        self.assertEqual(self.ids("foo*bar"), set())

    def test_結果數有上限而且會標示(self):
        for i in range(api._SEARCH_MAX_HITS + 8):
            self.write(f"bulk{i}", [("user", "共同關鍵字 zzz")])
        got = api._search_conversations("zzz")
        self.assertEqual(len(got["hits"]), api._SEARCH_MAX_HITS)
        self.assertTrue(got["truncated"], "截斷了就要說，不然使用者以為看到的是全部")

    def test_壞掉的檔案不能讓整個搜尋掛掉(self):
        (self.tmp / "conv" / "broken.json").write_text("{ 這不是 JSON", encoding="utf-8")
        self.assertEqual(self.ids("CP950"), {"a"})

    def test_沒有conv目錄也不會炸(self):
        shutil.rmtree(self.tmp / "conv")
        got = api._search_conversations("CP950")
        self.assertTrue(got["ok"])
        self.assertEqual(got["hits"], [])

    def test_檔案改了之後要搜得到新內容(self):
        """快取的鍵是 (路徑, mtime, 大小)。只用路徑當鍵的話，
        對話更新之後永遠搜到舊內容 —— 而且完全看不出來。"""
        self.assertEqual(self.ids("嶄新的關鍵字"), set())
        self.write("c", [("user", "今天天氣很好"), ("assistant", "嶄新的關鍵字")])
        import os
        p = self.tmp / "conv" / "c.json"
        st = p.stat()
        os.utime(p, (st.st_atime, st.st_mtime + 5))
        self.assertEqual(self.ids("嶄新的關鍵字"), {"c"})

    def test_查詢長度有上限(self):
        got = api._search_conversations("x" * 5000)
        self.assertLessEqual(len(got["q"]), api._SEARCH_MAX_Q)


if __name__ == "__main__":
    unittest.main()
