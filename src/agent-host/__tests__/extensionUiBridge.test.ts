import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionUiResponse } from '../../shared/types/runtimeEvents.ts';
import {
  createPortableExtensionUiBridge,
  type createPortableTheme,
  type ExtensionUiCancel,
  type ExtensionUiRequest,
  type ExtensionUiReset,
} from '../extensionUiBridge.ts';

/**
 * T11 — the portable Extension UI bridge.
 *
 * The invariant every test below defends: a blocking extension call resolves
 * EXACTLY ONCE, with either the user's answer or the fallback recorded when the
 * dialog opened. An unsettled Promise hangs the turn with no user-visible way
 * out, and a wrongly-settled one answers on the user's behalf — the second is
 * worse, which is why the fallback lives in the bridge and not in any caller.
 */

interface Harness {
  requests: ExtensionUiRequest[];
  cancels: ExtensionUiCancel[];
  resets: ExtensionUiReset[];
  bridge: ReturnType<typeof createPortableExtensionUiBridge>;
  ui: Record<string, (...args: unknown[]) => unknown>;
  last(): ExtensionUiRequest;
  answer(value: unknown, overrides?: Partial<ExtensionUiResponse>): boolean;
}

function harness(options?: { onRequest?: (r: ExtensionUiRequest) => void }): Harness {
  const requests: ExtensionUiRequest[] = [];
  const cancels: ExtensionUiCancel[] = [];
  const resets: ExtensionUiReset[] = [];
  const bridge = createPortableExtensionUiBridge({
    runtimeId: 'runtime-1',
    onRequest: (request) => {
      requests.push(request);
      options?.onRequest?.(request);
    },
    onCancel: (cancel) => cancels.push(cancel),
    onReset: (reset) => resets.push(reset),
  });
  const ui = bridge.uiContext as Record<string, (...args: unknown[]) => unknown>;
  const last = () => {
    const request = requests.at(-1);
    if (!request) throw new Error('no request was emitted');
    return request;
  };
  return {
    requests,
    cancels,
    resets,
    bridge,
    ui,
    last,
    answer: (value, overrides) =>
      bridge.respond({
        runtimeId: 'runtime-1',
        uiRequestId: last().uiRequestId,
        ok: true,
        value,
        ...overrides,
      }),
  };
}

describe('dialog round trip', () => {
  it('parks a select until the renderer answers', async () => {
    const h = harness();
    const promise = h.ui.select('Pick one', ['a', 'b']) as Promise<string | undefined>;

    expect(h.last().method).toBe('select');
    expect(h.last().args).toEqual({ title: 'Pick one', options: ['a', 'b'] });
    expect(h.bridge.pendingCount()).toBe(1);

    expect(h.answer('b')).toBe(true);
    await expect(promise).resolves.toBe('b');
    expect(h.bridge.pendingCount()).toBe(0);
  });

  it('carries confirm, input and editor args verbatim', async () => {
    const h = harness();
    const confirm = h.ui.confirm('Delete?', 'This cannot be undone') as Promise<boolean>;
    expect(h.last().args).toEqual({ title: 'Delete?', message: 'This cannot be undone' });
    h.answer(true);
    await expect(confirm).resolves.toBe(true);

    const input = h.ui.input('Name', 'your name') as Promise<string | undefined>;
    expect(h.last().args).toEqual({ title: 'Name', placeholder: 'your name' });
    h.answer('dan');
    await expect(input).resolves.toBe('dan');

    const editor = h.ui.editor('Body', 'draft') as Promise<string | undefined>;
    expect(h.last().args).toEqual({ title: 'Body', prefill: 'draft' });
    h.answer('final');
    await expect(editor).resolves.toBe('final');
  });

  it('gives every request a distinct id under the one runtime id', () => {
    const h = harness();
    void h.ui.select('A', ['x']);
    void h.ui.select('B', ['y']);
    const [first, second] = h.requests;
    expect(first.uiRequestId).not.toBe(second.uiRequestId);
    expect(first.runtimeId).toBe('runtime-1');
    expect(second.runtimeId).toBe('runtime-1');
  });

  it('mints a runtime id when the caller does not supply one', () => {
    const a = createPortableExtensionUiBridge({ onRequest: () => undefined });
    const b = createPortableExtensionUiBridge({ onRequest: () => undefined });
    expect(a.runtimeId).toBeTruthy();
    expect(a.runtimeId).not.toBe(b.runtimeId);
  });
});

