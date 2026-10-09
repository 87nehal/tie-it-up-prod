import 'package:flutter/material.dart';

import '../app_state.dart';
import '../engine/types.dart';
import 'damage_screen.dart';
import 'device_screen.dart';
import 'gate_screen.dart';
import 'theme.dart';
import 'widgets.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  @override
  void initState() {
    super.initState();
    // The app was killed mid-inference last time: show where, so it can be reported.
    final crash = app.host?.lastCrash;
    if (crash != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => showDialog<void>(
            context: context,
            builder: (context) => AlertDialog(
              icon: const Icon(Icons.bug_report_rounded, color: Brand.red),
              title: const Text('The app closed during the last scan'),
              content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('It stopped while running:'),
                const SizedBox(height: 8),
                SelectableText(crash, style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w700)),
                const SizedBox(height: 12),
                const Text('Please send a screenshot of this to the developer.', style: TextStyle(color: Brand.muted)),
              ]),
              actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
            ),
          ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = app.host!.status;
    final totalBytes = status.models.fold<int>(0, (a, m) => a + m.bytes);
    return Scaffold(
      body: ListenableBuilder(
        listenable: app,
        builder: (context, _) => CustomScrollView(slivers: [
          SliverToBoxAdapter(child: _Hero(models: status.models.length, totalBytes: totalBytes, loadMs: status.totalMs)),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
            sliver: SliverList.list(children: [
              const SectionTitle('Inspect a vehicle'),
              _Action(
                icon: Icons.car_crash_outlined,
                color: Brand.red,
                title: 'Damage walk-around',
                subtitle: 'Dents, scratches, cracks and paint damage marked on the photo',
                tag: 'Segmentation',
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const DamageScreen())),
              ),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(child: _Tile(kind: CaptureKind.plate, icon: Icons.badge_outlined, title: 'Number plate', subtitle: 'Indian format check')),
                const SizedBox(width: 10),
                Expanded(child: _Tile(kind: CaptureKind.vin, icon: Icons.qr_code_2_rounded, title: 'VIN', subtitle: 'Check digit verified')),
                const SizedBox(width: 10),
                Expanded(child: _Tile(kind: CaptureKind.odometer, icon: Icons.speed_rounded, title: 'Odometer', subtitle: 'Picks the right number')),
              ]),
              const SectionTitle('On this phone'),
              Panel(
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const DeviceScreen())),
                child: Column(children: [
                  for (final m in status.models)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(children: [
                        Container(
                          width: 34,
                          height: 34,
                          decoration: BoxDecoration(color: Brand.accent, borderRadius: BorderRadius.circular(10)),
                          child: const Icon(Icons.memory_rounded, size: 18, color: Brand.blue),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(m.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                            Text('${m.file} · ${mb(m.bytes)}', style: const TextStyle(fontSize: 12, color: Brand.muted)),
                          ]),
                        ),
                        Pill(acceleratorLabel(m.accelerator), color: Brand.success),
                      ]),
                    ),
                  const Divider(height: 20),
                  const Row(children: [
                    Icon(Icons.verified_outlined, size: 18, color: Brand.blue),
                    SizedBox(width: 8),
                    Expanded(child: Text('Model self-test & speed benchmark', style: TextStyle(fontWeight: FontWeight.w600))),
                    Icon(Icons.chevron_right_rounded, color: Brand.muted),
                  ]),
                ]),
              ),
              if (app.history.isNotEmpty) ...[
                const SectionTitle('Recent'),
                Panel(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Column(children: [
                    for (final h in app.history.take(6))
                      ListTile(
                        leading: ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.memory(h.thumbnail, width: 52, height: 40, fit: BoxFit.cover, cacheWidth: 160),
                        ),
                        title: Text(h.title, style: const TextStyle(fontWeight: FontWeight.w600)),
                        subtitle: Text(h.summary, maxLines: 1, overflow: TextOverflow.ellipsis),
                        trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                          Icon(h.good ? Icons.check_circle_rounded : Icons.error_rounded, size: 18, color: h.good ? Brand.success : Brand.warning),
                          Text(ms(h.ms), style: const TextStyle(fontSize: 11, color: Brand.muted)),
                        ]),
                      ),
                  ]),
                ),
              ],
              const SizedBox(height: 18),
              const Center(
                child: Text('Development models · not production approved',
                    style: TextStyle(fontSize: 11.5, color: Brand.muted)),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.models, required this.totalBytes, required this.loadMs});
  final int models;
  final int totalBytes;
  final int loadMs;

  @override
  Widget build(BuildContext context) => Container(
        decoration: const BoxDecoration(
          gradient: Brand.heroGradient,
          borderRadius: BorderRadius.vertical(bottom: Radius.circular(28)),
        ),
        child: Stack(children: [
          Positioned(
            right: -50,
            top: -40,
            child: Container(
              width: 200,
              height: 200,
              decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: Colors.white12)),
            ),
          ),
          SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 20, 22),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Container(
                    width: 38,
                    height: 38,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(colors: [Color(0xFFFF2A3D), Color(0xFFB80016)]),
                      borderRadius: BorderRadius.circular(11),
                    ),
                    child: const Text('MS', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900)),
                  ),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Maruti Suzuki', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 16)),
                      Text('Sharma Motors · Sector 18 · ARENA', style: TextStyle(color: Colors.white70, fontSize: 12)),
                    ]),
                  ),
                ]),
                const SizedBox(height: 22),
                const Text('Vehicle inspection',
                    style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w700, letterSpacing: -.6)),
                const SizedBox(height: 4),
                const Text('Damage, number plate, VIN and odometer, read by AI running entirely on this phone.',
                    style: TextStyle(color: Colors.white70, height: 1.35)),
                const SizedBox(height: 14),
                const OfflineBadge(dark: true),
                const SizedBox(height: 18),
                Row(children: [
                  Expanded(child: Stat('$models', 'AI models on device', light: true)),
                  Expanded(child: Stat(mb(totalBytes), 'total model size', light: true)),
                  Expanded(child: Stat(ms(loadMs), 'to load', light: true)),
                ]),
              ]),
            ),
          ),
        ]),
      );
}

class _Action extends StatelessWidget {
  const _Action({required this.icon, required this.color, required this.title, required this.subtitle, required this.tag, required this.onTap});
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final String tag;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Panel(
        onTap: onTap,
        child: Row(children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(color: color.withValues(alpha: .1), borderRadius: BorderRadius.circular(16)),
            child: Icon(icon, color: color, size: 28),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700))),
                const SizedBox(width: 8),
                Pill(tag),
              ]),
              const SizedBox(height: 3),
              Text(subtitle, style: const TextStyle(color: Brand.muted, fontSize: 13)),
            ]),
          ),
          const Icon(Icons.chevron_right_rounded, color: Brand.muted),
        ]),
      );
}

class _Tile extends StatelessWidget {
  const _Tile({required this.kind, required this.icon, required this.title, required this.subtitle});
  final CaptureKind kind;
  final IconData icon;
  final String title;
  final String subtitle;
  @override
  Widget build(BuildContext context) => Panel(
        padding: const EdgeInsets.all(14),
        onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => GateScreen(kind: kind))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(color: Brand.accent, borderRadius: BorderRadius.circular(12)),
            child: Icon(icon, color: Brand.blue),
          ),
          const SizedBox(height: 12),
          Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text(subtitle, style: const TextStyle(fontSize: 11.5, color: Brand.muted)),
        ]),
      );
}
