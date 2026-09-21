"""Windows setup contracts using disposable fixtures; no installs or model calls."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts" / "setup-devspace.ps1"
POWERSHELL = shutil.which("powershell.exe") if os.name == "nt" else None


@unittest.skipUnless(POWERSHELL, "requires Windows PowerShell 5.1")
class DevSpaceQuickSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="devspace-setup-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.project = self.base / "中文專案 A & B's [test]"
        self.project.mkdir()
        self.config = self.base / ".devspace"

    def run_ps(self, body: str, *, values=None):
        script = self.base / "test.ps1"
        script.write_text(
            "$ErrorActionPreference = 'Stop'\n"
            "[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n"
            ". $env:DEVSPACE_TEST_HELPER -LibraryOnly\n"
            "$testValues = $env:DEVSPACE_TEST_VALUES | ConvertFrom-Json\n"
            + body,
            encoding="utf-8-sig",
        )
        env = dict(os.environ, DEVSPACE_TEST_HELPER=str(HELPER),
                   DEVSPACE_TEST_CONFIG=str(self.config), DEVSPACE_TEST_PROJECT=str(self.project),
                   DEVSPACE_TEST_VALUES=json.dumps(values or {}, ensure_ascii=False))
        return subprocess.run(
            [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)],
            env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )

    def setup_mock(self, body: str, *, runtime=None):
        values = {"NodePath": "node.exe", "NodeVersion": "v24.15.0", "NodeCompatible": True,
                  "NpmCliPath": "npm-cli.js", "CliPath": "cli.js", "BashPath": "bash.exe", "GitPath": "git.exe"}
        if runtime:
            values.update(runtime)
        return self.run_ps(
            "function Get-DevSpaceRuntime { return $testValues }\n"
            "function Test-DevSpaceCli { return $true }\n"
            "function Assert-DevSpaceFreshVersion {}\n"
            "function Install-DevSpacePrerequisite { throw 'UNEXPECTED_PREREQUISITE_INSTALL' }\n"
            "function Install-DevSpacePackage { throw 'UNEXPECTED_PACKAGE_INSTALL' }\n"
            "function Read-Host { throw 'UNEXPECTED_PROMPT' }\n" + body,
            values=values,
        )

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def make_junction(self, name: str, target: Path) -> Path:
        link = self.base / name
        result = self.run_ps(
            "New-Item -ItemType Junction -Path $testValues.link -Target $testValues.target | Out-Null",
            values={"link": str(link), "target": str(target)},
        )
        self.assert_ok(result)
        # Remove the junction entry only; never recurse into its target.
        self.addCleanup(lambda: os.rmdir(link) if link.exists() else None)
        return link

    def write_existing(self, name="config.json"):
        self.config.mkdir()
        # Deliberate custom/local fields and formatting must be preserved byte-for-byte.
        existing = {
            name: b'// retained patched settings\r\n{"local":"keep", "publicBaseUrl":"https://existing.example"}\r\n',
            "auth.json": b'{"ownerToken":"SECRET_MUST_NOT_APPEAR"}\r\n',
        }
        for filename, data in existing.items():
            (self.config / filename).write_bytes(data)
        return existing

    def test_library_only_has_no_top_level_actions_and_script_has_bom(self):
        self.assertTrue(HELPER.read_bytes().startswith(b"\xef\xbb\xbf"))
        result = self.run_ps("Write-Output 'LIBRARY_ONLY'")
        self.assert_ok(result)
        self.assertEqual(result.stdout.strip(), "LIBRARY_ONLY")
        self.assertFalse(self.config.exists())

    def test_node_version_boundaries(self):
        result = self.run_ps(
            "@('v22.18.0','v22.19.0','v24.0.0','v26.9.0','v27.0.0','v24.0.0-rc.1','oops') | "
            "ForEach-Object { Test-DevSpaceNodeVersion $_ } | ConvertTo-Json"
        )
        self.assert_ok(result)
        self.assertEqual(json.loads(result.stdout), [False, True, True, True, False, False, False])

    def test_unattended_confirmation_never_prompts_or_implicitly_grants(self):
        result = self.run_ps(
            "function Read-Host { throw 'UNEXPECTED_PROMPT' }\n"
            "if (Confirm-DevSpaceAction 'fixture' -Unattended) { throw 'UNEXPECTED_GRANT' }\n"
            "Write-Output 'DECLINED_WITHOUT_PROMPT'"
        )
        self.assert_ok(result)
        self.assertEqual(result.stdout.strip(), 'DECLINED_WITHOUT_PROMPT')

    def test_existing_json_and_jsonc_are_reused_without_touching_credentials(self):
        for name in ("config.json", "config.jsonc"):
            with self.subTest(name=name):
                if self.config.exists():
                    shutil.rmtree(self.config)
                original = self.write_existing(name)
                result = self.setup_mock(
                    "Invoke-DevSpaceSetup -Unattended -AllowPrerequisites -AllowPackage -AllowConfiguration "
                    "-ConfigDirectory $env:DEVSPACE_TEST_CONFIG -Directory $env:DEVSPACE_TEST_PROJECT -SelectedProvider codex"
                )
                self.assert_ok(result)
                self.assertIn("沿用既有", result.stdout)
                self.assertNotIn("SECRET_MUST_NOT_APPEAR", result.stdout + result.stderr)
                self.assertEqual({p.name: p.read_bytes() for p in self.config.iterdir()}, original)

    def test_partial_configuration_never_installs_or_overwrites(self):
        self.config.mkdir()
        original = b'{"custom":true}\r\n'
        (self.config / "config.json").write_bytes(original)
        result = self.setup_mock(
            "Invoke-DevSpaceSetup -Unattended -AllowPackage -AllowConfiguration -ConfigDirectory $env:DEVSPACE_TEST_CONFIG"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("設定不完整", result.stderr)
        self.assertEqual((self.config / "config.json").read_bytes(), original)
        self.assertFalse((self.config / "auth.json").exists())

    def test_plan_only_is_side_effect_free_even_with_install_switches(self):
        result = self.setup_mock(
            "Invoke-DevSpaceSetup -DryRun -AllowPrerequisites -AllowPackage -AllowConfiguration "
            "-ConfigDirectory $env:DEVSPACE_TEST_CONFIG",
            runtime={"NodePath": None, "NodeVersion": None, "NodeCompatible": False, "CliPath": None, "BashPath": None},
        )
        self.assert_ok(result)
        self.assertFalse(self.config.exists())
        self.assertIn("不建立檔案", result.stdout)

    def test_noninteractive_without_explicit_configuration_is_read_only(self):
        result = self.setup_mock("Invoke-DevSpaceSetup -Unattended -ConfigDirectory $env:DEVSPACE_TEST_CONFIG")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("-Configure", result.stderr)
        self.assertFalse(self.config.exists())

    def test_fresh_interactive_setup_uses_official_chatgpt_onboarding(self):
        result = self.setup_mock(
            "function New-DevSpaceConfiguration { throw 'UNEXPECTED_LEGACY_PROVIDER_CONFIG' }\n"
            "function Invoke-DevSpaceChatGPTInit { param($Runtime, $ConfigDirectory, $Directory) "
            "if ($Runtime.CliPath -ne 'cli.js' -or $ConfigDirectory -ne $env:DEVSPACE_TEST_CONFIG) { throw 'Wrong init context' }; "
            "Write-Output 'OFFICIAL_CHATGPT_INIT' }\n"
            "Invoke-DevSpaceSetup -ConfigDirectory $env:DEVSPACE_TEST_CONFIG"
        )
        self.assert_ok(result)
        self.assertIn('OFFICIAL_CHATGPT_INIT', result.stdout)
        self.assertFalse(self.config.exists())

    def test_noninteractive_chatgpt_setup_requires_human_onboarding(self):
        result = self.setup_mock(
            "function Invoke-DevSpaceChatGPTInit { throw 'UNEXPECTED_INTERACTIVE_INIT' }\n"
            "Invoke-DevSpaceSetup -Unattended -AllowConfiguration -ConfigDirectory $env:DEVSPACE_TEST_CONFIG"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('互動式 devspace init', result.stderr)
        self.assertNotIn('UNEXPECTED_INTERACTIVE_INIT', result.stderr)
        self.assertFalse(self.config.exists())

    def test_noninteractive_missing_node_does_not_install_or_prompt(self):
        result = self.setup_mock(
            "Invoke-DevSpaceSetup -Unattended -ConfigDirectory $env:DEVSPACE_TEST_CONFIG",
            runtime={"NodePath": None, "NodeVersion": None, "NodeCompatible": False},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("https://nodejs.org/en/download", result.stderr)
        self.assertNotIn("UNEXPECTED_", result.stderr)

    def test_incompatible_node_is_preserved_even_with_install_authorization(self):
        result = self.setup_mock(
            "Invoke-DevSpaceSetup -Unattended -AllowPrerequisites -ConfigDirectory $env:DEVSPACE_TEST_CONFIG",
            runtime={"NodeVersion": "v20.20.0", "NodeCompatible": False},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("已保留現有版本", result.stderr)
        self.assertNotIn("UNEXPECTED_", result.stderr)

    def test_existing_broken_cli_is_never_reinstalled(self):
        original = self.write_existing()
        result = self.setup_mock(
            "function Test-DevSpaceCli { return $false }\n"
            "Invoke-DevSpaceSetup -Unattended -AllowPackage -ConfigDirectory $env:DEVSPACE_TEST_CONFIG"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("已有 DevSpace 安裝但無法執行", result.stderr)
        self.assertEqual({p.name: p.read_bytes() for p in self.config.iterdir()}, original)

    def test_existing_config_with_missing_cli_does_not_install_new_public_package(self):
        original = self.write_existing()
        result = self.setup_mock(
            "Invoke-DevSpaceSetup -Unattended -AllowPackage -ConfigDirectory $env:DEVSPACE_TEST_CONFIG",
            runtime={"CliPath": None},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("UNEXPECTED_", result.stderr)
        self.assertEqual({p.name: p.read_bytes() for p in self.config.iterdir()}, original)

    def test_authorized_fresh_configuration_has_exact_upstream_fields(self):
        result = self.setup_mock(
            "Invoke-DevSpaceSetup -Unattended -AllowConfiguration -ConfigDirectory $env:DEVSPACE_TEST_CONFIG "
            "-Directory $env:DEVSPACE_TEST_PROJECT -SelectedProvider claude"
        )
        self.assert_ok(result)
        config = json.loads((self.config / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(config, {
            "host": "127.0.0.1", "port": 7676, "allowedRoots": [str(self.project)], "publicBaseUrl": None,
            "subagents": {"enabled": True, "providers": [{"id": "claude", "enabled": True}]},
        })
        auth = json.loads((self.config / "auth.json").read_text(encoding="utf-8"))
        self.assertEqual(set(auth), {"ownerToken"})
        self.assertRegex(auth["ownerToken"], r"^[A-Za-z0-9_-]{43}$")
        self.assertNotIn(auth["ownerToken"], result.stdout + result.stderr)

    def test_authorized_package_install_is_mocked_and_scoped(self):
        result = self.setup_mock(
            "$script:installed = 0\n"
            "function Install-DevSpacePackage { $script:installed++; $testValues.CliPath = 'cli.js' }\n"
            "Invoke-DevSpaceSetup -Unattended -AllowPackage -AllowConfiguration -ConfigDirectory $env:DEVSPACE_TEST_CONFIG "
            "-Directory $env:DEVSPACE_TEST_PROJECT -SelectedProvider codex\n"
            "if ($script:installed -ne 1) { throw 'Expected exactly one mocked installation' }",
            runtime={"CliPath": None},
        )
        self.assert_ok(result)
        self.assertTrue((self.config / "config.json").is_file())

    def test_new_config_never_overwrites_existing_auth(self):
        self.config.mkdir()
        auth_path = self.config / "auth.json"
        auth_path.write_bytes(b"existing-auth")
        result = self.run_ps(
            "New-DevSpaceConfiguration -ConfigDirectory $env:DEVSPACE_TEST_CONFIG "
            "-Directory $env:DEVSPACE_TEST_PROJECT -SelectedProvider codex"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(auth_path.read_bytes(), b"existing-auth")
        self.assertFalse((self.config / "config.json").exists())

    def test_project_selection_is_required_and_drive_root_is_rejected(self):
        for directory in ("", self.project.anchor, str(self.base / "missing")):
            with self.subTest(directory=directory):
                result = self.run_ps("Resolve-DevSpaceProjectRoot $testValues.directory", values={"directory": directory})
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.config.exists())

    def test_fresh_config_rejects_junction_ancestor_without_creating_credentials(self):
        destination = self.base / "actual-profile"
        destination.mkdir()
        linked = self.make_junction("linked-profile", destination)
        self.config = linked / "new-parent" / ".devspace"
        result = self.run_ps(
            "New-DevSpaceConfiguration -ConfigDirectory $env:DEVSPACE_TEST_CONFIG "
            "-Directory $env:DEVSPACE_TEST_PROJECT -SelectedProvider codex"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("junction", result.stderr)
        self.assertEqual(list(destination.iterdir()), [])

    def test_project_rejects_direct_junction_and_junction_ancestor(self):
        actual_project = self.base / "actual-project"
        actual_project.mkdir()
        linked = self.make_junction("linked-project", actual_project)
        (actual_project / "src").mkdir()
        for selected in (linked, linked / "src"):
            with self.subTest(selected=selected):
                result = self.run_ps(
                    "New-DevSpaceConfiguration -ConfigDirectory $env:DEVSPACE_TEST_CONFIG "
                    "-Directory $testValues.directory -SelectedProvider codex",
                    values={"directory": str(selected)},
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("junction", result.stderr)
                self.assertFalse(self.config.exists())

    def test_complete_existing_configuration_in_junction_is_still_preserved_and_reused(self):
        original = self.write_existing("config.jsonc")
        self.config = self.make_junction("existing-profile", self.config)
        result = self.setup_mock("Invoke-DevSpaceSetup -Unattended -ConfigDirectory $env:DEVSPACE_TEST_CONFIG")
        self.assert_ok(result)
        self.assertIn("沿用既有", result.stdout)
        self.assertEqual({p.name: p.read_bytes() for p in self.config.iterdir()}, original)

    @unittest.skipUnless(shutil.which("git.exe"), "git required only for disposable repository metadata fixture")
    def test_git_subdirectory_is_rejected_without_silently_granting_ancestor(self):
        initialized = subprocess.run(
            [shutil.which("git.exe"), "init", "--quiet", "--template=", str(self.project)],
            capture_output=True, text=True, encoding="utf-8", timeout=15,
        )
        self.assert_ok(initialized)
        nested = self.project / "src"
        nested.mkdir()
        result = self.run_ps(
            "New-DevSpaceConfiguration -ConfigDirectory $env:DEVSPACE_TEST_CONFIG "
            "-Directory $testValues.directory -SelectedProvider codex",
            values={"directory": str(nested)},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Git", result.stderr)
        self.assertFalse(self.config.exists())
        # Explicitly selecting the same repository's exact root is valid.
        accepted = self.run_ps(
            "New-DevSpaceConfiguration -ConfigDirectory $env:DEVSPACE_TEST_CONFIG "
            "-Directory $env:DEVSPACE_TEST_PROJECT -SelectedProvider codex"
        )
        self.assert_ok(accepted)
        config = json.loads((self.config / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(config["allowedRoots"], [str(self.project)])

    @unittest.skipUnless(shutil.which("node.exe"), "node required only for local argv round-trip")
    def test_native_argv_handles_quotes_chinese_metacharacters_and_trailing_slash(self):
        arguments = ['中文 A & B', 'quote " and slash\\', '$(not-a-command)', '%PATH%', '', "apostrophe's"]
        result = self.run_ps(
            "$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source\n"
            "$native = Invoke-DevSpaceNative $node (@('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))') + @($testValues.arguments))\n"
            "if ($native.ExitCode -ne 0) { throw 'Local argv fixture failed' }; Write-Output $native.Output",
            values={"arguments": arguments},
        )
        self.assert_ok(result)
        self.assertEqual(json.loads(result.stdout), arguments)

    def test_generated_config_loads_through_installed_upstream_without_auth_leak(self):
        module = Path(os.environ.get("APPDATA", "")) / "npm/node_modules/@waishnav/devspace/dist/config.js"
        node = shutil.which("node.exe")
        if not node or not module.is_file():
            self.skipTest("optional installed DevSpace schema check; no package downloads")
        result = self.run_ps(
            "New-DevSpaceConfiguration -ConfigDirectory $env:DEVSPACE_TEST_CONFIG "
            "-Directory $env:DEVSPACE_TEST_PROJECT -SelectedProvider codex"
        )
        self.assert_ok(result)
        loaded = subprocess.run(
            [node, "--input-type=module", "-e",
             "const {pathToFileURL}=await import('node:url');"
             "const {loadConfig}=await import(pathToFileURL(process.argv[1]).href);"
             "const c=loadConfig({DEVSPACE_CONFIG_DIR:process.argv[2]});"
             "process.stdout.write(JSON.stringify({host:c.host,allowedRoots:c.allowedRoots,subagents:c.subagents}));",
             str(module), str(self.config)],
            capture_output=True, text=True, encoding="utf-8", timeout=20,
        )
        self.assert_ok(loaded)
        config = json.loads(loaded.stdout)
        self.assertEqual(config["host"], "127.0.0.1")
        self.assertEqual(config["allowedRoots"], [str(self.project)])
        self.assertEqual(config["subagents"]["providers"], [{"id": "codex", "enabled": True}])


if __name__ == "__main__":
    unittest.main()
