# Starts the ForgeAi dashboard on http://127.0.0.1:3000 in the background and writes its logs to output/logs.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/start_dashboard.ps1 [-Port 3000]
param([int]$Port = 3000)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path -replace '\\', '/'
$logs = Join-Path $root 'output/logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) { Write-Output "Port $Port is already in use by process $($listening[0].OwningProcess); nothing started."; exit 1 }
# The settings every video run since 2026-11-19 uses (author session, HyperFrames text, ACE-Step music). Set here so that any start, also
# start.cmd, gives the same pipeline; a value already set in the environment wins. claude-pro | claude-fable-5-2 | 2026-11-20
$defaults = @{
  FORGEAI_AUTHOR_SESSION = '1'; FORGE_HYPERFRAMES_TEXT = '1'; FORGEAI_ACESTEP_MUSIC = '1'
  FORGE_HYPERFRAMES_CLI = 'C:/Users/Lava/AppData/Local/npm-cache/_npx/702923228c2ce1e6/node_modules/hyperframes/bin/hyperframes.mjs'
  FORGE_HYPERFRAMES_BROWSER = 'C:/Users/Lava/.cache/hyperframes/chrome/chrome-headless-shell/win64-158.0.8127.36/chrome-headless-shell-win64/chrome-headless-shell.exe'
}
foreach ($name in $defaults.Keys) { if (-not (Test-Path "Env:$name")) { Set-Item "Env:$name" $defaults[$name] } }
$ffmpeg = 'C:/Users/Lava/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin'
if ((Test-Path $ffmpeg) -and ($env:PATH -notlike "*$ffmpeg*")) { $env:PATH = "$ffmpeg;" + $env:PATH }
foreach ($name in 'FORGE_HYPERFRAMES_CLI', 'FORGE_HYPERFRAMES_BROWSER') { if (-not (Test-Path (Get-Item "Env:$name").Value)) { Write-Output "Warning: $name points at a missing file; the text layer will fall back to the old one." } }
$proc = Start-Process -FilePath node -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -ArgumentList "--env-file-if-exists=$root/.env", 'scripts/supervisor/start_codebuilt_dashboard.mjs', '--root', $root, '--port', $Port `
  -RedirectStandardOutput (Join-Path $logs 'dashboard.out.log') -RedirectStandardError (Join-Path $logs 'dashboard.err.log')
Write-Output "Dashboard starting as process $($proc.Id) on http://127.0.0.1:$Port (logs in output/logs)"
