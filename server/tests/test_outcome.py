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

import json
import shutil
import sys
import tempfile
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
            "文件只是在解釋 Traceback (most recent call last) 的格式",
            'README 的範例含有 "status":"failed"，不是本次執行結果',
        ):
            with self.subTest(benign=benign):
                self.assertEqual(api._parse_outcome(benign)["outcome"], "ok")

    def test_先529後成功要以最後終端結果為準(self):
        """重試成功後，早期 529 仍要算成本，但不能把整件工作留在紅色。"""
        text = CLAUDE_529 + '\nSTATUS: COMPLETE\n'
        got = api._parse_outcome(text)
        self.assertEqual(got["outcome"], "ok")
        self.assertEqual(got["issue"], "")
        self.assertAlmostEqual(got["cost"]["usd"], 0.001978, places=6)

    def test_地端候選沒改檔但後段真的改了要算成功(self):
        final = ('{"status":"COMPLETE",'
                 '"changed_files":["server/api.py","server/tests/test_outcome.py"]}')
        got = api._parse_outcome(GOVERNOR_NO_CHANGE + "\n" + final)
        self.assertEqual(got["outcome"], "ok")
        self.assertEqual(got["issue"], "")

    def test_早期成功但最後失敗要算失敗(self):
        success = '{"status":"COMPLETE","changed_files":["server/api.py"]}'
        got = api._parse_outcome(success + "\n" + CLAUDE_529)
        self.assertEqual(got["outcome"], "error")
        self.assertIn("529", got["issue"])

    def test_最後只有traceback也要算失敗(self):
        text = ("開始執行\n"
                "Traceback (most recent call last):\n"
                '  File "worker.py", line 7, in <module>\n'
                '    raise ValueError("壞資料")\n'
                "ValueError: 壞資料\n")
        got = api._parse_outcome(text)
        self.assertEqual(got["outcome"], "error")
        self.assertIn("ValueError", got["issue"])

    def test_wrapper正常不等於result裡的工作成功(self):
        cases = (
            ({"is_error": False, "result": "STATUS: FAILED"}, "error"),
            ({"success": True, "result": "STATUS: NO_CHANGES"}, "no_changes"),
            ({"success": True, "result": {"status": "UNAVAILABLE"}}, "error"),
            ({"is_error": False, "result": (
                "Traceback (most recent call last):\n"
                "  File \"worker.py\", line 1, in <module>\n"
                "ValueError: result 壞掉")}, "error"),
        )
        for record, expected in cases:
            with self.subTest(expected=expected):
                got = api._parse_outcome(json.dumps(record, ensure_ascii=False))
                self.assertEqual(got["outcome"], expected)

    def test_UNAVAILABLE是明確的終端失敗(self):
        got = api._parse_outcome("STATUS: UNAVAILABLE\n")
        self.assertEqual(got["outcome"], "error")
        self.assertIn("UNAVAILABLE", got["issue"])

    def test_正文提到API_Error範例不能變成失敗(self):
        benign = (
            "稽核文件提到 API Error: 529 Overloaded 是過去案例，本次沒有發生。\n"
            "工作仍照原計畫執行。"
        )
        self.assertEqual(api._parse_outcome(benign)["outcome"], "ok")

    def test_行首API_Error但明說是範例也不能誤判(self):
        benign_cases = (
            "API Error: 529 Overloaded is a historical example, not this run.\n",
            "API Error: 529 Overloaded 是歷史範例，並非本次執行。\n",
            "API Error: 529 Overloaded\n這只是歷史範例，並非本次執行。\n",
        )
        for text in benign_cases:
            with self.subTest(text=text):
                self.assertEqual(api._parse_outcome(text)["outcome"], "ok")

    def test_真正獨立錯誤行與結構化錯誤仍要判失敗(self):
        for text in (
            "API Error: 503 Service Unavailable\n",
            "API Error: 529 Overloaded. This is a server-side issue.\n",
            json.dumps({
                "is_error": True,
                "terminal_reason": "api_error",
                "api_error_status": 529,
                "result": "API Error: 529 Overloaded is a historical example",
            }),
        ):
            with self.subTest(text=text):
                self.assertEqual(api._parse_outcome(text)["outcome"], "error")

    def test_不同成本格式同一份log要全部算進去(self):
        text = (CLAUDE_529 + "\n" + GOVERNOR_NO_CHANGE
                + "\ntokens used\n500\n")
        cost = api._parse_outcome(text)["cost"]
        self.assertAlmostEqual(cost["usd"], 0.001978, places=6)
        self.assertEqual(cost["in"], 1908 + 810)
        self.assertEqual(cost["out"], 14 + 1000)
        self.assertEqual(cost["unattributed"], 500)
        self.assertEqual(cost["total"], 1908 + 810 + 14 + 1000 + 500)
        self.assertEqual(cost["model"], "mixed")

    def test_codex累積快照取最大值避免重複計算(self):
        text = ("tokens used\n100\n"
                "中途又印一次\n"
                "tokens used\n250\n"
                "tokens used\n250\n")
        cost = api._parse_outcome(text)["cost"]
        self.assertEqual(cost["in"], 0)
        self.assertEqual(cost["out"], 0)
        self.assertEqual(cost["unattributed"], 250)
        self.assertEqual(cost["total"], 250)

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
        api._COST_STREAMS.clear()

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

    def test_終端只看尾端但成本要掃完整log(self):
        with tempfile.TemporaryDirectory(prefix="accost_") as tmp:
            log = Path(tmp) / "large.log"
            log.write_text(
                GOVERNOR_NO_CHANGE + "\n" + ("一般執行輸出\n" * 12_000)
                + "STATUS: COMPLETE\n",
                encoding="utf-8")
            tail = api._tail_text(log)
            self.assertNotIn("input_tokens", tail)
            got = api._outcome_for(log, log.stat().st_size, tail)
            self.assertEqual(got["outcome"], "ok")
            self.assertEqual(got["cost"]["in"], 810)
            self.assertEqual(got["cost"]["out"], 1000)
            self.assertEqual(got["cost"]["model"], "local")

    def test_log成長時成本增量不能漏算或重複(self):
        with tempfile.TemporaryDirectory(prefix="accostgrow_") as tmp:
            log = Path(tmp) / "growing.log"
            log.write_text(GOVERNOR_NO_CHANGE + "\n", encoding="utf-8")
            first = api._outcome_for(log, log.stat().st_size, api._tail_text(log))
            self.assertEqual(first["cost"]["total"], 810 + 1000)

            with log.open("a", encoding="utf-8") as handle:
                handle.write(("一般執行輸出\n" * 12_000) + CLAUDE_529 + "\n")
            second = api._outcome_for(log, log.stat().st_size, api._tail_text(log))
            self.assertEqual(second["cost"]["in"], 810 + 1908)
            self.assertEqual(second["cost"]["out"], 1000 + 14)
            self.assertAlmostEqual(second["cost"]["usd"], 0.001978, places=6)


