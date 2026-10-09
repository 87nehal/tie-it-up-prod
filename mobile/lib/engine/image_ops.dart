// Pixel helpers for the OCR / odometer engines. Pure Dart (no Flutter) so they run in
// a background isolate. The resamplers reproduce the two libraries the Python pipeline
// uses: OpenCV's INTER_LINEAR (RapidOCR) and Pillow's convolution resampler (ocr.py,
// cluster_reader.py, odometer.py), including their fixed-point rounding.

import 'dart:math' as math;
import 'dart:typed_data';

import 'types.dart';

/// A single-channel 8-bit image, row-major (Pillow mode "L").
class GrayImage {
  GrayImage(this.width, this.height, this.data) : assert(data.length == width * height);
  final int width;
  final int height;
  final Uint8List data;
}

/// Pixels [x0, x1) x [y0, y1) of [img]; the box must lie inside the image.
RgbImage cropRgb(RgbImage img, int x0, int y0, int x1, int y1) {
  final w = x1 - x0, h = y1 - y0;
  final out = Uint8List(w * h * 3);
  for (var y = 0; y < h; y++) {
    final src = ((y0 + y) * img.width + x0) * 3;
    out.setRange(y * w * 3, (y + 1) * w * 3, img.rgb, src);
  }
  return RgbImage(w, h, out);
}

/// Pillow `convert("L")`: L = R*299/1000 + G*587/1000 + B*114/1000, in Pillow's
/// 16-bit fixed point.
GrayImage toGray(RgbImage img) {
  final n = img.width * img.height;
  final out = Uint8List(n);
  final p = img.rgb;
  for (var i = 0; i < n; i++) {
    out[i] = (p[3 * i] * 19595 + p[3 * i + 1] * 38470 + p[3 * i + 2] * 7471 + 0x8000) >> 16;
  }
  return GrayImage(img.width, img.height, out);
}

/// np.rot90 (counter-clockwise quarter turn), used by RapidOCR for tall crops.
RgbImage rot90(RgbImage img) {
  final w = img.width, h = img.height;
  final out = Uint8List(w * h * 3);
  // new (row i, col j) = old (row j, col w-1-i); new size is h wide, w high.
  for (var i = 0; i < w; i++) {
    for (var j = 0; j < h; j++) {
      final s = (j * w + (w - 1 - i)) * 3, d = (i * h + j) * 3;
      out[d] = img.rgb[s];
      out[d + 1] = img.rgb[s + 1];
      out[d + 2] = img.rgb[s + 2];
    }
  }
  return RgbImage(h, w, out);
}

// ------------------------------------------------------------ OpenCV INTER_LINEAR

