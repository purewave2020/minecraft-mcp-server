param([string]$ServerRoot='D:\Game\minecraft-java-26.3',[string]$BackupRoot='E:\MinecraftBackups\minecraft-java-26.3')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$record=[IO.File]::ReadAllText((Join-Path $BackupRoot 'latest-result.json'))|ConvertFrom-Json
if(-not $record.restoreVerified){throw 'Backup was not verified'}
$directory=Join-Path $BackupRoot ('restore-rehearsal-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
[IO.Directory]::CreateDirectory($directory)|Out-Null
$process=$null;$stdout=$null;$stderr=$null
function Read-SharedLog([string]$Path){
  $stream=[IO.File]::Open($Path,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try{$reader=[IO.StreamReader]::new($stream);return $reader.ReadToEnd()}finally{if($reader){$reader.Dispose()}else{$stream.Dispose()}}
}
try {
  [IO.Compression.ZipFile]::ExtractToDirectory($record.archive,$directory)
  $manifest=[IO.File]::ReadAllText((Join-Path $directory 'manifest.json'))|ConvertFrom-Json
  foreach($entry in $manifest.files){
    $file=Join-Path $directory $entry.path
    if(-not [IO.Path]::GetFullPath($file).StartsWith($directory+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe backup member'}
    if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256){throw 'Restore file hash mismatch'}
  }
  Copy-Item -LiteralPath (Join-Path $ServerRoot 'server.jar') -Destination $directory
  foreach($name in @('libraries','versions')){Copy-Item -LiteralPath (Join-Path $ServerRoot $name) -Destination $directory -Recurse}
  Copy-Item -LiteralPath (Join-Path $ServerRoot 'eula.txt') -Destination $directory
  # The rehearsal world uses an isolated loopback listener, no LAN discovery or players.
  $properties=@('server-ip=127.0.0.1','server-port=25575','online-mode=false','enforce-secure-profile=false','white-list=true','enforce-whitelist=true','enable-rcon=false','enable-query=false','level-name=world','view-distance=2','simulation-distance=2','max-players=1','pause-when-empty-seconds=0','sync-chunk-writes=true')
  [IO.File]::WriteAllLines((Join-Path $directory 'server.properties'),$properties,[Text.UTF8Encoding]::new($false))
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,25575)
  try{$listener.Start()}finally{$listener.Stop()}
  $process=[Diagnostics.Process]::new()
  $process.StartInfo.FileName=([IO.File]::ReadAllText((Join-Path $ServerRoot 'java-path.txt'))).Trim()
  $process.StartInfo.Arguments='-Xms256M -Xmx1G -jar server.jar nogui'
  $process.StartInfo.WorkingDirectory=$directory
  $process.StartInfo.UseShellExecute=$false
  $process.StartInfo.CreateNoWindow=$true
  $process.StartInfo.RedirectStandardInput=$true
  $process.StartInfo.RedirectStandardOutput=$true
  $process.StartInfo.RedirectStandardError=$true
  $stdout=[IO.File]::Open((Join-Path $directory 'stdout.log'),'Create','Write','ReadWrite')
  $stderr=[IO.File]::Open((Join-Path $directory 'stderr.log'),'Create','Write','ReadWrite')
  [void]$process.Start()
  $stdoutCopy=$process.StandardOutput.BaseStream.CopyToAsync($stdout)
  $stderrCopy=$process.StandardError.BaseStream.CopyToAsync($stderr)
  $deadline=[DateTime]::UtcNow.AddSeconds(120)
  $ready=$false
  do {
    Start-Sleep -Milliseconds 500
    $log=Join-Path $directory 'logs\latest.log'
    if((Test-Path $log) -and ((Read-SharedLog $log) -match 'Done \([\d.,]+s\)!')){$ready=$true;break}
    if($process.HasExited){throw 'Restored Minecraft server exited before readiness'}
  }while([DateTime]::UtcNow -lt $deadline)
  if(-not $ready){throw 'Restored Minecraft server did not become ready within 120 seconds'}
  $process.StandardInput.WriteLine('stop');$process.StandardInput.Flush()
  if(-not $process.WaitForExit(30000)){throw 'Rehearsal server did not stop gracefully'}
  [void]$stdoutCopy.GetAwaiter().GetResult();[void]$stderrCopy.GetAwaiter().GetResult()
  if($process.ExitCode -ne 0){throw 'Rehearsal server exited with an error'}
  $text=[IO.File]::ReadAllText((Join-Path $directory 'logs\latest.log'))
  $saveAt=$text.LastIndexOf('Saving worlds')
  if($saveAt -lt 0){throw 'Restored world save was not confirmed'}
  $saved=$text.Substring($saveAt)
  foreach($dimension in @('overworld','the_nether','the_end')){if($saved -notmatch ('Saving chunks for level .*/minecraft:'+$dimension)){throw ('Restored dimension save was not confirmed: '+$dimension)}}
  $result=@{completedAtUtc=[DateTime]::UtcNow.ToString('o');archive=$record.archive;directory=$directory;files=$manifest.files.Count;loaded=$true;gracefullyStopped=$true;port=25575}
  [IO.File]::WriteAllText((Join-Path $BackupRoot 'restore-rehearsal-result.json'),($result|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  $result|ConvertTo-Json -Compress
}finally{
  if($process -and -not $process.HasExited){
    try{$process.StandardInput.WriteLine('stop');$process.StandardInput.Flush()}catch{}
    if(-not $process.WaitForExit(10000)){$process.Kill();$process.WaitForExit()}
  }
  if($stdout){$stdout.Dispose()};if($stderr){$stderr.Dispose()};if($process){$process.Dispose()}
}
