import 'package:flutter/material.dart';

/// Maruti Suzuki DMS palette, shared with the web workspace (frontend/app/globals.css).
class Brand {
  static const blue = Color(0xFF1B3A93);
  static const navy = Color(0xFF0C1745);
  static const navyDeep = Color(0xFF10205F);
  static const red = Color(0xFFE3001B);
  static const bg = Color(0xFFF3F5FA);
  static const card = Colors.white;
  static const ink = Color(0xFF0F1631);
  static const muted = Color(0xFF626C86);
  static const line = Color(0xFFE3E7F0);
  static const accent = Color(0xFFE9EEFB);
  static const success = Color(0xFF15A34A);
  static const warning = Color(0xFFF08C00);
  static const info = Color(0xFF2F6FE4);

  static const heroGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF10205F), Color(0xFF1B3A93), Color(0xFF2449B5)],
  );
}

ThemeData buildTheme() {
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(seedColor: Brand.blue, primary: Brand.blue, secondary: Brand.red,
        surface: Brand.card, brightness: Brightness.light),
    scaffoldBackgroundColor: Brand.bg,
    fontFamily: 'Roboto',
  );
  return base.copyWith(
    appBarTheme: const AppBarTheme(
      backgroundColor: Brand.bg,
      foregroundColor: Brand.ink,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(color: Brand.ink, fontSize: 18, fontWeight: FontWeight.w600, letterSpacing: -.3),
    ),
    textTheme: base.textTheme.apply(bodyColor: Brand.ink, displayColor: Brand.ink),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Brand.blue,
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Brand.ink,
        side: const BorderSide(color: Brand.line),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontWeight: FontWeight.w600),
      ),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
      ),
    ),
    dividerTheme: const DividerThemeData(color: Brand.line, space: 1),
  );
}