/// cv2.resize(..., interpolation=INTER_LINEAR) for 8-bit data with [ch] channels.
/// Mirrors OpenCV's half-pixel mapping and its 11-bit fixed-point weights.
Uint8List _cvLinear(Uint8List src, int sw, int sh, int ch, int dw, int dh) {
  const bits = 11, one = 1 << bits;
  List<(int, int, int)> table(int sn, int dn) {
    final scale = sn / dn;
    return List.generate(dn, (d) {
      final f = (d + 0.5) * scale - 0.5;
      var i = f.floor();
      var a = f - i;
      if (i < 0) {
        i = 0;
        a = 0;
      }
      if (i >= sn - 1) {
        i = sn - 1;
        a = 0;
      }
      final w1 = (a * one).round();
      return (i, math.min(i + 1, sn - 1), w1);
    });
  }

  final xt = table(sw, dw), yt = table(sh, dh);
  // Horizontal pass into int rows (weights sum to 2048).
  final rows = <int, Int32List>{};
  Int32List hrow(int y) => rows.putIfAbsent(y, () {
        final r = Int32List(dw * ch);
        final base = y * sw * ch;
        for (var x = 0; x < dw; x++) {
          final (i0, i1, w1) = xt[x];
          final w0 = one - w1;
          for (var c = 0; c < ch; c++) {
            r[x * ch + c] = src[base + i0 * ch + c] * w0 + src[base + i1 * ch + c] * w1;
          }
        }
        return r;
      });
  final out = Uint8List(dw * dh * ch);
  for (var y = 0; y < dh; y++) {
    final (j0, j1, w1) = yt[y];
    final w0 = one - w1;
    final r0 = hrow(j0), r1 = hrow(j1);
    final o = y * dw * ch;
    for (var k = 0; k < dw * ch; k++) {
      final v = (r0[k] * w0 + r1[k] * w1 + (1 << (2 * bits - 1))) >> (2 * bits);
      out[o + k] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
  }
  return out;
}

RgbImage resizeLinearCv(RgbImage img, int w, int h) =>
    RgbImage(w, h, _cvLinear(img.rgb, img.width, img.height, 3, w, h));

// ------------------------------------------------------------ Pillow resampling

enum PilFilter { bilinear, bicubic, lanczos }

double _sinc(double x) {
  if (x == 0) return 1;
  x *= math.pi;
  return math.sin(x) / x;
}

double _filter(PilFilter f, double x) {
  switch (f) {
    case PilFilter.bilinear:
      x = x.abs();
      return x < 1 ? 1 - x : 0;
    case PilFilter.bicubic:
      const a = -0.5;
      x = x.abs();
      if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
      if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
      return 0;
    case PilFilter.lanczos:
      return (x > -3 && x < 3) ? _sinc(x) * _sinc(x / 3) : 0;
  }
}

double _support(PilFilter f) => switch (f) { PilFilter.bilinear => 1, PilFilter.bicubic => 2, PilFilter.lanczos => 3 };

/// Pillow's precomputeCoeffs + normalize_coeffs_8bpc: per output index, the first
/// input index and fixed-point (22-bit) weights.
List<(int, Int32List)> _pilCoeffs(int inSize, int outSize, PilFilter f) {
  const precision = 22;
  final scale = inSize / outSize;
  final fscale = math.max(scale, 1.0);
  final support = _support(f) * fscale;
  final ss = 1.0 / fscale;
  return List.generate(outSize, (xx) {
    final center = (xx + 0.5) * scale;
    var xmin = (center - support + 0.5).floor();
    if (xmin < 0) xmin = 0;
    var xmax = (center + support + 0.5).floor();
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    final k = List<double>.generate(xmax, (x) => _filter(f, (x + xmin - center + 0.5) * ss));
    final total = k.fold(0.0, (a, b) => a + b);
    final kk = Int32List(xmax);
    for (var x = 0; x < xmax; x++) {
      final w = total != 0 ? k[x] / total : 0.0;
      kk[x] = (w < 0 ? -0.5 + w * (1 << precision) : 0.5 + w * (1 << precision)).truncate();
    }
    return (xmin, kk);
  });
}

int _clip8(int v) {
  final r = v >> 22;
  return r < 0 ? 0 : (r > 255 ? 255 : r);
}

/// Image.resize((dw, dh), filter) for 8-bit data with [ch] channels: horizontal pass
/// then vertical pass, each rounded to 8 bits, as Pillow does.
Uint8List _pilResize(Uint8List src, int sw, int sh, int ch, int dw, int dh, PilFilter f) {
  var data = src;
  var w = sw;
  const half = 1 << 21;
  if (dw != sw) {
    final co = _pilCoeffs(sw, dw, f);
    final out = Uint8List(dw * sh * ch);
    for (var y = 0; y < sh; y++) {
      for (var x = 0; x < dw; x++) {
        final (xmin, kk) = co[x];
        for (var c = 0; c < ch; c++) {
          var s = half;
          var p = (y * sw + xmin) * ch + c;
          for (var i = 0; i < kk.length; i++, p += ch) {
            s += data[p] * kk[i];
          }
          out[(y * dw + x) * ch + c] = _clip8(s);
        }
      }
    }
    data = out;
    w = dw;
  }
  if (dh != sh) {
    final co = _pilCoeffs(sh, dh, f);
    final out = Uint8List(w * dh * ch);
    final stride = w * ch;
    for (var y = 0; y < dh; y++) {
      final (ymin, kk) = co[y];
      for (var k = 0; k < stride; k++) {
        var s = half;
        var p = ymin * stride + k;
        for (var i = 0; i < kk.length; i++, p += stride) {
          s += data[p] * kk[i];
        }
        out[y * stride + k] = _clip8(s);
      }
    }
    data = out;
  }
  return identical(data, src) ? Uint8List.fromList(src) : data;
}

RgbImage resizePil(RgbImage img, int w, int h, PilFilter f) =>
    RgbImage(w, h, _pilResize(img.rgb, img.width, img.height, 3, w, h, f));

GrayImage resizePilGray(GrayImage img, int w, int h, PilFilter f) =>
    GrayImage(w, h, _pilResize(img.data, img.width, img.height, 1, w, h, f));

// ------------------------------------------------------------ number helpers

/// Python's round(): half to even.
int roundHalfEven(double v) {
  final f = v.floorToDouble();
  final d = v - f;
  if (d > 0.5) return f.toInt() + 1;
  if (d < 0.5) return f.toInt();
  final i = f.toInt();
  return i.isEven ? i : i + 1;
}
