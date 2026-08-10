import { describe, expect, it } from 'vitest';
import {
  type DropZoneRect,
  hasFilePayload,
  isDragLeavingWindow,
  isPointInsideDropZone,
  normalizeDroppedRepositoryPath,
} from '../fileDragDrop';

const RECT: DropZoneRect = { left: 100, right: 400, top: 50, bottom: 300 };

describe('hasFilePayload', () => {
  it('accepts an OS file drag via the types flag', () => {
    expect(hasFilePayload({ types: ['Files'] })).toBe(true);
  });

  it('rejects text-only drags', () => {
    expect(hasFilePayload({ types: ['text/plain', 'text/html'] })).toBe(false);
  });

  it('rejects a missing payload', () => {
    expect(hasFilePayload(undefined)).toBe(false);
    expect(hasFilePayload(null)).toBe(false);
    expect(hasFilePayload({ types: [] })).toBe(false);
  });

  // T-24 audit risk: some non-Chromium-standard drag sources never set the
  // `types` 'Files' flag, which made `hasFilePayload` return false and skip
  // `preventDefault` — the drop was never even dispatched.
  it('falls back to items when types omits the Files flag', () => {
    expect(hasFilePayload({ types: ['text/plain'], items: [{ kind: 'file' }] })).toBe(true);
  });

  it('rejects items with no file-kind entry', () => {
    expect(hasFilePayload({ types: ['text/plain'], items: [{ kind: 'string' }] })).toBe(false);
  });

  it('rejects when neither types nor items signal a file', () => {
    expect(hasFilePayload({ types: [], items: [] })).toBe(false);
    expect(hasFilePayload({ types: ['text/plain'], items: undefined })).toBe(false);
  });
});

describe('isPointInsideDropZone', () => {
  it('accepts a point inside the zone', () => {
    expect(isPointInsideDropZone(RECT, { x: 200, y: 100 })).toBe(true);
  });

  it('accepts points on the border', () => {
    expect(isPointInsideDropZone(RECT, { x: 100, y: 50 })).toBe(true);
    expect(isPointInsideDropZone(RECT, { x: 400, y: 300 })).toBe(true);
  });

  it('rejects points outside the zone on every axis', () => {
    expect(isPointInsideDropZone(RECT, { x: 99, y: 100 })).toBe(false);
    expect(isPointInsideDropZone(RECT, { x: 401, y: 100 })).toBe(false);
    expect(isPointInsideDropZone(RECT, { x: 200, y: 49 })).toBe(false);
    expect(isPointInsideDropZone(RECT, { x: 200, y: 301 })).toBe(false);
  });

  it('rejects everything when no shell bound the drop zone', () => {
    // Regression: this is exactly the state the new shell was in, and it made
    // every folder drop disappear without a single log line.
    expect(isPointInsideDropZone(null, { x: 200, y: 100 })).toBe(false);
    expect(isPointInsideDropZone(undefined, { x: 200, y: 100 })).toBe(false);
  });
});

describe('isDragLeavingWindow', () => {
  const viewport = { width: 1280, height: 800 };

  it('detects leaving via the top/left edges', () => {
    expect(isDragLeavingWindow({ x: 0, y: 400 }, viewport)).toBe(true);
    expect(isDragLeavingWindow({ x: 640, y: 0 }, viewport)).toBe(true);
    expect(isDragLeavingWindow({ x: -5, y: 400 }, viewport)).toBe(true);
  });

  it('detects leaving via the right/bottom edges', () => {
    expect(isDragLeavingWindow({ x: 1280, y: 400 }, viewport)).toBe(true);
    expect(isDragLeavingWindow({ x: 640, y: 800 }, viewport)).toBe(true);
  });

  it('keeps the highlight while the pointer stays inside', () => {
    expect(isDragLeavingWindow({ x: 640, y: 400 }, viewport)).toBe(false);
    expect(isDragLeavingWindow({ x: 1, y: 1 }, viewport)).toBe(false);
  });
});

describe('normalizeDroppedRepositoryPath', () => {
  it('keeps a usable path', () => {
    expect(normalizeDroppedRepositoryPath('/home/dan/projects/ai-client')).toBe(
      '/home/dan/projects/ai-client'
    );
  });

  it('preserves surrounding whitespace, which is legal in a directory name', () => {
    // Trimming would prefill the dialog with a path that does not exist.
    expect(normalizeDroppedRepositoryPath('/home/dan/projects/my repo ')).toBe(
      '/home/dan/projects/my repo '
    );
    expect(normalizeDroppedRepositoryPath(' /home/dan/ leading')).toBe(' /home/dan/ leading');
  });

  it('rejects empty or non-string paths', () => {
    expect(normalizeDroppedRepositoryPath('')).toBeNull();
    expect(normalizeDroppedRepositoryPath('   ')).toBeNull();
    expect(normalizeDroppedRepositoryPath(null)).toBeNull();
    expect(normalizeDroppedRepositoryPath(undefined)).toBeNull();
  });
});
