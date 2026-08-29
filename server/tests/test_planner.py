# -*- coding: utf-8 -*-
"""派工拆解器的邏輯測試

不碰地端模型 —— 那是網路呼叫，測試不該依賴 LM Studio 有沒有開。
測的是純邏輯：指名判斷、JSON 挖取、行格式解析、失敗時的退路。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import planner  # noqa: E402

ALL = {"claude", "codex", "qwen", "gemini", "grok", "kimi", "cursor", "local"}


class TestNamedTool(unittest.TestCase):
    """使用者指名了誰，就一定要照他講的

    明明打了「用 codex」卻派給別人，是最讓人不敢再用這個介面的行為。
    """

    def test_動詞加工具名算指名(self):
        for text, want in [
            ("用 codex 把測試修好", "codex"),
            ("叫 claude 重構這個檔案", "claude"),
            ("請 qwen 翻譯這段", "qwen"),
            ("派 gemini 去查資料", "gemini"),
            ("交給 kimi 整理", "kimi"),
            ("讓 grok 生一張圖", "grok"),
        ]:
            with self.subTest(text=text):
                self.assertEqual(planner.named_tool(text, ALL), want)

    def test_中文別名(self):
        self.assertEqual(planner.named_tool("用千問翻譯這段", ALL), "qwen")
        self.assertEqual(planner.named_tool("交給反重力處理", ALL), "gemini")
        self.assertEqual(planner.named_tool("請克勞德看一下", ALL), "claude")
        self.assertEqual(planner.named_tool("用 agy 跑一次", ALL), "gemini")

    def test_句首指名(self):
        self.assertEqual(planner.named_tool("codex 幫我跑測試", ALL), "codex")

    def test_工具名當受詞不算指名(self):
        """「幫我修 codex 的設定檔」是要修 codex 的檔，不是要 codex 做事"""
        self.assertEqual(planner.named_tool("幫我修 codex 的設定檔", ALL), "")
        self.assertEqual(planner.named_tool("看看 claude 的 log 為什麼是空的", ALL), "")

    def test_沒指名就回空字串(self):
        self.assertEqual(planner.named_tool("把測試跑一遍", ALL), "")
        self.assertEqual(planner.named_tool("", ALL), "")

    def test_不在可用清單裡的不算指名(self):
        """限流中的工具被排掉之後，指名它也不該回它 —— 派出去也是失敗"""
        self.assertEqual(planner.named_tool("用 codex 修一下", {"claude", "local"}), "")

    def test_同時出現取最前面那個(self):
        self.assertEqual(planner.named_tool("用 codex 改完之後叫 claude 檢查", ALL), "codex")


class TestExtractJson(unittest.TestCase):
    def test_乾淨的_json(self):
        self.assertEqual(planner._extract_json('{"steps": []}'), {"steps": []})

    def test_包在_markdown_裡(self):
        got = planner._extract_json('```json\n{"steps": [{"tool": "codex"}]}\n```')
        self.assertEqual(got, {"steps": [{"tool": "codex"}]})

    def test_前後有廢話(self):
        got = planner._extract_json('好的，這是計畫：\n{"steps": []}\n希望有幫助！')
        self.assertEqual(got, {"steps": []})

    def test_單引號也吃(self):
        self.assertEqual(planner._extract_json("{'steps': []}"), {"steps": []})

    def test_挖不到就回_None(self):
        self.assertIsNone(planner._extract_json("完全沒有 JSON"))
        self.assertIsNone(planner._extract_json(""))
        self.assertIsNone(planner._extract_json("{ 壞掉的"))


class TestCleanSteps(unittest.TestCase):
    def test_不認得的工具換成預設(self):
        got = planner._clean_steps(
            {"steps": [{"tool": "不存在的AI", "task": "做事"}]}, ALL, "claude")
        self.assertEqual(got[0]["tool"], "claude")

    def test_跳過沒有內容的(self):
        got = planner._clean_steps(
            {"steps": [{"tool": "codex", "task": ""}, {"tool": "codex", "task": "有內容"}]},
            ALL, "claude")
        self.assertEqual(len(got), 1)

    def test_最多五件(self):
        got = planner._clean_steps(
            {"steps": [{"tool": "codex", "task": f"第{i}件"} for i in range(9)]}, ALL, "claude")
        self.assertEqual(len(got), 5)

    def test_不是清單就回空(self):
        self.assertEqual(planner._clean_steps({"steps": "不是陣列"}, ALL, "claude"), [])
        self.assertEqual(planner._clean_steps({}, ALL, "claude"), [])


class TestParseLines(unittest.TestCase):
    """小模型寫不出巢狀 JSON，但寫得出「工具 | 工作 | 理由」"""

    def test_基本解析(self):
        got = planner._parse_lines("codex | 跑測試並收集失敗 | 規格明確\n"
                                   "claude | 修掉失敗的地方 | 需要讀上下文", ALL, "claude")
        self.assertEqual([s["tool"] for s in got], ["codex", "claude"])
        self.assertEqual(got[0]["why"], "規格明確")

    def test_去掉編號與項目符號(self):
        got = planner._parse_lines("1. codex | 跑測試並收集失敗\n- claude | 修掉失敗的地方", ALL, "claude")
        self.assertEqual(len(got), 2)

    def test_跳過表頭(self):
        got = planner._parse_lines("工具 | 要做的事 | 原因\ncodex | 跑測試並收集失敗 | 明確", ALL, "claude")
        self.assertEqual(len(got), 1)

    def test_跳過把提示詞抄回來的行(self):
        got = planner._parse_lines("codex | 每行一件工作，用直線分隔 | x\n"
                                   "codex | 跑測試並收集失敗 | y", ALL, "claude")
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["task"], "跑測試並收集失敗")

    def test_重複的只留一件(self):
        got = planner._parse_lines("codex | 跑測試並收集失敗\ncodex | 跑測試並收集失敗", ALL, "claude")
        self.assertEqual(len(got), 1)

    def test_太短的不算工作(self):
        self.assertEqual(planner._parse_lines("codex | 好", ALL, "claude"), [])

    def test_沒有分隔線就整段跳過(self):
        self.assertEqual(planner._parse_lines("這只是一段說明文字", ALL, "claude"), [])


class TestPlanShortCircuits(unittest.TestCase):
    """不需要打模型就能決定的路徑"""

    def test_空輸入(self):
        got = planner.plan("", "some-model")
        self.assertFalse(got["ok"])
        self.assertEqual(got["steps"], [])

    def test_指名時直接回傳不打模型(self):
        got = planner.plan("用 codex 把測試修好", "不存在的模型", available=sorted(ALL))
        self.assertTrue(got["ok"])
        self.assertEqual(got["steps"][0]["tool"], "codex")
        self.assertEqual(got["steps"][0]["task"], "用 codex 把測試修好")

    def test_沒有地端模型時退回整件派工(self):
        got = planner.plan("把測試跑一遍", "", available=sorted(ALL))
        self.assertFalse(got["ok"])
        self.assertEqual(len(got["steps"]), 1)          # 失敗一定至少給一件
        self.assertEqual(got["steps"][0]["tool"], "claude")
        self.assertIn("沒有可用模型", got["note"])

    def test_可用清單只剩地端時退路也要跟著換(self):
        got = planner.plan("把測試跑一遍", "", available=["local"])
        self.assertEqual(got["steps"][0]["tool"], "local")

    def test_地端拆解第一發關閉_reasoning(self):
        captured = {}

        class Response:
            def read(self):
                return b'{"choices":[{"message":{"content":"{\\"steps\\":[]}"}}]}'

        def fake_open(request, timeout):
            captured.update(json.loads(request.data.decode("utf-8")))
            return Response()

        with mock.patch.object(planner.urllib.request, "urlopen", side_effect=fake_open):
            planner.plan("把測試跑一遍", "qwen/qwen3.5-4b", available=sorted(ALL))

        self.assertEqual(captured["reasoning"], "off")




class TestFasterModelHint(unittest.TestCase):
    """拆解逾時時建議一個跑得動的地端模型

    api.py 匯入成本高一點，但這個判斷正是使用者卡住時唯一的出路，
    不該只靠肉眼看程式碼。
    """

    @classmethod
    def setUpClass(cls):
        import api
        cls.hint = staticmethod(api.faster_model_hint)

    def test_慢的_dense_會建議_a3b(self):
        got = self.hint("qwen3.8-27b",
                        ["qwen3.8-27b", "qwen/qwen3.6-35b-a3b", "qwen/qwen3.5-4b"])
        self.assertIn("qwen3.6-35b-a3b", got)

    def test_已經在用_a3b_就不建議(self):
        self.assertEqual(
            self.hint("qwen/qwen3.6-35b-a3b", ["qwen/qwen3.6-35b-a3b", "kimi-linear-48b-a3b"]),
            "")

    def test_沒有更快的就不亂講(self):
        self.assertEqual(self.hint("qwen3.8-27b", ["qwen3.8-27b", "qwen/qwen3.5-4b"]), "")

    def test_不會建議自己(self):
        self.assertEqual(self.hint("kimi-linear-48b-a3b", ["kimi-linear-48b-a3b"]), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
