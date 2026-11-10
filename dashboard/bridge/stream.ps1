$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root=$DashboardRequest.serverRoot
$log=Join-Path $root 'logs\latest.log'
$stream=$null; $fileId=''; $offset=0L; $initial=$true
$lastPosition=[DateTime]::MinValue; $lastStatus=[DateTime]::MinValue
$lastFull=[DateTime]::MinValue; $lastMetrics=[DateTime]::MinValue
. (Join-Path $root 'console-channel.ps1')
$paths=Initialize-MinecraftConsoleChannel -Root $root
function Emit($value) { [Console]::WriteLine(($value | ConvertTo-Json -Depth 12 -Compress)); [Console]::Out.Flush() }
function Drain($Source,[string]$FileId,[long]$Offset,[bool]$Historical) {
  while($Source -and $Source.Length -gt $Offset) {
    $size=[int][Math]::Min(131072, $Source.Length-$Offset)
    $buffer=[byte[]]::new($size)
    $read=$Source.Read($buffer,0,$size)
    if($read -le 0){break}
    Emit @{type='log';file=$FileId;offset=$Offset;bytes=[Convert]::ToBase64String($buffer,0,$read);historical=$Historical}
    $Offset+=$read
  }
  return $Offset
}
function QueryBatch([string[]]$Commands) {
  $requests=@()
  foreach($command in $Commands) {
    $id=[Guid]::NewGuid().ToString('N')
    $pending=Join-Path $paths.Pending ($id+'.json')
    $request=@{id=$id;command=(ConvertTo-MinecraftConsoleCommand -Command $command);requestedAtUtc=[DateTime]::UtcNow.ToString('o')}
    [IO.File]::WriteAllText(($pending+'.tmp'),($request|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    [IO.File]::Move(($pending+'.tmp'),$pending)
    $requests+=Join-Path $paths.Results ($id+'.json')
  }
  $deadline=[DateTime]::UtcNow.AddSeconds(3)
  foreach($receiptPath in $requests) {
    while(-not (Test-Path -LiteralPath $receiptPath)) {
      if([DateTime]::UtcNow -gt $deadline){throw 'Read-only query batch timed out; inspect queue before reconnect'}
      Start-Sleep -Milliseconds 50
    }
    $receipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if($receipt.status -ne 'dispatched'){throw 'Read-only query batch was rejected'}
    Remove-Item -LiteralPath $receiptPath -Force
  }
}
try {
  Emit @{type='bridge';state='connected';observedAt=[DateTime]::UtcNow.ToString('o')}
  while($true) {
    $info=Get-Item -LiteralPath $log
    $nextId=[string]$info.CreationTimeUtc.Ticks
    if(-not $stream -or $nextId -ne $fileId -or $info.Length -lt $offset) {
      if($stream){$offset=Drain $stream $fileId $offset $false;$stream.Dispose()}
      $fileId=$nextId
      $stream=[IO.File]::Open($log,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
      $offset=0L
      $historical=$false
      if($initial) {
        if($DashboardRequest.cursor -and $DashboardRequest.cursor.file -eq $fileId -and $DashboardRequest.cursor.offset -le $stream.Length) {
          $offset=[long]$DashboardRequest.cursor.offset
        } else {
          $offset=[Math]::Max(0L,$stream.Length-131072L)
          $historical=$true
        }
        $initial=$false
      }
      [void]$stream.Seek($offset,'Begin')
      $offset=Drain $stream $fileId $offset $historical
    }
    $offset=Drain $stream $fileId $offset $false
    $now=[DateTime]::UtcNow
    $commands=@()
    if(($now-$lastPosition).TotalMilliseconds -ge $DashboardRequest.positionIntervalMs) {
      $commands+='execute as @a run data get entity @s Pos'
      $commands+='execute as @a run data get entity @s Dimension'
      $lastPosition=$now
    }
    if(($now-$lastStatus).TotalSeconds -ge 5) {
      $commands+='list uuids'
      $commands+='execute as @a run data get entity @s Health'
      $commands+='execute as @a run data get entity @s foodLevel'
      $lastStatus=$now
    }
    if(($now-$lastFull).TotalSeconds -ge 30) {
      $commands+='execute as @a run data get entity @s'
      $lastFull=$now
    }
    if($commands.Count){QueryBatch $commands}
    if(($now-$lastMetrics).TotalSeconds -ge 5) {
      $metrics=Join-Path $root 'metrics\latest.json'
      if(Test-Path $metrics) {
        try { Emit @{type='metrics';data=(Get-Content -LiteralPath $metrics -Raw | ConvertFrom-Json)} } catch {}
      }
      Emit @{type='heartbeat';observedAt=$now.ToString('o')}
      $lastMetrics=$now
    }
    Start-Sleep -Milliseconds 150
  }
} finally { if($stream){$stream.Dispose()} }
