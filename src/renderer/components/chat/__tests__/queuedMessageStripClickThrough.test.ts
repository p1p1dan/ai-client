// @vitest-environment happy-dom
/**
 * Decision 046 rule 4 — a disabled control must not turn a click into another
 * action.
 *
 * Field report: after "End conversation", clicking the queued row's disabled
 * 「立即发送」 put the message back into the composer. Disabled buttons in the
 * strip are `pointer-events: none` (the `Button` base class and the icon
 * buttons' own class), so the browser delivers the click to the element under
 * the button — which was the row, whose click is "take back into the draft".
 *
 * happy-dom applies no stylesheet, so the pass-through is reproduced directly:
 * the click is dispatched on the element that sits under each disabled button,
 * exactly where a real browser would deliver it.
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate('zh', key, params),
  }),
}));

const { QueuedMessageStrip } = await import('../QueuedMessageStrip');
const { deriveQueueStripModel } = await import('../queueRelease');

const REASON = 'why it is disabled';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function model(count: number) {
  return deriveQueueStripModel({
    entries: Array.from({ length: count }, (_, index) => ({
      id: `q${index + 1}`,
      sessionId: 's1',
      text: `queued ${index + 1}`,
      attachments: [],
      queuedAt: index,
    })),
    paused: null,
    hasPendingPermissionHere: false,
  });
}

async function render(options: { sendNowDisabled: boolean; count?: number }) {
  const handlers = {
    onResume: vi.fn(),
    onEdit: vi.fn(),
    onMove: vi.fn(),
    onRemove: vi.fn(),
    onSendNow: vi.fn(),
  };
  await act(async () =>
    root.render(
      createElement(QueuedMessageStrip, {
        model: model(options.count ?? 1),
        ...handlers,
        sendNowDisabled: options.sendNowDisabled,
        sendNowDisabledReason: REASON,
      })
    )
  );
  return handlers;
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function sendNowSlot(): HTMLElement {
  const slot = container.querySelector<HTMLElement>('[data-testid="queue-send-now"]');
  if (!slot) throw new Error('send-now slot not rendered');
  return slot;
}

describe('queued row: disabled controls do not click through (decision 046 rule 4)', () => {
  it('a click landing under a disabled Send now does not take the entry into the draft', async () => {
    const handlers = await render({ sendNowDisabled: true });
    const button = sendNowSlot().querySelector('button');
    expect(button?.disabled).toBe(true);

    // What the browser does with `pointer-events: none`: the target is the
    // wrapper the button sits in.
    await act(async () => click(sendNowSlot()));

    expect(handlers.onEdit).not.toHaveBeenCalled();
    expect(handlers.onSendNow).not.toHaveBeenCalled();
  });

  it('a disabled Send now explains itself on the element that receives the hover', async () => {
    await render({ sendNowDisabled: true });
    // The button cannot show a tooltip while it ignores the pointer, so the
    // wrapper carries it.
    expect(sendNowSlot().title).toBe(REASON);
  });

  it('an enabled Send now sends, and only sends', async () => {
    const handlers = await render({ sendNowDisabled: false });
    expect(sendNowSlot().title).toBe('');
    const button = sendNowSlot().querySelector('button');
    if (!button) throw new Error('send-now button not rendered');
    await act(async () => click(button));
    expect(handlers.onSendNow).toHaveBeenCalledWith('q1');
    expect(handlers.onEdit).not.toHaveBeenCalled();
  });

  it('the disabled move arrows (head up, tail down) do not click through either', async () => {
    const handlers = await render({ sendNowDisabled: false, count: 2 });
    const groups = container.querySelectorAll<HTMLElement>('[data-testid="queue-row-actions"]');
    expect(groups).toHaveLength(2);
    const headUp = groups[0]?.querySelector<HTMLButtonElement>(
      `button[aria-label="${translate('zh', 'Move queued message up')}"]`
    );
    const tailDown = groups[1]?.querySelector<HTMLButtonElement>(
      `button[aria-label="${translate('zh', 'Move queued message down')}"]`
    );
    expect(headUp?.disabled).toBe(true);
    expect(tailDown?.disabled).toBe(true);

    // Under a disabled icon button is the row's action group.
    for (const group of groups) await act(async () => click(group));

    expect(handlers.onEdit).not.toHaveBeenCalled();
    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it('clicking the row itself still takes the entry into the draft', async () => {
    const handlers = await render({ sendNowDisabled: true });
    const preview = container.querySelector<HTMLElement>('span[title="queued 1"]');
    if (!preview) throw new Error('preview not rendered');
    await act(async () => click(preview));
    expect(handlers.onEdit).toHaveBeenCalledWith('q1');
  });
});
