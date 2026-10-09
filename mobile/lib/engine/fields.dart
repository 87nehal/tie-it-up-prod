// VIN and Indian registration plate extraction, ported from
// backend/app/fleet/extract.py (find_vin, vin_check_digit_ok, find_plate,
// _coerce_plate, _best_plate, format_plate, normalize_plate).

import 'dart:math' as math;

import 'types.dart';

// ---------------------------------------------------------------- VIN (ISO 3779)

final vinChars = RegExp(r'^[A-HJ-NPR-Z0-9]{17}$');
final vinLabel = RegExp(r'\b(VIN|V\.I\.N\.?|CHASSIS(\s*NO\.?)?)\b\s*[:#.-]?');
const _vinFix = {'O': '0', 'Q': '0', 'I': '1'};

final Map<String, int> _vinValues = {
  for (var d = 0; d < 10; d++) '$d': d,
  for (var i = 0; i < 8; i++) 'ABCDEFGH'[i]: i + 1,
  for (var i = 0; i < 5; i++) 'JKLMN'[i]: i + 1,
  'P': 7,
  'R': 9,
  for (var i = 0; i < 8; i++) 'STUVWXYZ'[i]: i + 2,
};
const _vinWeights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

String translate(String s, Map<String, String> table) {
  final sb = StringBuffer();
  for (final r in s.runes) {
    final ch = String.fromCharCode(r);
    sb.write(table[ch] ?? ch);
  }
  return sb.toString();
}

bool vinCheckDigitOk(String vin) {
  var total = 0;
  for (var i = 0; i < math.min(vin.length, 17); i++) {
    final v = _vinValues[vin[i]];
    if (v == null) return false;
    total += v * _vinWeights[i];
  }
  final expected = total % 11 == 10 ? 'X' : '${total % 11}';
  return vin.length > 8 && vin[8] == expected;
}

class VinRead {
  VinRead(this.value, this.confidence, this.score, this.readLength, this.source);
  final String value;
  final double confidence;
  final double score;
  final int readLength; // 17 unless a longer run had to be trimmed
  final String source;
  bool get checkDigitOk => vinCheckDigitOk(value);
}

/// extract.py find_vin: runs of 1-3 adjacent lines, every 17-character window.
VinRead? findVin(List<OcrLine> lines) {
  VinRead? best;
  for (var start = 0; start < lines.length; start++) {
    for (final n in const [1, 2, 3]) {
      if (start + n > lines.length) break;
      final chunk = lines.sublist(start, start + n);
      final conf = chunk.map((l) => l.confidence).reduce(math.min);
      final text = chunk.map((l) => l.text).join(' ').toUpperCase();
      final labelled = vinLabel.hasMatch(text);
      final cleaned = text.replaceAll(vinLabel, ' ');
      final compact = translate(cleaned.replaceAll(RegExp(r'[^A-Z0-9]'), ''), _vinFix);
      for (final m in RegExp(r'[A-HJ-NPR-Z0-9]{17,}').allMatches(compact)) {
        final run = m.group(0)!;
        for (var offset = 0; offset < run.length - 16; offset++) {
          final vin = run.substring(offset, offset + 17);
          final checkOk = vinCheckDigitOk(vin);
          // Across lines, only trust a read the sticker label or the check digit backs up.
          if (n > 1 && !labelled && !checkOk) continue;
          var score = conf + (checkOk ? 0.2 : 0);
          score -= run.length > 17 ? 0.1 : 0;
          score -= 0.3 * (n - 1);
          if (best == null || score > best.score) {
            best = VinRead(vin, conf, score, run.length, chunk.map((l) => l.text).join(' '));
          }
        }
      }
    }
  }
  return best;
}

// ------------------------------------------------------- Registration (India)

