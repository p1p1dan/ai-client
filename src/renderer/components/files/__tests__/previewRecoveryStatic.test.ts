import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const readSource = (name: string) => readFileSync(path.resolve(dirname, '..', name), 'utf8');

describe('preview recovery wiring', () => {
  it('image preview exposes load failure and component-local retry', () => {
    const source = readSource('ImagePreview.tsx');
    expect(source).toContain('onError=');
    expect(source).toContain('setRetryKey((value) => value + 1)');
    expect(source).toContain('imageDimensionsAllowed');
  });

  it('PDF retry remounts only the preview request and never reloads the application', () => {
    const source = readSource('PdfPreview.tsx');
    expect(source).toContain('setRetryKey((value) => value + 1)');
    expect(source).not.toContain('window.location.reload');
    expect(source).toContain('clampPdfScale');
  });

  it('previews build their URL through the non-throwing builder, never new URL() in render', () => {
    for (const name of ['ImagePreview.tsx', 'PdfPreview.tsx']) {
      const source = readSource(name);
      expect(source, name).toContain('buildPreviewUrl(path, retryKey)');
      expect(source, name).not.toContain('new URL(');
      expect(source, name).not.toContain('toLocalFileUrl');
      // T5: a load failure offers the OS viewer as the way out.
      expect(source, name).toContain('<OpenWithSystemViewerButton path={path} />');
    }
  });

  it('PDF.js and its worker are Vite-local imports rather than CDN resources', () => {
    const source = readSource('pdfSetup.ts');
    expect(source).toContain("from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url'");
    expect(source).toContain("import('pdfjs-dist')");
    expect(source).not.toContain('cdn.jsdelivr.net');
  });

  it('registers local-file as a privileged scheme before app readiness', () => {
    const mainSource = readFileSync(path.resolve(dirname, '../../../../main/index.ts'), 'utf8');
    const privilege = mainSource.indexOf("scheme: 'local-file'");
    const ready = mainSource.indexOf('.whenReady()');
    expect(privilege).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(privilege);
    expect(mainSource).toContain("protocol.handle('local-file'");
    expect(mainSource).toContain('resolveAllowedLocalFileReadPath');
  });
});
