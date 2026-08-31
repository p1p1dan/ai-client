import { describe, expect, it, vi } from 'vitest';
import {
  EDITOR_PREVIEW_MAX_BYTES,
  type PreviewFileReadDependencies,
  readPreviewFile,
} from '../previewFileRead';

function dependencies(
  overrides: Partial<PreviewFileReadDependencies> = {}
): PreviewFileReadDependencies {
  return {
    statFile: async () => ({ size: 5 }),
    openFile: async () => ({
      read: async (buffer: Uint8Array) => {
        buffer.set(Buffer.from('hello'));
        return { bytesRead: 5, buffer };
      },
      close: async () => undefined,
    }),
    readBounded: async () => Buffer.from('hello'),
    detectBinary: async () => false,
    detectTsd: () => false,
    ...overrides,
  };
}

describe('readPreviewFile', () => {
  it('refuses an oversized text file before the full read is attempted', async () => {
    const readBounded = vi.fn(async () => Buffer.from('must not run'));
    const result = await readPreviewFile(
      '/workspace/huge.txt',
      EDITOR_PREVIEW_MAX_BYTES,
      dependencies({
        statFile: async () => ({ size: EDITOR_PREVIEW_MAX_BYTES + 1 }),
        readBounded,
      })
    );
    expect(result).toEqual({
      kind: 'too-large',
      byteLength: EDITOR_PREVIEW_MAX_BYTES + 1,
      maxBytes: EDITOR_PREVIEW_MAX_BYTES,
    });
    expect(readBounded).not.toHaveBeenCalled();
  });

  it('classifies a binary file from the bounded head without reading the whole file', async () => {
    const readBounded = vi.fn(async () => Buffer.from('must not run'));
    const result = await readPreviewFile(
      '/workspace/image.png',
      EDITOR_PREVIEW_MAX_BYTES,
      dependencies({ detectBinary: async () => true, readBounded })
    );
    expect(result).toEqual({ kind: 'binary', byteLength: 5 });
    expect(readBounded).not.toHaveBeenCalled();
  });

  it('returns the bounded text buffer after admission', async () => {
    const buffer = Buffer.from('hello');
    const result = await readPreviewFile(
      '/workspace/a.txt',
      EDITOR_PREVIEW_MAX_BYTES,
      dependencies({ readBounded: async () => buffer })
    );
    expect(result).toEqual({ kind: 'text', byteLength: 5, buffer });
  });

  it('does not misclassify a TSD header before the decrypted bounded read', async () => {
    const detectBinary = vi.fn(async () => false);
    const result = await readPreviewFile(
      '/workspace/encrypted.ts',
      EDITOR_PREVIEW_MAX_BYTES,
      dependencies({ detectTsd: () => true, detectBinary })
    );
    expect(result.kind).toBe('text');
    expect(detectBinary).toHaveBeenCalledTimes(1);
  });
});
