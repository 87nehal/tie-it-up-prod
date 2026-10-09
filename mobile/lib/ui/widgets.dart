import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../engine/types.dart';
import 'theme.dart';

/// White rounded card used across the app (mirrors the web cards).
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.onTap});
  final Widget child;
  final EdgeInsets padding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final box = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: Brand.card,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: Brand.line),
        boxShadow: const [BoxShadow(color: Color(0x0A141C3C), blurRadius: 10, offset: Offset(0, 2))],
      ),
      child: child,
    );
    if (onTap == null) return box;
    return Material(
      color: Colors.transparent,
      child: InkWell(borderRadius: BorderRadius.circular(20), onTap: onTap, child: box),
    );
  }
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key, this.trailing});
  final String text;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 20, 4, 10),
        child: Row(children: [
          Expanded(
            child: Text(text.toUpperCase(),
                style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 1.1, color: Brand.muted)),
          ),
          ?trailing,
        ]),
      );
}

/// Small rounded label.
class Pill extends StatelessWidget {
  const Pill(this.text, {super.key, this.color = Brand.blue, this.icon, this.solid = false});
  final String text;
  final Color color;
  final IconData? icon;
  final bool solid;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
        decoration: BoxDecoration(
          color: solid ? color : color.withValues(alpha: .1),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (icon != null) ...[Icon(icon, size: 13, color: solid ? Colors.white : color), const SizedBox(width: 4)],
          Text(text,
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: solid ? Colors.white : color)),
        ]),
      );
}

/// "Runs on this phone" badge.
class OfflineBadge extends StatelessWidget {
  const OfflineBadge({super.key, this.dark = false});
  final bool dark;
  @override
  Widget build(BuildContext context) {
    final fg = dark ? Colors.white : Brand.success;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: dark ? Colors.white.withValues(alpha: .12) : Brand.success.withValues(alpha: .1),
        borderRadius: BorderRadius.circular(999),
        border: dark ? Border.all(color: Colors.white24) : null,
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.wifi_off_rounded, size: 14, color: fg),
        const SizedBox(width: 5),
        Text('On-device · no internet', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: fg)),
      ]),
    );
  }
}

/// Indian registration plate.
class PlateView extends StatelessWidget {
  const PlateView(this.reg, {super.key, this.large = false});
  final String reg;
  final bool large;
  @override
  Widget build(BuildContext context) {
    final fs = large ? 30.0 : 15.0;
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(large ? 8 : 5),
        border: Border.all(color: const Color(0xFF111111), width: large ? 2.5 : 1.5),
        boxShadow: const [BoxShadow(color: Color(0x22000000), blurRadius: 6, offset: Offset(0, 2))],
      ),
      child: IntrinsicHeight(
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Container(
            color: const Color(0xFF1D3FB0),
            padding: EdgeInsets.symmetric(horizontal: large ? 6 : 3),
            alignment: Alignment.center,
            child: Text('IND',
                style: TextStyle(color: Colors.white, fontSize: large ? 10 : 6, fontWeight: FontWeight.w800)),
          ),
          Padding(
            padding: EdgeInsets.symmetric(horizontal: large ? 14 : 7, vertical: large ? 6 : 2),
            child: Text(reg,
                style: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: fs,
                    fontWeight: FontWeight.w800,
                    letterSpacing: large ? 2 : 1,
                    color: const Color(0xFF111111))),
          ),
        ]),
      ),
    );
  }
}

/// Seven-segment-style odometer readout.
class OdometerView extends StatelessWidget {
  const OdometerView(this.km, {super.key});
  final int km;
  @override
  Widget build(BuildContext context) {
    final digits = km.toString().padLeft(6, '0');
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF0B1220),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF26324D), width: 2),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
        for (final d in digits.split(''))
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 2),
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
            decoration: BoxDecoration(color: const Color(0xFF131C2F), borderRadius: BorderRadius.circular(4)),
            child: Text(d,
                style: const TextStyle(
                    fontFamily: 'monospace', fontSize: 30, fontWeight: FontWeight.w700, color: Color(0xFF7CF3B4))),
          ),
        const SizedBox(width: 8),
        const Padding(
          padding: EdgeInsets.only(bottom: 6),
          child: Text('km', style: TextStyle(color: Color(0xFF7CF3B4), fontWeight: FontWeight.w700)),
        ),
      ]),
    );
  }
}

