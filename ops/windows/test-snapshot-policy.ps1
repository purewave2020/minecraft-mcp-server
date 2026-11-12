param([string]$PolicyFile=(Join-Path $PSScriptRoot 'snapshot-policy.ps1'))
$ErrorActionPreference='Stop'
. $PolicyFile
$now=[DateTimeOffset]::UtcNow
$metrics=@{running=$true;observedAt=$now.ToString('o');tick=@{averageMs=7;p99Ms=20};tickError=$null;cpuPercent=10}
Assert-DashboardSnapshotReady -Metrics $metrics -Previous $null -Now $now
$fromJson=($metrics|ConvertTo-Json)|ConvertFrom-Json
Assert-DashboardSnapshotReady -Metrics $fromJson -Previous $null -Now $now
function Expect-Deferred([scriptblock]$Action){$failed=$false;try{& $Action}catch{$failed=$_.Exception.Message -match 'deferred'};if(-not $failed){throw 'Unsafe snapshot was not deferred'}}
Expect-Deferred {Assert-DashboardSnapshotReady -Metrics $metrics -Previous @{attemptAtUtc=$now.AddMinutes(-5).ToString('o');completed=$true} -Now $now}
Expect-Deferred {Assert-DashboardSnapshotReady -Metrics $metrics -Previous @{attemptAtUtc=$now.AddMinutes(-20).ToString('o');completed=$false} -Now $now}
$metrics.tick.p99Ms=200
Expect-Deferred {Assert-DashboardSnapshotReady -Metrics $metrics -Previous $null -Now $now}
$metrics.tick.p99Ms=20;$metrics.observedAt=$now.AddMinutes(-3).ToString('o')
Expect-Deferred {Assert-DashboardSnapshotReady -Metrics $metrics -Previous $null -Now $now}
$metrics.observedAt=$now.ToString('o');$metrics.running=$false
Expect-Deferred {Assert-DashboardSnapshotReady -Metrics $metrics -Previous $null -Now $now}
@{passed=7;runtime=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Compress
