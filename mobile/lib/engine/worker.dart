// Runs every model in one long-lived background isolate so inference never blocks the
// UI. The main isolate reads the model assets and hands the bytes over once; requests
// and results are plain Dart objects copied between isolates.

import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import 'dart:io';

import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';

import 'damage.dart';
import 'gate.dart';
import 'ort.dart';
import 'types.dart';

/// What loaded, where, and how long it took. Shown on the home and device screens.
class ModelInfo {
  ModelInfo(this.name, this.file, this.bytes, this.loadMs, this.accelerator);
  final String name;
  final String file;
  final int bytes;
  final int loadMs;
  final Accelerator accelerator;
}

class EngineStatus {
  EngineStatus(this.models, this.totalMs);
  final List<ModelInfo> models;
  final int totalMs;
}

const _assets = {
  'damage': ('Damage segmentation', 'assets/models/damage_int8.onnx'),
  'det': ('Text detection', 'assets/models/ocr_det.onnx'),
  'rec': ('Text recognition', 'assets/models/ocr_rec.onnx'),
  'reader': ('Cluster digit reader', 'assets/models/cluster_reader.onnx'),
};

class _Boot {
  _Boot(this.reply, this.models, this.profile, this.charset, this.ranker, this.accelerator, this.threads, this.breadcrumb);
  final SendPort reply;
  final Map<String, TransferableTypedData> models;
  final String profile;
  final String charset;
  final String ranker;
  final Accelerator accelerator;
  final int threads;
  final String breadcrumb;
}

class _Request {
  _Request(this.id, this.kind, this.image, {this.mode, this.capture});
  final int id;
  final String kind; // 'damage' | 'gate'
  final RgbImage image;
  final DamageMode? mode;
  final CaptureKind? capture;
}

class _Progress {
  _Progress(this.id, this.done, this.total);
  final int id;
  final int done;
  final int total;
}

class _Reply {
  _Reply(this.id, this.result, this.error);
  final int id;
  final Object? result;
  final String? error;
}

class EngineHost {
  EngineHost._(this._send, this._events, this.status, this._isolate, this.lastCrash);

  /// What was running when the app was last killed mid-inference, if it was.
  final String? lastCrash;

  final SendPort _send;
  final Stream<Object?> _events;
  final Isolate _isolate;
  final EngineStatus status;
  int _next = 0;

  /// Loads every model on a background isolate. [onStage] reports progress for the splash.
  static Future<EngineHost> start({
    Accelerator accelerator = Accelerator.xnnpack,
    int threads = 4,
    void Function(String stage)? onStage,
  }) async {
    final models = <String, TransferableTypedData>{};
    for (final e in _assets.entries) {
      onStage?.call('Reading ${e.value.$1}');
      final data = await rootBundle.load(e.value.$2);
      models[e.key] = TransferableTypedData.fromList([data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes)]);
    }
    final profile = await rootBundle.loadString('assets/models/damage_profile.json');
    final charset = await rootBundle.loadString('assets/models/ocr_charset.txt');
    final ranker = await rootBundle.loadString('assets/models/odometer_ranker.json');

