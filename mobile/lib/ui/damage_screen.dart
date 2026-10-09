import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../engine/damage.dart';
import '../engine/types.dart';
import 'capture.dart';
import 'theme.dart';
import 'widgets.dart';

const classColors = {
  'dent': Color(0xFFE3001B),
  'scratch': Color(0xFFF08C00),
  'crack_or_breakage': Color(0xFF7C3AED),
  'paint_damage': Color(0xFF2F6FE4),
  'deformation_or_detachment': Color(0xFF0EA5A4),
};

String classLabel(String c) => switch (c) {
      'dent' => 'Dent',
      'scratch' => 'Scratch',
      'crack_or_breakage' => 'Crack / breakage',
      'paint_damage' => 'Paint damage',
      'deformation_or_detachment' => 'Deformation / detached part',
      _ => c,
    };

class DamageScreen extends StatefulWidget {
  const DamageScreen({super.key});
  @override
  State<DamageScreen> createState() => _DamageScreenState();
}

class _DamageScreenState extends State<DamageScreen> {
  Picked? _photo;
  DamageResult? _result;
  ui.Image? _overlay;
  List<DamageRegion> _regions = const [];
  bool _busy = false;
  bool _showOverlay = true;
  String _progress = '';
  int _wallMs = 0;
  String? _error;

  Future<void> _pick() async {
    final p = await pickPhoto(context, title: 'Photo of the vehicle', samples: damageSamples);
    if (p == null || !mounted) return;
    setState(() {
      _photo = p;
      _result = null;
      _overlay = null;
    });
    await _run();
  }

