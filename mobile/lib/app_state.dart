import 'package:flutter/foundation.dart';

import 'engine/types.dart';
import 'engine/worker.dart';

/// One finished inspection, for the recent list on the home screen.
class Inspection {
  Inspection({required this.title, required this.summary, required this.kind, required this.ms,
      required this.thumbnail, required this.good});
  final String title;
  final String summary;
  final String kind; // 'damage' | 'plate' | 'vin' | 'odometer'
  final int ms;
  final Uint8List thumbnail; // encoded image bytes
  final bool good; // read cleanly / no damage
  final DateTime at = DateTime.now();
}

class AppState extends ChangeNotifier {
  EngineHost? host;
  String stage = 'Starting';
  String? error;
  Accelerator accelerator = Accelerator.xnnpack;
  int threads = 4;
  DamageMode damageMode = DamageMode.quick;
  final List<Inspection> history = [];

  Future<void> boot() async {
    error = null;
    host?.dispose();
    host = null;
    notifyListeners();
    try {
      host = await EngineHost.start(
        accelerator: accelerator,
        threads: threads,
        onStage: (s) {
          stage = s;
          notifyListeners();
        },
      );
    } catch (e) {
      error = '$e';
    }
    notifyListeners();
  }

  void record(Inspection i) {
    history.insert(0, i);
    if (history.length > 20) history.removeLast();
    notifyListeners();
  }

  void setAccelerator(Accelerator a) {
    if (a == accelerator) return;
    accelerator = a;
    boot();
  }

  void setThreads(int n) {
    if (n == threads) return;
    threads = n;
    boot();
  }

  void setDamageMode(DamageMode m) {
    damageMode = m;
    notifyListeners();
  }
}

/// App-wide state, created once in main().
final app = AppState();