describe('no-answer fallbacks', () => {
  /**
   * The asymmetry that matters: a dismissed confirmation is a REFUSAL. Every
   * other dialog falls back to `undefined`, which extensions already read as
   * "the user picked nothing".
   */
  it('settles a dismissed confirm as false and the rest as undefined', async () => {
    const h = harness();
    const confirm = h.ui.confirm('Delete?', 'sure?') as Promise<boolean>;
    h.answer(undefined, { ok: false });
    await expect(confirm).resolves.toBe(false);

    const select = h.ui.select('Pick', ['a']) as Promise<string | undefined>;
    h.answer(undefined, { ok: false });
    await expect(select).resolves.toBeUndefined();
  });

  /**
   * `ok: false` means nobody answered, so any `value` riding along is the
   * renderer's leftover state and must be ignored — otherwise a dismissal could
   * be dressed up as a confirmation.
   */
  it('ignores a value attached to a not-answered response', async () => {
    const h = harness();
    const confirm = h.ui.confirm('Delete?', '') as Promise<boolean>;
    h.answer(true, { ok: false });
    await expect(confirm).resolves.toBe(false);
  });
});

describe('staleness and duplicate answers', () => {
  it('refuses an answer addressed to a different bridge instance', async () => {
    const h = harness();
    const promise = h.ui.select('Pick', ['a']) as Promise<string | undefined>;

    expect(
      h.bridge.respond({
        runtimeId: 'runtime-OTHER',
        uiRequestId: h.last().uiRequestId,
        ok: true,
        value: 'a',
      })
    ).toBe(false);
    expect(h.bridge.pendingCount()).toBe(1);

    h.answer('a');
    await expect(promise).resolves.toBe('a');
  });

  it('refuses a second answer to the same dialog', async () => {
    const h = harness();
    const promise = h.ui.select('Pick', ['a', 'b']) as Promise<string | undefined>;
    expect(h.answer('a')).toBe(true);
    expect(h.answer('b')).toBe(false);
    await expect(promise).resolves.toBe('a');
  });

  it('refuses an answer to an id it never issued', () => {
    const h = harness();
    expect(
      h.bridge.respond({ runtimeId: 'runtime-1', uiRequestId: 'never-issued', ok: true })
    ).toBe(false);
  });
});

describe('timeout and abort', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('settles with the fallback when the extension deadline elapses', async () => {
    const h = harness();
    const promise = h.ui.confirm('Slow', 'waiting', { timeout: 5000 }) as Promise<boolean>;
    expect(h.last().timeoutMs).toBe(5000);
    expect(h.bridge.pendingCount()).toBe(1);

    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toBe(false);
    expect(h.bridge.pendingCount()).toBe(0);
  });

  it('drops the timer once the user answers in time', async () => {
    const h = harness();
    const promise = h.ui.select('Quick', ['a'], { timeout: 5000 }) as Promise<string | undefined>;
    h.answer('a');
    await expect(promise).resolves.toBe('a');

    // A stale timer firing after the answer would be a second settle attempt.
    vi.advanceTimersByTime(10_000);
    await expect(promise).resolves.toBe('a');
  });

  it('settles on abort and never parks an already-aborted call', async () => {
    const h = harness();
    const controller = new AbortController();
    const promise = h.ui.select('Pick', ['a'], { signal: controller.signal }) as Promise<
      string | undefined
    >;
    expect(h.bridge.pendingCount()).toBe(1);
    controller.abort();
    await expect(promise).resolves.toBeUndefined();
    expect(h.bridge.pendingCount()).toBe(0);

    const before = h.requests.length;
    const already = h.ui.confirm('Pre-aborted', 'x', {
      signal: controller.signal,
    }) as Promise<boolean>;
    await expect(already).resolves.toBe(false);
    expect(h.requests).toHaveLength(before);
    expect(h.bridge.pendingCount()).toBe(0);
  });
});

