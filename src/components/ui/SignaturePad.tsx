import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

interface SignaturePadProps {
  onChange: (dataUrl: string | null) => void;
}

/**
 * A recipient signature captured on a canvas — Proof of Delivery, alongside
 * (or instead of) a photo. Uses Pointer Events so finger/stylus/mouse all work
 * uniformly on a tablet. Exports a PNG data URL, stored the same way a photo
 * is (as an Attachment) — see the Attachment model / signatureAttachmentId.
 */
export function SignaturePad({ onChange }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const hasDrawnRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  function fillWhite() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  useEffect(() => {
    fillWhite();
  }, []);

  function getPoint(e: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastPointRef.current = getPoint(e);
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    const last = lastPointRef.current;
    if (!ctx || !last) return;
    const point = getPoint(e);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
    hasDrawnRef.current = true;
  }

  function handlePointerUp() {
    drawingRef.current = false;
    lastPointRef.current = null;
    if (hasDrawnRef.current) {
      onChange(canvasRef.current!.toDataURL('image/png'));
    }
  }

  function clear() {
    fillWhite();
    hasDrawnRef.current = false;
    onChange(null);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={600}
        height={220}
        className="w-full touch-none rounded-2xl border border-(--border-subtle) bg-white"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      />
      <button type="button" onClick={clear} className="mt-2 text-sm text-(--text-tertiary) underline">
        Clear signature
      </button>
    </div>
  );
}
