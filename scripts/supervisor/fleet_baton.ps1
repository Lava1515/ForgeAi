# Fleet baton helper. The baton (ForgeBrain/fleet/BATON.md) says who supervises the fleet.
# Protocol: ForgeBrain/fleet/RELAY.md. Written 2026-11-12 by claude-pro (claude-fable-5-2).
#
#   fleet_baton.ps1                       print status (time, baton, heartbeat age, lock, limits)
#   fleet_baton.ps1 -Claim "<who>"        take the takeover lock; prints CLAIMED or BUSY (exit 2)
#   fleet_baton.ps1 -Release              drop the takeover lock
#   fleet_baton.ps1 -Set "k=v|k=v" -By "<id - model>"     change baton values (known keys only; separate pairs with |)
#   fleet_baton.ps1 -Log "<text>" -By "<id - model>"      add one dated line to HANDOFFS.md
param(
  [string]$Claim,
  [switch]$Release,
  [string]$Set,
  [string]$Log,
  [string]$By = 'unsigned'
)
$ErrorActionPreference = 'Stop'
$root   = 'C:\code\ForgeAi'
$fleet  = Join-Path $root 'ForgeBrain\fleet'
$baton  = Join-Path $fleet 'BATON.md'
$hand   = Join-Path $fleet 'HANDOFFS.md'
$lockDir = Join-Path $root '.superpowers\fleet'
$lock   = Join-Path $lockDir 'TAKEOVER.lock'
$now    = Get-Date
$stamp  = $now.ToString('yyyy-MM-dd HH:mm zzz')
$utf8   = New-Object System.Text.UTF8Encoding($false)
$keys = @(
  'state','supervisor','supervisor_model','supervisor_thread','supervisor_since','ledger',
  'previous_supervisor','previous_thread','previous_ledger',
  'codex_limit_until','claude_limit_until','agy_limit_until',
  'watchdog_task','wake_codex_task','wake_claude_task',
  'relay_claude_thread','relay_claude_task','relay_codex_thread','relay_codex_task',
  'relay_agy_thread','relay_agy_task','orders','updated','updated_by'
)

function Read-Lines { [System.IO.File]::ReadAllLines($baton, $utf8) }
function Read-Baton {
  $h = [ordered]@{}
  foreach ($l in (Read-Lines)) {
    if ($l -match '^([a-z_]+):\s*(.*)$' -and $keys -contains $Matches[1]) { $h[$Matches[1]] = $Matches[2].Trim() }
  }
  $h
}

if ($Claim) {
  if (-not (Test-Path $lockDir)) { New-Item -ItemType Directory -Force $lockDir | Out-Null }
  if (Test-Path $lock) {
    $age = ($now - (Get-Item $lock).LastWriteTime).TotalMinutes
    if ($age -lt 15) { "BUSY: lock held ($([int]$age) min old): " + ((Get-Content $lock -Raw).Trim()); exit 2 }
    Remove-Item $lock -Confirm:$false
  }
  try {
    $fs = [System.IO.File]::Open($lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    $b = $utf8.GetBytes("$stamp $Claim")
    $fs.Write($b, 0, $b.Length); $fs.Close()
    "CLAIMED $stamp $Claim"
  } catch { "BUSY: another agent took the lock first"; exit 2 }
  exit 0
}

if ($Release) {
  if (Test-Path $lock) { Remove-Item $lock -Confirm:$false; "RELEASED" } else { "no lock" }
  exit 0
}

if ($Set) {
  $pairs = [ordered]@{}
  foreach ($p in ($Set -split '\|')) {
    $i = $p.IndexOf('=')
    if ($i -lt 1) { "BAD: '$p' is not key=value"; exit 1 }
    $k = $p.Substring(0, $i).Trim(); $v = $p.Substring($i + 1).Trim()
    if ($keys -notcontains $k) { "BAD: unknown key '$k'. Known: $($keys -join ', ')"; exit 1 }
    $pairs[$k] = $v
  }
  $pairs['updated'] = $stamp
  $pairs['updated_by'] = $By
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($l in (Read-Lines)) { $lines.Add($l) }
  foreach ($k in $pairs.Keys) {
    $done = $false
    for ($n = 0; $n -lt $lines.Count; $n++) {
      if ($lines[$n] -match "^$k`:") { $lines[$n] = "$k`: $($pairs[$k])"; $done = $true; break }
    }
    if (-not $done) { $lines.Add("$k`: $($pairs[$k])") }
  }
  [System.IO.File]::WriteAllLines($baton, $lines, $utf8)
  "SET " + (($pairs.Keys | ForEach-Object { "$_=$($pairs[$_])" }) -join '; ')
}

if ($Log) {
  $dot = [char]0xB7   # middle dot, built here so this file stays pure ASCII for PowerShell 5.1
  [System.IO.File]::AppendAllText($hand, "- $stamp $dot $By $dot $Log`r`n", $utf8)
  "LOGGED"
}

if ($Set -or $Log) { exit 0 }

# ---- status ----
$b = Read-Baton
"NOW $stamp"
foreach ($k in $b.Keys) { if ($b[$k] -ne '') { "$k`: $($b[$k])" } }
if ($b['ledger'] -and (Test-Path (Join-Path $root $b['ledger']))) {
  $lf = Get-Item (Join-Path $root $b['ledger'])
  $age = [int]($now - $lf.LastWriteTime).TotalMinutes
  "HEARTBEAT_AGE_MIN $age (ledger last written $($lf.LastWriteTime.ToString('HH:mm')))"
  $last = Get-Content $lf.FullName -Tail 1 -Encoding UTF8
  if ($last.Length -gt 300) { $last = $last.Substring(0, 300) }
  "LEDGER_LAST $last"
} else { "HEARTBEAT_AGE_MIN none (no ledger named in the baton)" }
foreach ($p in 'codex','claude','agy') {
  $v = $b["${p}_limit_until"]
  if ($v) {
    try {
      $t = [datetime]::ParseExact($v.Substring(0, 16), 'yyyy-MM-dd HH:mm', $null)
      if ($t -le $now) { "LIMIT $p PASSED ($v): probe it, then clear the value" } else { "LIMIT $p ACTIVE until $v" }
    } catch { "LIMIT $p unreadable value '$v' (use yyyy-MM-dd HH:mm)" }
  } else { "LIMIT $p none" }
}
if (Test-Path $lock) {
  $age = [int]($now - (Get-Item $lock).LastWriteTime).TotalMinutes
  "LOCK held $age min: " + ((Get-Content $lock -Raw).Trim())
} else { "LOCK free" }
