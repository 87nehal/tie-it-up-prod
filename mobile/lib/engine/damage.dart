// On-device vehicle damage segmentation. A pure-Dart port of the device recipe in
// mobile/tools/decision_parity.py (`device_recipe`), which itself derives from
// backend/src/vehicle_damage/inference.py (predict_probabilities, probabilities_to_mask,
// filter_small_damage_components, assess_quality, route_inference_decision).
//
// No Flutter imports: this runs in a background isolate.

import 'dart:math' as math;
import 'dart:typed_data';

import 'ort.dart';
import 'types.dart';

/// One connected damage region in the analysed image (pixel coordinates of
/// [DamageResult.width] x [DamageResult.height]).
class DamageRegion {
  const DamageRegion({
    required this.left,
    required this.top,
    required this.right,
    required this.bottom,
    required this.cls,
    required this.share,
    required this.pixels,
  });
  /// Pixels in the analysed image (DamageResult.width/height), right/bottom exclusive.
  final int left, top, right, bottom;
  /// Majority class, a damageClasses name.
  final String cls;
  /// Fraction of image pixels.
  final double share;
  final int pixels;
}

const _recaptureReasons = {
  'low_resolution',
  'underexposed',
  'excessive_glare_or_overexposure',
  'blur_or_low_detail',
};

/// Python's round() (half to even).
int _pyRound(double v) {
  final f = v.floorToDouble();
  final d = v - f;
  if (d > 0.5) return f.toInt() + 1;
  if (d < 0.5) return f.toInt();
  final i = f.toInt();
  return i.isEven ? i : i + 1;
}

class DamageEngine {
  DamageEngine(this.model, Map<String, dynamic> profile)
      : threshold = (profile['threshold'] as num).toDouble(),
        exteriorFloor = (profile['exterior_floor'] as num).toDouble(),
        overlap = (profile['overlap'] as num).toInt(),
        minComponentPixels = (profile['minimum_component_pixels'] as num).toDouble(),
        nearBand = (profile['near_threshold_band'] as num).toDouble(),
        maxUncertain = (profile['max_uncertain_fraction'] as num).toDouble(),
        tile = (profile['tile_size'] as num?)?.toInt() ?? 768,
        mean = [for (final v in profile['mean'] as List) (v as num).toDouble()],
        std = [for (final v in profile['std'] as List) (v as num).toDouble()];

  final Model model;
  final double threshold, exteriorFloor, minComponentPixels, nearBand, maxUncertain;
  final int overlap, tile;
  final List<double> mean, std;

  List<int> _starts(int length) {
    if (length <= tile) return [0];
    final stride = tile - overlap;
    final pts = <int>[for (var p = 0; p <= length - tile; p += stride) p];
    if (pts.last != length - tile) pts.add(length - tile);
    return pts;
  }

