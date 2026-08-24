# -*- coding: utf-8 -*-
"""派工結果判定的回歸測試

起因是一個真實案例（2026-08-24）：派給 codex 的實作工單，它的地端優先
治理層先用一顆 4B 產出候選設計，接著的雲端步驟撞上 API Error 529 Overloaded，
整份工作在**沒有改到任何一個檔案**的情況下結束，而行程回傳 0。
派工畫面顯示「已完成」，使用者幾小時後才發現檔案根本沒動。

各家 CLI 宣告失敗的方式都在 log 裡，不在 exit code 裡。
這一份測的就是那些說法有沒有被認出來 —— 而且要同時守住反面：
log 裡出現「retry」「rate limit 這個詞被當成一般名詞提到」不能被誤判成失敗，
不然畫面會開始把成功的工作標成紅色，比沒有這個功能更糟。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402

# 真實 log 片段（截自 ~/ai-hub/dispatch-log，已去掉個人路徑）
CLAUDE_529 = (
    '{"is_error":true,"duration_api_ms":1020,"num_turns":1,'
    '"total_cost_usd":0.001978,'
    '"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":1908,'
    '"outputTokens":14,"costUSD":0.001978}},'
    '"terminal_reason":"api_error","api_error_status":529,'
    '"result":"API Error: 529 Overloaded. This is a server-side issue."}'
)
GOVERNOR_NO_CHANGE = (
    '{"schema_version":1,"mode":"LOCAL_FIRST_CANDIDATE","status":"OK",'
    '"selected_alias":"qwen_35_4b","model":"qwen/qwen3.5-4b",'
    '"changed_files":[],'
    '"stats":{"input_tokens":810,"total_output_tokens":1000,'
    '"tokens_per_second":12.67}}'
)


class TestParseOutcome(unittest.TestCase):

    def test_529_是失敗而且原因要看得到(self):
        got = api._parse_outcome(CLAUDE_529)
        self.assertEqual(got["outcome"], "error")
        self.assertIn("529", got["issue"])

    def test_失敗也要算得出花了多少(self):
        """撞牆的那一趟一樣有花錢。不算的話累計金額會偏低，
        而使用者對成本的直覺就是從那個數字來的。"""
        got = api._parse_outcome(CLAUDE_529)
        self.assertAlmostEqual(got["cost"]["usd"], 0.001978, places=6)
        self.assertEqual(got["cost"]["in"], 1908)
        self.assertEqual(got["cost"]["out"], 14)

    def test_治理層說自己一個檔都沒改(self):
        got = api._parse_outcome(GOVERNOR_NO_CHANGE)
        self.assertEqual(got["outcome"], "no_changes")

    def test_地端的花費是零元但有token數(self):
        """地端不花錢，但不能因此顯示成「沒有用量」——
        那會讓人以為地端那一段沒跑。"""
        got = api._parse_outcome(GOVERNOR_NO_CHANGE)
        self.assertEqual(got["cost"]["usd"], 0.0)
        self.assertEqual(got["cost"]["in"], 810)
        self.assertEqual(got["cost"]["out"], 1000)
        self.assertEqual(got["cost"]["model"], "local")

    def test_多段結算要加總(self):
        """一份 log 裡可以有好幾段結算（重試、子代理各一段）。
        只取最後一段的話，一趟跑了六個子代理只會算到第六個的錢。"""
        text = (CLAUDE_529 + "\n" + CLAUDE_529)
        got = api._parse_outcome(text)
        self.assertAlmostEqual(got["cost"]["usd"], 0.003956, places=6)
        self.assertEqual(got["cost"]["in"], 3816)

    def test_一切正常時是ok而且沒有原因欄(self):
        got = api._parse_outcome("已完成三項修改，測試 158 個全過。")
        self.assertEqual(got["outcome"], "ok")
        self.assertEqual(got["issue"], "")
        self.assertIsNone(got["cost"])

    def test_有改到檔就不是no_changes(self):
        got = api._parse_outcome('{"changed_files":["src/a.ts","src/b.ts"]}')
        self.assertEqual(got["outcome"], "ok")

    def test_不要把工單裡提到的詞當成失敗(self):
        """工單本文會被寫進 log 開頭。工單裡提到「限流」「額度」是家常便飯，
        誤判的話畫面會把成功的工作標成紅色 —— 比沒有這個功能更糟，
        因為使用者會開始不相信這個標示。"""
        for benign in (
            "請注意這個工具目前沒有 rate limit 的問題",
            "如果撞到 usage limit 就回報，不要自己重試",
            "檢查 quota 還夠不夠",
        ):
            with self.subTest(benign=benign):
                self.assertEqual(api._parse_outcome(benign)["outcome"], "ok")

    def test_codex只印總數也要算得到(self):
        """codex CLI 收尾只印一個總數、沒有拆輸入輸出、也沒有金額。
        不認得的話它每一趟都顯示成「沒有用量」—— 而它是這裡最貴的一個。"""
        got = api._parse_outcome("已完成三項修改。\ntokens used\n371,555\n")
        self.assertEqual(got["cost"]["total"], 371555)
        self.assertEqual(got["cost"]["in"], 0)
        self.assertEqual(got["cost"]["model"], "codex")

    def test_有拆輸入輸出時total是兩者相加(self):
        """畫面用同一個欄位顯示總量，不該讓它去分辨資料是哪一種格式來的。"""
        got = api._parse_outcome(CLAUDE_529)
        self.assertEqual(got["cost"]["total"], 1908 + 14)

    def test_真的撞牆還是要認得出來(self):
        """收緊誤判之後，真正的限流訊息不能跟著漏掉 ——
        那才是使用者最需要知道的一種失敗（等一下再派就好，不用查程式）。"""
        for real in (
            "You've hit your usage limit. Resets at 3pm.",
            "Rate limit exceeded, retry after 60s",
            "429 Too Many Requests",
            "quota exhausted for this billing period",
        ):
            with self.subTest(real=real):
                self.assertEqual(api._parse_outcome(real)["outcome"], "error")

    def test_ANSI色碼不要跑進原因字串(self):
        """CLI 的輸出帶顏色。原因直接顯示在畫面上，
        混著 ESC[31m 會變成一串亂碼。"""
        text = "\x1b[31mAPI Error: 503 Service Unavailable\x1b[0m"
        got = api._parse_outcome(text)
        self.assertEqual(got["outcome"], "error")
        self.assertNotIn("\x1b", got["issue"])


class TestOutcomeCache(unittest.TestCase):

    def setUp(self):
        api._OUTCOME_CACHE.clear()

    def test_同一份log同樣大小只解析一次(self):
        """/api/dispatches 每 8 秒被打一次、一次掃 30 份 log。
        沒有快取的話，光是正規表示式就會讓輪詢本身變成負擔。"""
        p = Path("fake.log")
        a = api._outcome_for(p, 100, CLAUDE_529)
        b = api._outcome_for(p, 100, "完全不一樣的內容")
        self.assertIs(a, b)          # 第二次根本沒解析，回的是同一個物件

    def test_log長大了就重新解析(self):
        """log 還在長 = 工作還在跑。size 一變就要重看，
        不然一件跑到一半被判定的狀態會一直留到最後。"""
        p = Path("fake.log")
        api._outcome_for(p, 100, "還在跑")
        got = api._outcome_for(p, 200, CLAUDE_529)
        self.assertEqual(got["outcome"], "error")


if __name__ == "__main__":
    unittest.main()