class TestDispatchState(unittest.TestCase):

    def _state(self, text: str, *, alive: bool = False, mode: str = "headless",
               echo_size=None) -> str:
        with tempfile.TemporaryDirectory(prefix="acstate_") as tmp:
            log = Path(tmp) / "dispatch.log"
            log.write_text(text, encoding="utf-8")
            record = {"log": str(log), "mode": mode}
            if echo_size is not None:
                record["echo_size"] = echo_size
            handler = api.Handler.__new__(api.Handler)
            return handler._dispatch_state(record, alive)

    def test_state跟outcome共用最後終端結果(self):
        recovered = CLAUDE_529 + "\nSTATUS: COMPLETE\n"
        failed = "STATUS: COMPLETE\n" + CLAUDE_529
        self.assertEqual(self._state(recovered), "done")
        self.assertEqual(self._state(failed), "failed")

    def test_running_waiting_silent語意不變(self):
        self.assertEqual(self._state(CLAUDE_529, alive=True), "running")
        echoed = "工單內提到 API Error: 529，尚未按下執行"
        self.assertEqual(self._state(echoed, mode="terminal",
                                     echo_size=len(echoed.encode("utf-8"))), "waiting")
        self.assertEqual(self._state(""), "silent")


if __name__ == "__main__":
    unittest.main()


