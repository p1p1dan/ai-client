// @vitest-environment happy-dom
/**
 * F2 regression: the hit-list popup anchored to the viewport's top-left
 * corner (positioner rect `[0, 4, 560, 122]`, covering the title bar) because
 * the trigger was wrapped in a `display: contents` span. Such a box is
 * invisible to layout — `getClientRects()` returns nothing — so floating-ui
 * measured an empty reference rect.
 *
 * The guarantee pinned here is structural, not cosmetic: the `.ct-a` arg node
 * the caller passes must BE the trigger, so the popup is measured against a
 * real box.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HitListPopover } from '../HitListPopover';

const GREP_OUTPUT = [
  'src/renderer/components/chat/toolCard.ts:464:const hitSource = output;',
  'src/renderer/stores/editor.ts:12:const pendingCursor = null;',
  '',
].join('\n');

function mount(source: string) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  // `children` goes in the props object, not as a vararg: the component now
  // demands a single element (it IS the trigger), and TS only checks that
  // through the props object.
  const element = createElement(HitListPopover, {
    source,
    onOpenFile: () => {},
    // biome-ignore lint/correctness/noChildrenProp: the component types `children` as one ReactElement; only the props object is type-checked for it.
    children: createElement('span', { className: 'ct-a-probe min-w-0 truncate' }, 'toolCard.ts'),
  });
  return { container, root, element };
}

it('renders the arg node itself as the trigger — no boxless `contents` wrapper', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const { container, root, element } = mount(GREP_OUTPUT);
  try {
    await act(async () => root.render(element));

    const trigger = container.querySelector<HTMLElement>('[data-slot="preview-card-trigger"]');
    expect(trigger).not.toBeNull();
    // The caller's span, with its own classes — not a wrapper around it.
    expect(trigger?.tagName).toBe('SPAN');
    expect(trigger?.className).toContain('ct-a-probe');
    expect(trigger?.textContent).toBe('toolCard.ts');
    // `display: contents` anywhere in this subtree is the bug itself.
    expect(trigger?.className).not.toContain('contents');
    expect(container.querySelectorAll('.contents')).toHaveLength(0);
    // One element deep: the trigger is the only node between row and text.
    expect(container.firstElementChild).toBe(trigger);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('still downgrades to the plain arg node when the output does not parse', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const { container, root, element } = mount('I searched but found nothing relevant, sorry.\n');
  try {
    await act(async () => root.render(element));
    expect(container.querySelector('[data-slot="preview-card-trigger"]')).toBeNull();
    expect(container.textContent).toBe('toolCard.ts');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
