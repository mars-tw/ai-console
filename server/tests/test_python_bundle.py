"""Pinned runtime extraction checks without downloads or installed interpreters."""
import hashlib
import importlib.util
import io
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('bundle_python', Path(__file__).resolve().parents[2] / 'scripts/bundle_python.py')
bundle_python = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle_python)


def fixture(extra=None):
    values = {'python.exe': b'synthetic-executable', 'python314._pth': b'original', 'LICENSE.txt': b'synthetic-license'}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        for name, value in values.items():
            archive.writestr(name, value)
        if extra:
            archive.writestr(*extra)
    data = stream.getvalue()
    values['python314._pth'] = b'python314.zip\n.\n../..\n../../server\n../../tools\n'
    pin = {'sha256': hashlib.sha256(data).hexdigest(), 'pth': values['python314._pth'].decode(),
           'files': {name: hashlib.sha256(value).hexdigest() for name, value in values.items()}}
    return data, pin


class PythonBundleTests(unittest.TestCase):
    def test_verified_fixture_is_extracted_with_relative_isolated_paths_and_license(self):
        data, pin = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp) / 'app'
            stage.mkdir()
            archive = Path(tmp) / 'fixture.zip'
            archive.write_bytes(data)
            with patch.object(bundle_python, 'PIN', pin):
                target = bundle_python.bundle(stage, archive)
            self.assertEqual((target / 'LICENSE.txt').read_bytes(), b'synthetic-license')
            self.assertEqual((target / 'python314._pth').read_text(), pin['pth'])
            self.assertNotIn(tmp, (target / 'runtime.json').read_text())
            with self.assertRaises(ValueError):
                bundle_python.bundle(stage, archive)

    def test_bad_digest_writes_nothing(self):
        data, _ = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp) / 'app'
            stage.mkdir()
            archive = Path(tmp) / 'fixture.zip'
            archive.write_bytes(data)
            with self.assertRaises(ValueError):
                bundle_python.bundle(stage, archive)
            self.assertFalse((stage / 'runtime').exists())

    def test_unsafe_and_duplicate_entries_are_refused_even_with_matching_archive_hash(self):
        for name in ('../escape', '/absolute', 'C:drive', 'nested/file', 'nested\\file', 'PYTHON.EXE', 'trailing.', 'stream:ads'):
            with self.subTest(name=name):
                data, pin = fixture((name, b'bad'))
                with self.assertRaises(ValueError):
                    bundle_python.validated_files(data, pin)
        symlink = zipfile.ZipInfo('linked')
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        data, pin = fixture((symlink, b'target'))
        with self.assertRaises(ValueError):
            bundle_python.validated_files(data, pin)

    def test_expansion_limits_and_file_integrity_are_enforced(self):
        data, pin = fixture()
        with patch.object(bundle_python, 'MAX_EXPANDED_BYTES', 1), self.assertRaises(ValueError):
            bundle_python.validated_files(data, pin)
        with patch.object(bundle_python, 'MAX_FILES', 1), self.assertRaises(ValueError):
            bundle_python.validated_files(data, pin)
        pin['files']['python.exe'] = '0' * 64
        with self.assertRaises(ValueError):
            bundle_python.validated_files(data, pin)

    def test_linked_stage_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            with patch.object(bundle_python, 'linked', return_value=True), self.assertRaises(ValueError):
                bundle_python.checked_destination(stage)


if __name__ == '__main__':
    unittest.main()