describe('reload and dispose', () => {
  it('drains pending dialogs on reload so no extension is left awaiting', async () => {
    const h = harness();
    const select = h.ui.select('Pick', ['a']) as Promise<string | undefined>;
    const confirm = h.ui.confirm('Sure?', '') as Promise<boolean>;
    expect(h.bridge.pendingCount()).toBe(2);

    h.bridge.reload();

    await expect(select).resolves.toBeUndefined();
    await expect(confirm).resolves.toBe(false);
    expect(h.bridge.pendingCount()).toBe(0);
  });

  /**
   * The extension that set a status chip is gone after a session swap and will
   * never clear it. If the bridge does not, the chip outlives its owner.
   */
  it('tells the renderer to clear the display state it set', () => {
    const h = harness();
    h.ui.setStatus('lint', 'running');
    h.ui.setWidget('panel', ['x']);
    h.ui.setTitle('Working');
    h.ui.setWorkingVisible(true);
    h.requests.length = 0;

    h.bridge.reload();

    const cleared = h.requests.map((r) => [r.method, r.args]);
    expect(cleared).toContainEqual(['setStatus', { key: 'lint', text: undefined }]);
    expect(cleared).toContainEqual(['setWidget', { key: 'panel', content: undefined }]);
    expect(cleared).toContainEqual(['setTitle', { title: '' }]);
    expect(cleared).toContainEqual(['setWorkingVisible', { visible: false }]);
  });

  it('does not re-clear state it already cleared', () => {
    const h = harness();
    h.ui.setStatus('lint', 'running');
    h.ui.setStatus('lint', undefined);
    h.requests.length = 0;

    h.bridge.reload();
    expect(h.requests.filter((r) => r.method === 'setStatus')).toHaveLength(0);
  });

  it('announces a runtime reset even when no dialog or display key was open', () => {
    const h = harness();
    h.bridge.reload();
    expect(h.resets).toEqual([{ runtimeId: 'runtime-1', reason: 'session_replaced' }]);
  });

  it('carries the teardown reason when disposed', () => {
    const h = harness();
    h.bridge.dispose('session_closed');
    expect(h.resets).toEqual([{ runtimeId: 'runtime-1', reason: 'session_closed' }]);
  });

  it('settles pending dialogs on dispose and refuses everything after', async () => {
    const h = harness();
    const promise = h.ui.select('Pick', ['a']) as Promise<string | undefined>;
    h.bridge.dispose();
    await expect(promise).resolves.toBeUndefined();

    expect(h.answer('a')).toBe(false);
    // A post-dispose call must settle immediately rather than park forever.
    await expect(h.ui.confirm('After', 'x') as Promise<boolean>).resolves.toBe(false);
    expect(h.bridge.pendingCount()).toBe(0);
  });

  it('is idempotent on repeated dispose', () => {
    const h = harness();
    h.bridge.dispose();
    expect(() => h.bridge.dispose()).not.toThrow();
    // reload after dispose is a no-op, not a resurrection
    expect(() => h.bridge.reload()).not.toThrow();
  });
});

describe('degradation for TUI-only surface', () => {
  it('keeps semantic no-ops quiet instead of presenting them as failures', () => {
    const h = harness();
    h.ui.setWorkingMessage('working');
    h.ui.setTitle('title');
    h.ui.getEditorComponent();
    expect(h.requests.filter((request) => request.method === 'unsupported')).toEqual([]);
  });

  it('reports an unsupported method once, not once per call', () => {
    const h = harness();
    h.ui.setFooter();
    h.ui.setFooter();
    h.ui.setHeader();

    const reports = h.requests.filter((r) => r.method === 'unsupported');
    expect(reports.map((r) => r.args)).toEqual([{ method: 'setFooter' }, { method: 'setHeader' }]);
  });

  /**
   * The compatibility guarantee: pi's `ExtensionUIContext` grows, and an
   * extension calling a member this build never heard of must degrade to a
   * reported no-op instead of throwing `is not a function` and aborting the bind.
   */
  it('turns an unknown member into a reported no-op', () => {
    const h = harness();
    const unknown = (h.ui as Record<string, () => unknown>).someFutureApi;
    expect(typeof unknown).toBe('function');
    expect(unknown()).toBeUndefined();
    expect(h.last().method).toBe('unsupported');
    expect(h.last().args).toEqual({ method: 'someFutureApi' });
  });

  /** A widget built from pi TUI components cannot cross the wire; only string lines can. */
  it('refuses component widgets but forwards a string array', () => {
    const h = harness();
    h.ui.setWidget('k', { component: 'Box' });
    expect(h.last().method).toBe('unsupported');
    expect(h.last().args).toEqual({ method: 'setWidget.component' });

    h.ui.setWidget('k', [{ text: 'still a component' }]);
    expect(h.requests.filter((request) => request.method === 'unsupported')).toHaveLength(1);

    h.ui.setWidget('k', ['ok']);
    expect(h.last().method).toBe('setWidget');
  });

  it('keeps editor text locally so getEditorText answers without a round trip', () => {
    const h = harness();
    h.ui.pasteToEditor('hello ');
    h.ui.pasteToEditor('world');
    expect(h.ui.getEditorText()).toBe('hello world');
    expect(h.last().args).toEqual({ text: 'hello world' });

    h.ui.setEditorText('replaced');
    expect(h.ui.getEditorText()).toBe('replaced');
  });

  it('reports theme switching as unavailable rather than pretending it worked', () => {
    const h = harness();
    expect(h.ui.setTheme()).toMatchObject({ success: false });
    expect(h.ui.getAllThemes()).toEqual([]);
  });
});

