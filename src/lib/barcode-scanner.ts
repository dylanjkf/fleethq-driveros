import { Capacitor } from '@capacitor/core';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';

/**
 * Camera barcode/QR scanning for DriverOS.
 *
 * DECISION — native plugin, not web-in-webview. `@capacitor-mlkit/barcode-scanning`
 * ships a Capacitor-8-compatible release (8.1.0, peerDependency `@capacitor/core
 * >=8.0.0`; DriverOS runs `@capacitor/core` 8.4.2), so per the brief we prefer
 * the native ML Kit scanner — it is materially stronger on real devices (better
 * low-light decode, hardware autofocus, no `getUserMedia`/`BarcodeDetector`
 * feature-detection gaps) than a web `BarcodeDetector` fallback would be.
 *
 * The native `scan()` presents its own full-screen scanning UI and resolves with
 * the decoded barcode(s); it rejects when the user backs out. On the plain web
 * build (dev in a browser, no native shell) the plugin is not available, so we
 * report `unsupported` and the caller keeps manual entry — which is ALWAYS
 * available regardless — as the path.
 *
 * NOTE: requires `npx cap sync` (adds the native plugin to the iOS/Android
 * projects) before a device build. Camera permission strings are already
 * declared: iOS `NSCameraUsageDescription` in Info.plist, Android
 * `android.permission.CAMERA` in AndroidManifest.xml. On Android the ML Kit
 * scanner module is downloaded on-demand by Google Play services the first time
 * `scan()` runs.
 */
export type BarcodeScanResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'permission' | 'unsupported' | 'noread' | 'cancelled'; message: string };

export async function scanBarcodeWithCamera(): Promise<BarcodeScanResult> {
  // No native shell (e.g. dev in a browser tab) → keep the driver on manual entry.
  if (!Capacitor.isNativePlatform()) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Camera scanning needs the installed app. Enter the barcode manually.',
    };
  }

  try {
    const { supported } = await BarcodeScanner.isSupported();
    if (!supported) {
      return {
        ok: false,
        reason: 'unsupported',
        message: "This device can't scan with the camera. Enter the barcode manually.",
      };
    }

    // (a) Permission denied → clear message; manual entry stays usable.
    const perm = await BarcodeScanner.requestPermissions();
    if (perm.camera !== 'granted' && perm.camera !== 'limited') {
      return {
        ok: false,
        reason: 'permission',
        message: 'Camera access is off. Enter the barcode manually, or allow the camera in Settings.',
      };
    }

    const { barcodes } = await BarcodeScanner.scan();
    const value = barcodes[0]?.rawValue || barcodes[0]?.displayValue;
    // (c) Poor lighting / nothing decoded.
    if (!value) {
      return { ok: false, reason: 'noread', message: "Couldn't read a barcode. Try again or enter it manually." };
    }
    return { ok: true, value };
  } catch {
    // scan() rejects when the driver backs out of the native scanner — not an
    // error to shout about; just fall quietly back to the form.
    return { ok: false, reason: 'cancelled', message: '' };
  }
}
