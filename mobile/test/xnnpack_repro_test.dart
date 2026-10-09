// Reproduces the gate-scan crash: OCR models (dynamic input shapes) on XNNPACK.

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:msil_inspect/engine/ort.dart';
import 'package:msil_inspect/engine/types.dart';

void main() {
  test('OCR models with XNNPACK across varying shapes', () {
    final det = Model.load('det', File('assets/models/ocr_det.onnx').readAsBytesSync(), accelerator: Accelerator.xnnpack);
    final rec = Model.load('rec', File('assets/models/ocr_rec.onnx').readAsBytesSync(), accelerator: Accelerator.xnnpack);
    // ignore: avoid_print
    print('det on ${det.accelerator}, rec on ${rec.accelerator}');
    for (final (h, w) in [(736, 544), (480, 736), (320, 640)]) {
      det.run(det.inputNames.first, Float32List(3 * h * w), [1, 3, h, w]);
    }
    for (final (n, w) in [(1, 320), (4, 512), (2, 900)]) {
      rec.run(rec.inputNames.first, Float32List(n * 3 * 48 * w), [n, 3, 48, w]);
    }
  });
}
