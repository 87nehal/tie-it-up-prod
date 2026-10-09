// Odometer reading, ported from backend/app/fleet/odometer.py (learned ranker over
// candidate numbers, with the cluster reader re-read and the vote), the cluster reader
// itself (cluster_reader.py) and the rule fallback (extract.py find_odometer).

import 'dart:math' as math;
import 'dart:typed_data';

import 'fields.dart';
import 'image_ops.dart';
import 'ocr.dart';
import 'ort.dart';
import 'types.dart';

// ------------------------------------------------------------------ cluster reader

/// cluster_reader.py: CRNN re-reader for seven-segment / LCD / TFT text.
class ClusterReader {
  ClusterReader(this.model);
  final Model model;

  static const charset = ' 0123456789.,:/-°ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  static const height = 32, width = 256;

  /// cluster_reader.crop: the line box with a 0.12*h margin, as grayscale.
  static GrayImage crop(RgbImage rgb, OcrLine line) {
    final h = line.h;
    final pad = 0.12 * h;
    final bx0 = math.max(0.0, line.x - pad).truncate();
    final by0 = math.max(0.0, line.y0 - pad).truncate();
    final bx1 = math.min(rgb.width.toDouble(), line.x1 + pad).truncate();
    final by1 = math.min(rgb.height.toDouble(), line.y0 + h + pad).truncate();
    if (bx1 - bx0 < 2 || by1 - by0 < 2) return GrayImage(8, 8, Uint8List(64));
    return toGray(cropRgb(rgb, bx0, by0, bx1, by1));
  }

  /// cluster_reader.preprocess: 32 high, aspect kept, right-padded with the median of
  /// the first and last columns, normalised to [-1, 1]. Writes into [dst] at [off].
  static void preprocess(GrayImage g, Float32List dst, int off) {
    final newW = math.max(1, math.min(width, roundHalfEven(g.width * height / math.max(g.height, 1))));
    final r = resizePilGray(g, newW, height, PilFilter.bilinear);
    final edge = <double>[
      for (var y = 0; y < height; y++) r.data[y * newW] / 255.0,
      for (var y = 0; y < height; y++) r.data[y * newW + newW - 1] / 255.0,
    ]..sort();
    final med = (edge[height - 1] + edge[height]) / 2;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        final v = x < newW ? r.data[y * newW + x] / 255.0 : med;
        dst[off + y * width + x] = (v - 0.5) / 0.5;
      }
    }
  }

  /// Re-read each grayscale crop; greedy CTC (softmax, min char prob as confidence).
  List<(String, double)> readGray(List<GrayImage> crops) {
    if (crops.isEmpty) return [];
    const plane = height * width;
    final batch = Float32List(crops.length * plane);
    for (var i = 0; i < crops.length; i++) {
      preprocess(crops[i], batch, i * plane);
    }
    final out = model.run('image', batch, [crops.length, 1, height, width]).values.first;
    final logits = out.$1, t = out.$2[1], classes = out.$2[2];
    final res = <(String, double)>[];
    for (var b = 0; b < crops.length; b++) {
      final sb = StringBuffer();
      final confs = <double>[];
      var prev = 0;
      for (var s = 0; s < t; s++) {
        final base = (b * t + s) * classes;
        var best = 0;
        var mx = logits[base];
        for (var c = 1; c < classes; c++) {
          if (logits[base + c] > mx) {
            mx = logits[base + c];
            best = c;
          }
        }
        if (best != 0 && best != prev) {
          var sum = 0.0;
          for (var c = 0; c < classes; c++) {
            sum += math.exp(logits[base + c] - mx);
          }
          sb.write(best - 1 < charset.length ? charset[best - 1] : '');
          confs.add(1 / sum);
        }
        prev = best;
      }
      res.add((sb.toString().trim(), confs.isEmpty ? 0.0 : confs.reduce(math.min)));
    }
    return res;
  }

  /// cluster_reader.read_lines
  List<(String, double)> readLines(RgbImage rgb, List<OcrLine> lines) =>
      readGray([for (final l in lines) crop(rgb, l)]);
}

// ------------------------------------------------------------------ candidates

final numRe = RegExp(r'(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+|\d+)(?![\d]|[.,]\d)');
const _numFix = {'O': '0', 'o': '0', 'D': '0', 'l': '1', 'I': '1', 'S': '5', 'B': '8'};

