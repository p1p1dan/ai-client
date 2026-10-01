// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ReleaseNotes } from '../ReleaseNotes';

/** The shape GitHub's release feed hands electron-updater: the body already rendered to HTML. */
const GITHUB_NOTES = [
  '<h1 dir="auto">PiLab Ai 1.0.4</h1>',
  '<p dir="auto">本版修复无法添加 AI 服务的问题。</p>',
  '<h2 dir="auto">本版修复</h2>',
  '<ul dir="auto">',
  '<li><strong>修复无法添加 AI 服务的问题。</strong> 替换前自动备份到 <code>vault.json.unreadable-&lt;时间&gt;.bak</code>。</li>',
  '<li>详见 <a href="https://github.com/p1p1dan/ai-client/releases" rel="nofollow">发布页</a>。</li>',
  '</ul>',
].join('\n');

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function render(notes: string): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ReleaseNotes, { notes })));
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}

it('renders the GitHub feed HTML as structure, not as literal tags', async () => {
  const container = await render(GITHUB_NOTES);

  expect(container.textContent).not.toContain('<li>');
  expect(container.textContent).not.toContain('dir="auto"');
  expect(container.querySelectorAll('ul > li')).toHaveLength(2);
  expect(container.querySelector('strong')?.textContent).toBe('修复无法添加 AI 服务的问题。');
  // Entities are decoded once, by the parser, and then shown as text.
  expect(container.querySelector('code')?.textContent).toBe('vault.json.unreadable-<时间>.bak');
  // No attribute from the feed is carried over.
  expect(container.querySelector('[dir]')).toBeNull();
});

it('renders the latest.yml Markdown the same way, without its syntax showing', async () => {
  const container = await render(
    [
      '# PiLab Ai 1.0.4',
      '',
      '## 本版修复',
      '',
      '- **修复无法添加 AI 服务的问题。** 备份到 `vault.json.unreadable-<时间>.bak`。',
      '- 数据目录为 `<userData>/PiLabAi`，<script>alert(1)</script> 不会执行。',
      '',
      '![beacon](https://example.com/beacon.png)',
    ].join('\n')
  );

  expect(container.textContent).not.toContain('**');
  expect(container.textContent).not.toContain('## ');
  expect(container.querySelectorAll('ul > li')).toHaveLength(2);
  expect(container.querySelector('strong')?.textContent).toBe('修复无法添加 AI 服务的问题。');
  // `<userData>` in prose is Markdown, not the HTML shape.
  expect([...container.querySelectorAll('code')].map((code) => code.textContent)).toEqual([
    'vault.json.unreadable-<时间>.bak',
    '<userData>/PiLabAi',
  ]);
  expect(container.querySelector('script, img')).toBeNull();
});

it('drops scripts and embedded media, and copies no event handler', async () => {
  const container = await render(
    '<p onclick="alert(1)">safe text</p><script>alert(2)</script><img src="https://example.com/beacon.png" onerror="alert(3)"><style>p{color:red}</style>'
  );

  expect(container.textContent).toBe('safe text');
  expect(container.querySelector('script, img, style')).toBeNull();
  expect(container.querySelector('[onclick], [onerror]')).toBeNull();
});

it('opens http(s) links in the system browser and leaves any other scheme as text', async () => {
  const openExternal = vi.fn().mockResolvedValue(undefined);
  window.electronAPI = { shell: { openExternal } } as unknown as typeof window.electronAPI;
  const container = await render(
    '<p><a href="https://github.com/p1p1dan/ai-client/releases">发布页</a> <a href="javascript:alert(1)">bad</a> <a href="../pi-only-migration.md">relative</a></p>'
  );

  const links = container.querySelectorAll('a');
  expect(links).toHaveLength(1);
  expect(container.textContent).toContain('bad');
  expect(container.textContent).toContain('relative');
  await act(async () => links[0].click());
  expect(openExternal).toHaveBeenCalledWith('https://github.com/p1p1dan/ai-client/releases');
});

it('shows plain-text notes as their text', async () => {
  const container = await render('first line\n\nsecond line');

  expect([...container.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
    'first line',
    'second line',
  ]);
});
