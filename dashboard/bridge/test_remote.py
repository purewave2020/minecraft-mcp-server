"""Exercise snapshot integrity and interrupted-transfer recovery without SSH or game commands."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import remote


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.data_patch = patch.object(remote, 'DATA', self.data)
        self.data_patch.start()
        self.addCleanup(self.data_patch.stop)

    def transport(self, files, corrupt=False):
        entries = [{'path': name, 'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body)} for name, body in files.items()]
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('dashboard-manifest.json', json.dumps({'snapshotAt': '2026-11-10T03:00:00Z', 'files': entries, 'changed': len(files)}))
            for name, body in files.items():
                archive.writestr(name, b'bad' if corrupt else body)
        self.requests = []

        def powershell(_script, request=None, output=None, timeout=None):
            if request is not None:
                self.requests.append(request)
                return subprocess.CompletedProcess([], 0, b'{"archive":"E:\\\\private-export.zip"}')
            if hasattr(output, 'write'):
                output.write(buffer.getvalue())
            return subprocess.CompletedProcess([], 0, b'')
        return patch.object(remote, 'powershell', side_effect=powershell)

    def test_valid_snapshot_is_verified_and_manifest_committed(self):
        with self.transport({'level.dat': b'world', 'dimensions/minecraft/overworld/region/r.0.0.mca': b'region'}):
            remote.snapshot()
        self.assertEqual((self.data / 'world/level.dat').read_bytes(), b'world')
        self.assertEqual(len(json.loads((self.data / 'world-manifest.json').read_text())['files']), 2)
        self.assertFalse((self.data / 'snapshot.partial.zip').exists())

    def test_corrupt_download_does_not_publish_world_or_manifest(self):
        with self.transport({'level.dat': b'world'}, corrupt=True):
            with self.assertRaisesRegex(RuntimeError, 'hash verification'):
                remote.snapshot()
        self.assertFalse((self.data / 'world/level.dat').exists())
        self.assertFalse((self.data / 'world-manifest.json').exists())

    def test_partial_previous_application_requests_the_damaged_file_again(self):
        remote.atomic_json(self.data / 'world-manifest.json', {'files': [{'path': 'level.dat', 'sha256': hashlib.sha256(b'old').hexdigest()}]})
        (self.data / 'world').mkdir()
        (self.data / 'world/level.dat').write_bytes(b'interrupted-write')
        with self.transport({'level.dat': b'new'}):
            remote.snapshot()
        self.assertEqual(self.requests[0]['manifest'], {})
        self.assertEqual((self.data / 'world/level.dat').read_bytes(), b'new')


if __name__ == '__main__':
    unittest.main()
