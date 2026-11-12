# Executed over SSH, not installed into or substituted for the game server launcher.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=$DashboardRequest.serverRoot
$backupRoot=$DashboardRequest.backupRoot
$exportRoot=Join-Path $backupRoot 'dashboard-map'
$guard=Join-Path $root 'backup-save-guard.json'
$lock=$null; $shadow=$null; $mount=$null; $saveDisabled=$false; $archive=$null
# Do not take the shared backup lock around the scheduled 03:30 server backup.
$localTime=[DateTime]::Now.TimeOfDay
if($localTime -ge [TimeSpan]::Parse('03:25:00') -and $localTime -lt [TimeSpan]::Parse('03:45:00')) {
  throw 'Map snapshot deferred for the daily backup window (03:25-03:45 server time)'
}
function Send-Verified([string]$Command,[string]$Expected) {
  $log=Join-Path $root 'logs\latest.log'
  $offset=(Get-Item -LiteralPath $log).Length
  & (Join-Path $root 'send-command.ps1') -Command $Command -TimeoutSeconds 10 | Out-Null
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
    $f=[IO.File]::Open($log,'Open','Read','ReadWrite')
    try { [void]$f.Seek([Math]::Min($offset,$f.Length),'Begin');$r=[IO.StreamReader]::new($f);$text=$r.ReadToEnd() } finally {if($r){$r.Dispose()}else{$f.Dispose()}}
    if($text -match $Expected){return}
    Start-Sleep -Milliseconds 100
  }while([DateTime]::UtcNow -lt $deadline)
  throw "Game did not confirm snapshot command: $Command"
}
try {
  $lock=[IO.File]::Open((Join-Path $backupRoot 'backup.lock'),'OpenOrCreate','ReadWrite','None')
  if(Test-Path $guard){throw 'Saving recovery is pending; snapshot deferred'}
  $metricsPath=Join-Path $root 'metrics\latest.json'
  $metrics=if(Test-Path $metricsPath){[IO.File]::ReadAllText($metricsPath)|ConvertFrom-Json}else{$null}
  $policyPath=Join-Path $exportRoot 'snapshot-state.json'
  $previous=if(Test-Path $policyPath){[IO.File]::ReadAllText($policyPath)|ConvertFrom-Json}else{$null}
  Assert-DashboardSnapshotReady -Metrics $metrics -Previous $previous -MinimumIntervalSeconds $DashboardRequest.snapshotMinimumSeconds
  [IO.Directory]::CreateDirectory($exportRoot)|Out-Null
  $stamp=[DateTime]::UtcNow.ToString('o')
  # Mark before dispatch; a timed-out or interrupted flush may still execute.
  $snapshotState=@{attemptAtUtc=$stamp;completed=$false}
  [IO.File]::WriteAllText($policyPath,($snapshotState|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($guard,(@{pid=$PID;createdAtUtc=$stamp;purpose='dashboard-map'}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  $saveDisabled=$true
  Send-Verified 'save-off' 'Automatic saving is now disabled|Saving is already turned off'
  Send-Verified 'save-all flush' 'Saved the game|Saved the world'
  $volume=[IO.Path]::GetPathRoot($root)
  $created=Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{Volume=$volume;Context='ClientAccessible'}
  if($created.ReturnValue -ne 0){throw "VSS snapshot failed with code $($created.ReturnValue)"}
  $shadow=Get-CimInstance Win32_ShadowCopy | Where-Object {$_.ID -eq $created.ShadowID}
  if(-not $shadow){throw 'Could not locate created VSS snapshot'}
  $mount=Join-Path $exportRoot ('mount-'+[Guid]::NewGuid().ToString('N'))
  $null=& cmd.exe /d /c mklink /D $mount ($shadow.DeviceObject+'\')
  if($LASTEXITCODE -ne 0){throw 'Could not expose VSS snapshot'}
  $world=Join-Path $mount ($root.Substring($volume.Length)+'\world')
  Send-Verified 'save-on' 'Automatic saving is now enabled|Saving is already turned on'
  $saveDisabled=$false
  Remove-Item -LiteralPath $guard -Force
  $snapshotState.completed=$true
  [IO.File]::WriteAllText($policyPath,($snapshotState|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  $files=@(Get-ChildItem -LiteralPath $world -File -Recurse | Where-Object {
    $_.Name -eq 'level.dat' -or ($_.Extension -in @('.mca','.mcc') -and $_.Directory.Name -eq 'region')
  })
  $manifest=@(); $changed=@()
  foreach($file in $files) {
    $relative=$file.FullName.Substring($world.Length+1).Replace('\','/')
    $hash=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest+=@{path=$relative;sha256=$hash;bytes=$file.Length}
    $previous=$DashboardRequest.manifest.PSObject.Properties[$relative]
    if(-not $previous -or $previous.Value -ne $hash){$changed+=@{path=$relative;file=$file.FullName}}
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive=Join-Path $exportRoot ('export-'+[Guid]::NewGuid().ToString('N')+'.zip')
  $zip=[IO.Compression.ZipFile]::Open($archive,'Create')
  try {
    foreach($file in $changed) { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.file,$file.path,[IO.Compression.CompressionLevel]::Fastest) }
    $entry=$zip.CreateEntry('dashboard-manifest.json')
    $writer=[IO.StreamWriter]::new($entry.Open(),[Text.UTF8Encoding]::new($false))
    try { $writer.Write((@{snapshotAt=$stamp;files=$manifest;changed=$changed.Count}|ConvertTo-Json -Depth 8 -Compress)) } finally {$writer.Dispose()}
  } finally {$zip.Dispose()}
  # Remove abandoned downloads only after a full day, never another active export.
  Get-ChildItem -LiteralPath $exportRoot -Filter 'export-*.zip' -File | Where-Object {$_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-1)} | Remove-Item -Force
  [Console]::WriteLine((@{archive=$archive;snapshotAt=$stamp;changed=$changed.Count;files=$manifest.Count;bytes=(Get-Item $archive).Length}|ConvertTo-Json -Compress))
} finally {
  if($saveDisabled) {
    try {Send-Verified 'save-on' 'Automatic saving is now enabled|Saving is already turned on';Remove-Item -LiteralPath $guard -Force}
    catch {Write-Error 'Could not confirm save-on; existing monitor will recover the save guard' -ErrorAction Continue}
  }
  if($mount -and (Test-Path -LiteralPath $mount)){[IO.Directory]::Delete($mount)}
  if($shadow){Remove-CimInstance -InputObject $shadow -ErrorAction Continue}
  if($lock){$lock.Dispose()}
}
