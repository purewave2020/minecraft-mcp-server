import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('mirror_backup', Path(__file__).resolve().parents[1] / 'scripts/mirror-backup.py')
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)


class BackupTests(unittest.TestCase):
    def archive(self, directory, corrupt=False, unsafe=False):
        target = Path(directory) / 'test.zip'
        body = b'restored world'
        name = '../level.dat' if unsafe else 'world/level.dat'
        with zipfile.ZipFile(target, 'w') as archive:
            archive.writestr(name, body if not corrupt else b'corrupt')
            archive.writestr('manifest.json', json.dumps({'files': [{'path': name, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}]}))
        return target

    def test_restored_bytes_are_checked_against_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(mirror.verify_archive(self.archive(directory)), 1)
            with self.assertRaisesRegex(ValueError, 'verification failed'):
                mirror.verify_archive(self.archive(directory, corrupt=True))

    def test_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                mirror.verify_archive(self.archive(directory, unsafe=True))


if __name__ == '__main__':
    unittest.main()
