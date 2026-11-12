function Get-MinecraftServerProcess {
  param([string]$ServerRoot, [scriptblock]$Lookup={param($ProcessId) Get-CimInstance Win32_Process -Filter ("ProcessId="+$ProcessId)})
  $pidFile=Join-Path $ServerRoot 'server.pid'
  $javaFile=Join-Path $ServerRoot 'java-path.txt'
  if(-not (Test-Path $pidFile) -or -not (Test-Path $javaFile)){return $null}
  $processNumber=0
  if(-not [int]::TryParse([IO.File]::ReadAllText($pidFile).Trim(),[ref]$processNumber) -or $processNumber -le 0){return $null}
  $candidate=& $Lookup $processNumber
  $expected=[IO.File]::ReadAllText($javaFile).Trim()
  if(-not $candidate -or $candidate.ExecutablePath -ine $expected -or $candidate.CommandLine -notmatch '(?i)\s-jar\s+"?(?:[^"\r\n]*[\\/])?server\.jar"?(?:\s|$)'){return $null}
  return $candidate
}

function Write-MinecraftJson {
  param([string]$Path, $Value)
  $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  try {
    [IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    if(Test-Path -LiteralPath $Path){[IO.File]::Replace($temporary,$Path,$temporary+'.old')}else{[IO.File]::Move($temporary,$Path)}
  } finally {foreach($file in @($temporary,($temporary+'.old'))){if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force}}}
}

function Read-MinecraftLogDelta {
  param([string]$Path, $Cursor, [long]$MaximumBytes=8388608)
  $info=Get-Item -LiteralPath $Path
  $identity=[string]$info.CreationTimeUtc.Ticks
  $offset=0L
  if($Cursor -and $Cursor.file -eq $identity -and $Cursor.offset -le $info.Length){$offset=[long]$Cursor.offset}
  $truncated=$info.Length-$offset -gt $MaximumBytes
  if($truncated){$offset=$info.Length-$MaximumBytes}
  $stream=[IO.File]::Open($Path,'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try {
    [void]$stream.Seek($offset,'Begin')
    $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::UTF8)
    $content=$reader.ReadToEnd()
    return @{text=$content;cursor=@{file=$identity;offset=$stream.Position};truncated=$truncated}
  } finally {if($reader){$reader.Dispose()}else{$stream.Dispose()}}
}
