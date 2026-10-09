// Gate OCR on the bundled samples vs the server's output (assets/samples/golden.json).
// Run with the plugin's onnxruntime.dll on PATH: powershell -File tool/test.ps1 test/gate_test.dart

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as im;
import 'package:msil_inspect/engine/gate.dart';
import 'package:msil_inspect/engine/ort.dart';
import 'package:msil_inspect/engine/types.dart';

RgbImage load(String path) {
  final img = im.decodeImage(File(path).readAsBytesSync())!;
  final out = Uint8List(img.width * img.height * 3);
  var i = 0;
  for (final p in img) {
    out[i++] = p.r.toInt();
    out[i++] = p.g.toInt();
    out[i++] = p.b.toInt();
  }
  return RgbImage(img.width, img.height, out);
}

void main() {
  late GateEngine engine;
  final golden = jsonDecode(File('assets/samples/golden.json').readAsStringSync()) as Map<String, dynamic>;

  setUpAll(() {
    Model m(String f) => Model.load(f, File('assets/models/$f').readAsBytesSync(), accelerator: Accelerator.cpu);
    engine = GateEngine(
      det: m('ocr_det.onnx'),
      rec: m('ocr_rec.onnx'),
      charset: const LineSplitter().convert(File('assets/models/ocr_charset.txt').readAsStringSync()),
      reader: m('cluster_reader.onnx'),
      ranker: jsonDecode(File('assets/models/odometer_ranker.json').readAsStringSync()) as Map<String, dynamic>,
    );
  });

  final cases = <(String, CaptureKind, String)>[
    ('gate_plate.jpg', CaptureKind.plate, 'HR51NY9785'),
    ('gate_vin.jpg', CaptureKind.vin, 'MA3GVESR3TM772642'),
    ('gate_odometer.jpg', CaptureKind.odometer, '29882'),
    ('odometer_maruti_cluster.png', CaptureKind.odometer, '15010'),
    ('odometer_lcd.png', CaptureKind.odometer, '91308'),
  ];

  for (final (name, kind, want) in cases) {
    test('$name -> $want', () {
      final img = load('assets/samples/$name');
      final r = engine.read(img, kind);
      final g = golden[name] as Map<String, dynamic>;
      final gl = [for (final l in g['lines'] as List) (l['text'] as String, (l['confidence'] as num).toDouble())];
      // ignore_for_file: avoid_print
      print('== $name (${kind.name}) got ${r.field?.value} conf ${r.field?.confidence} want $want');
      print('   timings ${r.timings}');
      for (final c in r.checks) {
        print('   ${c.$1}: ${c.$2}');
      }
      final got = [for (final l in r.lines) (l.text, l.confidence)];
      for (var i = 0; i < got.length || i < gl.length; i++) {
        final a = i < got.length ? got[i] : null, b = i < gl.length ? gl[i] : null;
        final same = a != null && b != null && a.$1 == b.$1;
        print('   ${same ? '  ' : '!='} dart=${a?.$1}|${a?.$2}  server=${b?.$1}|${b?.$2}');
      }
      expect(r.field?.value, want);
    });
  }
}
