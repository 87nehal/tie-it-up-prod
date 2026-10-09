// Thin wrapper over ONNX Runtime (onnxruntime_v2, dart:ffi) used by every engine.

import 'dart:io';
import 'dart:typed_data';

import 'package:onnxruntime_v2/onnxruntime_v2.dart';

import 'types.dart';

bool _envReady = false;

/// File that records the model call in progress; set by the inference isolate.
String? breadcrumbPath;

void ensureOrtEnv() {
  if (_envReady) return;
  OrtEnv.instance.init();
  _envReady = true;
}

/// A loaded model. Inputs and outputs are flat float32 buffers.
class Model {
  Model._(this.name, this._session, this.accelerator);

  /// [accelerator] is a preference: if the provider can't be added the session falls
  /// back to the plain CPU provider and [accelerator] reports what actually loaded.
  factory Model.load(String name, Uint8List bytes, {Accelerator accelerator = Accelerator.xnnpack, int threads = 4}) {
    ensureOrtEnv();
    final opts = OrtSessionOptions()
      ..setIntraOpNumThreads(threads)
      ..setSessionGraphOptimizationLevel(GraphOptimizationLevel.ortEnableAll);
    var used = Accelerator.cpu;
    try {
      if (accelerator == Accelerator.nnapi && opts.appendNnapiProvider(NnapiFlags.useNone)) {
        used = Accelerator.nnapi;
      } else if (accelerator == Accelerator.xnnpack && opts.appendXnnpackProvider()) {
        used = Accelerator.xnnpack;
      }
    } catch (_) {
      used = Accelerator.cpu;
    }
    final session = OrtSession.fromBuffer(bytes, opts);
    opts.release();
    return Model._(name, session, used);
  }

  final String name;
  final OrtSession _session;
  final Accelerator accelerator;

  List<String> get inputNames => _session.inputNames;
  List<String> get outputNames => _session.outputNames;

  /// Runs the model on one float32 input. Returns output name -> (data, shape).
  Map<String, (Float32List, List<int>)> run(String input, Float32List data, List<int> shape) {
    // A native crash kills the process before any Dart handler runs; this note survives
    // it and is shown on the next launch (see crashBreadcrumb in worker.dart).
    if (breadcrumbPath != null) {
      try {
        File(breadcrumbPath!).writeAsStringSync('$name model · input $shape · ${accelerator.name}', flush: true);
      } catch (_) {}
    }
    final tensor = OrtValueTensor.fromFloat32List(data, shape);
    final runOptions = OrtRunOptions();
    try {
      final outputs = _session.run(runOptions, {input: tensor});
      final result = <String, (Float32List, List<int>)>{};
      for (var i = 0; i < outputs.length; i++) {
        final o = outputs[i] as OrtValueTensor?;
        if (o == null) continue;
        result[_session.outputNames[i]] = (o.floatData, o.shape);
        o.release();
      }
      return result;
    } finally {
      tensor.release();
      runOptions.release();
    }
  }

  void release() => _session.release();
}
