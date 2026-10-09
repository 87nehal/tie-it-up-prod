// On-device port of backend/app/fleet/ocr.py and the RapidOCR pipeline it wraps
// (rapidocr_onnxruntime: ch_ppocr_v3_det + ch_ppocr_v3_rec; the angle classifier is
// skipped). RapidOCR is fed BGR pixels, so both models here see B, G, R channel order.

import 'dart:math' as math;
import 'dart:typed_data';

import 'image_ops.dart';
import 'ort.dart';
import 'types.dart';

/// ocr.py MAX_SIDE: the longest side is capped before OCR.
const maxSide = 1600;

/// ocr.py decode(): shrink so the longest side is at most [maxSide] (Pillow's default
/// BICUBIC resize). Returns [img] itself when it is already small enough.
RgbImage capImage(RgbImage img) {
  final scale = maxSide / math.max(img.width, img.height);
  if (scale >= 1) return img;
  return resizePil(img, roundHalfEven(img.width * scale), roundHalfEven(img.height * scale), PilFilter.bicubic);
}

/// One raw RapidOCR result: integer axis-aligned box and recognised text.
class RawText {
  RawText(this.x0, this.y0, this.x1, this.y1, this.text, this.score);
  final int x0, y0, x1, y1;
  final String text;
  final double score;
}

class _Box {
  _Box(this.x0, this.y0, this.x1, this.y1);
  final int x0, y0, x1, y1;
}

class Ocr {
  Ocr(this.det, this.rec, List<String> charset)
      // CTCLabelDecode: class 0 is blank, then the charset, then a space.
      : _chars = ['', ...charset, ' '];

  final Model det;
  final Model rec;
  final List<String> _chars;

  // config.yaml
  static const _limitSideLen = 736;
  static const _thresh = 0.3;
  static const _boxThresh = 0.5;
  static const _unclipRatio = 1.6;
  static const _minSize = 3;
  static const _textScore = 0.5;
  static const _minHeight = 30;
  static const _widthHeightRatio = 8;
  static const _recH = 48;
  static const _recBatch = 6;

  /// ocr.py ocr(): text lines sorted by (row, x). The image is capped at [maxSide]
  /// first; coordinates are returned in [img]'s own pixel frame.
  List<OcrLine> read(RgbImage img, {Map<String, int>? timings}) {
    final capped = capImage(img);
    final back = img.width / capped.width;
    final lines = <OcrLine>[];
    for (final r in recognise(capped, timings: timings)) {
      lines.add(OcrLine(
        text: r.text,
        confidence: (r.score * 1000).round() / 1000,
        x: r.x0 * back,
        x1: r.x1 * back,
        y0: r.y0 * back,
        h: (r.y1 - r.y0) * back,
      ));
    }
    // ocr.py: key = (round(cy / max(h, 1)), x)
    int row(OcrLine l) => roundHalfEven(l.cy / math.max(l.h, 1));
    final keyed = [for (var i = 0; i < lines.length; i++) (row(lines[i]), lines[i].x, i)];
    keyed.sort((a, b) {
      final c = a.$1.compareTo(b.$1);
      if (c != 0) return c;
      final d = a.$2.compareTo(b.$2);
      return d != 0 ? d : a.$3.compareTo(b.$3);
    });
    return [for (final k in keyed) lines[k.$3]];
  }

  /// RapidOCR.__call__ on [img] with no resizing cap: detection (unless the image is
  /// too short or too wide, then it is recognised whole), crop, recognition, and the
  /// text_score filter.
  List<RawText> recognise(RgbImage img, {Map<String, int>? timings}) {
    final sw = Stopwatch()..start();
    final h = img.height, w = img.width;
    List<_Box> boxes;
    List<RgbImage> crops;
    if (h <= _minHeight || w / h > _widthHeightRatio) {
      boxes = [_Box(0, 0, w, h)];
      crops = [img];
    } else {
      boxes = _sortedBoxes(_detect(img));
      if (boxes.isEmpty) {
        _add(timings, 'detect', sw);
        return [];
      }
      crops = [for (final b in boxes) _crop(img, b)];
    }
    _add(timings, 'detect', sw);
    sw
      ..reset()
      ..start();
    final res = _recognise(crops);
    _add(timings, 'recognise', sw);
    final out = <RawText>[];
    for (var i = 0; i < boxes.length; i++) {
      final (text, score) = res[i];
      if (score >= _textScore) {
        final b = boxes[i];
        out.add(RawText(b.x0, b.y0, b.x1, b.y1, text, score));
      }
    }
    return out;
  }

  static void _add(Map<String, int>? t, String k, Stopwatch sw) {
    if (t != null) t[k] = (t[k] ?? 0) + sw.elapsedMilliseconds;
  }

  // ---------------------------------------------------------------- detection

