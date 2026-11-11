$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root=$DashboardRequest.serverRoot
$log=Join-Path $root 'logs\latest.log'
$stream=$null; $fileId=''; $offset=0L; $initial=$true
$lastPosition=[DateTime]::MinValue; $lastStatus=[DateTime]::MinValue
$lastFull=[DateTime]::MinValue; $lastMetrics=[DateTime]::MinValue
$lastEnvironment=[DateTime]::MinValue
$lastEntities=[DateTime]::MinValue
# Windows OpenSSH can leave a grandchild PowerShell process alive after SSH exits.
# Follow the actual sshd process handle so reconnecting never leaves another polling loop.
$sshOwner=$null
$parent=Get-CimInstance Win32_Process -Filter ("ProcessId="+$PID)
$parent=Get-CimInstance Win32_Process -Filter ("ProcessId="+$parent.ParentProcessId)
if($parent -and $parent.Name -eq 'cmd.exe') {
  $parent=Get-CimInstance Win32_Process -Filter ("ProcessId="+$parent.ParentProcessId)
}
if($parent -and $parent.Name -eq 'sshd.exe') {$sshOwner=Get-Process -Id $parent.ProcessId -ErrorAction SilentlyContinue}
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
  # The existing queue sorts pending UUID filenames. Assign sorted UUIDs in command
  # order so a whole batch retains its boundaries without nine separate queue polls.
  $ids=@($Commands | ForEach-Object {[Guid]::NewGuid().ToString('N')} | Sort-Object)
  $index=0
  foreach($command in $Commands) {
    $id=$ids[$index];$index++
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
    if($sshOwner) {$sshOwner.Refresh();if($sshOwner.HasExited){break}}
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
    $entityCommands=@()
    if(($now-$lastPosition).TotalMilliseconds -ge $DashboardRequest.positionIntervalMs) {
      $commands+='execute as @a run data get entity @s Pos'
      $commands+='execute as @a run data get entity @s Rotation'
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
    if(($now-$lastEntities).TotalSeconds -ge 3) {
      foreach($dimension in @('overworld','the_nether','the_end')) {
        # Read-only storage boundaries delimit complete, possibly empty entity snapshots.
        $entityCommands+='data get storage minecraft_dashboard:entities_'+$dimension+'_begin'
        $entityCommands+='execute in minecraft:'+$dimension+' as @a[distance=0..] at @s as @e[type=!minecraft:player,type=!minecraft:item,type=!minecraft:experience_orb,distance=..48,sort=nearest,limit=32] if data entity @s Health run data get entity @s'
        $entityCommands+='data get storage minecraft_dashboard:entities_'+$dimension+'_end'
      }
      $lastEntities=$now
    }
    if(($now-$lastEnvironment).TotalSeconds -ge 5) {
      $commands+='time of minecraft:overworld query minecraft:day'
      # Empty command-storage reads label successful predicates without changing world data or sending chat.
      $commands+='execute in minecraft:overworld if predicate {type:"minecraft:weather_check",raining:false} run data get storage minecraft_dashboard:weather_clear'
      $commands+='execute in minecraft:overworld if predicate {type:"minecraft:weather_check",raining:true,thundering:false} run data get storage minecraft_dashboard:weather_rain'
      $commands+='execute in minecraft:overworld if predicate {type:"minecraft:weather_check",raining:true,thundering:true} run data get storage minecraft_dashboard:weather_thunder'
      $lastEnvironment=$now
    }
    if($commands.Count){QueryBatch $commands}
    $offset=Drain $stream $fileId $offset $false
    if($entityCommands.Count){QueryBatch $entityCommands}
    $offset=Drain $stream $fileId $offset $false
    if($entityCommands.Count){$lastEntities=[DateTime]::UtcNow}
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
} finally { if($stream){$stream.Dispose()};if($sshOwner){$sshOwner.Dispose()} }