describe('portable theme', () => {
  /**
   * Extensions call `ui.theme.fg('accent', text)` during init. A missing theme
   * throws there and takes the whole bind down, so this must be a real object
   * whose colour methods are identity functions.
   */
  it('is a real object that passes text through unstyled', () => {
    const h = harness();
    const theme = (h.ui as unknown as { theme: ReturnType<typeof createPortableTheme> }).theme;
    expect(theme).toBeDefined();
    expect(theme.fg('accent', 'hello')).toBe('hello');
    expect(theme.bg('bg', 'hello')).toBe('hello');
    expect(theme.bold('hello')).toBe('hello');
    expect(theme.getFgAnsi()).toBe('');
  });

  it('hands the same theme back from getTheme', () => {
    const h = harness();
    expect(h.ui.getTheme()).toBeDefined();
    expect((h.ui.getTheme() as { name: string }).name).toBe('aiclient-portable');
  });
});

/**
 * The bridge can settle a dialog on its own (its timer, the extension's abort
 * signal, a session swap). Every one of those leaves a modal on the user's
 * screen that maps to nothing, so each must be announced — this is the only
 * mechanism by which a dialog closes for a reason other than the user closing it.
 */
describe('cancellation announcements', () => {
  it('says nothing when the user answered', () => {
    const h = harness();
    void h.ui.select('Pick', ['a']);
    h.answer('a');
    expect(h.cancels).toHaveLength(0);
  });

  it('announces a timeout with its reason', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const promise = h.ui.confirm('Slow', 'x', { timeout: 1000 }) as Promise<boolean>;
      const id = h.last().uiRequestId;
      vi.advanceTimersByTime(1000);
      await expect(promise).resolves.toBe(false);
      expect(h.cancels).toEqual([
        { runtimeId: 'runtime-1', uiRequestIds: [id], reason: 'timed_out' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces an abort with its reason', async () => {
    const h = harness();
    const controller = new AbortController();
    const promise = h.ui.select('Pick', ['a'], { signal: controller.signal }) as Promise<
      string | undefined
    >;
    const id = h.last().uiRequestId;
    controller.abort();
    await promise;
    expect(h.cancels).toEqual([{ runtimeId: 'runtime-1', uiRequestIds: [id], reason: 'aborted' }]);
  });

  it('batches a session swap into one announcement', async () => {
    const h = harness();
    void h.ui.select('A', ['x']);
    const first = h.last().uiRequestId;
    void h.ui.confirm('B', 'y');
    const second = h.last().uiRequestId;

    h.bridge.reload();

    expect(h.cancels).toHaveLength(1);
    expect(h.cancels[0]).toEqual({
      runtimeId: 'runtime-1',
      uiRequestIds: [first, second],
      reason: 'session_replaced',
    });
  });

  it('distinguishes shutdown from a session swap', () => {
    const h = harness();
    void h.ui.select('A', ['x']);
    h.bridge.dispose();
    expect(h.cancels[0]?.reason).toBe('host_shutdown');
  });

  /** An announcement of nothing would make the renderer re-render for no reason. */
  it('stays silent when there was nothing pending', () => {
    const h = harness();
    h.bridge.reload();
    h.bridge.dispose();
    expect(h.cancels).toHaveLength(0);
  });

  /** A pre-aborted call never parks, so there is no open modal to close. */
  it('stays silent for a call that never parked', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await (h.ui.confirm('Pre-aborted', 'x', { signal: controller.signal }) as Promise<boolean>);
    expect(h.cancels).toHaveLength(0);
  });
});

describe('emit failures', () => {
  /**
   * The transport can fail (port closed mid-turn). If that propagated into the
   * extension's call stack it would abort the turn from inside third-party code;
   * the pending entry plus its fallback is what actually guarantees a settle.
   */
  it('still settles a dialog when the transport throws', async () => {
    const h = harness({
      onRequest: () => {
        throw new Error('port closed');
      },
    });
    const promise = h.ui.confirm('Ask', 'x') as Promise<boolean>;
    expect(h.bridge.pendingCount()).toBe(1);
    h.bridge.reload();
    await expect(promise).resolves.toBe(false);
  });
});