  DamageResult analyse(RgbImage img, DamageMode mode, {void Function(int done, int total)? onProgress}) {
    final longSide = mode == DamageMode.quick ? 768 : 1152;
    final flip = mode == DamageMode.thorough;
    final T = tile;

    // ---- preprocess
    final swPre = Stopwatch()..start();
    final s = math.min(1.0, longSide / math.max(img.width, img.height));
    final w = math.max(1, _pyRound(img.width * s));
    final h = math.max(1, _pyRound(img.height * s));
    final small = (w == img.width && h == img.height) ? img : resizeBilinearPil(img, w, h);
    final H = math.max(h, T), W = math.max(w, T);
    // normalised, edge-padded CHW
    final x = Float32List(3 * H * W);
    final rgb = small.rgb;
    for (var c = 0; c < 3; c++) {
      final m = mean[c], sd = std[c];
      final lut = Float32List(256);
      for (var v = 0; v < 256; v++) {
        lut[v] = (v / 255.0 - m) / sd;
      }
      final base = c * H * W;
      for (var yy = 0; yy < H; yy++) {
        final sy = yy < h ? yy : h - 1;
        final row = base + yy * W;
        final srow = sy * w * 3 + c;
        for (var xx = 0; xx < W; xx++) {
          final sx = xx < w ? xx : w - 1;
          x[row + xx] = lut[rgb[srow + sx * 3]];
        }
      }
    }
    final quality = _assessQuality(small);
    final qualityReasons = <String>[
      if (math.min(img.width, img.height) < 480) 'low_resolution', // original size
      ...quality.$2,
    ];
    swPre.stop();

    // ---- model
    final swModel = Stopwatch()..start();
    final acc = Float32List(H * W);
    final tacc = Float32List(5 * H * W);
    final wacc = Float32List(H * W);
    final win1 = Float32List(T);
    for (var n = 0; n < T; n++) {
      final v = T == 1 ? 1.0 : 0.5 - 0.5 * math.cos(2 * math.pi * n / (T - 1));
      win1[n] = math.max(v, 0.05);
    }
    final ys = _starts(H), xs = _starts(W);
    final total = ys.length * xs.length * (flip ? 2 : 1);
    var passes = 0;
    final tileIn = Float32List(3 * T * T);
    final tileFlip = Float32List(3 * T * T);
    final a = Float32List(T * T);
    final t = Float32List(5 * T * T);
    final a2 = Float32List(T * T);
    final t2 = Float32List(5 * T * T);
    onProgress?.call(0, total);
    for (final top in ys) {
      for (final left in xs) {
        for (var c = 0; c < 3; c++) {
          for (var yy = 0; yy < T; yy++) {
            final src = c * H * W + (top + yy) * W + left;
            final dst = c * T * T + yy * T;
            tileIn.setRange(dst, dst + T, x, src);
          }
        }
        _probs(tileIn, a, t);
        passes++;
        onProgress?.call(passes, total);
        if (flip) {
          for (var r = 0; r < 3 * T; r++) {
            final o = r * T;
            for (var xx = 0; xx < T; xx++) {
              tileFlip[o + xx] = tileIn[o + T - 1 - xx];
            }
          }
          _probs(tileFlip, a2, t2);
          passes++;
          onProgress?.call(passes, total);
          for (var yy = 0; yy < T; yy++) {
            final o = yy * T;
            for (var xx = 0; xx < T; xx++) {
              a[o + xx] = 0.5 * (a[o + xx] + a2[o + T - 1 - xx]);
            }
          }
          for (var r = 0; r < 5 * T; r++) {
            final o = r * T;
            for (var xx = 0; xx < T; xx++) {
              t[o + xx] = 0.5 * (t[o + xx] + t2[o + T - 1 - xx]);
            }
          }
        }
        for (var yy = 0; yy < T; yy++) {
          final wy = win1[yy];
          final dst = (top + yy) * W + left;
          final src = yy * T;
          for (var xx = 0; xx < T; xx++) {
            final wv = wy * win1[xx];
            acc[dst + xx] += a[src + xx] * wv;
            wacc[dst + xx] += wv;
            for (var k = 0; k < 5; k++) {
              tacc[k * H * W + dst + xx] += t[k * T * T + src + xx] * wv;
            }
          }
        }
      }
    }
    swModel.stop();

    // ---- postprocess
    final swPost = Stopwatch()..start();
    final n = w * h;
    final mask = Uint8List(n);
    var near = 0;
    for (var yy = 0; yy < h; yy++) {
      for (var xx = 0; xx < w; xx++) {
        final i = yy * W + xx;
        final wv = math.max(wacc[i], 1e-6);
        final av = acc[i] / wv;
        if ((av - threshold).abs() < nearBand) near++;
        if (av >= threshold) {
          var best = 0;
          var bv = tacc[i] / wv;
          for (var k = 1; k < 5; k++) {
            final v = tacc[k * H * W + i] / wv;
            if (v > bv) {
              bv = v;
              best = k;
            }
          }
          mask[yy * w + xx] = best + 1;
        }
      }
    }
    final minPx = math.max(1, _pyRound(minComponentPixels * s * s));
    if (minPx > 1) {
      final (labels, sizes) = _label(mask, w, h);
      for (var i = 0; i < n; i++) {
        final l = labels[i];
        if (l > 0 && sizes[l] < minPx) mask[i] = 0;
      }
    }
    final counts = List<int>.filled(6, 0);
    for (var i = 0; i < n; i++) {
      counts[mask[i]]++;
    }
    final damaged = n - counts[0];
    final nearFrac = near / n;

    // Decision, as route_inference_decision. The device runs a single branch (no separate
    // triage model), so there is no triage-vs-segmentation disagreement to report.
    final reasons = [for (final r in qualityReasons) 'quality:$r'];
    if (nearFrac > maxUncertain) reasons.add('excessive_near_threshold_area');
    final String decision;
    if (qualityReasons.any(_recaptureReasons.contains)) {
      decision = 'recapture_required';
    } else if (reasons.isNotEmpty) {
      decision = 'manual_review_required';
    } else if (damaged > 0) {
      decision = 'damage_detected';
    } else {
      decision = 'no_damage_detected';
    }
    swPost.stop();

    return DamageResult(
      decision: decision,
      reasons: reasons,
      width: w,
      height: h,
      mask: mask,
      typeFractions: {
        for (var k = 1; k < 6; k++)
          if (counts[k] > 0) damageClasses[k]: counts[k] / n,
      },
      damageFraction: damaged / n,
      nearThresholdFraction: nearFrac,
      quality: quality.$1,
      passes: passes,
      timings: {
        'preprocess': swPre.elapsedMilliseconds,
        'model': swModel.elapsedMilliseconds,
        'postprocess': swPost.elapsedMilliseconds,
      },
    );
  }

