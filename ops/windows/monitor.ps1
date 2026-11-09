param([string]$ServerRoot='D:\Game\minecraft-java-26.3')
$ErrorActionPreference='Stop'
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
  $pidFile=Join-Path $ServerRoot 'server.pid'
  $serverProcessId=if(Test-Path $pidFile){[int](Get-Content $pidFile -Raw)}else{0}
  $java=Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object {$_.IDProcess -eq $serverProcessId} | Select-Object -First 1
  $os=Get-CimInstance Win32_OperatingSystem
  $cpu=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
  $tick=@{};$tickError=$null
  $log=Join-Path $ServerRoot 'logs\latest.log'
  $offset=if(Test-Path $log){(Get-Item $log).Length}else{0}
  if($java){
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
  $lines=if(Test-Path $log){@(Get-Content -LiteralPath $log -Tail 3000)}else{@()}
  $minute=(Get-Date).AddMinutes(-1).ToString('HH:mm')
  $recent=@($lines | Where-Object {$_.StartsWith('['+$minute+':')})
  $row=[ordered]@{observedAt=$now.ToString('o');running=[bool]$java;serverPid=$serverProcessId;cpuPercent=$cpu.PercentProcessorTime;javaCpuPercent=$java.PercentProcessorTime;javaPrivateBytes=$java.WorkingSetPrivate;freeMemoryKB=$os.FreePhysicalMemory;tick=$tick;tickError=$tickError;lagWarnings=@($recent|Where-Object {$_ -match 'Can.t keep up'}).Count;movementWarnings=@($recent|Where-Object {$_ -match 'moved wrongly|moved too quickly'}).Count;disk=@(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk|Select-Object Name,CurrentDiskQueueLength,DiskBytesPersec);gcTail=@(Get-ChildItem -LiteralPath (Join-Path $ServerRoot 'logs') -Filter 'gc-*.log' -File|Sort-Object LastWriteTime -Descending|Select-Object -First 1|Get-Content -Tail 8)}
  $filename=Join-Path $directory ('metrics-'+(Get-Date -Format 'yyyyMMdd')+'.jsonl')
  if((Test-Path $filename) -and (Get-Item $filename).Length -gt 10MB){Move-Item -LiteralPath $filename -Destination ($filename+'.'+(Get-Date -Format 'HHmmss'))}
  [IO.File]::AppendAllText($filename,($row|ConvertTo-Json -Depth 5 -Compress)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $directory 'latest.json'),($row|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  Get-ChildItem -LiteralPath $directory -File | Where-Object {$_.Name -like 'metrics-*' -and $_.LastWriteTime -lt (Get-Date).AddDays(-7)} | Remove-Item -Force
  Get-ChildItem -LiteralPath (Join-Path $ServerRoot 'launcher-logs') -File | Where-Object {$_.LastWriteTime -lt (Get-Date).AddDays(-7)} | Remove-Item -Force -ErrorAction Continue
  Get-ChildItem -LiteralPath (Join-Path $ServerRoot 'logs') -Filter 'gc-*.log*' -File | Where-Object {$_.LastWriteTime -lt (Get-Date).AddDays(-7)} | Remove-Item -Force -ErrorAction Continue
  $row|ConvertTo-Json -Depth 5 -Compress
}finally{$lock.Dispose()}
