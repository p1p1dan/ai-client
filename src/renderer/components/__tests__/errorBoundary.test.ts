// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';
import { formatErrorReport } from '../errorReport';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const here = path.dirname(fileURLToPath(import.meta.url));

/** The field error, verbatim: what `new URL('local-file://')` throws in Chromium. */
function ThrowingPreview(): never {
  throw new TypeError("Failed to construct 'URL': Invalid URL");
}

let root: Root;
let container: HTMLDivElement;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

function renderShell(child: 'throw' | 'ok', resetKey = 'a') {
  return act(async () => {
    root.render(
      createElement(
        'div',
        null,
        createElement('p', { id: 'chat' }, 'chat column'),
        createElement(
          ErrorBoundary,
          { scope: 'editor-column', className: 'h-full min-h-0', resetKey },
          child === 'throw'
            ? createElement(ThrowingPreview)
            : createElement('p', { id: 'editor' }, 'editor ok')
        )
      )
    );
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((node) => node.textContent === label);
}

function boundaryLogLines(): string[] {
  return consoleError.mock.calls
    .map((call) => call[0])
    .filter(
      (first): first is string =>
        typeof first === 'string' && first.startsWith('[ErrorBoundary:editor-column]')
    );
}

describe('local ErrorBoundary (T4)', () => {
  it('contains a throwing child; the rest of the window keeps rendering', async () => {
    await renderShell('throw');
    expect(container.querySelector('#chat')?.textContent).toBe('chat column');
    expect(container.textContent).toContain("Failed to construct 'URL': Invalid URL");
    expect(button('Retry')).toBeDefined();
    // The local fallback does not claim the whole viewport height.
    expect(container.querySelector('.min-h-dvh')).toBeNull();
  });

  it('writes message, stack and component stack as one log line', async () => {
    await renderShell('throw');
    const [line] = boundaryLogLines();
    expect(line).toContain("[ErrorBoundary:editor-column] Failed to construct 'URL': Invalid URL");
    expect(line).toContain('[stack]');
    expect(line).toContain('ThrowingPreview');
    expect(line).toContain('[componentStack]');
  });

  it('copies the same report to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderShell('throw');
    await act(async () => button('Copy error details')?.click());
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("Failed to construct 'URL': Invalid URL");
    expect(copied).toContain('[componentStack]');
    expect(button('Copied')).toBeDefined();
  });

  it('recovers on its own when the reset key changes', async () => {
    await renderShell('throw', 'tab-1');
    expect(container.querySelector('#editor')).toBeNull();
    await renderShell('ok', 'tab-2');
    expect(container.querySelector('#editor')?.textContent).toBe('editor ok');
  });
});

describe('formatErrorReport', () => {
  it('labels the scope and survives non-Error throws', () => {
    expect(formatErrorReport({ error: 'boom', componentStack: null, scope: 'root' })).toBe(
      '[ErrorBoundary:root] boom'
    );
    expect(formatErrorReport({ error: 'boom', componentStack: '\n    at X\n' })).toBe(
      '[ErrorBoundary] boom\n\n[componentStack]\nat X'
    );
  });
});

describe('boundary placement (static)', () => {
  it('the editor column and the file previews sit behind local boundaries', () => {
    const shell = readFileSync(path.resolve(here, '../workspace-shell/WorkspaceShell.tsx'), 'utf8');
    expect(shell).toContain('<GuardedEditorColumn expanded={expanded}');
    expect(shell).toMatch(/scope="editor-column"[\s\S]*?<EditorColumn \{\.\.\.props\} \/>/);

    const area = readFileSync(path.resolve(here, '../files/EditorArea.tsx'), 'utf8');
    expect(area).toMatch(/scope="file-preview"[\s\S]*?<ImagePreview[\s\S]*?<PdfPreview/);
  });
});
