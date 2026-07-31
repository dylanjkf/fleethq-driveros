/**
 * Client-side image downscaling for Proof-of-Delivery / fault photos.
 *
 * A modern phone camera produces a 4–12 MP JPEG (several MB). Queued raw in the
 * offline outbox that (a) blows past the server's 8 MB attachment cap — which,
 * offline, only surfaces as a *poison* on replay — and (b) bloats IndexedDB by
 * ~33% (base64) per photo, a real quota risk on a 20-stop dead-zone run. A POD
 * photo needs to be legible, not full-resolution, so we re-encode it to a
 * capped edge length and moderate JPEG quality before it ever reaches state or
 * the queue.
 */

/** Longest-edge cap in px — legible for a delivery proof, tiny on the wire. */
const MAX_EDGE = 1600;
/** JPEG quality for the re-encode. */
const QUALITY = 0.7;

export interface CompressedImage {
  /** A `data:` URL (the same shape the capture flow already produced). */
  dataUrl: string;
  contentType: string;
  filename: string;
  /** Approximate decoded byte size — what the server's size cap measures. */
  bytes: number;
}

/** Approximate the decoded byte size of a base64 `data:` URL without decoding it. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image.'));
    img.src = dataUrl;
  });
}

function toJpgName(name: string | undefined): string {
  const base = (name ?? 'proof').replace(/\.[^.]+$/, '');
  return `${base || 'proof'}.jpg`;
}

/**
 * Downscale + re-encode an image file to a capped edge length. On any failure
 * (a non-image, a browser without canvas, a decode error) it falls back to the
 * original bytes rather than losing the capture — compression is an
 * optimisation, never a gate on recording a delivery.
 */
export async function compressImageFile(file: File, maxEdge = MAX_EDGE, quality = QUALITY): Promise<CompressedImage> {
  const original = await readAsDataUrl(file);
  const fallback: CompressedImage = {
    dataUrl: original,
    contentType: file.type || 'image/jpeg',
    filename: file.name || 'proof.jpg',
    bytes: dataUrlBytes(original),
  };
  if (!file.type.startsWith('image/')) return fallback;

  try {
    const img = await loadImage(original);
    const longest = Math.max(img.width, img.height) || 1;
    const scale = Math.min(1, maxEdge / longest);
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return fallback;
    ctx.drawImage(img, 0, 0, width, height);

    const compressed = canvas.toDataURL('image/jpeg', quality);
    // Guard against a tiny source that re-encodes larger than it started.
    if (!compressed.startsWith('data:image/jpeg') || compressed.length >= original.length) return fallback;
    return { dataUrl: compressed, contentType: 'image/jpeg', filename: toJpgName(file.name), bytes: dataUrlBytes(compressed) };
  } catch {
    return fallback;
  }
}