final plateRe = RegExp(r'^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$');
final plateBhRe = RegExp(r'^(\d{2})(BH)(\d{4})([A-Z]{1,2})$');
const _toDigit = {'O': '0', 'D': '0', 'Q': '0', 'I': '1', 'L': '1', 'Z': '2', 'S': '5', 'B': '8', 'G': '6'};
const _toAlpha = {'0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '6': 'G'};

/// RTO state / UT codes.
const stateCodes = {
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'DN', 'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', //
  'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD', 'OR', 'PB', 'PY', 'RJ', 'SK', 'TG', 'TN',
  'TR', 'TS', 'UK', 'UP', 'WB',
};

const _plateMin = 7;
const _plateMax = 11;

String normalizePlate(String raw) => raw.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');

/// _coerce_plate: repair one compact token into a legal plate; (plate, repairs).
(String, int)? coercePlate(String s) {
  if (plateBhRe.hasMatch(s)) return (s, 0);
  final head = translate(s.substring(0, 2), _toAlpha);
  final tail = translate(s.substring(s.length - 4), _toDigit);
  final mid = s.substring(2, s.length - 4);
  (String, int)? best;
  for (final rtoLen in const [2, 1]) {
    final cut = math.min(rtoLen, mid.length);
    final rto = translate(mid.substring(0, cut), _toDigit);
    final series = translate(mid.substring(cut), _toAlpha);
    final cand = head + rto + series + tail;
    if (!plateRe.hasMatch(cand)) continue;
    var repairs = 0;
    for (var i = 0; i < math.min(cand.length, s.length); i++) {
      if (cand[i] != s[i]) repairs++;
    }
    if (best == null || repairs < best.$2) best = (cand, repairs);
  }
  return best;
}

/// _best_plate: best-scoring plate window inside [raw].
(String, double)? bestPlate(String raw) {
  var s = normalizePlate(raw);
  if (s.startsWith('IND')) s = s.substring(3);
  (String, double)? best;
  for (var length = math.min(_plateMax, s.length); length >= _plateMin; length--) {
    for (var start = 0; start + length <= s.length; start++) {
      final found = coercePlate(s.substring(start, start + length));
      if (found == null) continue;
      final (plate, repairs) = found;
      final stateOk = stateCodes.contains(plate.substring(0, 2)) || plate.substring(2, 4) == 'BH';
      if (!stateOk && (length != s.length || repairs > 0)) continue;
      final score = (stateOk ? 1.0 : 0.0) - 0.3 * repairs + 0.02 * length;
      if (best == null || score > best.$2) best = (plate, score);
    }
  }
  return best;
}

String formatPlate(String plate) {
  final m = plateRe.firstMatch(plate);
  if (m != null) {
    return [for (var i = 1; i <= 4; i++) m.group(i)!].where((g) => g.isNotEmpty).join(' ');
  }
  final b = plateBhRe.firstMatch(plate);
  if (b != null) return [for (var i = 1; i <= 4; i++) b.group(i)!].join(' ');
  return plate;
}

class PlateRead {
  PlateRead(this.value, this.confidence, this.score, this.source);
  final String value;
  final double confidence;
  final double score;
  final String source;
  String get display => formatPlate(value);
}

/// extract.py find_plate: runs of 1-3 lines, skipping text already read as the VIN.
PlateRead? findPlate(List<OcrLine> lines, {String? vin}) {
  PlateRead? best;
  for (var i = 0; i < lines.length; i++) {
    for (final n in const [1, 2, 3]) {
      if (i + n > lines.length) break;
      final chunk = lines.sublist(i, i + n);
      final text = chunk.map((l) => l.text).join();
      if (vin != null && vin.isNotEmpty && translate(normalizePlate(text), _vinFix).contains(vin)) continue;
      final found = bestPlate(text);
      if (found == null) continue;
      final conf = chunk.map((l) => l.confidence).reduce(math.min);
      final score = found.$2 + conf;
      if (best == null || score > best.score) best = PlateRead(found.$1, conf, score, text);
    }
  }
  return best;
}

/// extract.py's VIN-fix translation, used by the odometer rules to skip VIN lines.
String vinFix(String s) => translate(s, _vinFix);
