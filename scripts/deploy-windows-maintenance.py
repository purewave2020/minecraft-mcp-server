"""Stage and install reviewed maintenance files through the existing private SSH helper."""
import argparse,pathlib,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parent.parent
HELPER=ROOT/'.npm/remote.py'
FILES=['maintenance-common.ps1','test-maintenance.ps1','backup-world.ps1','monitor.ps1','rolling-log.ps1','install-maintenance.ps1']
remote_stage='D:/Game/minecraft-java-26.3/maintenance-source/'
parser=argparse.ArgumentParser()
parser.add_argument('--scripts-only',action='store_true',help='Update maintenance scripts without changing tasks, JVM flags or server properties')
args=parser.parse_args()
def execute(script):
 result=subprocess.run([sys.executable,str(HELPER),'exec'],input=script,text=True,timeout=55,cwd=ROOT)
 if result.returncode:raise SystemExit(result.returncode)
execute("$ErrorActionPreference='Stop';[IO.Directory]::CreateDirectory('D:\\Game\\minecraft-java-26.3\\maintenance-source')|Out-Null")
for name in FILES:
 result=subprocess.run([sys.executable,str(HELPER),'upload',str(ROOT/'ops/windows'/name),remote_stage+name],timeout=55,cwd=ROOT)
 if result.returncode:raise SystemExit(result.returncode)
if args.scripts_only:
 execute(r"""$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root='D:\Game\minecraft-java-26.3';$source=Join-Path $root 'maintenance-source'
$names=@('maintenance-common.ps1','monitor.ps1','backup-world.ps1','rolling-log.ps1')
foreach($name in $names){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $source $name),[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)}}
& (Join-Path $source 'test-maintenance.ps1') -Source $source | Out-Null
$backup=Join-Path $root ('backups\maintenance-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
[IO.Directory]::CreateDirectory($backup)|Out-Null
foreach($name in $names){
 $target=Join-Path $root $name;$temporary=$target+'.deploy.tmp'
 Copy-Item -LiteralPath (Join-Path $source $name) -Destination $temporary -Force
 if(Test-Path $target){[IO.File]::Replace($temporary,$target,(Join-Path $backup $name))}else{[IO.File]::Move($temporary,$target)}
}
@{deployedAtUtc=[DateTime]::UtcNow.ToString('o');rollback=$backup;restartRequired=$false}|ConvertTo-Json -Compress
""")
else:
 execute("$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);& 'D:\\Game\\minecraft-java-26.3\\maintenance-source\\install-maintenance.ps1'")