final _km = RegExp(r'\bkm\b|\bkms\b|km$|^km', caseSensitive: false);
final _odo = RegExp(r'\b(odo|total|0d0|od0|0do)\b|^odo|odo$', caseSensitive: false);
final _trip = RegExp(r'\b(trip|tr1p|[ab])\b|^trip|trip$', caseSensitive: false);
final _range = RegExp(r'\b(dte|range|rng)\b', caseSensitive: false);
final _rate = RegExp(r'km\s*/\s*[lh]|kmpl|l\s*/\s*100|/h\b|kmh|km/', caseSensitive: false);
final _rpm = RegExp(r'rpm|r/min|x\s*1000|1000r', caseSensitive: false);
final _temp = RegExp(r'°|\bc\b|℃|\d\s*c$', caseSensitive: false);
final _clock = RegExp(r'\d\s*:\s*\d|\b(am|pm)\b', caseSensitive: false);
final _letter = RegExp(r'\p{L}', unicode: true);

const features = [
  'n_digits', 'log_value', 'has_sep', 'merged', 'leading_zero', 'dial_like', 'img_dial_like', //
  'img_cands', 'in_scale', 'same_value', 'rel_h', 'h_vs_median', 'h_rank',
  'w_vs_h', 'cx', 'cy', 'dist_center', 'tok_frac', 'line_numbers', 'line_alpha',
  'line_km', 'line_odo', 'line_trip', 'line_range', 'line_rate', 'line_rpm',
  'line_temp', 'line_clock', 'line_decimal', 'nb_km', 'nb_odo', 'nb_trip',
  'nb_range', 'nb_rate', 'nb_clock', 'conf', 'by_ocr', 'by_reader', 'reader_conf', 'crop_v', 'crop_std', 'crop_s',
  'ring_v', 'ring_std', 'ring_s', 'ring_amber', 'ring_green', 'contrast',
];

bool _isDial(int n) => n <= 300 && n % 10 == 0;
bool _isDigit(int cu) => cu >= 48 && cu <= 57;
String _stripSep(String g) => g.replaceAll(',', '').replaceAll('.', '');
String _lstrip0(String s) => s.replaceFirst(RegExp(r'^0+'), '');

/// The "repair O->0 inside mostly-digit tokens" step shared by _numbers and find_odometer.
String _fixTokens(String text) {
  final toks = text.trim().isEmpty ? <String>[] : text.trim().split(RegExp(r'\s+'));
  return toks.map((tok) {
    final digits = tok.codeUnits.where(_isDigit).length;
    return digits * 2 > tok.length ? translate(tok, _numFix) : tok;
  }).join(' ');
}

class _Num {
  _Num(this.digits, this.token, this.start, this.end, this.nLine, this.merged, this.hasSep, this.dialMerge);
  final String digits, token;
  final double start, end;
  final int nLine, merged;
  final bool hasSep, dialMerge;
}

/// odometer._numbers: whole numbers in one line, plus space-split and LCD-joined runs.
List<_Num> _numbers(String text) {
  final fixed = _fixTokens(text);
  final nums = numRe.allMatches(fixed).toList();
  final spans = <(int, int)>[for (var i = 0; i < nums.length; i++) (i, i)];
  for (var i = 0; i < nums.length; i++) {
    for (var j = i + 1; j < math.min(i + 3, nums.length); j++) {
      if (fixed.substring(nums[j - 1].end, nums[j].start) != ' ') break;
      spans.add((i, j));
    }
  }
  final out = <_Num>[];
  final core = fixed.replaceAll(RegExp(r"[\s.,:\-'`]"), '');
  if (core.isNotEmpty &&
      core.codeUnits.every(_isDigit) &&
      core.length >= 5 &&
      core.length <= 8 &&
      RegExp(r"\d[.,:\-'`]\d").hasMatch(fixed) &&
      !nums.any((m) => _stripSep(m.group(1)!).length == core.length)) {
    out.add(_Num(core, fixed.trim(), 0.0, 1.0, 1, math.max(nums.length - 1, 1), false, false));
  }
  final len = math.max(fixed.length, 1);
  for (final (i, j) in spans) {
    final group = [for (var k = i; k <= j; k++) nums[k].group(1)!];
    final digits = group.map(_stripSep).join();
    if (digits.length > 8 || _lstrip0(digits).length > 7) continue;
    final start = nums[i].start, end = nums[j].end;
    final groups = group.map((g) => int.parse(_stripSep(g))).toList();
    out.add(_Num(digits, fixed.substring(start, end), start / len, end / len, nums.length, j - i,
        group.any((g) => g.length != _stripSep(g).length), j > i && groups.every(_isDial)));
  }
  return out;
}

