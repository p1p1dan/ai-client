import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision 209 §2: the Outputs card's channel into the preview window takes
 * only an absolute local path to an existing `.html` / `.htm` file.
 */
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../services/preview/PreviewWindowManager', () => ({
  previewWindowManager: { show: vi.fn(async () => undefined) },
}));

const { isPreviewableHtmlPath, openHtmlPreview } = await import('../preview');

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiclient-preview-ipc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isPreviewableHtmlPath', () => {
  it('absolute .html / .htm paths, any case', () => {
    expect(isPreviewableHtmlPath(join(dir, 'a.html'))).toBe(true);
    expect(isPreviewableHtmlPath(join(dir, 'b.HTM'))).toBe(true);
  });

  it('refuses relative paths, other kinds, remote paths and non-strings', () => {
    for (const value of [
      'a.html',
      './a.html',
      join(dir, 'a.md'),
      join(dir, 'a.html.exe'),
      '/__aiclient_remote__/c1/srv/a.html',
      `${join(dir, 'a')}\0.html`,
      '',
      null,
      42,
    ]) {
      expect(isPreviewableHtmlPath(value), String(value)).toBe(false);
    }
  });
});

describe('openHtmlPreview', () => {
  it('opens an existing page at its real path', async () => {
    const page = join(dir, 'page.html');
    writeFileSync(page, '<p>hi</p>');
    const show = vi.fn(async (_path: string) => undefined);
    expect(await openHtmlPreview(page, show)).toEqual({ ok: true });
    expect(show).toHaveBeenCalledWith(page);
  });

  it('a page that is gone, or a folder named like one, is missing', async () => {
    const show = vi.fn(async (_path: string) => undefined);
    expect(await openHtmlPreview(join(dir, 'gone.html'), show)).toEqual({
      ok: false,
      reason: 'missing',
    });
    mkdirSync(join(dir, 'folder.html'));
    expect(await openHtmlPreview(join(dir, 'folder.html'), show)).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('a link named like a page does not open what it points at', async () => {
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'x');
    const link = join(dir, 'link.html');
    symlinkSync(secret, link);
    const show = vi.fn(async (_path: string) => undefined);
    expect(await openHtmlPreview(link, show)).toEqual({ ok: false, reason: 'not-html' });
    expect(show).not.toHaveBeenCalled();
  });

  it('refuses other kinds before touching the disk', async () => {
    const show = vi.fn(async (_path: string) => undefined);
    expect(await openHtmlPreview('relative.html', show)).toEqual({
      ok: false,
      reason: 'not-html',
    });
    expect(show).not.toHaveBeenCalled();
  });

  it('a window that cannot load it is a failure with the reason', async () => {
    const page = join(dir, 'page.htm');
    writeFileSync(page, '<p>hi</p>');
    const show = vi.fn(async (_path: string) => {
      throw new Error('load failed');
    });
    expect(await openHtmlPreview(page, show)).toEqual({
      ok: false,
      reason: 'failed',
      error: 'load failed',
    });
  });
});