  /// One tile forward pass -> any-damage probability [T*T] and type softmax [5*T*T].
  void _probs(Float32List tileIn, Float32List outA, Float32List outT) {
    final T = tile, tt = T * T;
    final out = model.run('image', tileIn, [1, 3, T, T]);
    final pres = out['presence']!.$1, typ = out['type']!.$1, ext = out['exterior']!.$1;
    final f = exteriorFloor;
    for (var i = 0; i < tt; i++) {
      final p = 1 / (1 + math.exp(-pres[i]));
      final e = 1 / (1 + math.exp(-ext[i]));
      outA[i] = p * (f + (1 - f) * e);
      var mx = typ[i];
      for (var k = 1; k < 5; k++) {
        final v = typ[k * tt + i];
        if (v > mx) mx = v;
      }
      var sum = 0.0;
      for (var k = 0; k < 5; k++) {
        final v = math.exp(typ[k * tt + i] - mx);
        outT[k * tt + i] = v;
        sum += v;
      }
      for (var k = 0; k < 5; k++) {
        outT[k * tt + i] /= sum;
      }
    }
  }
}

/// assess_quality on the analysed image. Returns (metrics, review reasons excluding
/// low_resolution, which the caller decides on the original size).
(Map<String, double>, List<String>) _assessQuality(RgbImage im) {
  final w = im.width, h = im.height, n = w * h, rgb = im.rgb;
  final lum = Float32List(n);
  var dark = 0, clipped = 0, spec = 0;
  for (var i = 0; i < n; i++) {
    final r = rgb[i * 3] / 255.0, g = rgb[i * 3 + 1] / 255.0, b = rgb[i * 3 + 2] / 255.0;
    final l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum[i] = l;
    if (l < 0.04) dark++;
    if (l > 0.985) clipped++;
    final mx = math.max(r, math.max(g, b)), mn = math.min(r, math.min(g, b));
    final sat = (mx - mn) / math.max(mx, 1e-6);
    if (l > 0.90 && sat < 0.12) spec++;
  }
  var sx = 0.0, sy = 0.0;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x + 1 < w; x++) {
      final d = lum[y * w + x + 1] - lum[y * w + x];
      sx += d * d;
    }
  }
  for (var y = 0; y + 1 < h; y++) {
    for (var x = 0; x < w; x++) {
      final d = lum[(y + 1) * w + x] - lum[y * w + x];
      sy += d * d;
    }
  }
  final sharp = (w > 1 ? sx / ((w - 1) * h) : 0.0) + (h > 1 ? sy / (w * (h - 1)) : 0.0);
  final q = {'dark': dark / n, 'clipped': clipped / n, 'specular': spec / n, 'sharpness': sharp};
  final reasons = <String>[
    if (q['dark']! > 0.35) 'underexposed',
    if (q['clipped']! > 0.20) 'excessive_glare_or_overexposure',
    if (q['specular']! > 0.015) 'possible_specular_glare',
    if (sharp < 0.00035) 'blur_or_low_detail',
  ];
  return (q, reasons);
}

