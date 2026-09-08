"""Starter catalog and actual import boundaries, with isolated HOME only."""
import base64
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api
from skill_starters import starter_catalog


class Fake(api.Handler):
    path = '/api/skills/starters'

    def __init__(self, body=None, same=True):
        self.body, self.same, self.sent = body or {}, same, None

    def _body(self):
        return self.body

    def _same_origin(self):
        return self.same

    def _json(self, obj, code=200):
        self.sent = code, obj
        return obj


class StarterTests(unittest.TestCase):
    def test_catalog_deterministic_independent_and_text_only(self):
        catalog = starter_catalog()
        self.assertEqual(catalog, starter_catalog())
        self.assertEqual(len(catalog['starters']), 2)
        for item in catalog['starters']:
            raw = base64.b64decode(item['package']['data'], validate=True)
            self.assertLess(len(raw), 4096)
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                self.assertEqual(archive.namelist(), ['SKILL.md'])
                self.assertEqual(archive.infolist()[0].date_time, (2026, 1, 1, 0, 0, 0))
                self.assertEqual(archive.infolist()[0].external_attr >> 16, 0o100644)
                self.assertIn(f'name: {item["name"]}', archive.read('SKILL.md').decode('utf-8'))
            self.assertEqual(api._skill_package(item['package'])['name'], item['name'])
        catalog['starters'][0]['package']['data'] = 'mutated'
        self.assertNotEqual(catalog, starter_catalog())

    def test_real_preview_import_digest_and_no_overwrite(self):
        for item in starter_catalog()['starters']:
            with self.subTest(item=item['id']), tempfile.TemporaryDirectory(prefix='ai-console-starter-') as directory:
                home = Path(directory)
                with mock.patch.object(api.Path, 'home', return_value=home), mock.patch.object(api, '_bin_available', return_value=False):
                    body = item['package']
                    preview = Fake(body)
                    preview.do_skills_preview()
                    self.assertEqual(preview.sent[0], 200)
                    self.assertEqual(list(home.iterdir()), [])
                    self.assertTrue(all(t['toolInstalled'] is False for t in preview.sent[1]['targets']))
                    digest = preview.sent[1]['skill']['digest']
                    for invalid in (None, '0' * 64):
                        bad = Fake({**body, 'targets': ['codex'], 'previewDigest': invalid})
                        bad.do_skills_import()
                        self.assertEqual(bad.sent[0], 409)
                        self.assertEqual(list(home.iterdir()), [])
                    accepted = Fake({**body, 'targets': ['codex'], 'previewDigest': digest})
                    accepted.do_skills_import()
                    self.assertEqual(accepted.sent[0], 201)
                    installed = api._skill_roots(home)['codex'] / item['name']
                    expected = api._skill_package(body)['files']['SKILL.md']
                    self.assertEqual(installed.joinpath('SKILL.md').read_bytes(), expected)
                    self.assertEqual(list(installed.iterdir()), [installed / 'SKILL.md'])
                    self.assertFalse(api._skill_roots(home)['claude'].exists())
                    accepted.do_skills_import()
                    self.assertEqual(accepted.sent[0], 409)
                    self.assertEqual(installed.joinpath('SKILL.md').read_bytes(), expected)

    def test_catalog_handler_origin_contract_and_remote_exclusion(self):
        handler = Fake()
        handler.do_GET()
        self.assertEqual(handler.sent, (200, starter_catalog()))
        foreign = Fake(same=False)
        foreign.do_GET()
        self.assertEqual(foreign.sent[0], 403)
        self.assertNotIn(Fake.path, api.REMOTE_ALLOWED_GET)
        for malformed in ([], {'ok': True, 'starters': [{}]}, {'ok': True, 'starters': [None, None]}):
            with mock.patch('skill_starters.starter_catalog', return_value=malformed):
                handler.do_GET()
                self.assertEqual(handler.sent[0], 503)
