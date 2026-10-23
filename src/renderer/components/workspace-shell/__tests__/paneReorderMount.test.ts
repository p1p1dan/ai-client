// @vitest-environment happy-dom
/**
 * Rearranging the pane cards (user, 2026-10-22): a card's header drags onto
 * another card, which lights up as the target; the drop hands both kinds to
 * `onDropPane`. A press on a header control never starts a drag, a card is no
 * target for itself, and a lone card is not draggable.
 */
import { englishTranslate } from '@shared/i18n';
import { act, type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANE_DRAG_TYPE, PaneCard } from '../PaneCard';
import type { PaneKind } from '../workPanelModel';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate }) }));

let root: Root | null = null;
let container: HTMLDivElement;

function card(
  kind: PaneKind,
  reorderable: boolean,
  onDropPane: (a: PaneKind, b: PaneKind) => void
) {
  // Built as the session rail test builds RailCard: props typed, children in them (lint).
  const props = {
    kind,
    icon: null,
    title: kind,
    shown: true,
    focused: false,
    expanded: false,
    onFocus: () => undefined,
    onClose: () => undefined,
    onToggleExpanded: () => undefined,
    reorderable,
    onDropPane,
    children: `${kind} body`,
  } as ComponentProps<typeof PaneCard>;
  return createElement(PaneCard, props);
}

async function mount(reorderable = true) {
  const onDropPane = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render([card('files', reorderable, onDropPane), card('git', reorderable, onDropPane)])
  );
  return onDropPane;
}

const section = (kind: PaneKind) =>
  container.querySelector<HTMLElement>(`[data-pane="${kind}"]`) as HTMLElement;
const header = (kind: PaneKind) => section(kind).querySelector('header') as HTMLElement;

/** A drag event carrying `transfer` (happy-dom's DragEvent leaves it null). */
function drag(type: string, transfer: DataTransfer): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  return event;
}

function fakeTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (format: string, value: string) => data.set(format, value),
    getData: (format: string) => data.get(format) ?? '',
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer;
}

async function fire(target: HTMLElement, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('dragging a pane header onto another card', () => {
  it('the target lights up and the drop names both panes', async () => {
    const onDropPane = await mount();
    expect(header('files').getAttribute('draggable')).toBe('true');
    const transfer = fakeTransfer();

    await fire(header('files'), new PointerEvent('pointerdown', { bubbles: true }));
    await fire(header('files'), drag('dragstart', transfer));
    expect(transfer.types).toContain(PANE_DRAG_TYPE);
    expect(section('files').className).toContain('opacity-60');

    const over = await fire(section('git'), drag('dragover', transfer));
    expect(over.defaultPrevented).toBe(true);
    expect(section('git').dataset.paneDropTarget).toBe('true');

    await fire(section('git'), drag('drop', transfer));
    expect(onDropPane).toHaveBeenCalledWith('files', 'git');
    expect(section('git').dataset.paneDropTarget).toBeUndefined();

    await fire(header('files'), drag('dragend', transfer));
    expect(section('files').className).not.toContain('opacity-60');
  });

  it('a card is no target for itself', async () => {
    const onDropPane = await mount();
    const transfer = fakeTransfer();
    await fire(header('files'), drag('dragstart', transfer));
    const over = await fire(section('files'), drag('dragover', transfer));
    expect(over.defaultPrevented).toBe(false);
    await fire(section('files'), drag('drop', transfer));
    expect(onDropPane).not.toHaveBeenCalled();
    await fire(header('files'), drag('dragend', transfer));
  });

  it('a press on a header control (⤢, ✕) does not start a drag', async () => {
    await mount();
    const button = header('files').querySelector('button') as HTMLButtonElement;
    await fire(button, new PointerEvent('pointerdown', { bubbles: true }));
    const start = await fire(header('files'), drag('dragstart', fakeTransfer()));
    expect(start.defaultPrevented).toBe(true);
  });

  it('a lone card (or an expanded one) is not draggable', async () => {
    await mount(false);
    expect(header('files').getAttribute('draggable')).toBe('false');
    expect(header('files').className).not.toContain('cursor-grab');
  });
});

describe('a mounted card that is not on screen', () => {
  // Field bug (2026-10-23): close the editor after 「打开文件」 in the diff
  // pane and the editor card stays mounted (its tabs are still open) but
  // hidden. Monaco's diff editor writes an inline `visibility: visible` on
  // both sides, which beats the card's inherited `visibility: hidden`, so the
  // diff stayed painted over the chat. The card must also go fully transparent.
  it('is transparent as well as invisible, so a descendant forcing visibility stays unseen', async () => {
    const props = {
      kind: 'editor',
      icon: null,
      title: 'editor',
      shown: false,
      focused: false,
      expanded: false,
      onFocus: () => undefined,
      onClose: () => undefined,
      onToggleExpanded: () => undefined,
      children: createElement('div', { style: { visibility: 'visible' } }, 'diff'),
    } as ComponentProps<typeof PaneCard>;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(PaneCard, props)));
    const classes = section('editor').className.split(/\s+/);
    expect(classes).toContain('invisible');
    expect(classes).toContain('opacity-0');
    expect(classes).toContain('pointer-events-none');
    expect(section('editor').hasAttribute('inert')).toBe(true);
  });
});
