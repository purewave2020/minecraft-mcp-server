function Assert-DashboardSnapshotReady {
  param($Metrics, $Previous, [DateTimeOffset]$Now=[DateTimeOffset]::UtcNow, [int]$MinimumIntervalSeconds=900)
  if(-not $Metrics -or -not $Metrics.running -or $Metrics.tickError -or $null -eq $Metrics.tick.averageMs -or $null -eq $Metrics.tick.p99Ms){throw 'Map snapshot deferred: server health was not confirmed'}
  # PowerShell 7 converts JSON ISO dates to DateTime; preserve their UTC kind.
  $age=($Now-([DateTimeOffset]$Metrics.observedAt)).TotalSeconds
  if($age -gt 90 -or $age -lt -10){throw 'Map snapshot deferred: server metrics are stale'}
  if($Metrics.tick.averageMs -ge 25 -or $Metrics.tick.p99Ms -ge 100 -or $Metrics.cpuPercent -ge 85){throw 'Map snapshot deferred: server is busy'}
  if($Previous -and $Previous.attemptAtUtc){
    $wait=if($Previous.completed){[Math]::Max(900,$MinimumIntervalSeconds)}else{[Math]::Max(1800,$MinimumIntervalSeconds)}
    if(($Now-([DateTimeOffset]$Previous.attemptAtUtc)).TotalSeconds -lt $wait){throw 'Map snapshot deferred: snapshot cooldown is active'}
  }
}
