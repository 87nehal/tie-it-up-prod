// Shared types for the on-device engines. Everything here is plain Dart data so it can
// cross an isolate boundary (the engines run in a background isolate, see worker.dart).

import 'dart:typed_data';

/// An upright RGB image, 3 bytes per pixel, row-major.
class RgbImage {
  RgbImage(this.width, this.height, this.rgb) : assert(rgb.length == width * height * 3);
  final int width;
  final int height;
  final Uint8List rgb;
}

/// One OCR text line. Coordinates are pixels in the image passed to OCR.
/// Mirrors the dicts produced by backend/app/fleet/ocr.py `ocr()`.
class OcrLine {
  OcrLine({
    required this.text,
    required this.confidence,
    required this.x,
    required this.x1,
    required this.y0,
    required this.h,
  });
  final String text;
  final double confidence;
  final double x; // left
  final double x1; // right
  final double y0; // top
  final double h; // height
  double get cy => y0 + h / 2;
  double get w => x1 - x;

  Map<String, Object> toJson() =>
      {'text': text, 'confidence': confidence, 'x': x, 'x1': x1, 'y0': y0, 'h': h};
}

/// A field read from a gate photo (plate / VIN / odometer).
class FieldRead {
  FieldRead({required this.value, required this.confidence, required this.source, this.notes = const []});
  final String value;
  final double confidence; // 0..1
  final String source; // the OCR text it came from
  final List<String> notes; // validation results, e.g. "VIN check digit valid"
}

enum CaptureKind { plate, vin, odometer }

class GateResult {
  GateResult({
    required this.kind,
    required this.lines,
    required this.field,
    required this.checks,
    required this.timings,
  });
  final CaptureKind kind;
  final List<OcrLine> lines;
  final FieldRead? field;
  /// (level, message) where level is 'ok' | 'warning' | 'error'.
  final List<(String, String)> checks;
  /// stage -> milliseconds, e.g. {'detect': 120, 'recognise': 210, 'reader': 40, 'ranker': 2}
  final Map<String, int> timings;
}

enum DamageMode { quick, thorough }

/// Damage classes in model order; index 0 is background.
const damageClasses = [
  'background',
  'dent',
  'scratch',
  'crack_or_breakage',
  'paint_damage',
  'deformation_or_detachment',
];

class DamageResult {
  DamageResult({
    required this.decision,
    required this.reasons,
    required this.width,
    required this.height,
    required this.mask,
    required this.typeFractions,
    required this.damageFraction,
    required this.nearThresholdFraction,
    required this.quality,
    required this.passes,
    required this.timings,
  });

  /// 'damage_detected' | 'no_damage_detected' | 'manual_review_required' | 'recapture_required'
  final String decision;
  final List<String> reasons;
  /// Size of the analysed (downscaled) image the mask belongs to.
  final int width;
  final int height;
  /// Per-pixel class index (0 = no damage), width*height.
  final Uint8List mask;
  /// class name -> fraction of image pixels
  final Map<String, double> typeFractions;
  final double damageFraction;
  final double nearThresholdFraction;
  final Map<String, double> quality; // dark, clipped, specular, sharpness
  final int passes; // model forward passes run
  final Map<String, int> timings; // 'preprocess', 'model', 'postprocess' (ms)
}

/// Hardware the sessions run on.
enum Accelerator { cpu, xnnpack, nnapi }
