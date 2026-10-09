import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../engine/types.dart';
import 'capture.dart';
import 'theme.dart';
import 'widgets.dart';

class GateScreen extends StatefulWidget {
  const GateScreen({super.key, required this.kind});
  final CaptureKind kind;
  @override
  State<GateScreen> createState() => _GateScreenState();
}

class _GateScreenState extends State<GateScreen> {
  Picked? _photo;
  GateResult? _result;
  bool _busy = false;
  int _wallMs = 0;
  String? _error;
  bool _showLines = false;

  String get _title => switch (widget.kind) {
        CaptureKind.plate => 'Number plate',
        CaptureKind.vin => 'VIN',
        CaptureKind.odometer => 'Odometer',
      };

  String get _hint => switch (widget.kind) {
        CaptureKind.plate => 'Frame the plate straight on. Read and checked against the Indian format.',
        CaptureKind.vin => 'Photograph the VIN sticker or chassis plate. The check digit is verified.',
        CaptureKind.odometer => 'Photograph the instrument cluster. The model picks the odometer from trip, clock and dial numbers.',
      };

  IconData get _icon => switch (widget.kind) {
        CaptureKind.plate => Icons.badge_outlined,
        CaptureKind.vin => Icons.qr_code_2_rounded,
        CaptureKind.odometer => Icons.speed_rounded,
      };

  Future<void> _pick() async {
    final p = await pickPhoto(context, title: 'Photo of the $_title'.toLowerCase().replaceFirst('photo', 'Photo'),
        samples: gateSamples[widget.kind]!);
    if (p == null || !mounted) return;
    setState(() {
      _photo = p;
      _result = null;
      _busy = true;
      _error = null;
    });
    final sw = Stopwatch()..start();
    try {
      final r = await app.host!.gate(p.rgb, widget.kind);
      _wallMs = sw.elapsedMilliseconds;
      if (!mounted) return;
      setState(() => _result = r);
      app.record(Inspection(
        title: '$_title · ${p.label}',
        summary: r.field == null ? 'Not read' : _display(r.field!),
        kind: widget.kind.name,
        ms: _wallMs,
        thumbnail: p.bytes,
        good: r.field != null && !r.checks.any((c) => c.$1 == 'error'),
      ));
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _display(FieldRead f) {
    if (widget.kind == CaptureKind.odometer) {
      final n = int.tryParse(f.value);
      return n == null ? f.value : '${_group(n)} km';
    }
    if (widget.kind == CaptureKind.plate) return _formatPlate(f.value);
    return f.value;
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(_title), actions: const [
          Padding(padding: EdgeInsets.only(right: 12), child: OfflineBadge()),
        ]),
        body: ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 120), children: [
          _photoPanel(),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Panel(child: Text(_error!, maxLines: 8, style: const TextStyle(color: Brand.red))),
          ],
          if (_result != null) ..._resultPanels(_result!),
        ]),
        bottomNavigationBar: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: FilledButton.icon(
              onPressed: _busy ? null : _pick,
              icon: const Icon(Icons.photo_camera_rounded),
              label: Text(_photo == null ? 'Take or choose a photo' : 'Read another'),
            ),
          ),
        ),
      );

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
            decoration: BoxDecoration(color: Brand.accent, borderRadius: BorderRadius.circular(22)),
            child: Icon(_icon, size: 38, color: Brand.blue),
          ),
          const SizedBox(height: 14),
          Text('Photograph the $_title'.replaceAll('the VIN', 'the VIN sticker'),
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(_hint, textAlign: TextAlign.center, style: const TextStyle(color: Brand.muted)),
        ]),
      );
    }
    final r = _result;
    return ClipRRect(
      borderRadius: BorderRadius.circular(20),
      child: AspectRatio(
        aspectRatio: photo.rgb.width / photo.rgb.height,
        child: Stack(fit: StackFit.expand, children: [
          Image.memory(photo.bytes, fit: BoxFit.fill, gaplessPlayback: true),
          if (r != null) CustomPaint(painter: _LinesPainter(r.lines, r.field?.source, photo.rgb.width, photo.rgb.height)),
          if (_busy) const ScanOverlay(),
        ]),
      ),
    );
  }

  List<Widget> _resultPanels(GateResult r) {
    final f = r.field;
    final total = r.timings.values.fold<int>(0, (a, b) => a + b);
    return [
      const SizedBox(height: 14),
      Panel(
        padding: const EdgeInsets.all(18),
        child: f == null
            ? Row(children: [
                const Icon(Icons.help_outline_rounded, color: Brand.warning, size: 30),
                const SizedBox(width: 12),
                Expanded(
                  child: Text('No $_title found in this photo. Try again closer and straight on.',
                      style: const TextStyle(fontWeight: FontWeight.w600)),
                ),
              ])
            : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Text('READ ON DEVICE',
                      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 1.1, color: Brand.muted)),
                  const Spacer(),
                  IconButton(
                    tooltip: 'Copy',
                    visualDensity: VisualDensity.compact,
                    onPressed: () {
                      Clipboard.setData(ClipboardData(text: f.value));
                      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Copied')));
                    },
                    icon: const Icon(Icons.copy_rounded, size: 18),
                  ),
                ]),
                const SizedBox(height: 6),
                Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
                  Expanded(child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: _value(f))),
                  const SizedBox(width: 12),
                  Ring(f.confidence, color: f.confidence >= .8 ? Brand.success : Brand.warning, label: '${(f.confidence * 100).round()}%'),
                ]),
                const SizedBox(height: 8),
                Text('From "${f.source}"', style: const TextStyle(fontSize: 12, color: Brand.muted)),
              ]),
      ),
      if (r.checks.isNotEmpty) ...[
        const SectionTitle('Checks'),
        Panel(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Column(children: [
            for (final (level, msg) in r.checks)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Icon(
                    level == 'ok' ? Icons.check_circle_rounded : level == 'error' ? Icons.cancel_rounded : Icons.error_rounded,
                    size: 18,
                    color: level == 'ok' ? Brand.success : level == 'error' ? Brand.red : Brand.warning,
                  ),
                  const SizedBox(width: 10),
                  Expanded(child: Text(msg)),
                ]),
              ),
          ]),
        ),
      ],
      const SectionTitle('Ran on this phone'),
      Panel(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Stat(ms(_wallMs), 'total time')),
            Expanded(child: Stat('${r.lines.length}', 'text lines found')),
            Expanded(child: Stat(ms(total), 'model compute')),
          ]),
          const Divider(height: 24),
          Wrap(spacing: 6, runSpacing: 6, children: [
            for (final e in r.timings.entries) Pill('${_stage(e.key)} ${ms(e.value)}', color: Brand.blue),
          ]),
          const SizedBox(height: 10),
          InkWell(
            onTap: () => setState(() => _showLines = !_showLines),
            child: Row(children: [
              Text(_showLines ? 'Hide all text read' : 'Show all text read',
                  style: const TextStyle(fontWeight: FontWeight.w600, color: Brand.blue)),
              Icon(_showLines ? Icons.expand_less_rounded : Icons.expand_more_rounded, color: Brand.blue),
            ]),
          ),
          if (_showLines)
            for (final l in r.lines)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Row(children: [
                  Expanded(child: Text(l.text, style: const TextStyle(fontFamily: 'monospace'))),
                  Text('${(l.confidence * 100).round()}%', style: const TextStyle(fontSize: 12, color: Brand.muted)),
                ]),
              ),
        ]),
      ),
    ];
  }

  Widget _value(FieldRead f) => switch (widget.kind) {
        CaptureKind.plate => PlateView(_formatPlate(f.value), large: true),
        CaptureKind.odometer => OdometerView(int.tryParse(f.value) ?? 0),
        CaptureKind.vin => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            RichText(
              text: TextSpan(
                style: const TextStyle(fontFamily: 'monospace', fontSize: 24, fontWeight: FontWeight.w800, color: Brand.ink, letterSpacing: 1.5),
                children: [
                  for (final (i, ch) in f.value.split('').indexed)
                    TextSpan(text: ch, style: i == 8 ? const TextStyle(color: Brand.success) : null),
                ],
              ),
            ),
            const SizedBox(height: 4),
            const Text('WMI · VDS · check digit (green) · VIS', style: TextStyle(fontSize: 11, color: Brand.muted)),
          ]),
      };

  String _stage(String k) => switch (k) {
        'detect' => 'Detect',
        'recognise' => 'Recognise',
        'reader' => 'Digit reader',
        'ranker' => 'Ranker',
        'extract' => 'Rules',
        _ => k,
      };
}

