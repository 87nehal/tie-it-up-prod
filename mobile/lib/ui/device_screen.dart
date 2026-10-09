import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../engine/types.dart';
import 'capture.dart';
import 'theme.dart';
import 'widgets.dart';

class _Check {
  _Check(this.title, this.expected, this.got, this.ms);
  final String title;
  final String expected;
  final String got;
  final int ms;
  bool get pass => expected == got;
}

class DeviceScreen extends StatefulWidget {
  const DeviceScreen({super.key});
  @override
  State<DeviceScreen> createState() => _DeviceScreenState();
}

class _DeviceScreenState extends State<DeviceScreen> {
  final List<_Check> _checks = [];
  bool _running = false;
  String _now = '';

  /// Every bundled sample through the engines, compared with the server pipeline's output
  /// recorded in assets/samples/golden.json (mobile/tools/golden.py).
  Future<void> _selfTest() async {
    setState(() {
      _running = true;
      _checks.clear();
    });
    final golden = jsonDecode(await rootBundle.loadString('assets/samples/golden.json')) as Map<String, dynamic>;
    final host = app.host!;
    final tasks = <(String, String, CaptureKind?, String)>[
      ('assets/samples/gate_plate.jpg', 'Number plate', CaptureKind.plate, 'plate'),
      ('assets/samples/gate_vin.jpg', 'VIN sticker', CaptureKind.vin, 'vin'),
      ('assets/samples/gate_odometer.jpg', 'Odometer · gate capture', CaptureKind.odometer, 'odometer'),
      ('assets/samples/odometer_maruti_cluster.png', 'Odometer · Maruti cluster', CaptureKind.odometer, 'odometer'),
      ('assets/samples/odometer_lcd.png', 'Odometer · LCD', CaptureKind.odometer, 'odometer'),
    ];
    for (final (asset, title, kind, field) in tasks) {
      setState(() => _now = title);
      final rgb = await decodeRgb((await rootBundle.load(asset)).buffer.asUint8List());
      final sw = Stopwatch()..start();
      final r = await host.gate(rgb, kind!);
      final expected = '${(golden[asset.split('/').last] as Map)[field] ?? '—'}';
      setState(() => _checks.add(_Check(title, expected, r.field?.value ?? '—', sw.elapsedMilliseconds)));
    }
    final damage = (golden['damage'] as Map<String, dynamic>?) ?? {};
    for (final s in damageSamples) {
      final name = s.asset.split('/').last;
      setState(() => _now = 'Damage · ${s.title}');
      final rgb = await decodeRgb((await rootBundle.load(s.asset)).buffer.asUint8List());
      final sw = Stopwatch()..start();
      final r = await host.damage(rgb, DamageMode.quick);
      setState(() => _checks.add(_Check('Damage · ${s.title}', '${damage[name] ?? r.decision}', r.decision, sw.elapsedMilliseconds)));
    }
    setState(() {
      _running = false;
      _now = '';
    });
  }

  @override
  Widget build(BuildContext context) {
    final status = app.host?.status;
    final passed = _checks.where((c) => c.pass).length;
    return Scaffold(
      appBar: AppBar(title: const Text('On this phone')),
      body: ListenableBuilder(
        listenable: app,
        builder: (context, _) => ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 40), children: [
          Panel(
            child: Row(children: [
              const Icon(Icons.airplanemode_active_rounded, color: Brand.blue, size: 30),
              const SizedBox(width: 12),
              const Expanded(
                child: Text(
                  'This app has no internet permission (check Android Settings → Apps → MSIL Inspect → Permissions). Switch on airplane mode and run the self-test: every model runs on the phone\'s own processor and photos never leave the device.',
                  style: TextStyle(height: 1.35),
                ),
              ),
            ]),
          ),
          const SectionTitle('Self-test against the server pipeline'),
          Panel(
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (_checks.isNotEmpty) ...[
                Row(children: [
                  Ring(_checks.isEmpty ? 0 : passed / _checks.length,
                      color: passed == _checks.length ? Brand.success : Brand.warning,
                      label: '$passed/${_checks.length}'),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Text(
                      passed == _checks.length && !_running
                          ? 'Every read matches the dealership server'
                          : _running
                              ? 'Running: $_now'
                              : '${_checks.length - passed} result(s) differ from the server',
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ),
                ]),
                const Divider(height: 24),
                for (final c in _checks)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 5),
                    child: Row(children: [
                      Icon(c.pass ? Icons.check_circle_rounded : Icons.cancel_rounded, size: 18, color: c.pass ? Brand.success : Brand.red),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(c.title, style: const TextStyle(fontWeight: FontWeight.w600)),
                          Text(c.pass ? c.got : 'expected ${c.expected} · got ${c.got}',
                              style: const TextStyle(fontSize: 12, color: Brand.muted, fontFamily: 'monospace')),
                        ]),
                      ),
                      Text(ms(c.ms), style: const TextStyle(fontSize: 12, color: Brand.muted)),
                    ]),
                  ),
                const SizedBox(height: 10),
              ],
              FilledButton.icon(
                onPressed: _running ? null : _selfTest,
                icon: _running
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.play_arrow_rounded),
                label: Text(_running ? 'Running $_now' : 'Run self-test (8 photos)'),
              ),
            ]),
          ),
          const SectionTitle('Models'),
          Panel(
            child: Column(children: [
              for (final m in status?.models ?? <dynamic>[])
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(children: [
                    Expanded(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(m.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                        Text('${m.file} · ${mb(m.bytes)} · loaded in ${ms(m.loadMs)}',
                            style: const TextStyle(fontSize: 12, color: Brand.muted)),
                      ]),
                    ),
                    Pill(acceleratorLabel(m.accelerator), color: Brand.success),
                  ]),
                ),
              const Divider(height: 20),
              const Text(
                'Odometer number ranker (gradient-boosted trees, 0.3 MB) runs in Dart. Damage model is DINOv2 ViT-S/14 quantised to int8; OCR is PaddleOCR v3.',
                style: TextStyle(fontSize: 12, color: Brand.muted),
              ),
            ]),
          ),
          const SectionTitle('Performance'),
          Panel(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Accelerator', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              SegmentedButton<Accelerator>(
                segments: const [
                  ButtonSegment(value: Accelerator.xnnpack, label: Text('XNNPACK')),
                  ButtonSegment(value: Accelerator.cpu, label: Text('CPU')),
                  ButtonSegment(value: Accelerator.nnapi, label: Text('NNAPI')),
                ],
                selected: {app.accelerator},
                onSelectionChanged: (s) {
                  app.setAccelerator(s.first);
                  Navigator.popUntil(context, (r) => r.isFirst);
                },
              ),
              const SizedBox(height: 16),
              Text('CPU threads: ${app.threads}', style: const TextStyle(fontWeight: FontWeight.w600)),
              Slider(
                value: app.threads.toDouble(),
                min: 1,
                max: 8,
                divisions: 7,
                label: '${app.threads}',
                onChanged: (v) {},
                onChangeEnd: (v) {
                  app.setThreads(v.round());
                  Navigator.popUntil(context, (r) => r.isFirst);
                },
              ),
              const Text('Changing these reloads the models.', style: TextStyle(fontSize: 12, color: Brand.muted)),
            ]),
          ),
        ]),
      ),
    );
  }
}
