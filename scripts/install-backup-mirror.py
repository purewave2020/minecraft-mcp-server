"""Install the current user's daily off-host Minecraft backup mirror."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
if not (root / '.npm/remote.py').is_file():
    raise SystemExit('Configure the existing private SSH helper before installing the mirror')
logs = Path.home() / '.local/share/minecraft-world-backups'
logs.mkdir(parents=True, exist_ok=True, mode=0o700)
logs.chmod(0o700)
filename = Path.home() / 'Library/LaunchAgents/local.minecraft.backup-mirror.plist'
filename.parent.mkdir(parents=True, exist_ok=True)
value = {'Label': 'local.minecraft.backup-mirror', 'ProgramArguments': [sys.executable, str(root / 'scripts/mirror-backup.py')],
         'WorkingDirectory': str(root), 'StartCalendarInterval': {'Hour': 4, 'Minute': 15}, 'RunAtLoad': True,
         'ProcessType': 'Background', 'LowPriorityIO': True, 'Nice': 10,
         'StandardOutPath': str(logs / 'mirror.log'), 'StandardErrorPath': str(logs / 'mirror-error.log')}
filename.write_bytes(plistlib.dumps(value))
filename.chmod(0o600)
domain = 'gui/' + str(os.getuid())
subprocess.run(['launchctl', 'bootout', domain + '/local.minecraft.backup-mirror'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.run(['launchctl', 'bootstrap', domain, str(filename)], check=True)
print(filename)
