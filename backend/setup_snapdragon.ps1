$ErrorActionPreference = "Stop"

# One-time setup for CUDA-free inference on Windows on Snapdragon (ARM64).
# Creates backend\.venv with native ARM64 Python, PyTorch (CPU build, used only
# for loading/exporting the checkpoint), and ONNX Runtime with the Qualcomm QNN
# execution provider (Adreno GPU + Hexagon NPU), then exports the ONNX model.

$backendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $backendRoot

$pythonVersion = "3.12-arm64"
if ($env:PROCESSOR_ARCHITECTURE -ne "ARM64") { $pythonVersion = "3.12" }
& py "-$pythonVersion" -c "import sys" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Python $pythonVersion is required (install it from python.org; the py launcher must list it in 'py -0')."
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    & py "-$pythonVersion" -m venv .venv
}
$python = Join-Path $backendRoot ".venv\Scripts\python.exe"
& $python -m pip install --upgrade pip
& $python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
& $python -m pip install -e ".[serve,onnx]"
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
    & $python -m pip install -e ".[snapdragon]"
}

$env:PYTHONPATH = Join-Path $backendRoot "src"
& $python -c "from vehicle_damage.api import selected_artifacts; from vehicle_damage.calibration import Calibration; from vehicle_damage.onnx_backend import load_onnx_model, available_devices; a = selected_artifacts(); c = Calibration.load(a['development_profile']); print('devices:', available_devices()); m = load_onnx_model(a['checkpoint'], tile_size=c.tile_size, device='auto'); print('selected:', m.description)"
if ($LASTEXITCODE -ne 0) { throw "ONNX export or device check failed" }
Write-Host "Setup complete. Start the API with .\run_backend.ps1"