String _group(int n) {
  final s = n.toString();
  final b = StringBuffer();
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 == 0) b.write(',');
    b.write(s[i]);
  }
  return b.toString();
}

/// "HR51NY9785" -> "HR 51 NY 9785" (state, district, series, number).
String _formatPlate(String p) {
  final m = RegExp(r'^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$').firstMatch(p);
  if (m == null) return p;
  return [m[1], m[2], m[3], m[4]].where((s) => s != null && s.isNotEmpty).join(' ');
}

class _LinesPainter extends CustomPainter {
  _LinesPainter(this.lines, this.chosen, this.w, this.h);
  final List<OcrLine> lines;
  final String? chosen;
  final int w;
  final int h;
  @override
  void paint(Canvas canvas, Size size) {
    final sx = size.width / w, sy = size.height / h;
    for (final l in lines) {
      final hit = chosen != null && (l.text == chosen || chosen!.contains(l.text) || l.text.contains(chosen!));
      final rect = Rect.fromLTRB(l.x * sx, l.y0 * sy, l.x1 * sx, (l.y0 + l.h) * sy).inflate(hit ? 4 : 2);
      canvas.drawRRect(
          RRect.fromRectAndRadius(rect, const Radius.circular(5)),
          Paint()
            ..color = hit ? const Color(0xFF15A34A) : const Color(0xAAFFFFFF)
            ..style = PaintingStyle.stroke
            ..strokeWidth = hit ? 3 : 1.2);
      if (hit) {
        canvas.drawRRect(RRect.fromRectAndRadius(rect, const Radius.circular(5)), Paint()..color = const Color(0x2215A34A));
      }
    }
  }

  @override
  bool shouldRepaint(covariant _LinesPainter o) => o.lines != lines || o.chosen != chosen;
}
