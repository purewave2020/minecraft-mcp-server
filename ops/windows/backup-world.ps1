param([string]$ServerRoot='D:\Game\minecraft-java-26.3', [string]$BackupRoot='E:\MinecraftBackups\minecraft-java-26.3', [int]$Keep=14)
$ErrorActionPreference='Stop'
$lock=$null; $shadow=$null; $saveDisabled=$false; $stage=$null; $mount=$null
$guard=Join-Path $ServerRoot 'backup-save-guard.json'
function Send-Verified([string]$Command,[string]$Expected) {
  $log=Join-Path $ServerRoot 'logs\latest.log'
  $offset=(Get-Item -LiteralPath $log).Length
  & (Join-Path $ServerRoot 'send-command.ps1') -Command $Command -TimeoutSeconds 30 | Out-Null
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  do {
    $stream=[IO.File]::Open($log,'Open','Read','ReadWrite')
    try { [void]$stream.Seek([Math]::Min($offset,$stream.Length),'Begin');$reader=[IO.StreamReader]::new($stream);$text=$reader.ReadToEnd() } finally { if($reader){$reader.Dispose()}else{$stream.Dispose()} }
    if($text -match $Expected){return}
    Start-Sleep -Milliseconds 250
  }while([DateTime]::UtcNow -lt $deadline)
  throw "Server did not confirm $Command; inspect latest.log before retrying"
}
[IO.Directory]::CreateDirectory($BackupRoot)|Out-Null
try {
  $lock=[IO.File]::Open((Join-Path $BackupRoot 'backup.lock'),'OpenOrCreate','ReadWrite','None')
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
  $stage=Join-Path $BackupRoot ($stamp+'.partial')
  [IO.Directory]::CreateDirectory($stage)|Out-Null
  $pidFile=Join-Path $ServerRoot 'server.pid'
  $running=(Test-Path $pidFile) -and (Get-Process -Id ([int](Get-Content $pidFile -Raw)) -ErrorAction SilentlyContinue)
  $world=Join-Path $ServerRoot 'world'
  if($running){
    # Set the flag before dispatch: a timed-out receipt may still have executed.
    [IO.File]::WriteAllText($guard,([ordered]@{pid=$PID;createdAtUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $saveDisabled=$true
    Send-Verified 'save-off' 'Automatic saving is now disabled|Saving is already turned off'
    Send-Verified 'save-all flush' 'Saved the game|Saved the world'
    $volume=[IO.Path]::GetPathRoot($ServerRoot)
    $created=Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{Volume=$volume;Context='ClientAccessible'}
    if($created.ReturnValue -ne 0){throw "VSS snapshot failed with code $($created.ReturnValue)"}
    $shadow=Get-CimInstance Win32_ShadowCopy | Where-Object {$_.ID -eq $created.ShadowID}
    if(-not $shadow){throw 'Created shadow copy could not be found'}
    $mount=Join-Path $BackupRoot ($stamp+'.snapshot')
    $linkOutput=& cmd.exe /d /c mklink /D $mount ($shadow.DeviceObject+'\')
    if($LASTEXITCODE -ne 0){throw ('Could not expose VSS snapshot: '+($linkOutput|Out-String))}
    $world=Join-Path $mount ($ServerRoot.Substring($volume.Length)+'\world')
    Send-Verified 'save-on' 'Automatic saving is now enabled|Saving is already turned on'
    $saveDisabled=$false
    Remove-Item -LiteralPath $guard -Force
  }
  $copyOutput=& robocopy.exe $world (Join-Path $stage 'world') /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XF session.lock /NFL /NDL /NP
  $copyCode=$LASTEXITCODE
  [IO.File]::WriteAllLines((Join-Path $BackupRoot 'last-copy.log'),[string[]]$copyOutput,[Text.UTF8Encoding]::new($false))
  if($copyCode -ge 8){throw ("World backup copy failed: robocopy $copyCode; source=$world; "+($copyOutput|Select-Object -Last 12|Out-String))}
  foreach($name in @('server.properties','ops.json','whitelist.json','banned-players.json','banned-ips.json')){Copy-Item -LiteralPath (Join-Path $ServerRoot $name) -Destination $stage}
  $manifest=@(Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {[ordered]@{path=$_.FullName.Substring($stage.Length+1);bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}})
  if(-not ($manifest | Where-Object {$_.path -eq 'world\level.dat'})){throw 'Backup does not contain world/level.dat'}
  [IO.File]::WriteAllText((Join-Path $stage 'manifest.json'),([ordered]@{createdAtUtc=[DateTime]::UtcNow.ToString('o');consistentSnapshot=$true;method=$(if($running){'VSS'}else{'cold'});files=$manifest}|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip=Join-Path $BackupRoot ($stamp+'.zip')
  [IO.Compression.ZipFile]::CreateFromDirectory($stage,$zip+'.partial',[IO.Compression.CompressionLevel]::Optimal,$false)
  $verify=Join-Path $BackupRoot ($stamp+'.verify')
  try {
    [IO.Compression.ZipFile]::ExtractToDirectory($zip+'.partial',$verify)
    foreach($entry in $manifest){$file=Join-Path $verify $entry.path;if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256){throw "Restore verification failed: $($entry.path)"}}
  } finally {if(Test-Path $verify){Remove-Item -LiteralPath $verify -Recurse -Force}}
  Move-Item -LiteralPath ($zip+'.partial') -Destination $zip
  $result=[ordered]@{completedAtUtc=[DateTime]::UtcNow.ToString('o');archive=$zip;bytes=(Get-Item $zip).Length;files=$manifest.Count;restoreVerified=$true}
  [IO.File]::WriteAllText((Join-Path $BackupRoot 'latest-result.json'),($result|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  Get-ChildItem -LiteralPath $BackupRoot -Filter '*.zip' -File | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Force
  Remove-Item -LiteralPath (Join-Path $BackupRoot 'last-error.json') -Force -ErrorAction SilentlyContinue
  $result|ConvertTo-Json -Compress
} catch {
  [IO.File]::WriteAllText((Join-Path $BackupRoot 'last-error.json'),([ordered]@{failedAtUtc=[DateTime]::UtcNow.ToString('o');error=$_.Exception.Message}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  throw
} finally {
  if($saveDisabled){try {Send-Verified 'save-on' 'Automatic saving is now enabled|Saving is already turned on';Remove-Item -LiteralPath $guard -Force}catch{Write-Error 'CRITICAL: could not confirm save-on; inspect server immediately' -ErrorAction Continue}}
  if($mount -and (Test-Path -LiteralPath $mount)){[IO.Directory]::Delete($mount)}
  if($shadow){Remove-CimInstance -InputObject $shadow -ErrorAction Continue}
  if($stage -and (Test-Path $stage)){Remove-Item -LiteralPath $stage -Recurse -Force}
  if($lock){$lock.Dispose()}
}