class Candidate {
  Candidate({
    required this.value,
    required this.digits,
    required this.line,
    required this.engines,
    required this.dialMerge,
    required this.readerConf,
    required this.confidence,
    required this.text,
    required this.features,
  });
  final int value;
  final String digits;
  final int line;
  final Set<String> engines;
  final bool dialMerge;
  final double readerConf;
  final double confidence;
  final String text;
  final List<double> features;
}

/// odometer._hsv_stats over a list of packed RGB pixels.
List<double> _hsvStats(List<int> px) {
  final n = px.length ~/ 3;
  if (n == 0) return [0, 0, 0, 0, 0];
  var sumV = 0.0, sumV2 = 0.0, sumS = 0.0;
  var amber = 0, green = 0;
  for (var i = 0; i < n; i++) {
    final r = px[3 * i] / 255.0, g = px[3 * i + 1] / 255.0, b = px[3 * i + 2] / 255.0;
    final mx = math.max(r, math.max(g, b)), mn = math.min(r, math.min(g, b));
    final sat = mx > 0 ? (mx - mn) / math.max(mx, 1e-6) : 0.0;
    sumV += mx;
    sumV2 += mx * mx;
    sumS += sat;
    if (r > 0.45 && r > g && g > b + 0.08 && sat > 0.35) amber++;
    if (g > 0.45 && g >= r - 0.05 && g > b + 0.08 && sat > 0.2) green++;
  }
  final mean = sumV / n;
  final variance = math.max(0.0, sumV2 / n - mean * mean);
  return [mean, math.sqrt(variance), sumS / n, amber / n, green / n];
}

/// odometer._appearance: stats of the box and of the ring (one box-height wide) around it.
List<double> _appearance(RgbImage? rgb, List<double> box) {
  if (rgb == null) return List.filled(9, 0.0);
  final hh = rgb.height, ww = rgb.width;
  final x0 = box[0], y0 = box[1], x1 = box[2], y1 = box[3];
  final h = math.max(y1 - y0, 4.0);
  final cx0 = math.max(0.0, x0).truncate(), cy0 = math.max(0.0, y0).truncate();
  final cx1 = math.max(0.0, math.min(ww.toDouble(), x1)).truncate();
  final cy1 = math.max(0.0, math.min(hh.toDouble(), y1)).truncate();
  final rx0 = math.max(0.0, x0 - h).truncate(), ry0 = math.max(0.0, y0 - h).truncate();
  final rx1 = math.min(ww.toDouble(), x1 + h).truncate(), ry1 = math.min(hh.toDouble(), y1 + h).truncate();
  final crop = <int>[], ring = <int>[];
  final p = rgb.rgb;
  for (var y = ry0; y < ry1; y++) {
    for (var x = rx0; x < rx1; x++) {
      final i = (y * ww + x) * 3;
      final inside = y >= cy0 && y < cy1 && x >= cx0 && x < cx1;
      (inside ? crop : ring).addAll([p[i], p[i + 1], p[i + 2]]);
    }
  }
  final c = _hsvStats(crop), r = _hsvStats(ring);
  return [c[0], c[1], c[2], r[0], r[1], r[2], r[3], r[4], (c[0] - r[0]).abs()];
}

double _median(List<double> v) {
  final s = [...v]..sort();
  final n = s.length;
  return n.isOdd ? s[n ~/ 2] : (s[n ~/ 2 - 1] + s[n ~/ 2]) / 2;
}

