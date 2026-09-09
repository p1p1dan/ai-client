// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { ChatMarkdown } from '../ChatMarkdown';
import { parseMarkdownFileLink } from '../markdownFileLink';

it.each([
  ['src/app.ts#L12-L14', 'src/app.ts', 12, 14],
  ['/repo/app.ts:9', '/repo/app.ts', 9, undefined],
  ['C:\\Users\\JC\\app.ts:20:3', 'C:\\Users\\JC\\app.ts', 20, undefined],
  ['file:///C:/My%20Project/app.ts#L5', 'C:/My Project/app.ts', 5, undefined],
  ['file://server/share/app.ts', '//server/share/app.ts', undefined, undefined],
])('parses %s', (href, path, line, endLine) =>
  expect(parseMarkdownFileLink(href)).toEqual({ path, line, endLine, source: 'markdown' }));
it.each([
  'javascript:alert(1)',
  'data:text/html,x',
  'vscode://file/x',
  'https://example.com/a.ts',
  '#footnote',
  'x%00.ts',
])('keeps %s out of file intents', (href) => expect(parseMarkdownFileLink(href)).toBeNull());
it('clicks a rendered Markdown file link and renews its request id after acknowledgement', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(ChatMarkdown, { text: '[Open](src/app.ts#L12)' }));
    });
    await act(async () => {
      container.querySelector('button')!.click();
    });
    const first = useFileOpenIntentStore.getState().intent!;
    expect(first).toMatchObject({ path: 'src/app.ts', line: 12, source: 'markdown' });
    useFileOpenIntentStore.getState().ackFileOpen(first.requestId);
    await act(async () => {
      container.querySelector('button')!.click();
    });
    expect(useFileOpenIntentStore.getState().intent!.requestId).toBeGreaterThan(first.requestId);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
