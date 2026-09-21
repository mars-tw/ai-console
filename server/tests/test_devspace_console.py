"""DevSpace contracts; all execution fixtures are local and never call a model."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import devspace_console as dc


class DevSpaceConsoleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="console-devspace-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.project = self.home / "projects" / "專案 A & B"
        self.project.mkdir(parents=True)
        self.config_dir = self.home / ".devspace"
        self.config_dir.mkdir()
        self.state = self.home / "state"
        self.state.mkdir()
        self.config = {"host": "127.0.0.1", "port": 7676,
                       "allowedRoots": [str(self.project.parent)], "stateDir": str(self.state),
                       "subagents": {"enabled": True, "providers": [
                           {"id": "codex", "enabled": True, "model": "config-is-not-availability"},
                           {"id": "claude", "enabled": True},
                           {"id": "local", "enabled": True, "model": "lmstudio-auto"},
                           {"id": "grok", "enabled": True}]}}
        self.write_config()
        # The adapter checks existence only; this content must never be read.
        (self.config_dir / "auth.json").write_text("AUTH_CONTENT_MUST_NOT_BE_READ", encoding="utf-8")
        self.console = dc.DevSpaceConsole(env={"PATH": "", "DEVSPACE_CONFIG_DIR": str(self.config_dir)}, home=self.home)
        self.body = {"cwd": str(self.project)}

    def write_config(self):
        (self.config_dir / "config.json").write_text(json.dumps(self.config), encoding="utf-8")

    def make_history(self):
        with sqlite3.connect(self.state / "devspace.sqlite") as conn:
            conn.execute("""CREATE TABLE local_agent_sessions (
                id TEXT, workspace_root TEXT, profile_name TEXT, provider TEXT, model TEXT,
                status TEXT, latest_response TEXT, error_code TEXT,
                error_retryable TEXT, updated_at TEXT)""")
            records = [
                ("agt_12345678", str(self.project), "codex", "codex", "gpt-5.6-sol", "idle", "完成 ✓", None, None, "2026-09-18"),
                ("agt_22345678", str(self.project), "local-reviewer", "local", "lmstudio-auto", "error", None, "MODEL_ERROR", "true", "2026-09-17"),
                ("agt_32345678", str(self.project.parent), "codex", "codex", "gpt-6-astra", "idle", "另一個專案", None, None, "2026-09-16"),
                ("agt_42345678", str(self.project), "grok", "grok", "grok-legacy", "idle", "Retired", None, None, "2026-09-15"),
                ("agt_52345678", str(self.project), "claude", "claude", "claude-legacy", "running", None, None, None, "2026-09-14"),
                ("agt_62345678", str(self.project), "codex", "codex", "gpt-6-astra", "running", None, None, None, "2026-09-13"),
            ]
            conn.executemany("INSERT INTO local_agent_sessions VALUES (?,?,?,?,?,?,?,?,?,?)", records)
        conn.close()

    def test_status_passive_missing_cli_no_auth_content(self):
        with mock.patch.object(self.console, "_health", return_value=False), mock.patch.object(self.console, "_execute") as execute:
            value = self.console.status()
        self.assertTrue(value["ok"])
        self.assertFalse(value["installed"])
        self.assertTrue(value["configured"])
        self.assertEqual(value["targets"], [{"name": "codex", "kind": "provider"}])
        self.assertEqual(value["models"], [
            {"id": "gpt-5.6-sol", "label": "GPT-5.6 SOL"},
            {"id": "gpt-6-astra", "label": "GPT-6 ASTRA"},
        ])
        self.assertEqual(value["defaultModel"], "gpt-5.6-sol")
        self.assertNotIn("config-is-not-availability", json.dumps(value))
        self.assertNotIn("AUTH_CONTENT", json.dumps(value))
        self.assertNotIn("auth.json", json.dumps(value))
        execute.assert_not_called()

    def test_nested_jsonc_comments_trailing_commas(self):
        config = {"configVersion": 1, "server": {"port": 8877},
                  "workspaces": {"allowedRoots": [str(self.project)]},
                  "storage": {"stateDir": str(self.state)}, "subagents": self.config["subagents"]}
        text = json.dumps(config, ensure_ascii=False)
        text = "// user configuration\n" + text[:-1] + ', "comment": "https://example/x//y/*z*/,}", /* comment */ }'
        (self.config_dir / "config.jsonc").write_text(text, encoding="utf-8")
        cfg = self.console._config()
        self.assertEqual(cfg["allowed"], [self.project])
        self.assertEqual(cfg["endpoint"], "http://127.0.0.1:8877/mcp")
        self.assertEqual(cfg["stateDir"], self.state)
        self.assertEqual(cfg["configFormat"], "jsonc")
        self.assertEqual((self.config_dir / "config.jsonc").read_text(encoding="utf-8"), text)

    def test_jsonc_preserves_escaped_quotes_and_slashes(self):
        value = {"value": 'a\\"//not comment/*still string*/', "comma": ",}"}
        self.assertEqual(dc._read_jsonc(json.dumps(value)[:-1] + ",}"), value)
        with self.assertRaises(ValueError):
            dc._read_jsonc('{"a": 1 /*')

    def test_future_schema_fails_without_private_details(self):
        self.config["configVersion"] = 42
        self.config["ownerToken"] = "DO_NOT_EXPOSE_THIS"
        self.write_config()
        result = self.console.status()
        self.assertEqual(result["code"], "UNSUPPORTED_CONFIG")
        self.assertNotIn("DO_NOT_EXPOSE_THIS", json.dumps(result))

    def test_yaml_is_explicitly_unsupported(self):
        (self.config_dir / "config.json").unlink()
        (self.config_dir / "config.yaml").write_text("host: localhost", encoding="utf-8")
        self.assertEqual(self.console.status()["code"], "UNSUPPORTED_CONFIG")

    def test_invalid_json_and_nonlocal_host_fail_closed(self):
        (self.config_dir / "config.json").write_text("SECRET_INVALID_JSON", encoding="utf-8")
        result = self.console.status()
        self.assertEqual(result["code"], "INVALID_CONFIG")
        self.assertNotIn("SECRET", json.dumps(result))
        self.config["host"] = "example.com"
        self.write_config()
        self.assertEqual(self.console.status()["code"], "NONLOCAL_HOST")

    def test_env_roots_and_subagents_match_cli_configuration(self):
        self.console.env["DEVSPACE_ALLOWED_ROOTS"] = str(self.project)
        self.console.env["DEVSPACE_SUBAGENTS"] = "false"
        cfg = self.console._config()
        self.assertEqual(cfg["allowed"], [self.project])
        self.assertEqual(cfg["targets"], [])

    def test_history_is_project_scoped_readonly_and_does_not_start_daemon(self):
        self.make_history()
        db = self.state / "devspace.sqlite"
        before = db.read_bytes()
        with mock.patch.object(self.console, "_execute") as execute:
            value = self.console.tasks(self.body)
        self.assertTrue(value["ok"], value)
        self.assertFalse(value["daemonRunning"])
        self.assertEqual([t["id"] for t in value["tasks"]],
                         ["agt_12345678", "agt_22345678", "agt_52345678", "agt_62345678"])
        self.assertEqual([t["model"] for t in value["tasks"]],
                         ["gpt-5.6-sol", "lmstudio-auto", "claude-legacy", "gpt-6-astra"])
        self.assertTrue(value["tasks"][-1]["stale"])
        self.assertEqual(db.read_bytes(), before)
        execute.assert_not_called()

    def test_show_handles_completed_failed_and_cross_project(self):
        self.make_history()
        value = self.console.show({**self.body, "id": "agt_12345678"})
        self.assertEqual(value["task"]["response"], "完成 ✓")
        self.assertEqual(value["task"]["model"], "gpt-5.6-sol")
        value = self.console.show({**self.body, "id": "agt_22345678"})
        self.assertEqual(value["task"]["model"], "lmstudio-auto")
        self.assertEqual(value["task"]["error"]["code"], "MODEL_ERROR")
        self.assertTrue(value["task"]["error"]["retryable"])
        for agent_id in ("agt_32345678", "agt_42345678"):
            self.assertEqual(self.console.show({**self.body, "id": agent_id})["code"], "TASK_NOT_FOUND")
        self.assertEqual(self.console.show({**self.body, "id": "--version"})["code"], "INVALID_TASK")

    def test_missing_database_returns_empty_without_creating_files(self):
        value = self.console.tasks(self.body)
        self.assertTrue(value["ok"])
        self.assertEqual(value["tasks"], [])
        self.assertEqual(list(self.state.iterdir()), [])

    def test_unknown_database_schema_returns_actionable_error(self):
        with sqlite3.connect(self.state / "devspace.sqlite") as conn:
            conn.execute("CREATE TABLE unrelated (id TEXT)")
        conn.close()
        self.assertEqual(self.console.tasks(self.body)["code"], "HISTORY_UNAVAILABLE")

    def test_history_schema_without_model_is_explicitly_incompatible(self):
        with sqlite3.connect(self.state / "devspace.sqlite") as conn:
            conn.execute("""CREATE TABLE local_agent_sessions (
                id TEXT, workspace_root TEXT, profile_name TEXT, provider TEXT,
                status TEXT, latest_response TEXT, error_code TEXT,
                error_retryable TEXT, updated_at TEXT)""")
        conn.close()
        result = self.console.tasks(self.body)
        self.assertEqual(result["code"], "HISTORY_UNAVAILABLE")
        self.assertIn("格式不相容", result["error"])

    def test_cwd_rejects_relative_traversal_sibling_and_missing_path(self):
        for path in ("relative", str(self.home), str(self.project.parent / ".."), str(self.home / "projects-evil")):
            self.assertFalse(self.console.tasks({"cwd": path})["ok"], path)
        self.assertEqual(self.console.tasks({"cwd": str(self.project / "missing")})["code"], "INVALID_WORKSPACE")

    def test_symlink_escape_is_rejected(self):
        outside = self.home / "outside"
        outside.mkdir()
        link = self.project / "link"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("Host does not permit directory symlinks")
        self.assertEqual(self.console.tasks({"cwd": str(link)})["code"], "WORKSPACE_NOT_ALLOWED")

    def test_git_parent_outside_allowed_roots_is_rejected(self):
        git_result = subprocess.CompletedProcess([], 0, str(self.home), "")
        with mock.patch.object(dc.shutil, "which", return_value="git"), mock.patch.object(dc.subprocess, "run", return_value=git_result):
            self.assertEqual(self.console.tasks(self.body)["code"], "WORKSPACE_NOT_ALLOWED")

    def test_run_always_passes_allowed_model_and_returns_selection(self):
        catalog = {"targets": [{"name": "codex", "kind": "provider"}]}
        prompt = "執行這項工作"
        for model in ("gpt-5.6-sol", "gpt-6-astra"):
            with self.subTest(model=model), mock.patch.object(
                    self.console, "_json", side_effect=[catalog, {"id": "agt_12345678", "status": "running"}]) as call:
                result = self.console.run({**self.body, "target": "codex", "model": model, "prompt": prompt})
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["task"]["model"], model)
            self.assertEqual(call.call_args_list[1].args[0],
                             ["agents", "run", "codex", "--model", model, "--json", "--", prompt])
            self.assertEqual(call.call_args_list[1].kwargs["cwd"], self.project)

    def test_run_without_model_defaults_and_keeps_prompt_literal(self):
        prompt = '--model evil\n請讀檔案 & echo bad | $(whoami) `quoted` "單引號\'"'
        replies = [{"targets": [{"name": "codex", "kind": "provider"}]},
                   {"id": "agt_12345678", "status": "running"}]
        with mock.patch.object(self.console, "_json", side_effect=replies) as call:
            result = self.console.run({**self.body, "target": "codex", "prompt": prompt})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["task"]["model"], "gpt-5.6-sol")
        self.assertEqual(call.call_args.args[0],
                         ["agents", "run", "codex", "--model", "gpt-5.6-sol", "--json", "--", prompt])

    def test_invalid_model_fails_before_any_devspace_cli_call(self):
        for model in ("gpt-4", "gpt-5.6-sol ", None, {"id": "gpt-6-astra"}):
            with self.subTest(model=model), mock.patch.object(self.console, "_json") as call:
                run = self.console.run({**self.body, "target": "codex", "model": model, "prompt": "x"})
                continued = self.console.continue_task(
                    {**self.body, "id": "agt_12345678", "model": model, "prompt": "x"})
            self.assertEqual(run["code"], "MODEL_NOT_ALLOWED")
            self.assertEqual(continued["code"], "MODEL_NOT_ALLOWED")
            call.assert_not_called()

    def test_run_rejects_noncodex_disabled_and_shadowed_targets(self):
        with mock.patch.object(self.console, "_json") as call:
            for target in ("claude", "local", "grok", "custom-profile", "--help", None):
                with self.subTest(target=target):
                    result = self.console.run({**self.body, "target": target, "model": "gpt-5.6-sol", "prompt": "x"})
                    self.assertEqual(result["code"], "TARGET_NOT_ALLOWED")
            call.assert_not_called()
        self.config["subagents"]["providers"][0]["enabled"] = False
        self.write_config()
        with mock.patch.object(self.console, "_json") as call:
            self.assertEqual(self.console.run({**self.body, "target": "codex", "model": "gpt-5.6-sol",
                                               "prompt": "x"})["code"], "TARGET_NOT_ALLOWED")
            call.assert_not_called()
        self.config["subagents"]["providers"][0]["enabled"] = True
        self.write_config()
        catalog = {"targets": [{"name": "codex", "kind": "provider"},
                               {"name": "codex", "kind": "profile", "provider": "grok"}]}
        with mock.patch.object(self.console, "_json", return_value=catalog) as call:
            self.assertEqual(self.console.run({**self.body, "target": "codex", "model": "gpt-5.6-sol",
                                               "prompt": "x"})["code"], "TARGET_SHADOWED")
            self.assertEqual(call.call_count, 1)

    def test_continue_always_passes_allowed_model_or_default(self):
        self.make_history()
        cases = ((None, "gpt-5.6-sol"), ("gpt-5.6-sol", "gpt-5.6-sol"),
                 ("gpt-6-astra", "gpt-6-astra"))
        for requested, expected in cases:
            body = {**self.body, "id": "agt_12345678", "prompt": "再檢查"}
            if requested is not None:
                body["model"] = requested
            with self.subTest(model=requested), mock.patch.object(
                    self.console, "_json", return_value={"id": "agt_12345678", "status": "running"}) as call:
                result = self.console.continue_task(body)
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["task"]["model"], expected)
            self.assertEqual(call.call_args.args[0],
                             ["agents", "continue", "agt_12345678", "--model", expected,
                              "--json", "--", "再檢查"])

    def test_continue_rejects_noncodex_disabled_cross_project_and_running(self):
        self.make_history()
        with mock.patch.object(self.console, "_json") as call:
            self.assertEqual(self.console.continue_task({**self.body, "id": "agt_32345678", "model": "gpt-5.6-sol",
                                                         "prompt": "x"})["code"], "TASK_NOT_FOUND")
            for agent_id in ("agt_22345678", "agt_52345678"):
                self.assertEqual(self.console.continue_task({**self.body, "id": agent_id, "model": "gpt-5.6-sol",
                                                             "prompt": "x"})["code"], "TARGET_NOT_ALLOWED")
            self.assertEqual(self.console.continue_task({**self.body, "id": "agt_62345678", "model": "gpt-5.6-sol",
                                                         "prompt": "x"})["code"], "TASK_RUNNING")
            call.assert_not_called()
        self.config["subagents"]["providers"][0]["enabled"] = False
        self.write_config()
        with mock.patch.object(self.console, "_json") as call:
            self.assertEqual(self.console.continue_task({**self.body, "id": "agt_12345678", "model": "gpt-5.6-sol",
                                                         "prompt": "x"})["code"], "TARGET_NOT_ALLOWED")
            call.assert_not_called()

    def test_provider_failure_propagates_without_model_fallback(self):
        catalog = {"targets": [{"name": "codex", "kind": "provider"}]}
        failure = dc._Failure("RATE_LIMITED", "DevSpace 未完成這項操作。")
        with mock.patch.object(self.console, "_json", side_effect=[catalog, failure]) as call:
            result = self.console.run({**self.body, "target": "codex", "model": "gpt-6-astra", "prompt": "x"})
        self.assertEqual(result["code"], "RATE_LIMITED")
        self.assertEqual(call.call_count, 2)
        self.assertIn("gpt-6-astra", call.call_args_list[1].args[0])
        self.assertNotIn("gpt-5.6-sol", call.call_args_list[1].args[0])

        self.make_history()
        with mock.patch.object(self.console, "_json", side_effect=dc._Failure(
                "RATE_LIMITED", "DevSpace 未完成這項操作。")) as call:
            result = self.console.continue_task({**self.body, "id": "agt_12345678", "model": "gpt-6-astra",
                                                 "prompt": "x"})
        self.assertEqual(result["code"], "RATE_LIMITED")
        self.assertEqual(call.call_count, 1)
        self.assertIn("gpt-6-astra", call.call_args.args[0])
        self.assertNotIn("gpt-5.6-sol", call.call_args.args[0])

    def test_cli_override_rejects_shell_wrapper_and_command_string(self):
        wrapper = self.home / "devspace.cmd"
        wrapper.write_text("@echo off", encoding="utf-8")
        for value in (str(wrapper), "devspace --unsafe", str(wrapper) + " & whoami"):
            self.console.env["AI_CONSOLE_DEVSPACE_BIN"] = value
            self.assertEqual(self.console.status()["code"], "INVALID_CLI")

    def test_js_override_uses_node_argv_and_missing_node_is_not_installed(self):
        entry = self.home / "cli.js"
        entry.write_text("", encoding="utf-8")
        self.console.env["AI_CONSOLE_DEVSPACE_BIN"] = str(entry)
        with mock.patch.object(dc.shutil, "which", return_value=None):
            self.assertIsNone(self.console._cli())
        with mock.patch.object(dc.shutil, "which", return_value="node.exe"):
            self.assertEqual(self.console._cli(), ["node.exe", str(entry)])

    def test_current_cli_cannot_implicitly_migrate_legacy_configuration(self):
        (self.home / "user-config.js").write_text('return join(configDir, "config.jsonc");', encoding="utf-8")
        with mock.patch.object(self.console, "_cli", return_value=["node", str(self.home / "cli.js")]), mock.patch.object(self.console, "_health", return_value=False), mock.patch.object(dc.subprocess, "Popen") as popen:
            value = self.console.doctor({})
            self.assertEqual(value["code"], "CONFIG_MIGRATION_REQUIRED")
            self.assertEqual(self.console.start({})["code"], "CONFIG_MIGRATION_REQUIRED")
            self.assertTrue(self.console._migration_required(self.console._config()))
            popen.assert_not_called()
        self.assertFalse((self.config_dir / "config.jsonc").exists())

    def test_subprocess_preserves_arguments_and_drops_injected_workspace(self):
        script = self.home / "echo_fixture.py"
        script.write_text("import json, os, sys\nprint(json.dumps({'args':sys.argv[1:], 'root':os.getenv('DEVSPACE_WORKSPACE_ROOT')}))", encoding="utf-8")
        self.console.env["DEVSPACE_WORKSPACE_ID"] = "inherited"
        self.console.env["DEVSPACE_WORKSPACE_ROOT"] = "wrong-project"
        args = ["--", '繁中 &|<> ^ %PATH% $(Get-Date) `引號` "\\']
        with mock.patch.object(self.console, "_cli", return_value=[sys.executable, str(script)]):
            result = self.console._execute(args)
        output = json.loads(result.stdout)
        self.assertEqual(output["args"], args)
        self.assertIsNone(output["root"])

    def test_output_limit_kills_only_fixture_process(self):
        script = self.home / "large_fixture.py"
        script.write_text("import sys\nsys.stdout.buffer.write(b'x' * (3 * 1024 * 1024))", encoding="utf-8")
        with mock.patch.object(self.console, "_cli", return_value=[sys.executable, str(script)]):
            with self.assertRaises(dc._Failure) as failure:
                self.console._execute([])
        self.assertEqual(failure.exception.code, "OUTPUT_TOO_LARGE")

    def test_raw_cli_error_is_not_returned(self):
        result = subprocess.CompletedProcess([], 1, json.dumps({"error": {"code": "PROVIDER_FAILED", "message": "SECRET_VALUE"}}), "SECRET_STDERR")
        with mock.patch.object(self.console, "_execute", return_value=result):
            with self.assertRaises(dc._Failure) as failure:
                self.console._json(["agents", "run"])
        self.assertEqual(failure.exception.code, "PROVIDER_FAILED")
        self.assertNotIn("SECRET", str(failure.exception))

    def test_doctor_filters_private_urls_errors_and_auth(self):
        output = "Node: v24.15.0\nGit: git version 2\nPublic MCP URL: https://owner:SECRET@example.com/mcp\nConfig status: SECRET\nAuth file: /secret\nSQLite native dependency: unavailable (SECRET)\n"
        with mock.patch.object(self.console, "_execute", return_value=subprocess.CompletedProcess([], 0, output, "SECRET")):
            value = self.console.doctor({})
        self.assertTrue(value["ok"])
        self.assertNotIn("SECRET", json.dumps(value))
        self.assertIn("SQLite native dependency: unavailable", value["output"])

    def test_service_attach_never_claims_or_stops_external_service(self):
        with mock.patch.object(self.console, "_cli", return_value=["node", "cli.js"]), mock.patch.object(self.console, "_health", return_value=True), mock.patch.object(self.console, "status", return_value={"ok": True}), mock.patch.object(dc.subprocess, "Popen") as popen:
            value = self.console.start({})
            self.assertTrue(value["attached"])
            self.assertEqual(self.console.stop({})["code"], "NOT_MANAGED")
            popen.assert_not_called()

    def test_service_start_and_stop_only_owned_process(self):
        child = mock.Mock(pid=9123)
        child.poll.return_value = None
        with mock.patch.object(self.console, "_cli", return_value=["node", "cli.js"]), mock.patch.object(self.console, "_health", side_effect=[False, True]), mock.patch.object(self.console, "status", return_value={"ok": True}), mock.patch.object(dc.subprocess, "Popen", return_value=child) as popen:
            value = self.console.start({})
            self.assertFalse(value["attached"])
            self.assertEqual(popen.call_args.args[0], ["node", "cli.js", "serve"])
            self.assertFalse(popen.call_args.kwargs["shell"])
            self.assertTrue(self.console.stop({})["ok"])
        child.terminate.assert_called_once()
        child.wait.assert_called_once_with(timeout=8)
        child.kill.assert_not_called()
        self.assertIsNone(self.console._child)

    def test_exited_owned_process_is_not_terminated_again(self):
        child = mock.Mock(pid=9876)
        child.poll.return_value = 0
        self.console._child = child
        self.assertEqual(self.console.stop({})["code"], "NOT_MANAGED")
        child.terminate.assert_not_called()

    def test_no_configuration_and_wildcard_bind_cannot_start(self):
        with mock.patch.object(self.console, "_cli", return_value=["node", "cli.js"]), mock.patch.object(self.console, "_health", return_value=False), mock.patch.object(dc.subprocess, "Popen") as popen:
            self.config["host"] = "0.0.0.0"
            self.write_config()
            self.assertEqual(self.console.start({})["code"], "NONLOCAL_BIND")
            (self.config_dir / "auth.json").unlink()
            self.assertEqual(self.console.start({})["code"], "NOT_CONFIGURED")
            popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
