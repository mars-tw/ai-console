# -*- coding: utf-8 -*-
"""技能中心的隱私、匯入交易與真實掛載證據。

測試全部使用任務專屬的暫存 HOME；不掃描、不寫入真實的
~/.agents、~/.claude、~/.codex、~/.grok、~/.qwen 或 ~/.kimi-code。
"""
from __future__ import annotations

import base64
import io
import json
import os
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api  # noqa: E402
import rules  # noqa: E402


def _skill_md(name="cactus-calibrator", description=None):
    description = description or (
        "Use only when calibrating phosphorescent cactus resonance telescopes."
    )
    return f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n".encode()


def _file_body(name="cactus-calibrator", extra=None):
    files = {"SKILL.md": _skill_md(name)}
    files.update(extra or {})
    return {
        "kind": "files",
        "files": [{"path": path, "data": base64.b64encode(data).decode("ascii")}
                  for path, data in files.items()],
    }


def _zip_body(files, compression=zipfile.ZIP_DEFLATED):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=compression) as archive:
        for path, data in files.items():
            archive.writestr(path, data)
    return {"kind": "zip", "data": base64.b64encode(out.getvalue()).decode("ascii")}


class _Fake(api.Handler):
    def __init__(self, body=None):
        self.body = body or {}
        self.sent = None

    def _body(self):
        return self.body

    def _json(self, obj, code=200):
        self.sent = (code, obj)
        return obj


