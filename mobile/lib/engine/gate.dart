// Gate capture reader: OCR plus the one extractor for the capture kind. Pure Dart, so
// it can run in a background isolate. Mirrors backend extract_fields() + the checks
// in validate.py that make sense without the trip log.

import 'fields.dart';
import 'ocr.dart';
import 'odometer.dart';
import 'ort.dart';
import 'types.dart';

/// validate.py LOW_CONFIDENCE
const lowConfidence = 0.6;

class GateEngine {
  GateEngine({
    required Model det,
    required Model rec,
    required List<String> charset,
    required Model reader,
    required Map<String, dynamic> ranker,
  }) : ocr = Ocr(det, rec, charset) {
    odometer = OdometerEngine(ocr: ocr, reader: ClusterReader(reader), ranker: Ranker(ranker));
  }

  final Ocr ocr;
  late final OdometerEngine odometer;

  GateResult read(RgbImage input, CaptureKind kind) {
    final timings = <String, int>{};
    final sw = Stopwatch()..start();
    final img = capImage(input); // ocr.py decode(): every stage works on the capped image
    timings['resize'] = sw.elapsedMilliseconds;
    final lines = ocr.read(img, timings: timings);

    sw
      ..reset()
      ..start();
    final checks = <(String, String)>[];
    FieldRead? field;
    if (lines.isEmpty) checks.add(('error', 'No text found in the photo - retake it closer and in focus'));

    // extract_fields order: the VIN first, then the plate (which must not reuse the VIN
    // text); both are excluded from odometer candidates.
    final vin = findVin(lines);
    switch (kind) {
      case CaptureKind.vin:
        if (vin == null) {
          if (lines.isNotEmpty) checks.add(('error', 'No VIN found'));
        } else {
          final notes = <String>[];
          if (vin.checkDigitOk) {
            notes.add('VIN check digit valid');
            checks.add(('ok', 'VIN check digit valid'));
          } else {
            notes.add("VIN check digit doesn't verify");
            checks.add(('warning', "VIN check digit doesn't verify - confirm it by eye"));
          }
          if (vin.readLength > 17) {
            checks.add(('warning', 'Read ${vin.readLength} characters; trimmed to 17 - confirm by eye'));
          }
          if (vin.source.toUpperCase().contains(vinLabel)) checks.add(('ok', 'VIN label found on sticker'));
          field = FieldRead(value: vin.value, confidence: vin.confidence, source: vin.source, notes: notes);
        }
      case CaptureKind.plate:
        final plate = findPlate(lines, vin: vin?.value);
        if (plate == null) {
          if (lines.isNotEmpty) checks.add(('error', 'No registration number found'));
        } else {
          final notes = <String>[];
          if (plateRe.hasMatch(plate.value) || plateBhRe.hasMatch(plate.value)) {
            notes.add('Indian plate format');
            checks.add(('ok', 'Indian plate format: ${plate.display}'));
          } else {
            checks.add(('warning', "${plate.value} doesn't match the Indian registration format"));
          }
          final state = plate.value.substring(0, 2);
          if (stateCodes.contains(state)) {
            checks.add(('ok', 'State code $state recognised'));
          } else if (plate.value.substring(2, 4) == 'BH') {
            checks.add(('ok', 'Bharat (BH) series'));
          } else {
            checks.add(('warning', 'Unknown state code $state'));
          }
          if (normalizePlate(plate.source) != plate.value) {
            checks.add(('warning', 'Read as "${plate.source}" and corrected to ${plate.value} - confirm by eye'));
          }
          field = FieldRead(value: plate.value, confidence: plate.confidence, source: plate.source, notes: notes);
        }
      case CaptureKind.odometer:
        final plate = findPlate(lines, vin: vin?.value);
        final exclude = {if (vin != null) vin.value, if (plate != null) plate.value};
        timings['fields'] = sw.elapsedMilliseconds;
        final odo = odometer.read(lines, img, exclude: exclude, timings: timings);
        sw
          ..reset()
          ..start();
        if (odo == null) {
          if (lines.isNotEmpty) checks.add(('error', 'No odometer reading found'));
        } else {
          final notes = <String>['engine: ${odo.engine}'];
          checks.add(('ok', 'Odometer ${odo.value} km (ranker score ${odo.score.toStringAsFixed(2)})'));
          if (odo.votes != null) {
            notes.add('re-read agreement ${(odo.votes! * 100).round()}%');
            checks.add((odo.votes! >= 0.5 ? 'ok' : 'warning', 'Re-reads agreed ${(odo.votes! * 100).round()}% on ${odo.value}'));
          }
          if (odo.score < 0.5) checks.add(('warning', 'Unsure which number is the odometer - confirm by eye'));
          field = FieldRead(value: '${odo.value}', confidence: odo.confidence, source: odo.source, notes: notes);
        }
    }
    if (field != null && field.confidence < lowConfidence) {
      checks.add(('warning', 'Low OCR confidence ${field.confidence.toStringAsFixed(2)} - verify manually'));
    }
    timings['fields'] = (timings['fields'] ?? 0) + sw.elapsedMilliseconds;
    return GateResult(kind: kind, lines: lines, field: field, checks: checks, timings: timings);
  }
}
