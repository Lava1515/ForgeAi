# Starts the ForgeShorts dashboard on http://127.0.0.1:3000 in the background and writes its logs to output/logs.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/start_dashboard.ps1 [-Port 3000]
param([int]$Port = 3000)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path -replace '\\', '/'
$logs = Join-Path $root 'output/logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) { Write-Output "Port $Port is already in use by process $($listening[0].OwningProcess); nothing started."; exit 1 }
$proc = Start-Process -FilePath node -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -ArgumentList "--env-file-if-exists=$root/.env", 'scripts/supervisor/start_codebuilt_dashboard.mjs', '--root', $root, '--port', $Port `
  -RedirectStandardOutput (Join-Path $logs 'dashboard.out.log') -RedirectStandardError (Join-Path $logs 'dashboard.err.log')
Write-Output "Dashboard starting as process $($proc.Id) on http://127.0.0.1:$Port (logs in output/logs)"
