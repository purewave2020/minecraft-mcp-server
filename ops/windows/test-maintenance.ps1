param([string]$Source=$PSScriptRoot)
$ErrorActionPreference='Stop'
. (Join-Path $Source 'maintenance-common.ps1')
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('minecraft-maintenance-test-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot)|Out-Null
function Assert($Condition,[string]$Message){if(-not $Condition){throw $Message}}
try {
  [IO.File]::WriteAllText((Join-Path $testRoot 'java-path.txt'),'D:\dedicated\java.exe')
  [IO.File]::WriteAllText((Join-Path $testRoot 'server.pid'),'0')
  Assert ($null -eq (Get-MinecraftServerProcess $testRoot {throw 'PID zero must never be queried'})) 'PID zero matched a system counter'
  [IO.File]::WriteAllText((Join-Path $testRoot 'server.pid'),'123')
  Assert ($null -eq (Get-MinecraftServerProcess $testRoot {param($n) @{ProcessId=$n;ExecutablePath='C:\other\java.exe';CommandLine='java -jar server.jar'}})) 'Unrelated Java was accepted'
  Assert ($null -eq (Get-MinecraftServerProcess $testRoot {param($n) @{ProcessId=$n;ExecutablePath='D:\dedicated\java.exe';CommandLine='java -jar other.jar'}})) 'Wrong Java application was accepted'
  $verified=Get-MinecraftServerProcess $testRoot {param($n) @{ProcessId=$n;ExecutablePath='D:\dedicated\java.exe';CommandLine='java -Xmx4G -jar server.jar nogui'}}
  Assert ($verified.ProcessId -eq 123) 'Dedicated server process was rejected'
  $log=Join-Path $testRoot 'latest.log'
  [IO.File]::WriteAllText($log,"first`n",[Text.UTF8Encoding]::new($false))
  $first=Read-MinecraftLogDelta $log $null
  [IO.File]::AppendAllText($log,"second`n",[Text.UTF8Encoding]::new($false))
  $second=Read-MinecraftLogDelta $log $first.cursor
  Assert ($second.text -eq "second`n") 'Log cursor skipped or repeated appended bytes'
  [IO.File]::WriteAllText($log,"new`n",[Text.UTF8Encoding]::new($false))
  $rotated=Read-MinecraftLogDelta $log $second.cursor
  Assert ($rotated.text -eq "new`n") 'Truncated log did not reset its cursor'
  $json=Join-Path $testRoot 'state.json'
  Write-MinecraftJson $json @{state='old'}
  Write-MinecraftJson $json @{state='new'}
  Assert (([IO.File]::ReadAllText($json)|ConvertFrom-Json).state -eq 'new') 'Atomic JSON replacement failed'
  @{passed=7;runtime=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Compress
}finally{Remove-Item -LiteralPath $testRoot -Recurse -Force}
