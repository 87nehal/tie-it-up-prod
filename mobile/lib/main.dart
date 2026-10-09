import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_state.dart';
import 'ui/home.dart';
import 'ui/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(statusBarColor: Colors.transparent));
  app.boot();
  runApp(const InspectApp());
}

class InspectApp extends StatelessWidget {
  const InspectApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'MSIL Inspect',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(),
        home: ListenableBuilder(
          listenable: app,
          builder: (context, _) => app.host == null ? const Splash() : const HomeScreen(),
        ),
      );
}

/// Shown while the models load into the inference isolate (a few seconds, first launch only).
class Splash extends StatelessWidget {
  const Splash({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        body: Container(
          decoration: const BoxDecoration(gradient: Brand.heroGradient),
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Spacer(),
                Container(
                  width: 64,
                  height: 64,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(colors: [Color(0xFFFF2A3D), Color(0xFFB80016)]),
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: const Text('MS', style: TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w900)),
                ),
                const SizedBox(height: 22),
                const Text('Maruti Suzuki', style: TextStyle(color: Colors.white, fontSize: 30, fontWeight: FontWeight.w700, letterSpacing: -.8)),
                const Text('DMS Inspect', style: TextStyle(color: Colors.white70, fontSize: 18)),
                const SizedBox(height: 26),
                if (app.error == null) ...[
                  const SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white)),
                  const SizedBox(height: 14),
                  Text(app.stage, style: const TextStyle(color: Colors.white)),
                  const SizedBox(height: 4),
                  const Text('Loading the AI models into this phone. No internet needed.',
                      style: TextStyle(color: Colors.white60, fontSize: 13)),
                ] else ...[
                  Text(app.error!, maxLines: 6, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white)),
                  const SizedBox(height: 12),
                  FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: Brand.navy),
                    onPressed: app.boot,
                    child: const Text('Try again'),
                  ),
                ],
                const Spacer(flex: 2),
              ]),
            ),
          ),
        ),
      );
}
