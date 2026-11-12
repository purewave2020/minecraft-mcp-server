param([string]$ServerRoot='D:\Game\minecraft-java-26.3')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'maintenance-common.ps1')
$directory=Join-Path $ServerRoot 'metrics'
[IO.Directory]::CreateDirectory($directory)|Out-Null
$lock=[IO.File]::Open((Join-Path $directory 'monitor.lock'),'OpenOrCreate','ReadWrite','None')
try {
  $now=[DateTime]::UtcNow
  $saveGuard=Join-Path $ServerRoot 'backup-save-guard.json'
  if(Test-Path $saveGuard){
    $guard=Get-Content -LiteralPath $saveGuard -Raw|ConvertFrom-Json
    if(-not (Get-Process -Id $guard.pid -ErrorAction SilentlyContinue) -or ($now-[DateTime]::Parse($guard.createdAtUtc)).TotalMinutes -gt 5){
      $recoveryLog=Join-Path $ServerRoot 'logs\latest.log'
      $recoveryOffset=(Get-Item -LiteralPath $recoveryLog).Length
      & (Join-Path $ServerRoot 'send-command.ps1') -Command 'save-on' -TimeoutSeconds 10 | Out-Null
      $recoveryDeadline=[DateTime]::UtcNow.AddSeconds(10)
      $confirmed=$false
      do {
        $stream=[IO.File]::Open($recoveryLog,'Open','Read','ReadWrite')
        try {[void]$stream.Seek([Math]::Min($recoveryOffset,$stream.Length),'Begin');$reader=[IO.StreamReader]::new($stream);$text=$reader.ReadToEnd()}finally{if($reader){$reader.Dispose()}else{$stream.Dispose()}}
        if($text -match 'Automatic saving is now enabled|Saving is already turned on'){$confirmed=$true;break}
        Start-Sleep -Milliseconds 250
      }while([DateTime]::UtcNow -lt $recoveryDeadline)
      if(-not $confirmed){throw 'Recovery save-on was not confirmed; keep the guard for the next monitor run'}
      # Preserve evidence after the server confirms saving is enabled.
      Move-Item -LiteralPath $saveGuard -Destination ($saveGuard+'.recovered-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
    }
  }
  $process=Get-MinecraftServerProcess -ServerRoot $ServerRoot
  $serverProcessId=if($process){[int]$process.ProcessId}else{0}
  $java=if($process){Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter ("IDProcess="+$serverProcessId)|Select-Object -First 1}else{$null}
  $os=Get-CimInstance Win32_OperatingSystem
  $cpu=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
  $tick=@{};$tickError=$null
  $log=Join-Path $ServerRoot 'logs\latest.log'
  $offset=if(Test-Path $log){(Get-Item $log).Length}else{0}
  if($process){
    try {
      & (Join-Path $ServerRoot 'send-command.ps1') -Command 'tick query' -TimeoutSeconds 5 | Out-Null
      $deadline=[DateTime]::UtcNow.AddSeconds(5)
      do {
        $stream=[IO.File]::Open($log,'Open','Read','ReadWrite')
        try {[void]$stream.Seek([Math]::Min($offset,$stream.Length),'Begin');$reader=[IO.StreamReader]::new($stream);$text=$reader.ReadToEnd()}finally{if($reader){$reader.Dispose()}else{$stream.Dispose()}}
        if($text -match 'Average time per tick: ([\d.]+)ms'){$tick.averageMs=[double]::Parse($Matches[1],[Globalization.CultureInfo]::InvariantCulture)}
        if($text -match 'P50: ([\d.]+)ms P95: ([\d.]+)ms P99: ([\d.]+)ms'){$tick.p50Ms=[double]::Parse($Matches[1],[Globalization.CultureInfo]::InvariantCulture);$tick.p95Ms=[double]::Parse($Matches[2],[Globalization.CultureInfo]::InvariantCulture);$tick.p99Ms=[double]::Parse($Matches[3],[Globalization.CultureInfo]::InvariantCulture);break}
        Start-Sleep -Milliseconds 250
      }while([DateTime]::UtcNow -lt $deadline)
      if(-not $tick.ContainsKey('p99Ms')){throw 'tick query response was not confirmed'}
    }catch{$tickError=$_.Exception.Message}
  }
  $cursorPath=Join-Path $directory 'log-cursor.json'
  $cursor=if(Test-Path $cursorPath){try{[IO.File]::ReadAllText($cursorPath)|ConvertFrom-Json}catch{$null}}else{$null}
  $delta=if(Test-Path $log){Read-MinecraftLogDelta -Path $log -Cursor $cursor}else{@{text='';cursor=$null;truncated=$false}}
  $volumes=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace)
  $alerts=@()
  if(-not $process){$alerts+=@{code='server-stopped';severity='error'}}
  if($tickError){$alerts+=@{code='tick-query-failed';severity='error';message=$tickError}}
  if($tick.ContainsKey('p99Ms') -and ($tick.averageMs -ge 40 -or $tick.p99Ms -ge 100)){$alerts+=@{code='tick-lag';severity='warning'}}
  foreach($volume in $volumes){if($volume.FreeSpace -lt 15GB -or ($volume.Size -gt 0 -and $volume.FreeSpace/$volume.Size -lt 0.1)){$alerts+=@{code='disk-space-low';severity='warning';drive=$volume.DeviceID;freeBytes=$volume.FreeSpace}}}
  if($delta.truncated){$alerts+=@{code='log-scan-truncated';severity='warning'}}
  $healthy=[bool]$process -and -not $tickError -and $tick.ContainsKey('p99Ms')
  $row=[ordered]@{observedAt=$now.ToString('o');running=[bool]$process;healthy=$healthy;state=$(if(-not $process){'stopped'}elseif(-not $healthy){'unresponsive'}elseif($alerts.Count){'degraded'}else{'healthy'});alerts=$alerts;volumes=$volumes;serverPid=$serverProcessId;cpuPercent=$cpu.PercentProcessorTime;javaCpuPercent=$java.PercentProcessorTime;javaPrivateBytes=$java.WorkingSetPrivate;freeMemoryKB=$os.FreePhysicalMemory;tick=$tick;tickError=$tickError;lagWarnings=[regex]::Matches($delta.text,"Can.t keep up").Count;movementWarnings=[regex]::Matches($delta.text,'moved wrongly|moved too quickly|kicked for floating|standing on air').Count;disk=@(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk|Select-Object Name,CurrentDiskQueueLength,DiskBytesPersec);gcTail=@(Get-ChildItem -LiteralPath (Join-Path $ServerRoot 'logs') -Filter 'gc-*.log' -File|Sort-Object LastWriteTime -Descending|Select-Object -First 1|Get-Content -Tail 8)}
  $filename=Join-Path $directory ('metrics-'+(Get-Date -Format 'yyyyMMdd')+'.jsonl')
  if((Test-Path $filename) -and (Get-Item $filename).Length -gt 10MB){Move-Item -LiteralPath $filename -Destination ($filename+'.'+(Get-Date -Format 'HHmmss'))}
  [IO.File]::AppendAllText($filename,($row|ConvertTo-Json -Depth 5 -Compress)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  Write-MinecraftJson -Path (Join-Path $directory 'latest.json') -Value $row
  if($delta.cursor){Write-MinecraftJson -Path $cursorPath -Value $delta.cursor}
  Remove-Item -LiteralPath (Join-Path $directory 'last-error.json') -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $directory -File | Where-Object {$_.Name -like 'metrics-*' -and $_.LastWriteTime -lt (Get-Date).AddDays(-7)} | Remove-Item -Force
  Get-ChildItem -LiteralPath (Join-Path $ServerRoot 'launcher-logs') -File | Where-Object {$_.LastWriteTime -lt (Get-Date).AddDays(-7)} | Remove-Item -Force -ErrorAction Continue
  Get-ChildItem -LiteralPath (Join-Path $ServerRoot 'logs') -Filter 'gc-*.log*' -File | Where-Object {$_.LastWriteTime -lt (Get-Date).AddDays(-7)} | Remove-Item -Force -ErrorAction Continue
  $row|ConvertTo-Json -Depth 5 -Compress
}catch{
  Write-MinecraftJson -Path (Join-Path $directory 'last-error.json') -Value @{observedAt=[DateTime]::UtcNow.ToString('o');healthy=$false;error=$_.Exception.Message}
  throw
}finally{$lock.Dispose()}
