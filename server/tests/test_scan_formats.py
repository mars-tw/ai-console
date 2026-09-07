"""Synthetic discovery-to-index tests; no production conversations or credentials."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import indexer
import scan_ai


ROWS = [{"role": "user", "content": "What can we make today?"},
        {"role": "assistant", "content": "A small synthetic example."}]


class ScanFormatsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ac_formats_")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "home"
        self.home.mkdir()
        self.tool = self.home / ".new-assistant"
        self.tool.mkdir()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(scan_ai, "HOME", self.home).start()
        mock.patch.dict(os.environ, {"AI_CONSOLE_SCAN_DIRS": ""}).start()

    def write(self, name, value=ROWS):
        path = self.tool / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix.lower() in (".ndjson", ".jsonl"):
            text = "\n".join(json.dumps(r) for r in value) + "\n"
        else:
            text = json.dumps(value, indent=2)
        path.write_text(text, encoding="utf-8")
        return path

    def db(self, name="history.sqlite", *, unsupported=False, grouped=False):
        path = self.tool / name
        with contextlib.closing(sqlite3.connect(path)) as con, con:
            if unsupported:
                con.execute("CREATE TABLE sessions (id TEXT, title TEXT)")
                con.execute("INSERT INTO sessions VALUES ('s1', 'metadata only')")
            else:
                con.execute("CREATE TABLE messages (role TEXT, content TEXT, conversation_id TEXT, timestamp TEXT)")
                for row in ROWS:
                    con.execute("INSERT INTO messages VALUES (?, ?, 'a', '2026-09-01T00:00:00Z')",
                                (row["role"], row["content"]))
                if grouped:
                    con.execute("INSERT INTO messages VALUES ('user', 'A different conversation?', 'b', '')")
                con.execute("CREATE TABLE credentials (secret TEXT)")
                con.execute("INSERT INTO credentials VALUES ('synthetic sentinel')")
        return path

    def build(self, discovered=None):
        data = self.home / "output"
        with contextlib.ExitStack() as stack:
            for name, value in {"HOME": self.home, "AI_HUB": self.home / "ai-hub",
                                "DATA_DIR": data, "CONV_DIR": data / "conv",
                                "SOURCES_CACHE": data / "sources.json", "SOURCES": []}.items():
                stack.enter_context(mock.patch.object(indexer, name, value))
            stack.enter_context(mock.patch.object(sys, "argv", ["indexer.py", "--rescan"]))
            if discovered is not None:
                stack.enter_context(mock.patch.object(indexer, "discover_sources", return_value=discovered))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            indexer.main()
        result = json.loads((data / "index.json").read_text(encoding="utf-8"))
        exports = [json.loads(p.read_text(encoding="utf-8")) for p in (data / "conv").glob("*.json")]
        return result, exports

    def test_one_short_high_confidence_jsonl_discovers_and_exports(self):
        path = self.write("chat.jsonl", ROWS[:1])
        self.assertLess(path.stat().st_size, 120)
        report = scan_ai.scan_with_report()
        self.assertTrue(report["scan"]["complete"])
        self.assertEqual(len(report["sources"]), 1)
        result, exports = self.build()
        self.assertEqual(len(result["conversations"]), 1)
        self.assertEqual(exports[0]["messages"][0]["text"], ROWS[0]["content"])

    def test_ndjson_json_arrays_wrappers_and_sqlite_use_matching_parser(self):
        self.write("one.ndjson")
        self.write("two.NDJSON")
        self.write("array.json")
        self.write("wrapped.json", {"messages": ROWS})
        self.write("nested.json", {"data": {"history": ROWS}})
        self.db()
        discovered = scan_ai.scan_with_report()
        self.assertEqual(discovered["scan"]["matchedFiles"], 6)
        self.assertEqual(set(discovered["sources"][0]["patterns"]),
                         {"*.ndjson", "*.json", "*.sqlite"})
        result, exports = self.build()
        self.assertEqual(len(result["conversations"]), 6)
        self.assertEqual(len(exports), 6)
        self.assertTrue(all(len(e["messages"]) == 2 for e in exports))
        self.assertTrue(result["scan"]["complete"])

    def test_role_only_and_timestamp_text_configs_are_not_conversations(self):
        for row in ({"role": "user"}, {"role": "assistant", "content": []},
                    {"text": "configuration", "timestamp": "now"}):
            path = self.write("settings.json", row)
            self.assertFalse(scan_ai.sniff(path))
            self.assertFalse(scan_ai.looks_like_message(row))
        self.assertEqual(scan_ai.scan(), [])

    def test_json_and_jsonl_bom_sender_and_payload_roundtrip(self):
        for name, value in (("bom.json", {"turns": [{"sender": "human", "parts": ["Hello?"]}]}),
                            ("wrapped.jsonl", [{"data": {"payload": {
                                "role": "user", "content": "Nested?"}}}])):
            path = self.write(name, value)
            path.write_text("\ufeff" + path.read_text(encoding="utf-8"), encoding="utf-8")
            self.assertTrue(scan_ai.sniff(path))
            parsed = indexer.parse_jsonl_messages(path, True)
            self.assertEqual(parsed[3], 1)
            self.assertEqual(parsed[0][0]["role"], "user")

    def test_sqlite_schema_only_is_explicitly_unsupported(self):
        path = self.db(unsupported=True)
        self.assertFalse(scan_ai.sniff_db(path))
        self.assertEqual(indexer.parse_jsonl_messages(path, True)[3], 0)
        result = scan_ai.scan_with_report()
        self.assertFalse(result["scan"]["complete"])
        self.assertEqual(result["scan"]["unsupportedFiles"], 1)
        self.assertIn("unsupported-format", result["scan"]["reasons"])
        self.assertEqual(result["sources"], [])

    def test_sqlite_is_readonly_allowlisted_and_separates_conversations(self):
        path = self.db(grouped=True)
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        queries = []
        real_connect = sqlite3.connect
        def connect(*args, **kwargs):
            con = real_connect(*args, **kwargs)
            con.set_trace_callback(queries.append)
            return con
        with mock.patch.object(scan_ai.sqlite3, "connect", side_effect=connect):
            result, exports = self.build()
        self.assertEqual(len(result["conversations"]), 2)
        self.assertEqual(sorted(len(e["messages"]) for e in exports), [1, 2])
        self.assertEqual(before, hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertFalse(any("FROM credentials" in q for q in queries))
        self.assertFalse(any("SELECT *" in q for q in queries))
        self.assertFalse(Path(str(path) + "-journal").exists())

    def test_scan_depth_file_time_and_directory_caps_are_visible(self):
        self.write("nested/deep/one.jsonl")
        for attr, value, reason in (("MAX_DEPTH", 0, "depth-limit"),
                                    ("MAX_FILES_SNIFF", 0, "file-limit"),
                                    ("TIME_BUDGET", -1, "time-limit"),
                                    ("MAX_DIRS_PER_CAND", 0, "directory-limit")):
            with self.subTest(reason=reason), mock.patch.object(scan_ai, attr, value):
                report = scan_ai.scan_with_report()["scan"]
                self.assertFalse(report["complete"])
                self.assertIn(reason, report["reasons"])

    def test_deep_scan_expands_depth_budget(self):
        self.write("nested/deep/one.jsonl")
        with mock.patch.object(scan_ai, "MAX_DEPTH", 1):
            self.assertEqual(scan_ai.scan(), [])
            report = scan_ai.scan_with_report(deep=True)
        self.assertEqual(len(report["sources"]), 1)
        self.assertTrue(report["scan"]["deep"])

    def test_no_40_match_silent_cutoff(self):
        for i in range(41):
            self.write(f"chat-{i}.jsonl")
        report = scan_ai.scan_with_report()["scan"]
        self.assertEqual(report["matchedFiles"], 41)
        self.assertTrue(report["complete"])

    def test_malformed_and_oversized_json_report_partial(self):
        path = self.write("bad.json")
        path.write_text("{invalid", encoding="utf-8")
        self.assertIn("file-read-error", scan_ai.scan_with_report()["scan"]["reasons"])
        self.write("bad.json")
        with mock.patch.object(scan_ai, "JSON_BYTES", 10):
            self.assertIn("byte-limit", scan_ai.scan_with_report()["scan"]["reasons"])

    def test_shared_reader_reports_record_limit(self):
        path = self.write("large.json", ROWS * 5)
        parsed = scan_ai.read_conversation_records(path, max_records=3)
        self.assertEqual(len(parsed["records"]), 3)
        self.assertIn("record-limit", parsed["reasons"])

    def test_explicit_roots_are_scanned_directly_and_unsafe_roots_rejected(self):
        exported = self.home / "exports" / "tool"
        exported.mkdir(parents=True)
        (exported / "one.json").write_text(json.dumps(ROWS), encoding="utf-8")
        report = scan_ai.scan_with_report(extra_roots=[str(exported)])
        self.assertEqual(len(report["sources"]), 1)
        for root in (str(self.home), self.home.anchor, str(self.home / "Documents"),
                     str(self.tool / "auth"), "relative/path",
                     str(self.tool / ".."), str(Path(self.home.anchor) / "Users" / ".."),
                     str(self.home / "Documents" / "..")):
            with self.subTest(root=root), self.assertRaises(ValueError):
                scan_ai.scan_with_report(extra_roots=[root])
        with self.assertRaises(ValueError):
            scan_ai.scan_with_report(extra_roots=[str(exported)] * 9)

    def test_symlink_and_junction_paths_never_followed(self):
        real = self.home / "outside"
        real.mkdir()
        (real / "one.jsonl").write_text(json.dumps(ROWS[0]), encoding="utf-8")
        link = self.tool / "linked"
        try:
            link.symlink_to(real, target_is_directory=True)
        except OSError:
            if os.name != "nt":
                raise
            quote = lambda p: "'" + str(p).replace("'", "''") + "'"
            subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
                            f"New-Item -ItemType Junction -Path {quote(link)} -Target {quote(real)} | Out-Null"],
                           check=True, capture_output=True, timeout=10)
        self.assertTrue(scan_ai.is_link(link))
        self.assertEqual(scan_ai.scan(), [])
        self.assertEqual(list(indexer.iter_source_documents(
            {"root": self.tool, "pattern": "*.jsonl"}, scan_ai._report(), time.time() + 5)), [])
        with self.assertRaises(ValueError):
            scan_ai.validate_extra_roots([str(link)])

    def test_large_sqlite_database_still_exports_small_message_tables(self):
        path = self.db()
        with contextlib.closing(sqlite3.connect(path)) as con, con:
            con.execute("INSERT INTO credentials VALUES (zeroblob(?))", (9 * 1024 * 1024,))
        self.assertGreater(path.stat().st_size, indexer.FULL_PARSE_LIMIT)
        _, exports = self.build()
        self.assertEqual(len(exports), 1)
        self.assertEqual(len(exports[0]["messages"]), 2)

    def test_tool_folder_with_spaces_has_safe_stable_tool_id(self):
        spaced = self.home / "exports" / "My Chat Tool"
        spaced.mkdir(parents=True)
        (spaced / "chat.json").write_text(json.dumps(ROWS), encoding="utf-8")
        sources = scan_ai.scan(extra_roots=[str(spaced)])
        self.assertEqual(sources[0]["tool"], "my-chat-tool")
        result, exports = self.build(sources)
        self.assertEqual(len(result["conversations"]), 1)
        self.assertEqual(len(exports), 1)

    def test_unknown_ndjson_and_sqlite_are_visible_readonly_without_sidebar_claim(self):
        path = self.write("conversation.ndjson")
        database = self.db()
        old = time.time() - 365 * 86400
        for source in (path, database):
            os.utime(source, (old, old))
        with mock.patch.object(indexer, "ACTIVE_TOOLS", {"codex", "claude", "qwen", "kimi"}), \
             mock.patch.object(indexer, "TRASH_AFTER_DAYS", 1):
            result, exports = self.build()
        self.assertEqual(len(exports), 2)
        self.assertEqual(result["stats"]["discoveredConversations"], 2)
        self.assertEqual(result["stats"]["inApp"], 0)
        self.assertEqual(len(result["stats"]["discovered_sources"]), 1)
        for row in result["conversations"]:
            self.assertEqual(row["sourceKind"], "discovered")
            self.assertTrue(row["readOnly"])
            self.assertFalse(row["inApp"])
            self.assertFalse(row["trashed"])
            self.assertFalse(row["dispatch"])
            self.assertEqual(row["trashReason"], "")
            self.assertEqual(row["resume"], "")
            self.assertEqual(row["metadataSource"], "content-discovery")

    def test_discovered_worker_content_remains_classified_without_execution_authority(self):
        self.write("worker.ndjson", [{"role": "user", "content": "TASK_ID: synthetic worker only"}])
        result, _ = self.build()
        row = result["conversations"][0]
        self.assertTrue(row["dispatch"])
        self.assertTrue(row["readOnly"])
        self.assertFalse(row["inApp"])
        self.assertEqual(row["resume"], "")

    def test_discovery_does_not_revive_four_tool_non_sidebar_sessions(self):
        self.write("conversation.ndjson")
        found = scan_ai.scan()
        for tool in ("codex", "claude", "qwen", "kimi"):
            with self.subTest(tool=tool), mock.patch.object(indexer, "load_qwen_catalog", return_value=({}, True)):
                result, _ = self.build([{**found[0], "tool": tool, "label": tool}])
            row = result["conversations"][0]
            self.assertFalse(row["inApp"])
            self.assertTrue(row["trashed"])
            self.assertEqual(row["trashReason"], "not-in-app")
            self.assertNotIn("sourceKind", row)
            self.assertNotIn("readOnly", row)
            self.assertEqual(result["stats"]["discoveredConversations"], 0)

    def test_cached_scan_preserved_but_force_rescans_new_tool(self):
        self.write("first.jsonl")
        data = self.home / "output"
        with mock.patch.object(indexer, "DATA_DIR", data), \
             mock.patch.object(indexer, "SOURCES_CACHE", data / "sources.json"):
            first = indexer.discover_sources(force=True)
            other = self.home / ".another-tool"
            other.mkdir()
            (other / "chat.jsonl").write_text(json.dumps(ROWS[0]), encoding="utf-8")
            self.assertEqual(indexer.discover_sources(), first)
            self.assertTrue(indexer.LAST_SCAN_REPORT["cached"])
            self.assertEqual(len(indexer.discover_sources(force=True)), 2)
            self.assertFalse(indexer.LAST_SCAN_REPORT["cached"])
            self.assertIn("scan", json.loads((data / "sources.json").read_text(encoding="utf-8")))

    def test_partial_refresh_retains_previous_safe_sources(self):
        self.write("first.jsonl")
        data = self.home / "output"
        with mock.patch.object(indexer, "DATA_DIR", data), \
             mock.patch.object(indexer, "SOURCES_CACHE", data / "sources.json"):
            first = indexer.discover_sources(force=True)
            with mock.patch.object(scan_ai, "TIME_BUDGET", -1):
                self.assertEqual(indexer.discover_sources(force=True), first)
            self.assertFalse(indexer.LAST_SCAN_REPORT["complete"])
            self.assertEqual(indexer.LAST_SCAN_REPORT["retainedSources"], 1)

    def test_stale_cache_cannot_reintroduce_broad_or_traversal_roots(self):
        for root in (self.home.anchor, str(self.home),
                     str(Path(self.home.anchor) / "Users" / "..")):
            with self.subTest(root=root):
                sources, _ = indexer.merge_discovered_sources([], [{
                    "root": root, "tool": "old", "label": "Old",
                    "pattern": "*.jsonl", "hits": 1}])
                self.assertEqual(sources, [])

    def test_unsafe_cli_root_does_not_delete_previous_export(self):
        data = self.home / "output"
        conv = data / "conv"
        conv.mkdir(parents=True)
        old = conv / "previous.json"
        old.write_text("{}", encoding="utf-8")
        with mock.patch.object(indexer, "CONV_DIR", conv), \
             mock.patch.object(sys, "argv", ["indexer.py", "--scan-root", str(self.home)]), \
             self.assertRaises(ValueError):
            indexer._build_index()
        self.assertTrue(old.exists())
        with mock.patch.object(indexer, "CONV_DIR", conv), \
             mock.patch.object(sys, "argv", ["indexer.py"]), \
             mock.patch.dict(os.environ, {"AI_CONSOLE_SCAN_DIRS": self.home.anchor}), \
             self.assertRaises(ValueError):
            indexer._build_index()
        self.assertTrue(old.exists())


if __name__ == "__main__":
    unittest.main()
