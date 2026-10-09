# Run the engine tests on this PC: puts the plugin's onnxruntime.dll on PATH so the
# Dart VM can load ONNX Runtime through dart:ffi, then runs flutter test.
#   powershell -File tool/test.ps1 [test/some_test.dart]
$here = Split-Path -Parent $PSScriptRoot
$env:Path = "$here\packages\onnxruntime_v2\windows;$env:Path"
Set-Location $here
flutter test @args
