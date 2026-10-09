// Parity of the Dart damage engine with the Python device recipe.
// Reference numbers: `cd backend && python ../mobile/tools/damage_reference.py`
// Run: powershell -NoProfile -ExecutionPolicy Bypass -File tool/test.ps1 test/damage_test.dart
// ignore_for_file: avoid_print

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as im;
import 'package:msil_inspect/engine/damage.dart';
import 'package:msil_inspect/engine/ort.dart';
import 'package:msil_inspect/engine/types.dart';

RgbImage _decode(String path) {
  final d = im.decodeJpg(File(path).readAsBytesSync())!;
  final rgb = Uint8List(d.width * d.height * 3);
  var o = 0;
  for (final p in d) {
    rgb[o++] = p.r.toInt();
    rgb[o++] = p.g.toInt();
    rgb[o++] = p.b.toInt();
  }
  return RgbImage(d.width, d.height, rgb);
}

void main() {
  test('PIL-compatible bilinear resize', () {
    final meta = jsonDecode(File('test/resize_ref/meta.json').readAsStringSync());
    final src = RgbImage(meta['src'][0], meta['src'][1], File('test/resize_ref/src.rgb').readAsBytesSync());
    final ref = File('test/resize_ref/dst.rgb').readAsBytesSync();
    final out = resizeBilinearPil(src, meta['dst'][0], meta['dst'][1]);
    var sum = 0, mx = 0;
    for (var i = 0; i < ref.length; i++) {
      final d = (ref[i] - out.rgb[i]).abs();
      sum += d;
      if (d > mx) mx = d;
    }
    print('resize parity: mean abs diff ${(sum / ref.length).toStringAsFixed(4)}, max $mx');
    expect(sum / ref.length, lessThan(1.0));
  });

  test('damage engine matches Python device recipe', () {
    final ref = jsonDecode(File('test/damage_reference.json').readAsStringSync()) as Map<String, dynamic>;
    final model = Model.load('damage', File('assets/models/damage_int8.onnx').readAsBytesSync(),
        accelerator: Accelerator.cpu);
    final profile = jsonDecode(File('assets/models/damage_profile.json').readAsStringSync());
    final engine = DamageEngine(model, profile);
    final failures = <String>[];
    final warnings = <String>[];
    for (final entry in ref.entries) {
      final img = _decode('../${entry.key}');
      expect([img.width, img.height], entry.value['size'], reason: 'decoded size ${entry.key}');
      for (final mode in DamageMode.values) {
        final py = entry.value[mode.name] as Map<String, dynamic>;
        final r = engine.analyse(img, mode);
        final pct = r.damageFraction * 100;
        final types = {for (final e in r.typeFractions.entries) e.key: e.value * 100};
        final top = types.isEmpty ? '-' : (types.entries.toList()..sort((a, b) => b.value.compareTo(a.value))).first.key;
        final pyTypes = (py['types'] as Map).cast<String, num>();
        final pyTop = pyTypes.isEmpty ? '-' : (pyTypes.entries.toList()..sort((a, b) => b.value.compareTo(a.value))).first.key;
        print('${entry.key.split('/').last} ${mode.name}: '
            'py ${py['decision']} ${py['damage_pct']}% $pyTop | '
            'dart ${r.decision} ${pct.toStringAsFixed(2)}% $top | regions ${regions(r).length} '
            'reasons ${r.reasons} passes ${r.passes} ${r.timings}');
        overlayRgba(r);
        if (r.decision != py['decision']) failures.add('${entry.key} ${mode.name} decision');
        // model-only decision (before the capture-quality gate), which quality would otherwise mask
        final recipe = r.nearThresholdFraction > (profile['max_uncertain_fraction'] as num)
            ? 'manual_review_required'
            : (r.damageFraction > 0 ? 'damage_detected' : 'no_damage_detected');
        print('    recipe decision py ${py['recipe_decision']} dart $recipe, near py ${py['near_threshold']} '
            'dart ${r.nearThresholdFraction.toStringAsFixed(3)}');
        // The bundled onnxruntime.dll is 1.22 while the Python reference runs ORT 1.30; the
        // int8 dynamic-quant kernels differ (identical input tile: mean |presence logit diff|
        // ~0.09, max ~0.5), so the target is ±0.5 pp but the hard gate is wider. Anything
        // beyond the target is printed as a warning.
        if (recipe != py['recipe_decision']) warnings.add('${entry.key} ${mode.name} recipe decision');
        final dp = (pct - (py['damage_pct'] as num)).abs();
        if (dp > 0.5) warnings.add('${entry.key} ${mode.name} pct off by ${dp.toStringAsFixed(2)}');
        if (dp > 3.0) failures.add('${entry.key} ${mode.name} pct');
        for (final c in {...types.keys, ...pyTypes.keys}) {
          final dc = ((types[c] ?? 0) - (pyTypes[c] ?? 0)).abs();
          if (dc > 0.5) warnings.add('${entry.key} ${mode.name} $c off by ${dc.toStringAsFixed(2)}');
          if (dc > 3.0) failures.add('${entry.key} ${mode.name} $c');
        }
      }
    }
    model.release();
    print('WARNINGS (beyond ±0.5 pp / recipe-decision mismatch):\n  ${warnings.join('\n  ')}');
    expect(failures, isEmpty);
  }, timeout: const Timeout(Duration(minutes: 30)));
}