/// odometer.candidates: every number either engine read, with its 48 features.
List<Candidate> candidates(List<OcrLine> lines, RgbImage? rgb,
    {Set<String> exclude = const {}, List<(String, double)>? reads}) {
  double hImg, wImg;
  if (rgb != null) {
    hImg = rgb.height.toDouble();
    wImg = rgb.width.toDouble();
  } else {
    hImg = lines.fold(0.0, (a, l) => math.max(a, l.y0 + l.h));
    wImg = lines.fold(0.0, (a, l) => math.max(a, l.x1));
    if (hImg == 0) hImg = 1;
    if (wImg == 0) wImg = 1;
  }
  final useReads = reads != null && reads.isNotEmpty;

  final raw = <({_Num n, Set<String> engines, int line, List<double> box, String text, String reread, double conf, double readerConf})>[];
  for (var li = 0; li < lines.length; li++) {
    final ln = lines[li];
    final text = ln.text;
    final (reread, rereadConf) = useReads ? reads[li] : ('', 0.0);
    final compact = '$text $reread'.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
    if (exclude.any((ex) => ex.isNotEmpty && compact.contains(ex))) continue;
    final found = <String, (_Num, Set<String>)>{};
    for (final (engine, t) in [('ocr', text), ('reader', reread)]) {
      if (t.isEmpty) continue;
      for (final n in _numbers(t)) {
        final f = found[n.digits];
        if (f != null) {
          f.$2.add(engine);
          continue;
        }
        found[n.digits] = (n, {engine});
      }
    }
    for (final (n, engines) in found.values) {
      final box = [ln.x + n.start * (ln.x1 - ln.x), ln.y0, ln.x + n.end * (ln.x1 - ln.x), ln.y0 + ln.h];
      raw.add((
        n: n, engines: engines, line: li, box: box, text: text, reread: reread, //
        conf: ln.confidence, readerConf: rereadConf,
      ));
    }
  }
  if (raw.isEmpty) return [];

  final values = [for (final c in raw) int.parse(c.n.digits)];
  final heights = [for (final c in raw) c.box[3] - c.box[1]];
  var medH = _median(heights);
  if (medH == 0) medH = 1;
  final order = List.generate(raw.length, (i) => i)
    ..sort((a, b) {
      final c = heights[a].compareTo(heights[b]);
      return c != 0 ? c : a.compareTo(b);
    });
  final rank = <int, double>{
    for (var r = 0; r < order.length; r++) order[r]: r / math.max(raw.length - 1, 1),
  };
  final imgDial = values.where(_isDial).length;

  final lineFlags = <Map<String, bool>>[];
  for (var li = 0; li < lines.length; li++) {
    final t = useReads ? '${lines[li].text} ${reads[li].$1}' : lines[li].text;
    lineFlags.add({
      'km': _km.hasMatch(t) && !_rate.hasMatch(t),
      'odo': _odo.hasMatch(t),
      'trip': _trip.hasMatch(t),
      'range': _range.hasMatch(t),
      'rate': _rate.hasMatch(t),
      'clock': _clock.hasMatch(t),
    });
  }

  final out = <Candidate>[];
  for (var i = 0; i < raw.length; i++) {
    final c = raw[i];
    final v = values[i];
    final ln = lines[c.line];
    final x0 = c.box[0], y0 = c.box[1], x1 = c.box[2], y1 = c.box[3];
    final h = y1 - y0;
    final cx = (x0 + x1) / 2 / wImg, cy = (y0 + y1) / 2 / hImg;
    final text = c.text;
    final flags = lineFlags[c.line];
    final nb = {for (final k in const ['km', 'odo', 'trip', 'range', 'rate', 'clock']) k: 0.0};
    final lcx = (ln.x + ln.x1) / 2, lcy = ln.cy;
    for (var lj = 0; lj < lines.length; lj++) {
      if (lj == c.line) continue;
      final other = lines[lj];
      final ocx = (other.x + other.x1) / 2;
      if ((other.cy - lcy).abs() <= 2.5 * h && (ocx - lcx).abs() <= 8 * h) {
        for (final k in nb.keys) {
          if (lineFlags[lj][k]!) nb[k] = 1.0;
        }
      }
    }
    final letters = _letter.allMatches(text).length;
    double b(bool x) => x ? 1.0 : 0.0;
    final f = <String, double>{
      'n_digits': c.n.digits.length.toDouble(),
      'log_value': math.log(v + 1) / math.ln10,
      'has_sep': b(c.n.hasSep),
      'merged': c.n.merged.toDouble(),
      'leading_zero': b(c.n.digits.length > 1 && c.n.digits[0] == '0'),
      'dial_like': b(_isDial(v)),
      'img_dial_like': imgDial.toDouble(),
      'img_cands': raw.length.toDouble(),
      'in_scale': [
        for (var j = 0; j < values.length; j++)
          if (j != i && _isDial(v) && _isDial(values[j]) && const [10, 20, 30, 40].contains((v - values[j]).abs())) 1
      ].length.toDouble(),
      'same_value': [for (var j = 0; j < values.length; j++) if (j != i && values[j] == v) 1].length.toDouble(),
      'rel_h': h / hImg,
      'h_vs_median': h / medH,
      'h_rank': rank[i]!,
      'w_vs_h': (x1 - x0) / math.max(h, 1),
      'cx': cx,
      'cy': cy,
      'dist_center': math.sqrt((cx - 0.5) * (cx - 0.5) + (cy - 0.5) * (cy - 0.5)),
      'tok_frac': c.n.token.replaceAll(' ', '').length / math.max(text.replaceAll(' ', '').length, 1),
      'line_numbers': c.n.nLine.toDouble(),
      'line_alpha': letters / math.max(text.length, 1),
      'line_km': b(flags['km']!),
      'line_odo': b(flags['odo']!),
      'line_trip': b(flags['trip']!),
      'line_range': b(flags['range']!),
      'line_rate': b(flags['rate']!),
      'line_rpm': b(_rpm.hasMatch(text)),
      'line_temp': b(_temp.hasMatch(text)),
      'line_clock': b(flags['clock']!),
      'line_decimal': b(RegExp(r'\d[.,]\d(?!\d\d)').hasMatch(text)),
      'nb_km': nb['km']!,
      'nb_odo': nb['odo']!,
      'nb_trip': nb['trip']!,
      'nb_range': nb['range']!,
      'nb_rate': nb['rate']!,
      'nb_clock': nb['clock']!,
      'conf': c.conf,
      'by_ocr': b(c.engines.contains('ocr')),
      'by_reader': b(c.engines.contains('reader')),
      'reader_conf': c.readerConf,
    };
    final app = _appearance(rgb, c.box);
    const appKeys = ['crop_v', 'crop_std', 'crop_s', 'ring_v', 'ring_std', 'ring_s', 'ring_amber', 'ring_green', 'contrast'];
    for (var k = 0; k < appKeys.length; k++) {
      f[appKeys[k]] = app[k];
    }
    final byOcr = c.engines.contains('ocr');
    out.add(Candidate(
      value: v,
      digits: c.n.digits,
      line: c.line,
      engines: c.engines,
      dialMerge: c.n.dialMerge,
      readerConf: c.readerConf,
      confidence: byOcr ? c.conf : c.readerConf,
      text: byOcr ? text : c.reread,
      features: [for (final k in features) f[k]!],
    ));
  }
  return out;
}