/// 8-connected labelling of mask>0. Returns (labels, sizes) with sizes[0] unused.
(Int32List, List<int>) _label(Uint8List mask, int w, int h) {
  final labels = Int32List(w * h);
  final sizes = <int>[0];
  final stack = Int32List(w * h);
  var next = 0;
  for (var i = 0; i < w * h; i++) {
    if (mask[i] == 0 || labels[i] != 0) continue;
    next++;
    var sp = 0, count = 0;
    stack[sp++] = i;
    labels[i] = next;
    while (sp > 0) {
      final p = stack[--sp];
      count++;
      final py = p ~/ w, px = p - py * w;
      for (var dy = -1; dy <= 1; dy++) {
        final ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          final nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          final q = ny * w + nx;
          if (mask[q] != 0 && labels[q] == 0) {
            labels[q] = next;
            stack[sp++] = q;
          }
        }
      }
    }
    sizes.add(count);
  }
  return (labels, sizes);
}

/// Connected damage regions (8-connected), largest first.
List<DamageRegion> regions(DamageResult r) {
  final w = r.width, h = r.height;
  final (labels, sizes) = _label(r.mask, w, h);
  final m = sizes.length;
  final l0 = List<int>.filled(m, w), t0 = List<int>.filled(m, h);
  final r0 = List<int>.filled(m, 0), b0 = List<int>.filled(m, 0);
  final cls = List<int>.filled(m * 6, 0);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final i = y * w + x;
      final l = labels[i];
      if (l == 0) continue;
      if (x < l0[l]) l0[l] = x;
      if (x + 1 > r0[l]) r0[l] = x + 1;
      if (y < t0[l]) t0[l] = y;
      if (y + 1 > b0[l]) b0[l] = y + 1;
      cls[l * 6 + r.mask[i]]++;
    }
  }
  final out = <DamageRegion>[];
  for (var l = 1; l < m; l++) {
    var best = 1;
    for (var k = 2; k < 6; k++) {
      if (cls[l * 6 + k] > cls[l * 6 + best]) best = k;
    }
    out.add(DamageRegion(
        left: l0[l], top: t0[l], right: r0[l], bottom: b0[l],
        cls: damageClasses[best], pixels: sizes[l], share: sizes[l] / (w * h)));
  }
  out.sort((a, b) => b.pixels.compareTo(a.pixels));
  return out;
}

const _classColours = [
  [0, 0, 0],
  [0xE3, 0x00, 0x1B], // dent
  [0xF0, 0x8C, 0x00], // scratch
  [0x7C, 0x3A, 0xED], // crack_or_breakage
  [0x2F, 0x6F, 0xE4], // paint_damage
  [0x0E, 0xA5, 0xA4], // deformation_or_detachment
];

