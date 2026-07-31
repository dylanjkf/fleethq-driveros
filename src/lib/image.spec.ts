import { describe, expect, it } from 'vitest';
import { compressImageFile, dataUrlBytes } from './image';

describe('dataUrlBytes', () => {
  it('estimates decoded byte size from a base64 data URL', () => {
    // "hello" -> base64 "aGVsbG8=" (5 bytes, one pad char)
    expect(dataUrlBytes('data:text/plain;base64,aGVsbG8=')).toBe(5);
  });

  it('handles a bare base64 string and two-char padding', () => {
    // "hi" -> "aGk=" (2 bytes); "foobar" -> "Zm9vYmFy" (6 bytes, no pad)
    expect(dataUrlBytes('aGk=')).toBe(2);
    expect(dataUrlBytes('data:application/octet-stream;base64,Zm9vYmFy')).toBe(6);
  });
});

describe('compressImageFile', () => {
  it('passes a non-image file through untouched rather than losing the capture', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'note.txt', { type: 'text/plain' });
    const result = await compressImageFile(file);
    expect(result.contentType).toBe('text/plain');
    expect(result.filename).toBe('note.txt');
    expect(result.bytes).toBe(4);
    expect(result.dataUrl.startsWith('data:text/plain')).toBe(true);
  });
});