/// odometer.plausible: at least 3 digits shown, at most 7 significant.
bool plausible(Candidate c) => c.digits.length >= 3 && _lstrip0(c.digits).length <= 7;

// ------------------------------------------------------------------ ranker

/// The HistGradientBoosting classifier exported as JSON trees.
class Ranker {
  Ranker(Map<String, dynamic> json)
      : baseline = (json['baseline'] as num).toDouble(),
        usesReader = json['uses_reader'] == true,
        featureNames = (json['features'] as List).cast<String>(),
        _trees = [for (final t in json['trees'] as List) _Tree(t as Map<String, dynamic>)];

  final double baseline;
  final bool usesReader;
  final List<String> featureNames;
  final List<_Tree> _trees;

  /// Same feature list as odometer.FEATURES (load_model refuses a mismatched bundle).
  bool get compatible =>
      featureNames.length == features.length && [for (var i = 0; i < features.length; i++) featureNames[i] == features[i]].every((x) => x);

  double probability(List<double> x) {
    var raw = baseline;
    for (final t in _trees) {
      raw += t.eval(x);
    }
    return 1 / (1 + math.exp(-raw));
  }
}

class _Tree {
  _Tree(Map<String, dynamic> t)
      : feature = (t['feature'] as List).cast<num>().map((e) => e.toInt()).toList(),
        threshold = (t['threshold'] as List).cast<num>().map((e) => e.toDouble()).toList(),
        left = (t['left'] as List).cast<num>().map((e) => e.toInt()).toList(),
        right = (t['right'] as List).cast<num>().map((e) => e.toInt()).toList(),
        leaf = (t['leaf'] as List).map((e) => e == true || e == 1).toList(),
        value = (t['value'] as List).cast<num>().map((e) => e.toDouble()).toList(),
        missingLeft = (t['missing_left'] as List).map((e) => e == true || e == 1).toList();
  final List<int> feature, left, right;
  final List<double> threshold, value;
  final List<bool> leaf, missingLeft;

