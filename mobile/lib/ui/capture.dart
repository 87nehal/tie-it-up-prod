import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';

import '../engine/types.dart';
import '../engine/worker.dart';
import 'theme.dart';

/// A photo ready for the engines: the encoded bytes (for display) and packed RGB.
class Picked {
  Picked(this.bytes, this.rgb, this.label);
  final Uint8List bytes;
  final RgbImage rgb;
  final String label;
}

class Sample {
  const Sample(this.asset, this.title, this.subtitle);
  final String asset;
  final String title;
  final String subtitle;
}

const damageSamples = [
  Sample('assets/samples/damage_blue_fender.jpg', 'Dented fender', 'Field photo · blue hatchback'),
  Sample('assets/samples/damage_torn_bumper.jpg', 'Torn bumper', 'Field photo · rear bumper'),
  Sample('assets/samples/damage_red_suzuki_clean.jpg', 'Showroom car', 'Clean reference · red Suzuki'),
];

const gateSamples = {
  CaptureKind.plate: [Sample('assets/samples/gate_plate.jpg', 'Number plate', 'HR 51 NY 9785 · gate camera')],
  CaptureKind.vin: [Sample('assets/samples/gate_vin.jpg', 'VIN sticker', 'Grand Vitara · door pillar')],
  CaptureKind.odometer: [
    Sample('assets/samples/gate_odometer.jpg', 'Digital odometer', 'Gate capture'),
    Sample('assets/samples/odometer_maruti_cluster.png', 'Maruti cluster', 'Analogue dials + LCD'),
    Sample('assets/samples/odometer_lcd.png', 'LCD cluster', 'Seven-segment display'),
  ],
};

const maxSide = 1600; // same cap the server's OCR applies

/// Decodes to upright RGB, longest side capped at [maxSide].
Future<RgbImage> decodeRgb(Uint8List bytes) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
  final desc = await ui.ImageDescriptor.encoded(buffer);
  final scale = maxSide / (desc.width > desc.height ? desc.width : desc.height);
  final codec = scale < 1
      ? await desc.instantiateCodec(targetWidth: (desc.width * scale).round(), targetHeight: (desc.height * scale).round())
      : await desc.instantiateCodec();
  final frame = await codec.getNextFrame();
  final img = frame.image;
  final data = await img.toByteData(format: ui.ImageByteFormat.rawRgba);
  final rgb = rgbFromRgba(data!.buffer.asUint8List(), img.width, img.height);
  img.dispose();
  codec.dispose();
  desc.dispose();
  buffer.dispose();
  return rgb;
}

/// Bottom sheet: camera, gallery or a bundled demo photo.
Future<Picked?> pickPhoto(BuildContext context, {required String title, required List<Sample> samples}) async {
  final choice = await showModalBottomSheet<Object>(
    context: context,
    showDragHandle: true,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
    builder: (context) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          const Text('Photos stay on this phone. Nothing is uploaded.', style: TextStyle(color: Brand.muted)),
          const SizedBox(height: 16),
          Row(children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: () => Navigator.pop(context, ImageSource.camera),
                icon: const Icon(Icons.photo_camera_rounded),
                label: const Text('Camera'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => Navigator.pop(context, ImageSource.gallery),
                icon: const Icon(Icons.photo_library_outlined),
                label: const Text('Gallery'),
              ),
            ),
          ]),
          const SizedBox(height: 18),
          const Text('DEMO PHOTOS', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 1.1, color: Brand.muted)),
          const SizedBox(height: 8),
          for (final s in samples)
            ListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 4),
              leading: ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.asset(s.asset, width: 56, height: 42, fit: BoxFit.cover),
              ),
              title: Text(s.title, style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text(s.subtitle),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => Navigator.pop(context, s),
            ),
        ]),
      ),
    ),
  );
  if (choice == null) return null;
  Uint8List bytes;
  String label;
  if (choice is Sample) {
    bytes = (await rootBundle.load(choice.asset)).buffer.asUint8List();
    label = choice.title;
  } else {
    // image_picker bakes the EXIF rotation in and downsizes, so the RGB is upright
    final file = await ImagePicker().pickImage(
        source: choice as ImageSource, maxWidth: 2400, maxHeight: 2400, imageQuality: 95);
    if (file == null) return null;
    bytes = await file.readAsBytes();
    label = choice == ImageSource.camera ? 'Camera photo' : 'Gallery photo';
  }
  return Picked(bytes, await decodeRgb(bytes), label);
}
