# -*- coding: utf-8 -*-
"""對話真正尾端讀取的安全、上限與格式回歸測試。"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402
import conversation_tail as tail  # noqa: E402


def _line(record: dict) -> str:
    return json.dumps(record, ensure_ascii=False) + "\n"


class TestConversationTail(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="ac_tail_")
        self.root = Path(self._tmp.name)
        self.index = self.root / "index.json"

    def tearDown(self):
        self._tmp.cleanup()

    def _index(self, source: Path, *, conv_id: str = "codex__safe-id",
               resume: str = "codex resume safe-id") -> None:
        self.index.write_text(json.dumps({
            "conversations": [{
                "id": conv_id,
                "tool": "codex",
                "path": str(source),
                "resume": resume,
            }],
        }), encoding="utf-8")

    def test_各家包裝都取真正最後幾則而且不重複(self):
        source = self.root / "chat.jsonl"
        source.write_text("".join([
            _line({"type": "user", "content": "最早", "timestamp": "2026-01-01T00:00:00Z"}),
            _line({"type": "assistant", "message": {
                "role": "assistant", "content": [{"type": "text", "text": "Claude 回覆"}],
            }}),
            _line({"type": "response_item", "payload": {
                "type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "Codex 最新提問"}],
            }}),
            _line({"role": "system", "content": "系統內容不可回傳"}),
            _line({"role": "tool", "content": "工具輸出不可回傳"}),
            _line({"type": "context.append_message", "time": "2026-01-01T00:00:03Z",
                   "message": {"role": "assistant", "content": "Kimi 最新回覆"}}),
        ]), encoding="utf-8")
        self._index(source)

        got = tail.load_indexed_tail(
            self.index, "codex__safe-id", allowed_root=self.root, limit=2,
        )

        self.assertEqual([m["text"] for m in got["messages"]],
                         ["Codex 最新提問", "Kimi 最新回覆"])
        self.assertEqual([m["role"] for m in got["messages"]], ["user", "assistant"])
        self.assertNotIn("系統內容不可回傳", [m["text"] for m in got["messages"]])
        self.assertNotIn("工具輸出不可回傳", [m["text"] for m in got["messages"]])
        self.assertTrue(got["truncated"])
        self.assertNotIn("path", got)  # 回應不能洩漏來源路徑

    def test_訊息數與單則文字都有硬上限(self):
        source = self.root / "many.jsonl"
        rows = [_line({"type": "user", "content": ("字" * 3000) + str(i)})
                for i in range(130)]
        source.write_text("".join(rows), encoding="utf-8")
        self._index(source)

        got = tail.load_indexed_tail(
            self.index, "codex__safe-id", allowed_root=self.root, limit=9999,
        )

        self.assertEqual(len(got["messages"]), tail.MAX_TAIL_MESSAGES)
        self.assertTrue(all(len(m["text"]) <= tail.MAX_MESSAGE_CHARS
                            for m in got["messages"]))
        self.assertTrue(got["truncated"])

    def test_只掃固定尾端仍取到最後完整訊息(self):
        source = self.root / "bounded.jsonl"
        latest = _line({"type": "assistant", "content": "真正最新"})
        source.write_bytes(
            _line({"type": "user", "content": "很早以前"}).encode("utf-8")
            + (("x" * 80 + "\n") * 100).encode("utf-8")
            + latest.encode("utf-8")
        )
        self._index(source)

        got = tail.load_indexed_tail(
            self.index, "codex__safe-id", allowed_root=self.root,
            max_scan_bytes=512,
        )

        self.assertEqual(got["messages"][-1]["text"], "真正最新")
        self.assertTrue(got["scanLimited"])

    def test_過大或壞掉的格式會明確失敗並保留接續提示(self):
        source = self.root / "bad.jsonl"
        source.write_text(_line({"type": "user", "content": "x" * 100}), encoding="utf-8")
        self._index(source)

        with mock.patch.object(tail, "MAX_RECORD_BYTES", 32), \
             self.assertRaises(tail.ConversationTailError) as caught:
            tail.load_indexed_tail(
                self.index, "codex__safe-id", allowed_root=self.root,
            )

        self.assertEqual(caught.exception.code, "unparseable_format")
        self.assertTrue(caught.exception.resume_available)
        self.assertIn("安全上限", str(caught.exception))

    def test_較舊有效但最新_record_壞掉時不能宣稱_latest(self):
        source = self.root / "partial.jsonl"
        source.write_bytes(
            _line({"type": "assistant", "content": "較舊的有效回覆"}).encode("utf-8")
            + b'{"type":"user","content":"not finished"'
        )
        self._index(source)

        with self.assertRaises(tail.ConversationTailError) as caught:
            tail.load_indexed_tail(
                self.index, "codex__safe-id", allowed_root=self.root,
            )

        self.assertEqual(caught.exception.code, "incomplete_tail")
        self.assertTrue(caught.exception.resume_available)

    def test_較舊有效但最新_record_過大時不能宣稱_latest(self):
        source = self.root / "oversized-tail.jsonl"
        source.write_text(
            _line({"type": "assistant", "content": "較舊的有效回覆"})
            + _line({"type": "user", "content": "x" * 200}),
            encoding="utf-8",
        )
        self._index(source)

        with mock.patch.object(tail, "MAX_RECORD_BYTES", 80), \
             self.assertRaises(tail.ConversationTailError) as caught:
            tail.load_indexed_tail(
                self.index, "codex__safe-id", allowed_root=self.root,
            )

        self.assertEqual(caught.exception.code, "incomplete_tail")

    def test_來源讀取錯誤不會把絕對路徑放進錯誤字串(self):
        source = self.root / "private-conversation-name.jsonl"
        with self.assertRaises(tail.ConversationTailError) as caught:
            tail.read_jsonl_tail(source)
        self.assertEqual(caught.exception.code, "source_read_failed")
        self.assertNotIn(str(source), str(caught.exception))

    def test_任意路徑字串不能當成_id(self):
        self.index.write_text('{"conversations": []}', encoding="utf-8")
        for bad in ("../../secret.jsonl", "C:\\secret.jsonl", "a&path=secret"):
            with self.subTest(bad=bad), self.assertRaises(tail.ConversationTailError) as caught:
                tail.load_indexed_tail(self.index, bad, allowed_root=self.root)
            self.assertEqual(caught.exception.code, "invalid_id")

    def test_即使索引被改成允許根之外也拒絕(self):
        with tempfile.TemporaryDirectory(prefix="ac_tail_outside_") as outside:
            source = Path(outside) / "secret.jsonl"
            source.write_text(_line({"type": "user", "content": "不可讀"}), encoding="utf-8")
            self._index(source)
            with self.assertRaises(tail.ConversationTailError) as caught:
                tail.load_indexed_tail(
                    self.index, "codex__safe-id", allowed_root=self.root,
                )
        self.assertEqual(caught.exception.code, "unsafe_source")

    def test_索引裡不是_jsonl_也不會被當成對話讀取(self):
        source = self.root / "notes.txt"
        source.write_text(_line({"type": "user", "content": "看起來像 JSONL"}), encoding="utf-8")
        self._index(source)

        with self.assertRaises(tail.ConversationTailError) as caught:
            tail.load_indexed_tail(
                self.index, "codex__safe-id", allowed_root=self.root,
            )

        self.assertEqual(caught.exception.code, "unsupported_format")
        self.assertTrue(caught.exception.resume_available)


class _FakeHandler(api.Handler):
    def __init__(self, path: str, headers: dict[str, str]):
        self.path = path
        self.headers = headers
        self.response: tuple[dict, int] | None = None

    def _json(self, obj, code=200):
        self.response = (obj, code)
        return self.response


class TestConversationTailEndpoint(unittest.TestCase):
    def test_跨來源讀私人對話會被拒絕(self):
        handler = _FakeHandler(
            "/api/conv/tail?id=codex__safe-id",
            {"Origin": "https://evil.example"},
        )
        handler.do_GET()
        self.assertEqual(handler.response[1], 403)

    def test_沒有來源_header_也不能讀私人對話(self):
        handler = _FakeHandler("/api/conv/tail?id=codex__safe-id", {})
        handler.do_GET()
        self.assertEqual(handler.response[1], 403)

    def test_端點只把_id_交給索引查詢而忽略_path_參數(self):
        handler = _FakeHandler(
            "/api/conv/tail?id=codex__safe-id&path=C%3A%5Csecret.jsonl",
            {"Origin": f"http://127.0.0.1:{api.PORT}"},
        )
        result = {"id": "codex__safe-id", "messages": [], "latest": True}
        with mock.patch.object(api, "load_indexed_tail", return_value=result) as load:
            handler.do_GET()

        load.assert_called_once_with(api.INDEX_JSON, "codex__safe-id")
        self.assertEqual(handler.response, ({"ok": True, **result}, 200))
        self.assertNotIn("path", handler.response[0])

    def test_解析失敗會回傳接續是否仍可用(self):
        handler = _FakeHandler(
            "/api/conv/tail?id=codex__safe-id",
            {"Referer": f"http://localhost:{api.PORT}/"},
        )
        failure = tail.ConversationTailError(
            "unsupported_format", "不支援", 422, resume_available=True,
        )
        with mock.patch.object(api, "load_indexed_tail", side_effect=failure):
            handler.do_GET()

        self.assertEqual(handler.response[1], 422)
        self.assertEqual(handler.response[0]["code"], "unsupported_format")
        self.assertTrue(handler.response[0]["resumeAvailable"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
