// Host-side check that the vendored ONNX Runtime wrapper loads and runs the bundled
// models. Run with the plugin's onnxruntime.dll on PATH (see tool/test.ps1).

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:msil_inspect/engine/ort.dart';
import 'package:msil_inspect/engine/types.dart';

void main() {
  test('every bundled model loads and runs', () {
    final det = Model.load('det', File('assets/models/ocr_det.onnx').readAsBytesSync(), accelerator: Accelerator.cpu);
    final out = det.run(det.inputNames.first, Float32List(3 * 64 * 96), [1, 3, 64, 96]);
    expect(out.values.first.$2, [1, 1, 64, 96]);

    final damage = Model.load('damage', File('assets/models/damage_int8.onnx').readAsBytesSync(),
        accelerator: Accelerator.cpu);
    final sw = Stopwatch()..start();
    final d = damage.run('image', Float32List(3 * 768 * 768), [1, 3, 768, 768]);
    // ignore: avoid_print
    print('damage pass ${sw.elapsedMilliseconds} ms, outputs ${d.map((k, v) => MapEntry(k, v.$2))}');
    expect(d.keys.toSet(), {'presence', 'type', 'exterior'});
  });
}
