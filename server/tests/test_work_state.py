"""Passive work-state provenance and lifecycle boundaries, using isolated data."""
import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from work_state import process_evidence, work_state_snapshot, probe_process
from work_terminal_evidence import parse_terminal_metadata


class WorkStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.registry = self.root / 'dispatch-log' / '_registry.json'
        self.registry.parent.mkdir()
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()

    def snapshot(self, records=None, probe=None):
        if records is not None:
            self.registry.write_text(json.dumps(records), encoding='utf-8')
        return work_state_snapshot(self.registry, process_probe=probe or (lambda pid, **kw: {'status': 'absent'}), runtime_dir=self.runtime)

    def record(self, **values):
        return dict(id='20261104-120000', tool='codex', started='20261104-120000', mode='headless', pid=42, **values)

    def test_missing_unreadable_and_empty_are_distinct(self):
        missing = self.snapshot()
        self.assertEqual(missing['sources']['registry']['state'], 'missing')
        self.assertIsNone(missing['dispatches'])
        self.registry.write_text('{bad', encoding='utf-8')
        self.assertEqual(self.snapshot()['sources']['registry']['state'], 'unreadable')
        self.assertEqual(self.snapshot([])['dispatches'], [])

    def test_absent_pid_nonempty_log_and_result_do_not_mean_completion(self):
        row = self.record(result='done', task='PRIVATE TASK')
        value = self.snapshot([row])['dispatches'][0]
        self.assertEqual((value['state'], value['runtimePhase'], value['taskOutcome']), ('unknown', 'not_observed', 'unknown'))
        self.assertNotIn('PRIVATE', json.dumps(value))
        self.assertNotIn('pid', value)

    def test_stop_needs_original_process_absence_not_query_denial(self):
        row = self.record(stopped='20261104-120010')
        self.assertEqual(self.snapshot([row])['dispatches'][0]['state'], 'stopped')
        denied = self.snapshot([row], lambda pid, **kw: {'status': 'unavailable'})
        self.assertEqual(denied['dispatches'][0]['state'], 'stopped')
        self.assertEqual(denied['dispatches'][0]['runtimePhase'], 'unverified')

    def test_exact_full_path_binding_and_pid_reuse(self):
        row = self.record()
        created = dt.datetime.strptime(row['started'], '%Y%m%d-%H%M%S').timestamp()
        order = self.registry.parent / (row['id'] + '_task.md')
        facts = dict(status='observed', created=created, executable=r'C:\tools\codex.exe', commandLine=f'codex "Read {order} and carry it out"')
        self.assertEqual(process_evidence(row, facts, self.registry)['process'], 'verified')
        self.assertEqual(process_evidence(row, {**facts, 'created': created + 600}, self.registry)['process'], 'reused')
        self.assertEqual(process_evidence(row, {**facts, 'commandLine': str(order) + '.other'}, self.registry)['process'], 'unverified')
        self.assertEqual(process_evidence(row, {**facts, 'executable': r'C:\tailscale.exe'}, self.registry)['process'], 'unverified')

    def test_provider_success_and_forged_exit_are_not_task_success(self):
        agy = b'{"status":"SUCCESS","response":"done","usage":{}}'
        self.assertEqual(parse_terminal_metadata(agy, 'gemini')['taskOutcome'], 'unknown')
        self.assertEqual(parse_terminal_metadata(b'{"type":"process_exit","exit_code":0}', 'codex')['runtimePhase'], 'not_observed')
        self.assertEqual(parse_terminal_metadata(agy, 'gemini', truncated=True)['runtimePhase'], 'not_observed')

    def test_trusted_terminal_receipt_is_metadata_only(self):
        row = self.record()
        path = self.registry.parent / (row['id'] + '_codex.log')
        path.write_text("SECRET\nYou've hit your usage limit.\n", encoding='utf-8')
        row['log'] = str(path)
        snapshot = self.snapshot([row])
        self.assertEqual(snapshot['dispatches'][0]['state'], 'failed')
        self.assertNotIn('SECRET', json.dumps(snapshot))

    def test_only_last_30_registered_tasks_and_source_counts(self):
        rows = [{**self.record(), 'id': str(index)} for index in range(74)]
        data = self.snapshot(rows)
        self.assertEqual(len(data['dispatches']), 30)
        self.assertEqual(data['sources']['registry']['rowCount'], 74)
        self.assertEqual(len(data['tools']), 8)

    def test_project_header_only_even_when_body_is_large(self):
        path = self.root / 'projects' / 'sample' / 'STATE.md'
        path.parent.mkdir(parents=True)
        path.write_text('# STATE: Sample\n- project_id: sample\n- status: active\n- updated_at: 2020-01-01\n\n## Body\n' + 'private body' * 4000, encoding='utf-8')
        data = self.snapshot([])
        self.assertEqual(data['projects'][0]['status'], 'active')
        self.assertEqual(data['projects'][0]['updated_at'], '2020-01-01')
        self.assertNotIn('private body', json.dumps(data))

    def test_project_prefix_can_end_inside_valid_utf8_character(self):
        path = self.root / 'projects' / 'sample' / 'STATE.md'
        path.parent.mkdir(parents=True)
        header = b'\xef\xbb\xbf# STATE: Sample\n- project_id: sample\n- status: active\n\n## Body\n'
        cap = 16 * 1024
        for prefix_character_bytes in (1, 2):
            with self.subTest(prefix_character_bytes=prefix_character_bytes):
                raw = header + b'a' * (cap - len(header) - prefix_character_bytes) + '\u4e2d'.encode('utf-8') + b' trailing body'
                path.write_bytes(raw)
                data = self.snapshot([])
                self.assertEqual(data['sources']['projects']['state'], 'ready')
                self.assertEqual(data['sources']['projects']['unreadableCount'], 0)
                self.assertEqual(data['projects'][0]['project_id'], 'sample')
                self.assertEqual(data['projects'][0]['status'], 'active')
                self.assertNotIn('trailing body', json.dumps(data))

    def test_project_prefix_still_rejects_interior_invalid_utf8(self):
        path = self.root / 'projects' / 'sample' / 'STATE.md'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'# STATE: Sample\n- project_id: sample\n\n## Body\n' + b'a' * 100 + b'\xff' + b'a' * (16 * 1024))
        data = self.snapshot([])
        self.assertEqual(data['sources']['projects']['state'], 'partial')
        self.assertEqual(data['sources']['projects']['unreadableCount'], 1)
        self.assertIsNone(data['projects'])

    def test_complete_project_file_still_rejects_incomplete_utf8_tail(self):
        path = self.root / 'projects' / 'sample' / 'STATE.md'
        path.parent.mkdir(parents=True)
        header = b'# STATE: Sample\n- project_id: sample\n\n## Body\n'
        for size in (100, 16 * 1024):
            with self.subTest(size=size):
                path.write_bytes(header + b'a' * (size - len(header) - 1) + b'\xe4')
                data = self.snapshot([])
                self.assertEqual(data['sources']['projects']['state'], 'partial')
                self.assertEqual(data['sources']['projects']['unreadableCount'], 1)
                self.assertIsNone(data['projects'])

    def test_runtime_freshness_and_separate_coverage_without_commandline(self):
        now = time.time()
        row = dict(pid=19, sessionId='opaque-session', procStart=str(int((now + 11644473600) * 1e7)), status='busy', statusUpdatedAt=int(now * 1000), name='SECRET', cwd='SECRET')
        path = self.runtime / 'metadata.json'
        path.write_text(json.dumps(row), encoding='utf-8')
        def native(pid, **kwargs):
            self.assertEqual(kwargs, {})
            return dict(status='observed', created=now, createdFileTime=row['procStart'], executable=str(Path.home() / '.local' / 'bin' / 'claude.exe.old.1793323289191.27224'))
        data = self.snapshot([], native)
        self.assertEqual(data['dispatches'], [])
        self.assertEqual(data['runtimeSessions'][0]['state'], 'running')
        self.assertNotIn('SECRET', json.dumps(data))
        row['statusUpdatedAt'] -= 300000
        path.write_text(json.dumps(row), encoding='utf-8')
        self.assertEqual(self.snapshot([], native)['runtimeSessions'][0]['state'], 'unknown')

    def test_runtime_filetime_requires_exact_ticks_and_strict_installer_path(self):
        now = time.time()
        ticks = str(int((now + 11644473600) * 1e7))
        row = dict(pid=19, sessionId='opaque', procStart=ticks, status='shell', statusUpdatedAt=int(now * 1000))
        (self.runtime / 'one.json').write_text(json.dumps(row), encoding='utf-8')
        official = str(Path.home() / '.local' / 'bin' / 'claude.exe.old.1793323289191.27224')
        for filetime, image in [(str(int(ticks) + 1), official), (str(int(ticks) + 10000000), official), (ticks, str(self.root / 'claude.exe')), (ticks, official + '.evil')]:
            data = self.snapshot([], lambda pid, **kw: dict(status='observed', created=now, createdFileTime=filetime, executable=image))
            self.assertEqual(data['runtimeSessions'][0]['state'], 'unknown')

    def test_pending_cancel_overrides_recorded_stop_and_terminal_failure(self):
        row = self.record(stopped='20261104-120010', cancelOrderPending=True)
        data = self.snapshot([row])['dispatches'][0]
        self.assertEqual((data['state'], data['taskOutcome'], data['runtimePhase']), ('unknown', 'unknown', 'unverified'))

    def test_noncanonical_log_name_cannot_supply_a_terminal_receipt(self):
        row = self.record()
        path = self.registry.parent / (row['id'] + '_other.log')
        path.write_text("You've hit your usage limit.\n", encoding='utf-8')
        row['log'] = str(path)
        self.assertEqual(self.snapshot([row])['dispatches'][0]['state'], 'unknown')

    def test_nonfinite_runtime_time_is_not_active_and_does_not_fail_snapshot(self):
        row = dict(pid=19, sessionId='opaque', procStart='134000000000000000', status='busy', statusUpdatedAt=float('inf'))
        (self.runtime / 'one.json').write_text(json.dumps(row), encoding='utf-8')
        self.assertTrue(self.snapshot([])['ok'])

    def test_pid_dword_wrap_is_rejected_before_native_calls(self):
        self.assertEqual(probe_process(2**32 + 1)['reason'], 'invalid_pid')

    def test_metadata_path_is_rejected_when_symlink(self):
        if os.name == 'nt':
            self.skipTest('Windows symlink creation may need privileges')
        external = self.root / 'elsewhere'
        external.write_text('[]', encoding='utf-8')
        self.registry.symlink_to(external)
        self.assertEqual(self.snapshot()['sources']['registry']['state'], 'unreadable')
