"""Stage and install reviewed maintenance files through the existing private SSH helper."""
import pathlib,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parent.parent
HELPER=ROOT/'.npm/remote.py'
FILES=['backup-world.ps1','monitor.ps1','rolling-log.ps1','install-maintenance.ps1']
remote_stage='D:/Game/minecraft-java-26.3/maintenance-source/'
def execute(script):
 result=subprocess.run([sys.executable,str(HELPER),'exec'],input=script,text=True,timeout=55,cwd=ROOT)
 if result.returncode:raise SystemExit(result.returncode)
execute("$ErrorActionPreference='Stop';[IO.Directory]::CreateDirectory('D:\\Game\\minecraft-java-26.3\\maintenance-source')|Out-Null")
for name in FILES:
 result=subprocess.run([sys.executable,str(HELPER),'upload',str(ROOT/'ops/windows'/name),remote_stage+name],timeout=55,cwd=ROOT)
 if result.returncode:raise SystemExit(result.returncode)
execute("$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);& 'D:\\Game\\minecraft-java-26.3\\maintenance-source\\install-maintenance.ps1'")
