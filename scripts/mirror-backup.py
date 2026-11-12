"""Mirror a restore-verified Windows archive to this Mac without exposing SSH credentials."""
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / '.npm/remote.py'
DESTINATION = Path(os.environ.get('MINECRAFT_BACKUP_MIRROR', Path.home() / '.local/share/minecraft-world-backups'))


def remote(script, output=subprocess.PIPE):
    return subprocess.run([sys.executable, str(HELPER), 'exec'], input=script.encode('utf-8'),
                          stdout=output, stderr=subprocess.PIPE, check=True, timeout=240)


def verify_archive(filename):
    with zipfile.ZipFile(filename) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        expected = set()
        for entry in manifest['files']:
            name = entry['path'].replace('\\', '/')
            safe = PurePosixPath(name)
            if safe.is_absolute() or '..' in safe.parts or ':' in name or name in expected:
                raise ValueError('Unsafe or repeated archive member')
            expected.add(name)
            digest = hashlib.sha256()
            size = 0
            with archive.open(name) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
                    size += len(chunk)
            if digest.hexdigest().lower() != entry['sha256'].lower() or size != entry['bytes']:
                raise ValueError('Backup manifest verification failed: ' + name)
        if 'world/level.dat' not in expected:
            raise ValueError('Backup is missing world/level.dat')
        actual = {name for name in archive.namelist() if not name.endswith('/')} - {'manifest.json'}
        if actual != expected:
            raise ValueError('Backup archive contains unexpected files')
        return len(expected)


def mirror():
    os.umask(0o077)
    DESTINATION.mkdir(parents=True, exist_ok=True, mode=0o700)
    DESTINATION.chmod(0o700)
    script = r"""$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$base='E:\MinecraftBackups\minecraft-java-26.3'
$r=[IO.File]::ReadAllText((Join-Path $base 'latest-result.json'))|ConvertFrom-Json
if(-not $r.restoreVerified){throw 'Latest backup has not passed restore verification'}
$p=[IO.Path]::GetFullPath($r.archive)
if([IO.Path]::GetDirectoryName($p) -ine $base -or [IO.Path]::GetFileName($p) -notmatch '^\d{8}-\d{6}\.zip$'){throw 'Unexpected backup path'}
@{archive=$p;name=[IO.Path]::GetFileName($p);sha256=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash;bytes=(Get-Item $p).Length;completedAtUtc=$r.completedAtUtc}|ConvertTo-Json -Compress
"""
    record = json.loads(remote(script).stdout.decode('utf-8-sig').strip())
    if not re.fullmatch(r'\d{8}-\d{6}\.zip', record['name']):
        raise ValueError('Unexpected backup filename')
    target = DESTINATION / record['name']
    partial = target.with_suffix('.zip.partial')
    quoted = "'" + record['archive'].replace("'", "''") + "'"
    try:
        if not target.exists():
            with partial.open('wb') as output:
                remote('$ErrorActionPreference=\'Stop\';$f=[IO.File]::OpenRead(' + quoted +
                       ');try{$f.CopyTo([Console]::OpenStandardOutput())}finally{$f.Dispose()}', output=output)
            candidate = partial
        else:
            candidate = target
        with candidate.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest.lower() != record['sha256'].lower() or candidate.stat().st_size != record['bytes']:
            raise ValueError('Backup download hash mismatch')
        files = verify_archive(candidate)
        if candidate == partial:
            partial.replace(target)
        result = {**record, 'mirror': str(target), 'files': files, 'verified': True,
                  'mirroredAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        state = DESTINATION / 'latest-result.json'
        temporary = state.with_suffix('.tmp')
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        temporary.replace(state)
        archives = sorted(p for p in DESTINATION.glob('*.zip') if re.fullmatch(r'\d{8}-\d{6}\.zip', p.name))
        for old in archives[:-14]:
            old.unlink()
        print(json.dumps(result, ensure_ascii=False))
    finally:
        partial.unlink(missing_ok=True)


if __name__ == '__main__':
    mirror()