  Future<void> _run() async {
    final photo = _photo;
    if (photo == null) return;
    setState(() {
      _busy = true;
      _error = null;
      _progress = 'Preparing photo';
    });
    final sw = Stopwatch()..start();
    try {
      final r = await app.host!.damage(photo.rgb, app.damageMode, onProgress: (done, total) {
        if (mounted) setState(() => _progress = 'Analysing section ${done + 1 > total ? total : done + 1} of $total');
      });
      _wallMs = sw.elapsedMilliseconds;
      final overlay = await _toImage(overlayRgba(r), r.width, r.height);
      if (!mounted) return;
      setState(() {
        _result = r;
        _overlay = overlay;
        _regions = regions(r);
      });
      app.record(Inspection(
        title: 'Damage · ${photo.label}',
        summary: _headline(r).$1,
        kind: 'damage',
        ms: _wallMs,
        thumbnail: photo.bytes,
        good: r.decision == 'no_damage_detected',
      ));
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<ui.Image> _toImage(Uint8List rgba, int w, int h) {
    final c = Completer<ui.Image>();
    ui.decodeImageFromPixels(rgba, w, h, ui.PixelFormat.rgba8888, c.complete);
    return c.future;
  }

  (String, String, Color, IconData) _headline(DamageResult r) => switch (r.decision) {
        'damage_detected' => (
            '${_regions.isEmpty ? 'Damage' : '${_regions.length} damage area${_regions.length == 1 ? '' : 's'}'} found',
            'Marked on the photo. Record it on the arrival sheet with the customer.',
            Brand.red,
            Icons.report_rounded
          ),
        'no_damage_detected' => (
            'No damage found',
            'No dents, scratches or cracks above the calibrated threshold.',
            Brand.success,
            Icons.verified_rounded
          ),
        'recapture_required' => (
            'Retake the photo',
            'The photo is too dark, blurred or small to judge reliably.',
            Brand.muted,
            Icons.photo_camera_back_rounded
          ),
        // borderline photo but the model still marked damage: say what it found
        _ when r.damageFraction > 0 => (
            '${_regions.isEmpty ? 'Damage' : '${_regions.length} damage area${_regions.length == 1 ? '' : 's'}'} found',
            'Advisor to confirm: ${r.reasons.map(_reasonLabel).join(', ').toLowerCase()}.',
            Brand.red,
            Icons.report_rounded
          ),
        _ => (
            'Advisor to review',
            'Some areas are borderline. The AI does not decide; a person checks.',
            Brand.warning,
            Icons.visibility_rounded
          ),
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Damage walk-around'), actions: const [
        Padding(padding: EdgeInsets.only(right: 12), child: OfflineBadge()),
      ]),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 120), children: [
        _photoPanel(),
        const SizedBox(height: 12),
        _modePicker(),
        if (_error != null) ...[
          const SizedBox(height: 12),
          Panel(child: Text(_error!, style: const TextStyle(color: Brand.red), maxLines: 8)),
        ],
        if (_result != null) ..._resultPanels(_result!),
      ]),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: FilledButton.icon(
            onPressed: _busy ? null : _pick,
            icon: const Icon(Icons.photo_camera_rounded),
            label: Text(_photo == null ? 'Take or choose a photo' : 'Inspect another photo'),
          ),
        ),
      ),
    );
  }

  Widget _photoPanel() {
    final photo = _photo;
    if (photo == null) {
      return Panel(
        onTap: _pick,
        padding: const EdgeInsets.symmetric(vertical: 42, horizontal: 20),
        child: Column(children: [
          Container(
            width: 72,
            height: 72,
            decoration: BoxDecoration(color: Brand.red.withValues(alpha: .08), borderRadius: BorderRadius.circular(22)),
            child: const Icon(Icons.car_crash_outlined, size: 38, color: Brand.red),
          ),
          const SizedBox(height: 14),
          const Text('Photograph one side of the car', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text('Fill the frame with the panel. The model marks dents, scratches, cracks and paint damage.',
              textAlign: TextAlign.center, style: TextStyle(color: Brand.muted)),
        ]),
      );
    }
    final r = _result;
    final aspect = photo.rgb.width / photo.rgb.height;
    return ClipRRect(
      borderRadius: BorderRadius.circular(20),
      child: AspectRatio(
        aspectRatio: aspect,
        child: Stack(fit: StackFit.expand, children: [
          Image.memory(photo.bytes, fit: BoxFit.fill, gaplessPlayback: true),
          if (r != null && _overlay != null && _showOverlay)
            RawImage(image: _overlay, fit: BoxFit.fill, filterQuality: FilterQuality.medium),
          if (r != null && _showOverlay)
            CustomPaint(painter: _RegionPainter(_regions, r.width, r.height)),
          if (_busy) const ScanOverlay(),
          if (_busy)
            Positioned(
              left: 12,
              right: 12,
              bottom: 12,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(color: Brand.navy.withValues(alpha: .85), borderRadius: BorderRadius.circular(14)),
                child: Row(children: [
                  const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)),
                  const SizedBox(width: 10),
                  Expanded(child: Text(_progress, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600))),
                  const Text('on device', style: TextStyle(color: Colors.white60, fontSize: 12)),
                ]),
              ),
            ),
          if (r != null)
            Positioned(
              right: 10,
              top: 10,
              child: Material(
                color: Colors.black54,
                borderRadius: BorderRadius.circular(999),
                child: InkWell(
                  borderRadius: BorderRadius.circular(999),
                  onTap: () => setState(() => _showOverlay = !_showOverlay),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Icon(_showOverlay ? Icons.layers_rounded : Icons.layers_clear_rounded, size: 16, color: Colors.white),
                      const SizedBox(width: 6),
                      Text(_showOverlay ? 'Damage on' : 'Damage off', style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600)),
                    ]),
                  ),
                ),
              ),
            ),
        ]),
      ),
    );
  }

  Widget _modePicker() => Row(children: [
        Expanded(
          child: SegmentedButton<DamageMode>(
            segments: const [
              ButtonSegment(value: DamageMode.quick, label: Text('Quick'), icon: Icon(Icons.bolt_rounded)),
              ButtonSegment(value: DamageMode.thorough, label: Text('Thorough'), icon: Icon(Icons.manage_search_rounded)),
            ],
            selected: {app.damageMode},
            onSelectionChanged: _busy
                ? null
                : (s) {
                    app.setDamageMode(s.first);
                    setState(() {});
                    if (_photo != null) _run();
                  },
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            app.damageMode == DamageMode.quick
                ? 'One pass at 768 px. Fastest.'
                : 'Higher resolution, overlapping sections, mirrored check.',
            style: const TextStyle(fontSize: 12, color: Brand.muted),
          ),
        ),
      ]);

  List<Widget> _resultPanels(DamageResult r) {
    final (title, sub, color, icon) = _headline(r);
    final model = r.timings['model'] ?? 0;
    final types = r.typeFractions.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    final maxShare = types.isEmpty ? 1.0 : types.first.value;
    return [
      const SizedBox(height: 14),
      Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: color.withValues(alpha: .08),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: color.withValues(alpha: .3)),
        ),
        child: Row(children: [
          Icon(icon, color: color, size: 32),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: color)),
              const SizedBox(height: 2),
              Text(sub, style: const TextStyle(fontSize: 13, color: Brand.ink)),
            ]),
          ),
        ]),
      ),
      if (types.isNotEmpty) ...[
        const SectionTitle('What was found'),
        Panel(
          child: Column(children: [
            for (final t in types)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 7),
                child: Row(children: [
                  Container(width: 12, height: 12, decoration: BoxDecoration(color: classColors[t.key], borderRadius: BorderRadius.circular(3))),
                  const SizedBox(width: 10),
                  SizedBox(width: 150, child: Text(classLabel(t.key), style: const TextStyle(fontWeight: FontWeight.w600))),
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(99),
                      child: LinearProgressIndicator(
                        value: t.value / maxShare,
                        minHeight: 7,
                        backgroundColor: Brand.line,
                        color: classColors[t.key],
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text('${(t.value * 100).toStringAsFixed(1)}%', style: const TextStyle(fontSize: 12, color: Brand.muted)),
                ]),
              ),
            const SizedBox(height: 4),
            Text('${_regions.length} marked area${_regions.length == 1 ? '' : 's'} · share of the photo covered by each damage type',
                style: const TextStyle(fontSize: 11.5, color: Brand.muted)),
          ]),
        ),
      ],
      if (r.reasons.isNotEmpty) ...[
        const SectionTitle('Why'),
        Panel(
          child: Wrap(spacing: 6, runSpacing: 6, children: [
            for (final reason in r.reasons) Pill(_reasonLabel(reason), color: Brand.warning),
          ]),
        ),
      ],
      const SectionTitle('Ran on this phone'),
      Panel(
        child: Column(children: [
          Row(children: [
            Expanded(child: Stat(ms(_wallMs), 'total time')),
            Expanded(child: Stat(ms(model), 'model compute')),
            Expanded(child: Stat('${r.passes}', r.passes == 1 ? 'model pass' : 'model passes')),
          ]),
          const Divider(height: 24),
          Row(children: [
            const Icon(Icons.memory_rounded, size: 16, color: Brand.blue),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                'DINOv2 ViT-S/14 int8 · ${r.width}×${r.height} px · ${acceleratorLabel(app.host!.status.models.first.accelerator)}',
                style: const TextStyle(fontSize: 12, color: Brand.muted),
              ),
            ),
          ]),
          const SizedBox(height: 6),
          Row(children: [
            const Icon(Icons.tune_rounded, size: 16, color: Brand.blue),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                'Photo quality: sharpness ${(r.quality['sharpness'] ?? 0).toStringAsFixed(4)} · dark ${_pct(r.quality['dark'])} · glare ${_pct(r.quality['specular'])}',
                style: const TextStyle(fontSize: 12, color: Brand.muted),
              ),
            ),
          ]),
        ]),
      ),
    ];
  }

  String _pct(double? v) => '${((v ?? 0) * 100).toStringAsFixed(1)}%';

  String _reasonLabel(String r) => switch (r) {
        'excessive_near_threshold_area' => 'Many borderline areas',
        'quality:possible_specular_glare' => 'Reflections on paint',
        'quality:low_resolution' || 'low_resolution' => 'Photo too small',
        'quality:underexposed' || 'underexposed' => 'Too dark',
        'quality:blur_or_low_detail' || 'blur_or_low_detail' => 'Blurred',
        'quality:excessive_glare_or_overexposure' || 'excessive_glare_or_overexposure' => 'Overexposed',
        _ => r.replaceAll('_', ' ').replaceAll('quality:', ''),
      };
}

class _RegionPainter extends CustomPainter {
  _RegionPainter(this.regions, this.w, this.h);
  final List<DamageRegion> regions;
  final int w;
  final int h;
  @override
  void paint(Canvas canvas, Size size) {
    final sx = size.width / w, sy = size.height / h;
    for (final (i, r) in regions.take(8).indexed) {
      final color = classColors[r.cls] ?? Brand.red;
      final rect = Rect.fromLTRB(r.left * sx, r.top * sy, r.right * sx, r.bottom * sy).inflate(4);
      canvas.drawRRect(RRect.fromRectAndRadius(rect, const Radius.circular(6)), Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5);
      final tp = TextPainter(
        text: TextSpan(text: ' ${i + 1} ${classLabel(r.cls)} ', style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700)),
        textDirection: TextDirection.ltr,
      )..layout();
      final label = Rect.fromLTWH(rect.left, (rect.top - tp.height - 2).clamp(0, size.height), tp.width, tp.height);
      canvas.drawRRect(RRect.fromRectAndRadius(label, const Radius.circular(4)), Paint()..color = color);
      tp.paint(canvas, label.topLeft);
    }
  }

  @override
  bool shouldRepaint(covariant _RegionPainter o) => o.regions != regions;
}