/// A stat line: big value, small label.
class Stat extends StatelessWidget {
  const Stat(this.value, this.label, {super.key, this.light = false});
  final String value;
  final String label;
  final bool light;
  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(value,
            style: TextStyle(
                fontSize: 22, fontWeight: FontWeight.w700, letterSpacing: -.6, color: light ? Colors.white : Brand.ink)),
        Text(label, style: TextStyle(fontSize: 11.5, color: light ? Colors.white70 : Brand.muted)),
      ]);
}

/// Animated scanning line over an image while the models run.
class ScanOverlay extends StatefulWidget {
  const ScanOverlay({super.key});
  @override
  State<ScanOverlay> createState() => _ScanOverlayState();
}

class _ScanOverlayState extends State<ScanOverlay> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1600))
    ..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _c,
        builder: (context, _) => CustomPaint(painter: _ScanPainter(_c.value), size: Size.infinite),
      );
}

class _ScanPainter extends CustomPainter {
  _ScanPainter(this.t);
  final double t;
  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(Offset.zero & size, Paint()..color = const Color(0x330C1745));
    final y = size.height * t;
    final band = Rect.fromLTWH(0, y - 60, size.width, 60);
    canvas.drawRect(
        band,
        Paint()
          ..shader = const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0x002F6FE4), Color(0x662F6FE4)],
          ).createShader(band));
    canvas.drawLine(Offset(0, y), Offset(size.width, y), Paint()
      ..color = const Color(0xFF7FA6FF)
      ..strokeWidth = 2);
    // corner brackets
    final p = Paint()
      ..color = Colors.white
      ..strokeWidth = 3
      ..style = PaintingStyle.stroke;
    const l = 26.0, m = 14.0;
    for (final c in [
      (m, m, 1, 1),
      (size.width - m, m, -1, 1),
      (m, size.height - m, 1, -1),
      (size.width - m, size.height - m, -1, -1)
    ]) {
      final (x, yy, dx, dy) = c;
      canvas.drawLine(Offset(x, yy), Offset(x + l * dx, yy), p);
      canvas.drawLine(Offset(x, yy), Offset(x, yy + l * dy), p);
    }
  }

  @override
  bool shouldRepaint(covariant _ScanPainter old) => old.t != t;
}

/// Ring gauge for a fraction (0..1).
class Ring extends StatelessWidget {
  const Ring(this.value, {super.key, this.color = Brand.blue, this.size = 54, this.label});
  final double value;
  final Color color;
  final double size;
  final String? label;
  @override
  Widget build(BuildContext context) => SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          painter: _RingPainter(value.clamp(0, 1), color),
          child: Center(
              child: Text(label ?? '${(value * 100).round()}%',
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700))),
        ),
      );
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.v, this.color);
  final double v;
  final Color color;
  @override
  void paint(Canvas canvas, Size s) {
    final r = Rect.fromLTWH(3, 3, s.width - 6, s.height - 6);
    canvas.drawArc(r, 0, 2 * math.pi, false, Paint()
      ..color = Brand.line
      ..strokeWidth = 5
      ..style = PaintingStyle.stroke);
    canvas.drawArc(r, -math.pi / 2, 2 * math.pi * v, false, Paint()
      ..color = color
      ..strokeWidth = 5
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke);
  }

  @override
  bool shouldRepaint(covariant _RingPainter o) => o.v != v || o.color != color;
}

String acceleratorLabel(Accelerator a) => switch (a) {
      Accelerator.xnnpack => 'XNNPACK CPU',
      Accelerator.nnapi => 'NNAPI (NPU/GPU)',
      Accelerator.cpu => 'CPU',
    };

String ms(int v) => v >= 1000 ? '${(v / 1000).toStringAsFixed(1)} s' : '$v ms';

String mb(int bytes) => '${(bytes / 1e6).toStringAsFixed(1)} MB';
