# Launch scissor-fea-app on http://localhost:3000
# Uses the portable Node + Python + CalculiX under ..\tools
$ErrorActionPreference = "Stop"
$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Join-Path (Split-Path -Parent $root) "tools"
$node  = Join-Path $tools "node-v24.18.0-win-x64"

$env:Path   = "$node;" + $env:Path
$env:PYTHON = Join-Path $tools "python\python.exe"
$env:CCX    = Join-Path $tools "calculix\ccx.exe"
$env:OMP_NUM_THREADS = "4"
if (-not $env:PORT) { $env:PORT = "3000" }

Write-Host "Starting scissor-fea-app on http://localhost:$($env:PORT)" -ForegroundColor Green
Write-Host "  PYTHON = $env:PYTHON"
Write-Host "  CCX    = $env:CCX"
Set-Location $root
& "$node\node.exe" server.js