class SkillTempHome(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ai-console-skills-")
        self.home = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def make_installed(self, target, name, description=None, extra=None):
        root = api._skill_roots(self.home)[target] / name
        root.mkdir(parents=True)
        root.joinpath("SKILL.md").write_bytes(_skill_md(name, description))
        for rel, data in (extra or {}).items():
            dest = root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        return root


class TestMapPrivacy(SkillTempHome):
    def test_map_never_reads_auth_account_token_or_device_files(self):
        """哨兵檔如果被讀取就立即失敗，不只是檢查回應有沒有漏欄位。"""
        sentinels = [
            self.home / ".claude.json",
            self.home / ".codex" / "auth.json",
            self.home / ".grok" / "auth.json",
            self.home / ".gemini" / "google_accounts.json",
            self.home / ".kimi-code" / "device_id",
            self.home / ".codex" / "token.json",
            self.home / ".codex" / "browser" / "Cookies",
        ]
        for path in sentinels:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("DO NOT READ", encoding="utf-8")
        self.make_installed("codex", "safe-skill")

        original_read_text = Path.read_text
        original_open = Path.open

        def guarded(path, *args, **kwargs):
            if Path(path) in sentinels:
                raise AssertionError(f"sensitive file read: {path}")
            return original_read_text(path, *args, **kwargs)

        def guarded_open(path, *args, **kwargs):
            if Path(path) in sentinels:
                raise AssertionError(f"sensitive file opened: {path}")
            return original_open(path, *args, **kwargs)

        fake = _Fake()
        with mock.patch.object(api.Path, "home", return_value=self.home), \
                mock.patch.object(Path, "read_text", guarded), \
                mock.patch.object(Path, "open", guarded_open):
            fake.do_map()

        code, payload = fake.sent
        self.assertEqual(code, 200)
        encoded = json.dumps(payload, ensure_ascii=False).casefold()
        for forbidden in ('"account"', '"email"', '"name"', '"jwt"', 'id_token'):
            self.assertNotIn(forbidden, encoded)
        self.assertIn("safe-skill", payload["map"]["codex"]["skills"])
        self.assertIn("未讀取", payload["privacy"])


class TestSkillInventory(SkillTempHome):
    def test_inventory_reports_source_compatible_and_actual_targets(self):
        self.make_installed("claude", "shared-skill")
        self.make_installed("codex", "shared-skill")
        self.make_installed("qwen", "qwen-only")
        inventory = api._installed_skill_inventory(self.home)
        by_name = {item["name"]: item for item in inventory["skills"]}
        shared = by_name["shared-skill"]
        self.assertEqual(shared["source"], "claude")
        self.assertEqual(shared["installedTargets"], ["claude", "codex"])
        self.assertEqual(set(shared["targets"]), set(api.SKILL_IMPORT_TARGETS))
        target_counts = {item["id"]: item["installedCount"]
                         for item in inventory["targets"]}
        self.assertEqual(target_counts["claude"], 1)
        self.assertEqual(target_counts["codex"], 1)
        self.assertEqual(target_counts["qwen"], 1)

    def test_same_name_different_skill_md_is_a_visible_conflict(self):
        self.make_installed("claude", "shared-skill", "Use only for amber narwhal work.")
        self.make_installed("codex", "shared-skill", "Use only for cobalt narwhal work.")
        item = api._installed_skill_inventory(self.home)["skills"][0]
        self.assertEqual(item["conflicts"][0]["target"], "codex")

    def test_same_skill_md_but_different_script_is_a_visible_conflict(self):
        self.make_installed("claude", "shared-skill", extra={"scripts/run.py": b"print('one')"})
        self.make_installed("codex", "shared-skill", extra={"scripts/run.py": b"print('two')"})
        item = api._installed_skill_inventory(self.home)["skills"][0]
        self.assertEqual(item["conflicts"][0]["target"], "codex")

    def test_junction_like_skill_directory_is_never_inventoried_or_copied(self):
        child = self.make_installed("codex", "escaped-skill")
        real_link_like = api._skill_link_like

        def fake_link_like(path):
            return Path(path) == child or real_link_like(path)

        with mock.patch.object(api, "_skill_link_like", side_effect=fake_link_like):
            inventory = api._installed_skill_inventory(self.home)
            self.assertEqual(inventory["skills"][0]["name"], "escaped-skill")
            self.assertEqual(inventory["skills"][0]["digestUnavailable"], ["codex"])
            with self.assertRaises(api.SkillPackageError) as caught:
                api._skill_package({"kind": "installed", "source": "codex",
                                    "name": "escaped-skill"}, home=self.home)
        self.assertEqual(caught.exception.code, "SOURCE_NOT_FOUND")

    def test_unsafe_target_is_reported_unavailable(self):
        real_check = api._assert_safe_skill_target
        blocked_root = api._skill_roots(self.home)["codex"]

        def reject_one(root, home):
            if root == blocked_root:
                raise api.SkillPackageError("UNSAFE_TARGET", "synthetic junction", 409)
            return real_check(root, home)

        with mock.patch.object(api, "_assert_safe_skill_target", side_effect=reject_one):
            inventory = api._installed_skill_inventory(self.home)
        target = next(item for item in inventory["targets"] if item["id"] == "codex")
        self.assertFalse(target["available"])
        self.assertFalse(target["ready"])

    def test_global_governance_inventory_is_truthfully_read_only(self):
        self.make_installed("governance", "shared-policy")
        inventory = api._installed_skill_inventory(self.home)
        target = next(item for item in inventory["targets"] if item["id"] == "governance")
        self.assertTrue(target["readOnly"])
        self.assertFalse(target["available"])
        self.assertFalse(target["ready"])


class TestSkillPackageValidation(SkillTempHome):
    def assert_package_error(self, body, code):
        with self.assertRaises(api.SkillPackageError) as caught:
            api._skill_package(body, home=self.home)
        self.assertEqual(caught.exception.code, code)

    def test_directory_payload_accepts_valid_utf8_skill(self):
        package = api._skill_package(_file_body(), home=self.home)
        self.assertEqual(package["name"], "cactus-calibrator")
        self.assertEqual(package["fileCount"], 1)

    def test_directory_payload_accepts_zero_byte_support_file(self):
        package = api._skill_package(_file_body(extra={"assets/.gitkeep": b""}), home=self.home)
        self.assertEqual(package["files"]["assets/.gitkeep"], b"")

    def test_zip_with_one_wrapper_folder_is_accepted(self):
        body = _zip_body({"cactus-calibrator/SKILL.md": _skill_md()})
        package = api._skill_package(body, home=self.home)
        self.assertEqual(package["folder"], "cactus-calibrator")

    def test_path_traversal_is_rejected_for_file_list_and_zip(self):
        bad_file = {"kind": "files", "files": [{
            "path": "../SKILL.md",
            "data": base64.b64encode(_skill_md()).decode("ascii"),
        }]}
        self.assert_package_error(bad_file, "PATH_TRAVERSAL")
        self.assert_package_error(_zip_body({"../SKILL.md": _skill_md()}), "PATH_TRAVERSAL")

    def test_case_insensitive_duplicate_path_is_rejected(self):
        body = {"kind": "files", "files": [
            {"path": "SKILL.md", "data": base64.b64encode(_skill_md()).decode("ascii")},
            {"path": "skill.MD", "data": base64.b64encode(b"duplicate").decode("ascii")},
        ]}
        self.assert_package_error(body, "DUPLICATE_PATH")

    def test_nested_second_skill_md_is_rejected(self):
        body = _file_body(extra={"other/SKILL.md": _skill_md("other")})
        self.assert_package_error(body, "MULTIPLE_ROOTS")

    def test_sensitive_filenames_are_rejected(self):
        body = _file_body(extra={"references/auth.json": b"{}"})
        self.assert_package_error(body, "SENSITIVE_FILENAME")

    def test_private_key_marker_inside_normal_document_is_rejected(self):
        body = _file_body(extra={
            "references/guide.md": b"-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n",
        })
        self.assert_package_error(body, "PRIVATE_KEY_CONTENT")

    def test_plaintext_provider_token_assignment_is_rejected(self):
        body = _file_body(extra={
            "references/guide.md": b"OPENAI_API_KEY=sk-proj-1234567890abcdefghijkl\n",
        })
        self.assert_package_error(body, "SECRET_CONTENT")

    def test_json_password_and_camel_case_tokens_are_rejected(self):
        for document in (
            b'{"password":"SuperSecretValue12345"}',
            b'{"apiKey":"ActualApiKeyValue12345"}',
            b'{"nested":{"clientSecret":"ActualClientSecret12345"}}',
        ):
            with self.subTest(document=document):
                self.assert_package_error(
                    _file_body(extra={"references/guide.json": document}), "SECRET_CONTENT")

    def test_placeholder_assignment_cannot_hide_later_real_secret(self):
        body = _file_body(extra={
            "references/guide.md": (
                b"API_KEY=your-placeholder-value\n"
                b"PASSWORD=ActualSecretValue12345\n"
            ),
        })
        self.assert_package_error(body, "SECRET_CONTENT")

    def test_sensitive_filename_is_rejected_before_base64_decode(self):
        body = {"kind": "files", "files": [{"path": "references/token.json",
                                                "data": "not base64"}]}
        self.assert_package_error(body, "SENSITIVE_FILENAME")

    def test_nested_archive_is_rejected(self):
        body = _file_body(extra={"assets/another.zip": b"not opened"})
        self.assert_package_error(body, "NESTED_ARCHIVE")

    def test_zip_sensitive_member_is_rejected_without_opening_member(self):
        body = _zip_body({"auth.json": b"must not be opened",
                          "SKILL.md": _skill_md()})
        with mock.patch.object(zipfile.ZipFile, "read",
                               side_effect=AssertionError("member content was opened")):
            self.assert_package_error(body, "SENSITIVE_FILENAME")

    def test_directory_style_symlink_marker_is_rejected(self):
        body = {"kind": "files", "files": [{"path": "SKILL.md", "type": "symlink",
                                                "data": base64.b64encode(b"x").decode("ascii")}]}
        self.assert_package_error(body, "SYMLINK_REJECTED")

    def test_zip_symlink_is_rejected(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as archive:
            archive.writestr("SKILL.md", _skill_md())
            link = zipfile.ZipInfo("references/link")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, "../outside")
        body = {"kind": "zip", "data": base64.b64encode(out.getvalue()).decode("ascii")}
        self.assert_package_error(body, "SYMLINK_REJECTED")

    def test_zip_bomb_ratio_is_rejected_before_extraction(self):
        body = _zip_body({"SKILL.md": _skill_md(), "assets/padding.txt": b"A" * 400_000})
        self.assert_package_error(body, "ZIP_BOMB")

    def test_frontmatter_requires_name_and_description(self):
        raw = b"---\nname: incomplete\n---\n"
        body = {"kind": "files", "files": [{
            "path": "SKILL.md", "data": base64.b64encode(raw).decode("ascii")}]}
        self.assert_package_error(body, "INVALID_FRONTMATTER")

    def test_preview_is_memory_only_and_never_executes_packaged_script(self):
        marker = self.home / "script-ran.txt"
        script = f"from pathlib import Path\nPath({str(marker)!r}).write_text('bad')\n".encode()
        fake = _Fake(_file_body(extra={"scripts/install.py": script}))
        with mock.patch.object(api.Path, "home", return_value=self.home):
            fake.do_skills_preview()
        self.assertEqual(fake.sent[0], 200)
        self.assertFalse(marker.exists())
        self.assertTrue(all(not root.exists() for root in api._skill_roots(self.home).values()))


class TestSkillImportTransaction(SkillTempHome):
    def test_import_to_one_explicit_selected_target_only(self):
        package = api._skill_package(
            _file_body(extra={"references/guide.md": b"safe guide"}), home=self.home)
        results = api._install_skill(package, ["codex"], home=self.home)
        self.assertEqual([row["target"] for row in results], ["codex"])
        installed = api._skill_roots(self.home)["codex"] / "cactus-calibrator"
        self.assertEqual(installed.joinpath("references/guide.md").read_bytes(), b"safe guide")
        self.assertFalse((api._skill_roots(self.home)["claude"] / "cactus-calibrator").exists())

    def test_multiple_targets_are_rejected_before_any_write(self):
        package = api._skill_package(_file_body(), home=self.home)
        with self.assertRaises(api.SkillPackageError) as caught:
            api._install_skill(package, ["codex", "qwen"], home=self.home)
        self.assertEqual(caught.exception.code, "INVALID_TARGET")
        self.assertFalse((api._skill_roots(self.home)["codex"] / "cactus-calibrator").exists())
        self.assertFalse((api._skill_roots(self.home)["qwen"] / "cactus-calibrator").exists())

    def test_global_governance_root_is_read_only_in_beginner_import(self):
        package = api._skill_package(_file_body(), home=self.home)
        preview_ids = {item["id"] for item in api._skill_target_states(package, self.home)}
        self.assertNotIn("governance", preview_ids)
        with self.assertRaises(api.SkillPackageError) as caught:
            api._install_skill(package, ["governance"], home=self.home)
        self.assertEqual(caught.exception.code, "INVALID_TARGET")
        self.assertFalse((api._skill_roots(self.home)["governance"] / "cactus-calibrator").exists())

    def test_governance_skill_name_is_reserved_across_tool_roots(self):
        self.make_installed(
            "governance", "cactus-calibrator",
            "The trusted global governance version.",
        )
        package = api._skill_package(_file_body(), home=self.home)
        states = api._skill_target_states(package, self.home)
        self.assertTrue(all(state["status"] == "conflict" for state in states))
        with self.assertRaises(api.SkillPackageError) as caught:
            api._install_skill(package, ["codex"], home=self.home)
        self.assertIn(caught.exception.code, {"SKILL_CONFLICT", "GOVERNANCE_NAME_RESERVED"})
        self.assertFalse((api._skill_roots(self.home)["codex"] / "cactus-calibrator").exists())

    def test_import_copies_but_never_executes_packaged_script(self):
        marker = self.home / "script-ran.txt"
        script = f"from pathlib import Path\nPath({str(marker)!r}).write_text('bad')\n".encode()
        package = api._skill_package(_file_body(extra={"scripts/install.py": script}),
                                     home=self.home)
        api._install_skill(package, ["codex"], home=self.home)
        installed_script = (api._skill_roots(self.home)["codex"] /
                            "cactus-calibrator" / "scripts" / "install.py")
        self.assertEqual(installed_script.read_bytes(), script)
        self.assertFalse(marker.exists())

    def test_existing_destination_blocks_without_overwrite(self):
        existing = self.make_installed("codex", "cactus-calibrator",
                                       "Use only for the original protected skill.")
        before = existing.joinpath("SKILL.md").read_bytes()
        package = api._skill_package(_file_body(), home=self.home)
        with self.assertRaises(api.SkillPackageError) as caught:
            api._install_skill(package, ["codex"], home=self.home)
        self.assertEqual(caught.exception.code, "SKILL_CONFLICT")
        self.assertEqual(existing.joinpath("SKILL.md").read_bytes(), before)

    def test_atomic_rename_failure_cleans_single_target_stage(self):
        package = api._skill_package(_file_body(), home=self.home)
        with mock.patch.object(api, "_atomic_skill_rename",
                               side_effect=OSError("synthetic disk failure")):
            with self.assertRaises(api.SkillPackageError) as caught:
                api._install_skill(package, ["codex"], home=self.home)
        self.assertEqual(caught.exception.code, "IMPORT_ROLLED_BACK")
        root = api._skill_roots(self.home)["codex"]
        self.assertFalse((root / "cactus-calibrator").exists())
        if root.exists():
            self.assertEqual(list(root.glob(".skill-import-*")), [])

    def test_installed_source_can_be_previewed_and_copied(self):
        self.make_installed("claude", "cactus-calibrator",
                            extra={"references/guide.md": b"source guide"})
        package = api._skill_package({"kind": "installed", "source": "claude",
                                      "name": "cactus-calibrator"}, home=self.home)
        api._install_skill(package, ["kimi"], home=self.home)
        copied = api._skill_roots(self.home)["kimi"] / "cactus-calibrator"
        self.assertEqual(copied.joinpath("references/guide.md").read_bytes(), b"source guide")

    def test_handler_conflict_has_novice_choices_and_no_write(self):
        self.make_installed("codex", "cactus-calibrator")
        fake = _Fake({**_file_body(), "targets": ["codex"]})
        with mock.patch.object(api.Path, "home", return_value=self.home):
            fake.do_skills_import()
        code, payload = fake.sent
        self.assertEqual(code, 409)
        self.assertEqual(payload["status"], "conflict")
        self.assertEqual(payload["code"], "SKILL_CONFLICT")
        self.assertTrue(payload["choices"])


class TestTruthfulSkillMatching(SkillTempHome):
    def setUp(self):
        super().setUp()
        self.skill_root = self.home / "skills"
        self.skill_dir = self.skill_root / "cactus-calibrator"
        self.skill_dir.mkdir(parents=True)
        self.skill_file = self.skill_dir / "SKILL.md"
        self.skill_file.write_bytes(_skill_md())

    def add_skill(self, name: str, description: str) -> Path:
        folder = self.skill_root / name
        folder.mkdir(parents=True, exist_ok=True)
        skill_file = folder / "SKILL.md"
        skill_file.write_bytes(_skill_md(name, description))
        return skill_file

    def test_unique_matching_skill_is_returned_and_exact_path_is_in_work_order(self):
        with mock.patch.object(rules, "DEFAULT_SKILL_DIRS", []), \
                mock.patch.object(rules, "DEFAULT_RULE_FILES", []):
            wrapped, applied = rules.wrap(
                "Calibrate the phosphorescent cactus resonance telescope now.",
                "codex", {"skill_dirs": [str(self.skill_root)]})
        self.assertEqual(applied, ["cactus-calibrator"])
        self.assertIn(str(self.skill_file), wrapped)

    def test_generic_task_does_not_claim_a_skill(self):
        with mock.patch.object(rules, "DEFAULT_SKILL_DIRS", []), \
                mock.patch.object(rules, "DEFAULT_RULE_FILES", []):
            _, applied = rules.wrap("Help me organize a simple general task.", "codex",
                                    {"skill_dirs": [str(self.skill_root)]})
        self.assertEqual(applied, [])

    def test_negative_trigger_clause_vetoes_false_positive(self):
        self.add_skill(
            "translate-polish",
            "翻譯與繁體中文改寫工作。不要觸發：逐字翻譯。",
        )
        with mock.patch.object(rules, "DEFAULT_SKILL_DIRS", []), \
                mock.patch.object(rules, "DEFAULT_RULE_FILES", []):
            wrapped, applied = rules.wrap(
                "把這段英文逐字翻譯成繁體中文", "codex",
                {"skill_dirs": [str(self.skill_root)]},
            )
        self.assertNotIn("translate-polish", applied)
        self.assertNotIn("translate-polish", wrapped)

    def test_translation_does_not_match_article_skill_from_language_words_only(self):
        self.add_skill(
            "content-writing",
            "撰寫必須附圖的繁體中文文章。觸發：寫文章、部落格、專欄、稿件。",
        )
        with mock.patch.object(rules, "DEFAULT_SKILL_DIRS", []), \
                mock.patch.object(rules, "DEFAULT_RULE_FILES", []):
            _, applied = rules.wrap(
                "把這段英文逐字翻譯成繁體中文", "codex",
                {"skill_dirs": [str(self.skill_root)]},
            )
        self.assertNotIn("content-writing", applied)

    def test_bilingual_domain_terms_match_responsive_wordpress_skill(self):
        skill_file = self.add_skill(
            "build-responsive-wordpress",
            "Build responsive WordPress websites and homepage layouts.",
        )
        with mock.patch.object(rules, "DEFAULT_SKILL_DIRS", []), \
                mock.patch.object(rules, "DEFAULT_RULE_FILES", []):
            wrapped, applied = rules.wrap(
                "建立 WordPress 響應式首頁", "codex",
                {"skill_dirs": [str(self.skill_root)]},
            )
        self.assertIn("build-responsive-wordpress", applied)
        self.assertIn(str(skill_file), wrapped)

    def test_explicit_skill_name_is_selected_without_heuristic_guessing(self):
        skill_file = self.add_skill(
            "wp-plugin-development",
            "Use when developing WordPress plugins and release packages.",
        )
        with mock.patch.object(rules, "DEFAULT_SKILL_DIRS", []), \
                mock.patch.object(rules, "DEFAULT_RULE_FILES", []):
            wrapped, applied = rules.wrap(
                "請用 $wp-plugin-development 完成這件事", "codex",
                {"skill_dirs": [str(self.skill_root)]},
            )
        self.assertIn("wp-plugin-development", applied)
        self.assertIn(str(skill_file), wrapped)

    def test_negated_or_mentioned_skill_name_is_not_directly_selected(self):
        self.add_skill(
            "wp-plugin-development",
            "Use when developing WordPress plugins and release packages.",
        )
        skills = rules.load_skills([self.skill_root], include_defaults=False)
        self.assertEqual(
            rules.match_skills("不要使用 wp-plugin-development", skills), [])
        self.assertEqual(
            rules.match_skills("只是提到 wp-plugin-development，不要啟用它", skills), [])

    def test_skill_installed_only_for_claude_never_applies_to_codex(self):
        governance = self.home / ".agents" / "skills"
        claude = self.home / ".claude" / "skills"
        codex = self.home / ".codex" / "skills"
        target = claude / "cactus-calibrator"
        target.mkdir(parents=True)
        skill_file = target / "SKILL.md"
        skill_file.write_bytes(_skill_md())
        tool_dirs = {"claude": claude, "codex": codex}
        with mock.patch.object(rules, "GOVERNANCE_SKILL_DIR", governance), \
                mock.patch.object(rules, "TOOL_SKILL_DIRS", tool_dirs), \
                mock.patch.object(rules, "DEFAULT_RULE_FILES", []):
            codex_wrapped, codex_applied = rules.wrap(
                "Calibrate the phosphorescent cactus resonance telescope now.", "codex")
            claude_wrapped, claude_applied = rules.wrap(
                "Calibrate the phosphorescent cactus resonance telescope now.", "claude")
        self.assertEqual(codex_applied, [])
        self.assertNotIn(str(skill_file), codex_wrapped)
        self.assertEqual(claude_applied, ["cactus-calibrator"])
        self.assertIn(str(skill_file), claude_wrapped)


if __name__ == "__main__":
    unittest.main()