class TestFullLogScan(unittest.TestCase):
    """成敗判定必須掃**完整** log，不能只看尾端。

    起因是模擬實驗（把程式跑起來實際點）發現的：主控台把三份實際失敗的
    派工全部顯示成「已完成」。查下去是因為判定只讀 log 的最後 64 KiB，
    而那份撞上 API Error 529、一個檔都沒改的派工，三個失敗標記
    （529、terminal_reason、"changed_files":[]）全落在 1.1 MB 檔案的
    42%～53% 處 —— 尾端永遠掃不到。

    也就是說：這個功能在它自己的起因案例上是壞的，而且壞得沒有任何徵兆。
    """

    def setUp(self):
        api._OUTCOME_CACHE.clear()
        api._COST_STREAMS.clear()
        self.tmp = Path(tempfile.mkdtemp(prefix="acscan_"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, *parts: str) -> Path:
        p = self.tmp / "d.log"
        p.write_text("".join(parts), encoding="utf-8")
        return p

    def test_失敗埋在中段也要抓得到(self):
        pad = "還在做事的普通輸出，一行一行地長。\n" * 20_000   # 遠超過 64 KiB
        log = self._write(pad, CLAUDE_529, "\n", pad)
        size = log.stat().st_size
        self.assertGreater(size, 400_000)
        # 先確認前提成立：尾端真的看不到
        self.assertEqual(api._parse_outcome_text(api._tail_text(log))["outcome"], "ok")
        # 掃完整份就抓得到
        got = api._scan_log(log, size, api._tail_text(log))
        self.assertEqual(got["outcome"], "error")
        self.assertIn("529", got["issue"])

    def test_中段的沒改到檔也要抓得到(self):
        pad = "普通輸出\n" * 30_000
        log = self._write(pad, GOVERNOR_NO_CHANGE, "\n", pad)
        got = api._scan_log(log, log.stat().st_size, "")
        self.assertEqual(got["outcome"], "no_changes")

    def test_中段的花費要累加進去(self):
        pad = "x\n" * 30_000
        log = self._write(pad, CLAUDE_529, "\n", pad, CLAUDE_529, "\n", pad)
        got = api._scan_log(log, log.stat().st_size, "")
        self.assertAlmostEqual(got["cost"]["usd"], 0.003956, places=6)

    def test_後面的成功要蓋掉前面的失敗(self):
        """一次重試失敗、第二次成功，最後的裁決是成功。
        取最後一個訊號而不是「有失敗就算失敗」，不然任何重試過的工作
        都會被永久標成紅色。"""
        pad = "重試中\n" * 20_000
        log = self._write(pad, CLAUDE_529, "\n", pad,
                          '{"is_error":false,"terminal_reason":"success","result":"完成"}', "\n")
        got = api._scan_log(log, log.stat().st_size, "")
        self.assertEqual(got["outcome"], "ok")

    def test_增量掃描的結果要跟一次掃完一樣(self):
        """還在跑的派工每次輪詢只掃新長出來的那段。
        分段掃跟一次掃完必須得到同一個答案，否則畫面會隨輪詢時機忽紅忽綠。"""
        pad = "y\n" * 5_000
        body = pad + CLAUDE_529 + "\n" + pad
        log = self.tmp / "grow.log"

        # 一次寫完、一次掃完
        log.write_text(body, encoding="utf-8")
        api._COST_STREAMS.clear()
        once = api._scan_log(log, log.stat().st_size, "")

        # 分十段長出來，每長一段掃一次
        api._COST_STREAMS.clear()
        log.write_text("", encoding="utf-8")
        step = max(1, len(body) // 10)
        for i in range(step, len(body) + step, step):
            log.write_text(body[:i], encoding="utf-8")
            grown = api._scan_log(log, log.stat().st_size, "")
        self.assertEqual(grown["outcome"], once["outcome"])
        self.assertEqual(grown["cost"], once["cost"])

    def test_log被截斷重寫時要重新開始(self):
        """檔案變小 = 換了一份 log。沿用舊狀態會把上一份的失敗帶到新的上面。"""
        log = self._write("x\n" * 20_000, CLAUDE_529)
        self.assertEqual(api._scan_log(log, log.stat().st_size, "")["outcome"], "error")
        log.write_text("乾淨的新紀錄\n", encoding="utf-8")
        self.assertEqual(api._scan_log(log, log.stat().st_size, "")["outcome"], "ok")


class TestBlockedIsNotFailure(unittest.TestCase):
    """BLOCKED 是照規範停下，不是失敗。

    這台機器的 POLICY 明寫「缺授權標 BLOCKED」—— agent 回報 BLOCKED 的時候
    它做對了。跟 529、崩潰混在同一個紅色裡的話，使用者會學會忽略紅字，
    然後真正的失敗也一起被忽略。
    """

    def test_blocked自成一類(self):
        got = api._parse_outcome_text('{"status":"BLOCKED","reason":"缺少當次授權"}')
        self.assertEqual(got["outcome"], "blocked")

    def test_blocked不會被當成error(self):
        self.assertNotIn("blocked", api._TERMINAL_ERROR)