  /// TextDetector.__call__: DetResizeForTest (limit_type min), NormalizeImage on BGR,
  /// DBNet, DBPostProcess and filter_tag_det_res.
  List<_Box> _detect(RgbImage img) {
    final h = img.height, w = img.width;
    var ratio = 1.0;
    if (math.min(h, w) < _limitSideLen) {
      ratio = h < w ? _limitSideLen / h : _limitSideLen / w;
    }
    final rh = roundHalfEven((h * ratio).truncate() / 32) * 32;
    final rw = roundHalfEven((w * ratio).truncate() / 32) * 32;
    if (rh <= 0 || rw <= 0) return [];
    final resized = resizeLinearCv(img, rw, rh);

    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    final n = rw * rh;
    final input = Float32List(3 * n);
    final px = resized.rgb;
    for (var i = 0; i < n; i++) {
      // channel c of the BGR image is rgb byte (2 - c)
      for (var c = 0; c < 3; c++) {
        input[c * n + i] = (px[3 * i + 2 - c] / 255.0 - mean[c]) / std[c];
      }
    }
    final pred = det.run(det.inputNames.first, input, [1, 3, rh, rw]).values.first.$1;
    return _boxesFromBitmap(pred, rw, rh, w, h);
  }

  /// DBPostProcess.boxes_from_bitmap for axis-aligned text. OpenCV's contour +
  /// minAreaRect becomes the bounding box of each 8-connected component of the
  /// (dilated) binary map; the pyclipper unclip of a rectangle grows each side by
  /// d = area * unclip_ratio / perimeter.
  List<_Box> _boxesFromBitmap(Float32List pred, int width, int height, int destW, int destH) {
    final n = width * height;
    // threshold, then cv2.dilate with a 2x2 kernel (anchor at (1,1): looks up/left)
    final seg = Uint8List(n);
    for (var i = 0; i < n; i++) {
      if (pred[i] > _thresh) seg[i] = 1;
    }
    final mask = Uint8List(n);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        final i = y * width + x;
        if (seg[i] == 1 ||
            (x > 0 && seg[i - 1] == 1) ||
            (y > 0 && seg[i - width] == 1) ||
            (x > 0 && y > 0 && seg[i - width - 1] == 1)) {
          mask[i] = 1;
        }
      }
    }

    final label = Int32List(n);
    final stack = Int32List(n);
    var next = 0;
    final boxes = <_Box>[];
    for (var start = 0; start < n; start++) {
      if (mask[start] == 0 || label[start] != 0) continue;
      next++;
      var sp = 0;
      stack[sp++] = start;
      label[start] = next;
      var minX = width, minY = height, maxX = -1, maxY = -1;
      while (sp > 0) {
        final p = stack[--sp];
        final py = p ~/ width, pxx = p - py * width;
        if (pxx < minX) minX = pxx;
        if (pxx > maxX) maxX = pxx;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        for (var dy = -1; dy <= 1; dy++) {
          final yy = py + dy;
          if (yy < 0 || yy >= height) continue;
          for (var dx = -1; dx <= 1; dx++) {
            final xx = pxx + dx;
            if (xx < 0 || xx >= width) continue;
            final q = yy * width + xx;
            if (mask[q] == 1 && label[q] == 0) {
              label[q] = next;
              stack[sp++] = q;
            }
          }
        }
      }
      // minAreaRect over contour pixel centres: sides are (max - min).
      final bw = (maxX - minX).toDouble(), bh = (maxY - minY).toDouble();
      if (math.min(bw, bh) < _minSize) continue;
      // box_score_fast: mean prob over the filled rectangle (inclusive bounds).
      var sum = 0.0;
      for (var y = minY; y <= maxY; y++) {
        for (var x = minX; x <= maxX; x++) {
          sum += pred[y * width + x];
        }
      }
      final score = sum / ((maxX - minX + 1) * (maxY - minY + 1));
      if (_boxThresh > score) continue;
      final d = bw * bh * _unclipRatio / (2 * (bw + bh));
      // pyclipper rounds offset vertices half away from zero
      final ex0 = (minX - d).round(), ex1 = (maxX + d).round();
      final ey0 = (minY - d).round(), ey1 = (maxY + d).round();
      if (math.min(ex1 - ex0, ey1 - ey0) < _minSize + 2) continue;
      int sx(int v) => roundHalfEven(v / width * destW).clamp(0, destW);
      int sy(int v) => roundHalfEven(v / height * destH).clamp(0, destH);
      // filter_tag_det_res: clip to the last pixel, drop slivers
      final b = _Box(sx(ex0).clamp(0, destW - 1), sy(ey0).clamp(0, destH - 1), sx(ex1).clamp(0, destW - 1),
          sy(ey1).clamp(0, destH - 1));
      if (b.x1 - b.x0 <= 3 || b.y1 - b.y0 <= 3) continue;
      boxes.add(b);
    }
    return boxes;
  }

  /// RapidOCR.sorted_boxes: by top-left (y, x), then one bubble pass that swaps
  /// neighbours on (nearly) the same row into left-to-right order.
  static List<_Box> _sortedBoxes(List<_Box> boxes) {
    final idx = List.generate(boxes.length, (i) => i);
    idx.sort((a, b) {
      final c = boxes[a].y0.compareTo(boxes[b].y0);
      if (c != 0) return c;
      final d = boxes[a].x0.compareTo(boxes[b].x0);
      return d != 0 ? d : a.compareTo(b);
    });
    final out = [for (final i in idx) boxes[i]];
    for (var i = 0; i < out.length - 1; i++) {
      if ((out[i + 1].y0 - out[i].y0).abs() < 10 && out[i + 1].x0 < out[i].x0) {
        final t = out[i];
        out[i] = out[i + 1];
        out[i + 1] = t;
      }
    }
    return out;
  }

  /// get_rotate_crop_image for an axis-aligned box: the perspective warp is a pure
  /// translation onto integer pixels, so it is an exact crop.
  static RgbImage _crop(RgbImage img, _Box b) {
    final w = b.x1 - b.x0, h = b.y1 - b.y0;
    var crop = cropRgb(img, b.x0, b.y0, b.x0 + w, b.y0 + h);
    if (h / w >= 1.5) crop = rot90(crop);
    return crop;
  }

  // -------------------------------------------------------------- recognition

  /// TextRecognizer.__call__: sort by aspect ratio, batches of 6 padded to the widest
  /// crop in the batch, greedy CTC decode.
  List<(String, double)> _recognise(List<RgbImage> crops) {
    final ratios = [for (final c in crops) c.width / c.height];
    final order = List.generate(crops.length, (i) => i)
      ..sort((a, b) {
        final c = ratios[a].compareTo(ratios[b]);
        return c != 0 ? c : a.compareTo(b);
      });
    final res = List<(String, double)>.filled(crops.length, ('', 0.0));
    for (var beg = 0; beg < crops.length; beg += _recBatch) {
      final end = math.min(crops.length, beg + _recBatch);
      var maxRatio = 0.0;
      for (var k = beg; k < end; k++) {
        maxRatio = math.max(maxRatio, ratios[order[k]]);
      }
      // The installed rapidocr_onnxruntime starts max_wh_ratio at 0 (newer releases
      // start it at 320/48); this matches the server.
      final imgW = (_recH * maxRatio).truncate();
      final count = end - beg;
      final plane = _recH * imgW;
      final batch = Float32List(count * 3 * plane);
      for (var k = 0; k < count; k++) {
        _resizeNorm(crops[order[beg + k]], imgW, batch, k * 3 * plane);
      }
      final out = rec.run(rec.inputNames.first, batch, [count, 3, _recH, imgW]).values.first;
      final probs = out.$1, shape = out.$2;
      final t = shape[1], classes = shape[2];
      for (var k = 0; k < count; k++) {
        res[order[beg + k]] = _ctcDecode(probs, k * t * classes, t, classes);
      }
    }
    return res;
  }

  /// resize_norm_img: height 48, width ceil(48 * ratio) capped at the batch width,
  /// (x/255 - 0.5)/0.5 in BGR order, zero padded on the right.
  static void _resizeNorm(RgbImage img, int imgW, Float32List dst, int offset) {
    final ratio = img.width / img.height;
    final want = (_recH * ratio).ceil();
    final rw = want > imgW ? imgW : want;
    final r = resizeLinearCv(img, rw, _recH);
    final plane = _recH * imgW;
    for (var y = 0; y < _recH; y++) {
      for (var x = 0; x < rw; x++) {
        final p = (y * rw + x) * 3;
        for (var c = 0; c < 3; c++) {
          dst[offset + c * plane + y * imgW + x] = (r.rgb[p + 2 - c] / 255.0 - 0.5) / 0.5;
        }
      }
    }
  }

  /// CTCLabelDecode: argmax per step, drop blanks and repeats; the confidence is
  /// np.mean(confs + [1e-50]), i.e. sum / (n + 1).
  (String, double) _ctcDecode(Float32List p, int off, int t, int classes) {
    final sb = StringBuffer();
    var sum = 0.0, n = 0, prev = -1;
    for (var s = 0; s < t; s++) {
      final base = off + s * classes;
      var best = 0;
      var bv = p[base];
      for (var c = 1; c < classes; c++) {
        if (p[base + c] > bv) {
          bv = p[base + c];
          best = c;
        }
      }
      final dup = s > 0 && best == prev;
      prev = best;
      if (best == 0 || dup) continue;
      sb.write(best < _chars.length ? _chars[best] : '');
      sum += bv;
      n++;
    }
    return (sb.toString(), (sum + 1e-50) / (n + 1));
  }
}
