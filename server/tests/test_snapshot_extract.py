"""Exercise snapshot extraction with synthetic archives only."""
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('extract_snapshot', Path(__file__).resolve().parents[2] / 'scripts/extract_snapshot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SnapshotExtractTests(unittest.TestCase):
    def test_extracts_utf8_names_into_empty_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'fixture.zip'
            destination = root / 'snapshot'
            destination.mkdir()
            with zipfile.ZipFile(archive, 'w') as fixture:
                fixture.writestr('快速安裝.cmd', b'fixture')
                fixture.writestr('資料/測試.txt', b'content')
            module.extract(archive, destination)
            self.assertEqual((destination / '快速安裝.cmd').read_bytes(), b'fixture')
            self.assertEqual((destination / '資料/測試.txt').read_bytes(), b'content')
            with self.assertRaises(ValueError):
                module.extract(archive, destination)

    def test_rejects_unsafe_paths_and_links_before_any_extraction(self):
        link = zipfile.ZipInfo('link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for unsafe in ('../escape', '/absolute', 'C:drive', 'a\\b', 'path/../escape', 'file:stream', link):
            with self.subTest(entry=unsafe), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                archive = root / 'fixture.zip'
                destination = root / 'snapshot'
                destination.mkdir()
                with zipfile.ZipFile(archive, 'w') as fixture:
                    fixture.writestr('safe.txt', b'safe')
                    # ZipInfo normally converts Windows separators before writing.
                    if unsafe == 'a\\b':
                        unsafe = zipfile.ZipInfo('placeholder')
                        unsafe.filename = 'a\\b'
                    fixture.writestr(unsafe, b'bad')
                with self.assertRaises(ValueError):
                    module.extract(archive, destination)
                self.assertEqual(list(destination.iterdir()), [])

    def test_rejects_case_insensitive_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'fixture.zip'
            destination = root / 'snapshot'
            destination.mkdir()
            with zipfile.ZipFile(archive, 'w') as fixture:
                fixture.writestr('test.txt', b'a')
                fixture.writestr('TEST.TXT', b'b')
            with self.assertRaises(ValueError):
                module.extract(archive, destination)
            self.assertEqual(list(destination.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