/// width*height RGBA overlay: class colour at [alpha], 2-px white outline at component
/// edges, transparent elsewhere.
Uint8List overlayRgba(DamageResult r, {int alpha = 140}) {
  final w = r.width, h = r.height, mask = r.mask;
  final out = Uint8List(w * h * 4);
  // edge ring 1: foreground touching background (8-neighbourhood) or the border
  final ring = Uint8List(w * h);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final i = y * w + x;
      if (mask[i] == 0) continue;
      var edge = false;
      for (var dy = -1; dy <= 1 && !edge; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          final nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || mask[ny * w + nx] == 0) {
            edge = true;
            break;
          }
        }
      }
      if (edge) ring[i] = 1;
    }
  }
  // ring 2: foreground next to ring 1
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final i = y * w + x;
      if (mask[i] == 0 || ring[i] != 0) continue;
      outer:
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          final nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && ring[ny * w + nx] == 1) {
            ring[i] = 2;
            break outer;
          }
        }
      }
    }
  }
  for (var i = 0; i < w * h; i++) {
    final k = mask[i];
    if (k == 0) continue;
    final o = i * 4;
    if (ring[i] != 0) {
      out[o] = 255;
      out[o + 1] = 255;
      out[o + 2] = 255;
      out[o + 3] = 255;
    } else {
      final c = _classColours[k];
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = alpha;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PIL-compatible bilinear resize (Pillow's Resample.c: support-scaled triangle filter,
// 22-bit fixed-point coefficients, horizontal pass then vertical pass with uint8
// intermediate). Antialiases when downscaling, like Image.resize(..., BILINEAR).

const _precisionBits = 32 - 8 - 2;

(Int32List bounds, Int32List coeffs, int ksize) _pilCoeffs(int inSize, int outSize) {
  final scale = inSize / outSize;
  final filterscale = math.max(1.0, scale);
  final support = 1.0 * filterscale;
  final ksize = support.ceil() * 2 + 1;
  final bounds = Int32List(outSize * 2);
  final coeffs = Int32List(outSize * ksize);
  final k = Float64List(ksize);
  final ss = 1.0 / filterscale;
  for (var xx = 0; xx < outSize; xx++) {
    final center = (xx + 0.5) * scale;
    var xmin = (center - support + 0.5).truncate();
    if (xmin < 0) xmin = 0;
    var xmax = (center + support + 0.5).truncate();
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    var ww = 0.0;
    for (var x = 0; x < xmax; x++) {
      var v = ((x + xmin - center + 0.5) * ss).abs();
      v = v < 1.0 ? 1.0 - v : 0.0;
      k[x] = v;
      ww += v;
    }
    for (var x = 0; x < ksize; x++) {
      final v = x < xmax && ww != 0.0 ? k[x] / ww : 0.0;
      coeffs[xx * ksize + x] = (v * (1 << _precisionBits) + (v < 0 ? -0.5 : 0.5)).truncate();
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return (bounds, coeffs, ksize);
}

int _clip8(int v) {
  final s = v >> _precisionBits;
  return s < 0 ? 0 : (s > 255 ? 255 : s);
}

/// Resize like PIL `Image.resize((outW, outH), Image.BILINEAR)`.
RgbImage resizeBilinearPil(RgbImage src, int outW, int outH) {
  var cur = src.rgb;
  var cw = src.width;
  final ch = src.height;
  const half = 1 << (_precisionBits - 1);
  if (outW != cw) {
    final (b, c, ks) = _pilCoeffs(cw, outW);
    final dst = Uint8List(outW * ch * 3);
    for (var y = 0; y < ch; y++) {
      final row = y * cw * 3;
      for (var xx = 0; xx < outW; xx++) {
        final xmin = b[xx * 2], xmax = b[xx * 2 + 1];
        var s0 = half, s1 = half, s2 = half;
        for (var x = 0; x < xmax; x++) {
          final kv = c[xx * ks + x];
          final p = row + (x + xmin) * 3;
          s0 += cur[p] * kv;
          s1 += cur[p + 1] * kv;
          s2 += cur[p + 2] * kv;
        }
        final o = (y * outW + xx) * 3;
        dst[o] = _clip8(s0);
        dst[o + 1] = _clip8(s1);
        dst[o + 2] = _clip8(s2);
      }
    }
    cur = dst;
    cw = outW;
  }
  if (outH != ch) {
    final (b, c, ks) = _pilCoeffs(ch, outH);
    final dst = Uint8List(cw * outH * 3);
    final stride = cw * 3;
    for (var yy = 0; yy < outH; yy++) {
      final ymin = b[yy * 2], ymax = b[yy * 2 + 1];
      final o = yy * stride;
      for (var xi = 0; xi < stride; xi++) {
        var s = half;
        for (var y = 0; y < ymax; y++) {
          s += cur[(y + ymin) * stride + xi] * c[yy * ks + y];
        }
        dst[o + xi] = _clip8(s);
      }
    }
    cur = dst;
  }
  return RgbImage(cw, outH, cur);
}
