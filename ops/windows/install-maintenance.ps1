param([string]$ServerRoot='D:\Game\minecraft-java-26.3',[string]$Source=$PSScriptRoot)
$ErrorActionPreference='Stop'
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$backup=Join-Path $ServerRoot ('backups\maintenance-'+$stamp)
[IO.Directory]::CreateDirectory($backup)|Out-Null
foreach($name in @('start.ps1','server.properties')){Copy-Item -LiteralPath (Join-Path $ServerRoot $name) -Destination $backup}
foreach($name in @('backup-world.ps1','monitor.ps1','rolling-log.ps1')){
 $file=Join-Path $Source $name
 $tokens=$null;$errors=$null
 [void][Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw ('PowerShell syntax errors: '+($errors|Out-String))}
 Copy-Item -LiteralPath $file -Destination (Join-Path $ServerRoot $name) -Force
}
$startPath=Join-Path $ServerRoot 'start.ps1'
$start=[IO.File]::ReadAllText($startPath)
if(-not $start.Contains('MinecraftRollingLog')){
 $start=$start.Replace('Set-Location -LiteralPath $root',"Set-Location -LiteralPath `$root`r`n. (Join-Path `$root 'rolling-log.ps1')")
 $start=$start.Replace("[IO.File]::Open((Join-Path `$launchLogs (`$stamp + '.stdout.log')), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)","[MinecraftRollingLog]::new((Join-Path `$launchLogs (`$stamp + '.stdout.log')), 10485760, 5)")
 $start=$start.Replace("[IO.File]::Open((Join-Path `$launchLogs (`$stamp + '.stderr.log')), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)","[MinecraftRollingLog]::new((Join-Path `$launchLogs (`$stamp + '.stderr.log')), 10485760, 5)")
}
$start=$start.Replace('-Xms1G -Xmx4G -jar server.jar nogui','-Xms1G -Xmx4G -Xlog:gc*:file=logs/gc-%t.log:time,uptime,level,tags:filecount=5,filesize=10M -jar server.jar nogui')
$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($start,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Modified startup script did not parse'}
if(-not $start.Contains('MinecraftRollingLog') -or -not $start.Contains('-Xlog:gc*')){throw 'Startup patch did not match expected source'}
[IO.File]::WriteAllText($startPath,$start,[Text.UTF8Encoding]::new($false))
$properties=Join-Path $ServerRoot 'server.properties'
$content=[IO.File]::ReadAllText($properties)
$content=[regex]::Replace($content,'(?m)^view-distance=.*$','view-distance=8')
$content=[regex]::Replace($content,'(?m)^simulation-distance=.*$','simulation-distance=6')
[IO.File]::WriteAllText($properties,$content,[Text.UTF8Encoding]::new($false))
$backupRoot='E:\MinecraftBackups\minecraft-java-26.3'
[IO.Directory]::CreateDirectory($backupRoot)|Out-Null
& icacls.exe $backupRoot /inheritance:r /grant:r 'xiaqingbo:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not restrict backup directory permissions'}
function Register-TaskXml([string]$Name,[string]$Script,[string]$Trigger,[string]$Limit){
 $xml=@"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers>$Trigger</Triggers><Principals><Principal id="Server"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>$Limit</ExecutionTimeLimit></Settings><Actions Context="Server"><Exec><Command>C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe</Command><Arguments>-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;$ServerRoot\$Script&quot;</Arguments><WorkingDirectory>$ServerRoot</WorkingDirectory></Exec></Actions></Task>
"@
 $file=Join-Path $ServerRoot ($Name+'.xml');[IO.File]::WriteAllText($file,$xml,[Text.Encoding]::Unicode)
 & schtasks.exe /Create /TN $Name /XML $file /F|Out-Null
 if($LASTEXITCODE -ne 0){throw "Could not register task $Name"}
}
$today=(Get-Date).ToString('yyyy-MM-dd')
Register-TaskXml 'MinecraftJava-26.3-Backup' 'backup-world.ps1' "<CalendarTrigger><StartBoundary>${today}T03:30:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>" 'PT15M'
Register-TaskXml 'MinecraftJava-26.3-Monitor' 'monitor.ps1' "<TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${today}T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>" 'PT45S'
[ordered]@{installedAtUtc=[DateTime]::UtcNow.ToString('o');rollback=$backup;worldBackup=$backupRoot;viewDistance=8;simulationDistance=6;restartRequired=$true}|ConvertTo-Json -Compress
