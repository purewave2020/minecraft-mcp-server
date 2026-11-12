$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root=$DashboardRequest.serverRoot
$send=Join-Path $root 'send-command.ps1'
# Each send has a separate temporary result, so concurrent console users cannot
# produce a false acknowledgement. A queue receipt alone only means dispatched.
$storage='minecraft_dashboard:chat_'+[Guid]::NewGuid().ToString('N')
$stream=[IO.File]::Open((Join-Path $root 'logs\latest.log'),'Open','Read',([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
[void]$stream.Seek(0,'End')
$reader=[IO.StreamReader]::new($stream,[Text.UTF8Encoding]::new($false))
function Dispatch([string]$Command) {
  $receipt=(& $send -Command $Command -TimeoutSeconds 3) | ConvertFrom-Json
  if($receipt.status -ne 'dispatched'){throw 'Chat command was not dispatched'}
}
try {
  Dispatch ('execute store success storage '+$storage+' sent byte 1 run tellraw @a '+$DashboardRequest.component)
  Dispatch ('data get storage '+$storage+' sent')
  $deadline=[DateTime]::UtcNow.AddSeconds(5)
  $confirmed=$false
  while([DateTime]::UtcNow -lt $deadline) {
    $line=$reader.ReadLine()
    if($null -eq $line){Start-Sleep -Milliseconds 50;continue}
    if($line.Contains('Storage '+$storage+' has the following contents: 1b')){$confirmed=$true;break}
    if($line.Contains('Storage '+$storage+' has the following contents: 0b')){throw 'No online chat recipients'}
  }
  if(-not $confirmed){throw 'Chat execution was not confirmed; inspect game chat before retrying'}
  [Console]::WriteLine((@{status='sent';username='qingyage'} | ConvertTo-Json -Compress))
} finally {
  $reader.Dispose()
  try { Dispatch ('data remove storage '+$storage+' sent') } catch { }
}