    final crumb = '${(await getApplicationSupportDirectory()).path}${Platform.pathSeparator}inference_breadcrumb.txt';
    final crumbFile = File(crumb);
    final lastCrash = crumbFile.existsSync() ? crumbFile.readAsStringSync() : null;
    if (lastCrash != null) crumbFile.deleteSync();
    onStage?.call('Starting ONNX Runtime');
    final port = ReceivePort();
    final events = port.asBroadcastStream();
    final isolate = await Isolate.spawn(
      _main,
      _Boot(port.sendPort, models, profile, charset, ranker, accelerator, threads, crumb),
      debugName: 'inference',
    );
    final first = await events.first;
    if (first is String) throw StateError(first);
    final (send, status) = first as (SendPort, EngineStatus);
    return EngineHost._(send, events, status, isolate, lastCrash);
  }

  Future<T> _call<T>(_Request Function(int id) make, void Function(int, int)? onProgress) async {
    final id = _next++;
    final done = Completer<T>();
    late StreamSubscription<Object?> sub;
    sub = _events.listen((m) {
      if (m is _Progress && m.id == id) onProgress?.call(m.done, m.total);
      if (m is _Reply && m.id == id) {
        sub.cancel();
        m.error == null ? done.complete(m.result as T) : done.completeError(StateError(m.error!));
      }
    });
    _send.send(make(id));
    return done.future;
  }

  Future<DamageResult> damage(RgbImage image, DamageMode mode, {void Function(int done, int total)? onProgress}) =>
      _call((id) => _Request(id, 'damage', image, mode: mode), onProgress);

  Future<GateResult> gate(RgbImage image, CaptureKind kind) =>
      _call((id) => _Request(id, 'gate', image, capture: kind), null);

  void dispose() => _isolate.kill(priority: Isolate.immediate);
}

// ------------------------------------------------------------------ isolate side

Future<void> _main(_Boot boot) async {
  late final DamageEngine damage;
  late final GateEngine gate;
  breadcrumbPath = boot.breadcrumb;
  try {
    final infos = <ModelInfo>[];
    final loaded = <String, Model>{};
    final total = Stopwatch()..start();
    for (final e in boot.models.entries) {
      final bytes = e.value.materialize().asUint8List();
      final sw = Stopwatch()..start();
      File(boot.breadcrumb).writeAsStringSync('loading ${e.key} model', flush: true);
      // Only the damage model (fixed 768x768 input) uses the chosen accelerator. The OCR
      // detector/recogniser and digit reader take a new input shape on every photo and
      // every text line; on Android, XNNPACK with changing shapes crashed natively (app
      // closed on plate/VIN/odometer scans). They are small, so the plain CPU provider is fast.
      final accel = e.key == 'damage' ? boot.accelerator : Accelerator.cpu;
      final m = Model.load(e.key, bytes, accelerator: accel, threads: boot.threads);
      loaded[e.key] = m;
      infos.add(ModelInfo(_assets[e.key]!.$1, _assets[e.key]!.$2.split('/').last, bytes.length,
          sw.elapsedMilliseconds, m.accelerator));
    }
    damage = DamageEngine(loaded['damage']!, jsonDecode(boot.profile) as Map<String, dynamic>);
    gate = GateEngine(
      det: loaded['det']!,
      rec: loaded['rec']!,
      charset: const LineSplitter().convert(boot.charset),
      reader: loaded['reader']!,
      ranker: jsonDecode(boot.ranker) as Map<String, dynamic>,
    );
    _clearCrumb(boot.breadcrumb);
    final inbox = ReceivePort();
    boot.reply.send((inbox.sendPort, EngineStatus(infos, total.elapsedMilliseconds)));
    await for (final msg in inbox) {
      final r = msg as _Request;
      try {
        final Object result = r.kind == 'damage'
            ? damage.analyse(r.image, r.mode!, onProgress: (d, t) => boot.reply.send(_Progress(r.id, d, t)))
            : gate.read(r.image, r.capture!);
        boot.reply.send(_Reply(r.id, result, null));
        _clearCrumb(boot.breadcrumb);
      } catch (e, st) {
        boot.reply.send(_Reply(r.id, null, '$e\n$st'));
        _clearCrumb(boot.breadcrumb);
      }
    }
  } catch (e, st) {
    boot.reply.send('Could not load the on-device models: $e\n$st');
  }
}

void _clearCrumb(String path) {
  try {
    final f = File(path);
    if (f.existsSync()) f.deleteSync();
  } catch (_) {}
}

/// RGBA (as produced by dart:ui) to packed RGB.
RgbImage rgbFromRgba(Uint8List rgba, int width, int height) {
  final rgb = Uint8List(width * height * 3);
  for (var i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return RgbImage(width, height, rgb);
}