  double eval(List<double> x) {
    var n = 0;
    while (!leaf[n]) {
      final v = x[feature[n]];
      final goLeft = v.isNaN ? missingLeft[n] : v <= threshold[n];
      n = goLeft ? left[n] : right[n];
    }
    return value[n];
  }
}

/// odometer.prior: the longest non-dial number gets +0.25; short ones are halved.
List<double> prior(List<Candidate> cands, List<double> probs) {
  if (cands.isEmpty) return probs;
  final shown = [for (final c in cands) c.dialMerge ? 0 : c.digits.length];
  final sig = [for (final c in cands) _lstrip0(c.digits).length];
  final longest = shown.reduce(math.max);
  final out = [...probs];
  if (longest >= 4) {
    for (var i = 0; i < out.length; i++) {
      if (shown[i] == longest) out[i] += 0.25;
    }
    for (var i = 0; i < out.length; i++) {
      if (sig[i] <= 3) out[i] *= 0.5;
    }
  }
  return [for (final p in out) p.clamp(0.0, 1.0)];
}

int _argmax(List<double> v) {
  var best = 0;
  for (var i = 1; i < v.length; i++) {
    if (v[i] > v[best]) best = i;
  }
  return best;
}

/// odometer.pick: the ranker picks the box; among reads of that box, prefer the one both
/// engines agree on, else the more confident.
(Candidate, double) pick(List<Candidate> cands, List<double> probs) {
  final best = _argmax(probs);
  final line = cands[best].line, p = probs[best];
  final rivals = [for (var i = 0; i < cands.length; i++) if (cands[i].line == line && probs[i] >= 0.5 * p) i];
  var top = rivals.first;
  for (final i in rivals.skip(1)) {
    final a = cands[i], t = cands[top];
    if (a.engines.length > t.engines.length ||
        (a.engines.length == t.engines.length && a.confidence > t.confidence)) {
      top = i;
    }
  }
  return (cands[top], p);
}

// ------------------------------------------------------------------ odometer reader

class OdometerRead {
  OdometerRead({
    required this.value,
    required this.confidence,
    required this.score,
    required this.source,
    required this.engine,
    this.votes,
  });
  final int value;
  final double confidence;
  final double score;
  final String source;
  final String engine; // 'odometer-ranker' | 'rules'
  final double? votes;
}

double _round3(double v) => (v * 1000).round() / 1000;

class OdometerEngine {
  OdometerEngine({required this.ocr, required this.reader, required this.ranker});
  final Ocr ocr;
  final ClusterReader reader;
  final Ranker ranker;

  /// odometer.read (or extract.find_odometer when the ranker bundle doesn't match).
  OdometerRead? read(List<OcrLine> lines, RgbImage rgb, {Set<String> exclude = const {}, Map<String, int>? timings}) {
    if (!ranker.compatible) return findOdometer(lines, exclude);
    final sw = Stopwatch()..start();
    final reads = ranker.usesReader && lines.isNotEmpty ? reader.readLines(rgb, lines) : null;
    _t(timings, 'reader', sw);
    final cands = candidates(lines, rgb, exclude: exclude, reads: reads).where(plausible).toList();
    if (cands.isEmpty) {
      _t(timings, 'ranker', sw);
      return null;
    }
    var probs = [for (final c in cands) ranker.probability(c.features)];
    probs = prior(cands, probs);
    var (c, p) = pick(cands, probs);
    _t(timings, 'ranker', sw);
    final (voted, agreement) = vote(cands, lines, rgb, c);
    _t(timings, 'vote', sw);
    c = voted;
    final readConf = agreement == null ? c.confidence : math.max(c.confidence, agreement);
    return OdometerRead(
      value: c.value,
      confidence: _round3(math.min(1.0, p) * readConf),
      score: _round3(p),
      source: c.text,
      engine: 'odometer-ranker',
      votes: agreement == null ? null : (agreement * 100).round() / 100,
    );
  }

  static void _t(Map<String, int>? t, String k, Stopwatch sw) {
    if (t != null) t[k] = (t[k] ?? 0) + sw.elapsedMilliseconds;
    sw
      ..reset()
      ..start();
  }

