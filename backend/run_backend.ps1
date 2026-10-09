$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $backendRoot

# Prefer a local venv (e.g. created by setup_snapdragon.ps1) over the system Python.
$python = Join-Path $backendRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = "python" }

$port = if ($env:CAR_HEALTH_API_PORT) { $env:CAR_HEALTH_API_PORT } else { "8000" }
$device = if ($env:VEHICLE_DAMAGE_DEVICE) { $env:VEHICLE_DAMAGE_DEVICE } else { "auto" }

Write-Host "Starting Car Health Platform API on http://127.0.0.1:$port ..."
Write-Host "Damage device: $device (set VEHICLE_DAMAGE_DEVICE=gpu|npu|cpu|cuda to override)"
& $python -m app.main
