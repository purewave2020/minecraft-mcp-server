"""Private SSH bridge. Passwords never enter arguments, browser responses, or repository files."""
import argparse
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

PROJECT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get('DASHBOARD_DATA', PROJECT / '.npm/dashboard')).expanduser().resolve()
BRIDGE = Path(__file__).resolve().parent
CREDENTIALS = Path(os.environ.get('MINECRAFT_CREDENTIALS', Path.home() / '.config/minecraft-mcp-server/server-credentials.json'))
JAVA = os.environ.get('DASHBOARD_JAVA', str(Path.home() / 'Library/Application Support/minecraft/runtime/java-runtime-epsilon/mac-os-arm64/java-runtime-epsilon/jre.bundle/Contents/Home/bin/java'))
VERSION = '5.29'
JAR_URL = 'https://github.com/BlueMap-Minecraft/BlueMap/releases/download/v5.29/bluemap-5.29-cli.jar'
JAR_SHA256 = 'e830767fa6364b52b9310fb598508ebde7eec5ebe8360a989e240d991af89a3a'


@contextmanager
def map_lock():
    """Serialize cache application and rendering, including manual CLI invocations."""
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (DATA / 'map.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def safe_member(name):
    member = Path(name)
    if member.is_absolute() or '..' in member.parts or '\\' in name or ':' in name:
        raise RuntimeError('Unexpected snapshot path')
    return DATA / 'world' / member


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staging = path.with_suffix('.tmp')
    staging.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    staging.chmod(0o600)
    staging.replace(path)


def configuration():
    path = DATA / 'config.json'
    default = {'serverRoot': 'D:\\Game\\minecraft-java-26.3',
               'backupRoot': 'E:\\MinecraftBackups\\minecraft-java-26.3',
               'positionIntervalMs': 2500}
    return {**default, **(json.loads(path.read_text()) if path.exists() else {})}


def powershell(script, request=None, output=None, timeout=None):
    config = json.loads(CREDENTIALS.read_text())['ssh']
    request_text = json.dumps(request or configuration(), ensure_ascii=True)
    prefix = "$DashboardRequest = '" + request_text.replace("'", "''") + "' | ConvertFrom-Json\n"
    wrapper = ('[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);'
               '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'
               '$ProgressPreference="SilentlyContinue";'
               '& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))')
    encoded = base64.b64encode(wrapper.encode('utf-16-le')).decode()
    with tempfile.TemporaryDirectory(prefix='minecraft-dashboard-ssh-') as temp:
        helper = Path(temp) / 'askpass.py'
        helper.write_text('#!' + sys.executable + '\nimport json\nprint(json.load(open(' + repr(str(CREDENTIALS)) + '))["ssh"]["password"])\n')
        helper.chmod(0o700)
        env = {**os.environ, 'SSH_ASKPASS': str(helper), 'SSH_ASKPASS_REQUIRE': 'force', 'DISPLAY': 'minecraft-dashboard'}
        command = ['ssh', '-T', '-p', str(config.get('port', 22)), '-o', 'StrictHostKeyChecking=yes',
                   '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
                   '-o', 'NumberOfPasswordPrompts=1', str(config['username']) + '@' + str(config['host']),
                   'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + encoded]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=output, env=env, start_new_session=True)
        try:
            stdout, _ = process.communicate((prefix + script).encode(), timeout=timeout)
            if process.returncode:
                raise subprocess.CalledProcessError(process.returncode, ['ssh', '<private-server>'])
            return subprocess.CompletedProcess(['ssh'], process.returncode, stdout)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=10)


def snapshot():
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    old_path = DATA / 'world-manifest.json'
    previous = json.loads(old_path.read_text()) if old_path.exists() else {}
    # A partial/crashed prior application is repaired by requesting any mismatched local files again.
    cached = {}
    for entry in previous.get('files', []):
        local_file = safe_member(entry['path'])
        if local_file.is_file() and file_hash(local_file) == entry['sha256']:
            cached[entry['path']] = entry['sha256']
    request = {**configuration(), 'manifest': cached}
    result = powershell((BRIDGE / 'snapshot.ps1').read_text(), request, output=subprocess.PIPE, timeout=120)
    lines = result.stdout.decode('utf-8-sig').splitlines()
    export = next((json.loads(line) for line in reversed(lines) if line.startswith('{') and 'archive' in line), None)
    if not export:
        raise RuntimeError('Snapshot did not return an archive receipt')
    archive = export['archive']
    quoted = "'" + archive.replace("'", "''") + "'"
    local = DATA / 'snapshot.partial.zip'
    try:
        with local.open('wb') as output:
            powershell('$f=[IO.File]::OpenRead(' + quoted + ');try{$f.CopyTo([Console]::OpenStandardOutput())}finally{$f.Dispose()}', output=output, timeout=120)
        world = DATA / 'world'
        with zipfile.ZipFile(local) as zipped:
            manifest = json.loads(zipped.read('dashboard-manifest.json'))
            expected = {entry['path']: entry for entry in manifest['files']}
            for name in expected:
                safe_member(name)
            members = set(zipped.namelist()) - {'dashboard-manifest.json'}
            if len(members) != manifest['changed']:
                raise RuntimeError('Snapshot changed-file count mismatch')
            # Validate every changed file before publishing any of this generation.
            for name in zipped.namelist():
                if name == 'dashboard-manifest.json':
                    continue
                if name not in expected:
                    raise RuntimeError('Unexpected snapshot member')
                body = zipped.read(name)
                if hashlib.sha256(body).hexdigest() != expected[name]['sha256']:
                    raise RuntimeError('Snapshot hash verification failed: ' + name)
            for name, entry in expected.items():
                if name not in members and cached.get(name) != entry['sha256']:
                    raise RuntimeError('Snapshot omitted required file: ' + name)
            for name in zipped.namelist():
                if name == 'dashboard-manifest.json':
                    continue
                dest = world / name
                dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                part = dest.with_suffix(dest.suffix + '.partial')
                part.write_bytes(zipped.read(name))
                part.replace(dest)
            for old in previous.get('files', []):
                if old['path'] not in expected:
                    (world / old['path']).unlink(missing_ok=True)
            for entry in manifest['files']:
                if not (world / entry['path']).exists():
                    raise RuntimeError('Missing unchanged snapshot file: ' + entry['path'])
            manifest['syncedAt'] = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()
            atomic_json(old_path, manifest)
        print(json.dumps({**export, 'syncedAt': manifest['syncedAt'], 'verified': True}))
    finally:
        local.unlink(missing_ok=True)
        try:
            powershell('Remove-Item -LiteralPath ' + quoted + ' -Force', output=subprocess.DEVNULL, timeout=20)
        except (subprocess.SubprocessError, OSError):
            pass


def setup():
    runtime = DATA / 'runtime'
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    jar = runtime / ('bluemap-' + VERSION + '-cli.jar')
    if not jar.exists():
        part = jar.with_suffix('.partial')
        with urllib.request.urlopen(JAR_URL, timeout=60) as response, part.open('wb') as output:
            shutil.copyfileobj(response, output)
        if file_hash(part) != JAR_SHA256:
            part.unlink(missing_ok=True)
            raise RuntimeError('BlueMap download hash verification failed')
        part.replace(jar)
    if file_hash(jar) != JAR_SHA256:
        raise RuntimeError('BlueMap runtime hash mismatch')
    atomic_json(runtime / 'installation.json', {'version': VERSION, 'url': JAR_URL, 'sha256': hashlib.sha256(jar.read_bytes()).hexdigest()})
    if not (DATA / 'world/level.dat').exists():
        snapshot()
    configure_maps()
    print(json.dumps({'ready': True, 'runtime': str(runtime), 'world': str(DATA / 'world')}))


def configure_maps():
    runtime = DATA / 'runtime'
    config = runtime / 'config'
    config.mkdir(parents=True, exist_ok=True)
    (config / 'maps').mkdir(exist_ok=True)
    (config / 'storages').mkdir(exist_ok=True)
    # Remove only the unused example maps created by the CLI's initial configuration.
    for example in ['end.conf', 'nether.conf']:
        (config / 'maps' / example).unlink(missing_ok=True)
    world = str(DATA / 'world')
    web = str(DATA / 'web')
    (config / 'core.conf').write_text('accept-download: true\nrender-thread-count: 2\nscan-for-mod-resources: false\ndata: ' + json.dumps(str(runtime / 'data')) + '\n')
    (config / 'webapp.conf').write_text('webroot: ' + json.dumps(web) + '\nupdate-settings-file: true\nuse-cookies: true\n' +
        'default-to-flat-view: false\nstart-location: "overworld:-486:73:2:300:0:0:0:0:1"\n' +
        'scripts: ["/ui/dashboard.js"]\nstyles: ["/ui/dashboard.css"]\n')
    (config / 'webserver.conf').write_text('enabled: false\nwebroot: ' + json.dumps(web) + '\nbind: "127.0.0.1"\nport: 18101\n')
    (config / 'storages/file.conf').write_text('storage-type: "file"\nroot: ' + json.dumps(web + '/maps') + '\ncompression: GZIP\n')
    maps = []
    for map_id, name in [('overworld', '主世界'), ('the_nether', '下界'), ('the_end', '末地')]:
        # New 26.x saves use dimensions/minecraft/<dimension>/region.
        region = DATA / 'world/dimensions/minecraft' / map_id / 'region'
        if not region.exists():
            (config / 'maps' / (map_id + '.conf')).unlink(missing_ok=True)
            continue
        maps.append({'id': map_id, 'name': name, 'dimension': 'minecraft:' + map_id})
        text = ('world: ' + json.dumps(world) + '\ndimension: "minecraft:' + map_id + '"\nname: ' + json.dumps(name, ensure_ascii=False) + '\n' +
                'start-pos: { x: -486, z: 2 }\nordinal: ' + str(len(maps)) + '\nstorage: "file"\n' +
                'sky-color: "#99b1bc"\nvoid-color: "#172631"\nambient-light: 0.25\n' +
                'remove-caves-below-y: -64\nrender-edges: true\n' +
                'marker-sets: { landmarks: { label: "地标", markers: {} } }\n')
        (config / 'maps' / (map_id + '.conf')).write_text(text)
    atomic_json(DATA / 'maps.json', maps)


def update(sync=True):
    first = not (DATA / 'world/level.dat').exists()
    print('Synchronizing world snapshot...', flush=True)
    setup()
    if sync and not first:
        snapshot()
        configure_maps()
    print('Rendering terrain and buildings...', flush=True)
    command = [JAVA, '-Xms128M', '-Xmx1536M', '-Djava.awt.headless=true', '-jar',
               'bluemap-' + VERSION + '-cli.jar', '-r', '-g', '-v', '26.3']
    process = subprocess.Popen(command, cwd=DATA / 'runtime', start_new_session=True)
    try:
        if process.wait(timeout=1800):
            raise RuntimeError('BlueMap renderer failed')
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=20)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['live', 'snapshot', 'setup', 'configure', 'update', 'query'])
    parser.add_argument('--cursor')
    parser.add_argument('--username')
    parser.add_argument('--no-sync', action='store_true')
    args = parser.parse_args()
    if args.mode == 'live':
        request = configuration()
        if args.cursor:
            request['cursor'] = json.loads(args.cursor)
        powershell((BRIDGE / 'stream.ps1').read_text(), request)
    elif args.mode in ['snapshot', 'setup', 'configure', 'update']:
        with map_lock():
            if args.mode == 'snapshot':
                snapshot()
                configure_maps()
            elif args.mode == 'setup':
                setup()
            elif args.mode == 'configure':
                configure_maps()
            else:
                update(not args.no_sync)
    else:
        import re
        if not args.username or not re.fullmatch(r'[A-Za-z0-9_]{1,16}', args.username):
            raise ValueError('Invalid player name')
        command = 'execute as ' + args.username + ' run data get entity @s'
        powershell("& (Join-Path $DashboardRequest.serverRoot 'send-command.ps1') -Command '" + command + "' -TimeoutSeconds 5 | Out-Null", timeout=20)


if __name__ == '__main__':
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda _signal, _frame: sys.exit(0))
    try:
        main()
    except (subprocess.SubprocessError, OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)