  /// odometer._box_reads: re-read the box with three margins at 1x/2x/3x (Lanczos),
  /// through both engines, and count each 4+ digit reading.
  Map<String, double> boxReads(RgbImage rgb, OcrLine line) {
    final h = line.h;
    final votes = <String, double>{};
    for (final pad in const [0.15, 0.4, 0.8]) {
      final bx0 = math.max(0.0, line.x - pad * h).truncate();
      final by0 = math.max(0.0, line.y0 - pad * h).truncate();
      final bx1 = math.min(rgb.width.toDouble(), line.x1 + pad * h).truncate();
      final by1 = math.min(rgb.height.toDouble(), line.y0 + h + pad * h).truncate();
      if (bx1 - bx0 < 4 || by1 - by0 < 4) continue;
      final crop = cropRgb(rgb, bx0, by0, bx1, by1);
      for (final scale in const [1, 2, 3]) {
        final im = scale == 1 ? crop : resizePil(crop, crop.width * scale, crop.height * scale, PilFilter.lanczos);
        final texts = <(String, double)>[for (final r in ocr.recognise(im)) (r.text, r.score)];
        texts.addAll(reader.readGray([toGray(im)]));
        for (final (t, c) in texts) {
          for (final d in {for (final n in _numbers(t)) if (n.digits.length >= 4) n.digits}) {
            votes[d] = (votes[d] ?? 0.0) + 1.0 + 0.1 * c;
          }
        }
      }
    }
    return votes;
  }

  /// odometer.vote: when the chosen box has rival 4+ digit reads, repeated reads decide.
  (Candidate, double?) vote(List<Candidate> cands, List<OcrLine> lines, RgbImage rgb, Candidate chosen) {
    final rivals = [for (final c in cands) if (c.line == chosen.line && c.digits.length >= 4) c];
    if ({for (final c in rivals) c.digits}.length < 2) return (chosen, null);
    final votes = boxReads(rgb, lines[chosen.line]);
    final total = rivals.fold(0.0, (a, c) => a + (votes[c.digits] ?? 0.0));
    if (total == 0) return (chosen, null);
    var best = rivals.first;
    for (final c in rivals.skip(1)) {
      final vc = votes[c.digits] ?? 0.0, vb = votes[best.digits] ?? 0.0;
      if (vc > vb || (vc == vb && identical(c, chosen) && !identical(best, chosen))) best = c;
    }
    return (best, (votes[best.digits] ?? 0.0) / total);
  }
}

// ------------------------------------------------------------------ rule fallback

final _odoHint = RegExp(r'\b(ODO|KM|KMS|MILES|MI|TOTAL)\b', caseSensitive: false);
final _tripHint = RegExp(r'\b(TRIP|A|B|RANGE|DTE|AVG|L/100|KM/L|KMPL|RPM)\b', caseSensitive: false);

/// extract.py find_odometer: the hand-written rules.
OdometerRead? findOdometer(List<OcrLine> lines, Set<String> exclude) {
  var dialCount = 0;
  for (final ln in lines) {
    for (final m in numRe.allMatches(ln.text)) {
      if (_isDial(int.parse(_stripSep(m.group(1)!)))) dialCount++;
    }
  }
  final dial = dialCount >= 3;
  (int, double, double, String)? best;
  for (final ln in lines) {
    final text = ln.text;
    final fixed = _fixTokens(text);
    final compact = normalizePlate(text);
    if (vinLabel.hasMatch(text.toUpperCase()) ||
        exclude.any((ex) => ex.isNotEmpty && vinFix(compact).contains(ex))) {
      continue;
    }
    for (final m in numRe.allMatches(fixed)) {
      final digits = _stripSep(m.group(1)!);
      if (digits.length < 3 || digits.length > 7) continue;
      var score = ln.confidence + digits.length * 0.05;
      if (_odoHint.hasMatch(text) || RegExp(r'\b[O0]D[O0]\b', caseSensitive: false).hasMatch(text)) score += 1.0;
      if (_tripHint.hasMatch(text)) score -= 0.8;
      if (dial && _isDial(int.parse(digits))) score -= 1.0;
      if (best == null || score > best.$2) best = (int.parse(digits), score, ln.confidence, text);
    }
  }
  if (best == null) return null;
  return OdometerRead(
      value: best.$1, confidence: _round3(best.$3), score: _round3(best.$2), source: best.$4, engine: 'rules');
}
