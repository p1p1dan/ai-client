/**
 * Portable Extension UI bridge — T11.
 *
 * ## What it is
 *
 * pi extensions are written against a TUI. They call `ui.select(...)`,
 * `ui.confirm(...)`, `ui.setStatus(...)` on an `ExtensionUIContext` that pi
 * normally backs with an ANSI terminal, and `AgentSession.bindExtensions()` is
 * where that object gets handed over. We are not a terminal, so this module
 * builds a PORTABLE stand-in: each call becomes an `extensionUi.request` event
 * on the wire, and the four blocking ones park a Promise until an
 * `extensionUi.respond` command arrives.
 *
 * ## Why the bridge holds the object rather than proxying a subprocess
 *
 * `piRuntime.ts` runs the SDK EMBEDDED (`createAgentSessionRuntime`), so the
 * `ExtensionUIContext` we pass to `bindExtensions` is called in-process, by
 * ordinary function calls, on the utilityProcess's own event loop. There is no
 * serialization boundary between the extension and this file — which is exactly
 * why the pending map, the timers and the abort wiring have to live HERE. Ported
 * from pix `packages/agent-runtime/src/extension-ui-bridge.ts`, whose runtime
 * shape is identical to ours.
 *
 * ## The one invariant
 *
 * Every blocking call resolves EXACTLY ONCE, with either the user's answer or
 * this file's recorded fallback — never with nothing. An extension that never
 * gets its Promise settled hangs the turn with no way for the user to recover,
 * so `finish()` is the single settle path and `dispose()`/`reload()` drain the
 * map through it.
 */

import { randomUUID } from 'node:crypto';
import {
  type ExtensionUiCancelReason,
  type ExtensionUiMethod,
  type ExtensionUiResponse,
  extensionUiCapability,
} from '../shared/types/runtimeEvents.ts';

/** The four methods whose caller is awaiting a Promise. */
type DialogMethod = 'select' | 'confirm' | 'input' | 'editor';

interface PendingDialog {
  /**
   * What this call resolves to when nobody answers. Recorded at OPEN time, not
   * at settle time, because only the opening call knows the method's no-answer
   * semantics — `confirm` must fall back to `false` (a dismissed confirmation is
   * a refusal), the rest to `undefined`.
   */
  fallback: unknown;
  resolve(value: unknown): void;
  timer?: NodeJS.Timeout;
  removeAbort?: () => void;
}

/**
 * Headless stand-in for pi's TUI `Theme`.
 *
 * Extensions style their status strings with `ui.theme.fg('accent', text)`
 * during init. With no terminal there are no ANSI codes to emit, so every
 * method returns the text unchanged — the point is that `theme` is a real object
 * with real methods, because an extension calling `.fg` on `undefined` throws
 * during bind and takes the whole session down with it.
 */
export function createPortableTheme() {
  const pass = (text: string) => text;
  const wrap = (_color: string, text: string) => text;
  return {
    name: 'aiclient-portable',
    fg: wrap,
    bg: wrap,
    bold: pass,
    italic: pass,
    underline: pass,
    inverse: pass,
    strikethrough: pass,
    getFgAnsi: () => '',
    getBgAnsi: () => '',
    getColorMode: () => '256color' as const,
    getThinkingBorderColor: () => pass,
    getBashModeBorderColor: () => pass,
  };
}

/** What the bridge asks the Host to put on the wire. */
export interface ExtensionUiRequest {
  runtimeId: string;
  uiRequestId: string;
  method: ExtensionUiMethod;
  args: unknown;
  timeoutMs?: number;
}

/** Dialogs the bridge settled without a user answer; the renderer must close them. */
export interface ExtensionUiCancel {
  runtimeId: string;
  uiRequestIds: string[];
  reason: ExtensionUiCancelReason;
}

export type ExtensionUiResetReason = 'session_replaced' | 'session_closed' | 'host_shutdown';

export interface ExtensionUiReset {
  runtimeId: string;
  reason: ExtensionUiResetReason;
}

export interface PortableExtensionUiBridge {
  /** The bridge instance id, echoed on every request and checked on every response. */
  readonly runtimeId: string;
  /** Hand this to `session.bindExtensions({ uiContext })`. */
  readonly uiContext: unknown;
  /** True when this response settled a dialog; false when it addressed nobody. */
  respond(response: ExtensionUiResponse): boolean;
  /** Session replaced (reload / fork / switch): drain dialogs, clear display state. */
  reload(): void;
  /**
   * Settle every parked dialog now, with the reason to tell the renderer.
   *
   * This is what a Stop must call. Aborting the pi session only unblocks the
   * MODEL loop: an extension sitting inside `ui.select` is awaiting a Promise
   * that lives here, so without this the turn cannot finish, the modal stays on
   * screen, and the session waits out the extension's own timeout — if it set
   * one at all. Display state is deliberately left alone; the session is still
   * alive and its status chips still belong to it.
   */
  cancelAll(reason: ExtensionUiCancelReason): void;
  dispose(reason?: ExtensionUiResetReason): void;
  /** Diagnostics only — how many calls are still parked. */
  pendingCount(): number;
}

export interface PortableExtensionUiBridgeOptions {
  /** Defaults to a fresh UUID; injectable so tests can assert routing. */
  runtimeId?: string;
  onRequest(request: ExtensionUiRequest): void;
  /**
   * Dialogs settled with no user answer. Without this the renderer keeps showing
   * a modal the bridge already closed — see `ExtensionUiCancelledEvent`.
   */
  onCancel?(cancel: ExtensionUiCancel): void;
  /** Clear renderer display state even when no blocking dialog was open. */
  onReset?(reset: ExtensionUiReset): void;
}

export function createPortableExtensionUiBridge(
  options: PortableExtensionUiBridgeOptions
): PortableExtensionUiBridge {
  const runtimeId = options.runtimeId ?? randomUUID();
  const pending = new Map<string, PendingDialog>();
  const unsupported = new Set<string>();
  const statusKeys = new Set<string>();
  const widgetKeys = new Set<string>();
  const portableTheme = createPortableTheme();
  let editorText = '';
  let titleSet = false;
  let workingMessageSet = false;
  let workingVisibleSet = false;
  let disposed = false;

  function emit(method: ExtensionUiMethod, args: unknown, timeoutMs?: number): string {
    const uiRequestId = randomUUID();
    const request: ExtensionUiRequest = { runtimeId, uiRequestId, method, args };
    if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
    // An extension must not be able to kill the Host by making the emit path
    // throw: the request is best-effort, the PENDING ENTRY is what guarantees
    // the caller is eventually settled.
    try {
      options.onRequest(request);
    } catch {
      /* swallowed — the dialog's timeout/fallback still settles the caller */
    }
    return uiRequestId;
  }

  /**
   * The single settle path. Idempotent by construction: the map entry is deleted
   * before the Promise is resolved, so a re-entrant call finds nothing.
   *
   * `settled` collects the ids that actually resolved here, which is how the
   * caller knows whether there is a cancellation worth announcing — a settle
   * that matched no entry must not produce one.
   */
  function finish(uiRequestId: string, value: unknown, settled?: string[]): void {
    const entry = pending.get(uiRequestId);
    if (!entry) return;
    pending.delete(uiRequestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.removeAbort?.();
    settled?.push(uiRequestId);
    entry.resolve(value);
  }

  function emitCancel(uiRequestIds: string[], reason: ExtensionUiCancelReason): void {
    if (uiRequestIds.length === 0) return;
    try {
      options.onCancel?.({ runtimeId, uiRequestIds, reason });
    } catch {
      /* swallowed — the extension is already settled; this is renderer cleanup */
    }
  }

  function emitReset(reason: ExtensionUiResetReason): void {
    try {
      options.onReset?.({ runtimeId, reason });
    } catch {
      /* swallowed — reset is best-effort renderer cleanup */
    }
  }

  /** Settle one dialog nobody answered, and tell the renderer to close it. */
  function cancelOne(uiRequestId: string, value: unknown, reason: ExtensionUiCancelReason): void {
    const settled: string[] = [];
    finish(uiRequestId, value, settled);
    emitCancel(settled, reason);
  }

  function dialog(
    method: DialogMethod,
    args: unknown,
    fallback: unknown,
    opts?: { signal?: AbortSignal; timeout?: number }
  ): Promise<unknown> {
    // Already-aborted and post-dispose calls settle immediately rather than
    // parking an entry nothing will ever drain.
    if (disposed || opts?.signal?.aborted) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      const uiRequestId = emit(method, args, opts?.timeout);
      const entry: PendingDialog = { fallback, resolve };
      if (opts?.timeout !== undefined && opts.timeout >= 0) {
        entry.timer = setTimeout(() => cancelOne(uiRequestId, fallback, 'timed_out'), opts.timeout);
        // A pending dialog must not by itself hold the utilityProcess alive.
        entry.timer.unref?.();
      }
      if (opts?.signal) {
        const abort = () => cancelOne(uiRequestId, fallback, 'aborted');
        opts.signal.addEventListener('abort', abort, { once: true });
        entry.removeAbort = () => opts.signal?.removeEventListener('abort', abort);
      }
      pending.set(uiRequestId, entry);
    });
  }

  /** Announce a TUI-only method ONCE — extensions call these in render loops. */
  function reportUnsupported(method: string): void {
    if (extensionUiCapability(method) !== 'tui-only' || unsupported.has(method)) return;
    unsupported.add(method);
    emit('unsupported', { method });
  }

  /**
   * Tell the renderer to drop the display state this bridge put there. Without
   * this, a status chip or widget from the previous session outlives it — the
   * extension that owns it is gone and will never clear it itself.
   */
  function clearPortableState(): void {
    for (const key of statusKeys) emit('setStatus', { key, text: undefined });
    statusKeys.clear();
    for (const key of widgetKeys) emit('setWidget', { key, content: undefined });
    widgetKeys.clear();
    if (titleSet) {
      emit('setTitle', { title: '' });
      titleSet = false;
    }
    if (workingMessageSet) {
      emit('setWorkingMessage', { message: undefined });
      workingMessageSet = false;
    }
    if (workingVisibleSet) {
      emit('setWorkingVisible', { visible: false });
      workingVisibleSet = false;
    }
    if (editorText !== '') {
      editorText = '';
      emit('setEditorText', { text: '' });
    }
  }

  function cancelPending(reason: ExtensionUiCancelReason): void {
    // Snapshot first: `finish` mutates the map as it goes. No `pending.clear()`
    // afterwards — `finish` already removed every entry it settled, and clearing
    // would silently drop a dialog a resolved continuation had just opened
    // instead of settling it.
    const settled: string[] = [];
    for (const [uiRequestId, entry] of [...pending]) finish(uiRequestId, entry.fallback, settled);
    emitCancel(settled, reason);
  }

  const portable = {
    select: (title: string, values: string[], opts?: { signal?: AbortSignal; timeout?: number }) =>
      dialog('select', { title, options: values }, undefined, opts) as Promise<string | undefined>,
    // `false`, never undefined: a dismissed confirmation is a refusal.
    confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
      dialog('confirm', { title, message }, false, opts) as Promise<boolean>,
    input: (
      title: string,
      placeholder?: string,
      opts?: { signal?: AbortSignal; timeout?: number }
    ) => dialog('input', { title, placeholder }, undefined, opts) as Promise<string | undefined>,
    notify: (message: string, type: 'info' | 'warning' | 'error' = 'info') =>
      emit('notify', { message, type }),
    onTerminalInput: () => {
      reportUnsupported('onTerminalInput');
      return () => undefined;
    },
    setStatus: (key: string, text: string | undefined) => {
      if (text === undefined) statusKeys.delete(key);
      else statusKeys.add(key);
      emit('setStatus', { key, text });
    },
    setWorkingMessage: (message?: string) => {
      workingMessageSet = message !== undefined;
      emit('setWorkingMessage', { message });
    },
    setWorkingVisible: (visible: boolean) => {
      workingVisibleSet = true;
      emit('setWorkingVisible', { visible });
    },
    setWorkingIndicator: (indicator?: unknown) => emit('setWorkingIndicator', { indicator }),
    setHiddenThinkingLabel: (label?: string) => emit('setHiddenThinkingLabel', { label }),
    setWidget: (key: string, content: unknown, widgetOptions?: unknown) => {
      // A widget built from a pi TUI COMPONENT cannot cross the wire; only the
      // serializable array form can. Say so once instead of sending a blob the
      // renderer would have to guess at.
      if (
        content !== undefined &&
        (!Array.isArray(content) || !content.every((line) => typeof line === 'string'))
      ) {
        reportUnsupported('setWidget.component');
        return;
      }
      if (content === undefined) widgetKeys.delete(key);
      else widgetKeys.add(key);
      emit('setWidget', { key, content, options: widgetOptions });
    },
    setTitle: (title: string) => {
      titleSet = title.length > 0;
      emit('setTitle', { title });
    },
    pasteToEditor: (text: string) => {
      editorText += text;
      emit('setEditorText', { text: editorText });
    },
    setEditorText: (text: string) => {
      editorText = text;
      emit('setEditorText', { text });
    },
    getEditorText: () => editorText,
    editor: (title: string, prefill?: string) =>
      dialog('editor', { title, prefill }, undefined) as Promise<string | undefined>,
    custom: async () => {
      reportUnsupported('custom');
      return undefined;
    },
    addAutocompleteProvider: () => reportUnsupported('addAutocompleteProvider'),
    setFooter: () => reportUnsupported('setFooter'),
    setHeader: () => reportUnsupported('setHeader'),
    setEditorComponent: () => reportUnsupported('setEditorComponent'),
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: (_name?: string) => portableTheme,
    setTheme: () => ({ success: false, error: 'Theme switching is unavailable in this mode' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => reportUnsupported('setToolsExpanded'),
  };

  /**
   * The Proxy is the compatibility guarantee, not a convenience: pi's
   * `ExtensionUIContext` grows, and an extension calling a method this build has
   * never heard of would otherwise throw `is not a function` and abort the bind.
   * Unknown members become a reported no-op — degraded, but running.
   */
  const uiContext = new Proxy(portable, {
    get(target, property, receiver) {
      // Must be a real object: many extensions style status/widgets via theme.fg.
      if (property === 'theme') return portableTheme;
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (typeof property === 'string') {
        return (..._args: unknown[]) => {
          reportUnsupported(property);
          return undefined;
        };
      }
      return undefined;
    },
  });

  return {
    runtimeId,
    uiContext,
    respond(response) {
      if (disposed) return false;
      // Two independent staleness checks. `runtimeId` catches an answer meant
      // for a bridge that no longer exists (session replaced, Host respawned);
      // the map lookup catches a duplicate or an already-timed-out dialog. Both
      // return false rather than throwing — a late answer is a normal race, not
      // an error.
      if (response.runtimeId !== runtimeId) return false;
      const entry = pending.get(response.uiRequestId);
      if (!entry) return false;
      // `ok: false` means nobody answered; the fallback recorded at open time is
      // the only correct value, and it is decided HERE so no caller upstream can
      // turn a dismissal into a confirmation.
      finish(response.uiRequestId, response.ok ? response.value : entry.fallback);
      return true;
    },
    reload() {
      if (disposed) return;
      cancelPending('session_replaced');
      clearPortableState();
      unsupported.clear();
      emitReset('session_replaced');
    },
    cancelAll(reason) {
      if (disposed) return;
      cancelPending(reason);
    },
    dispose(reason = 'host_shutdown') {
      if (disposed) return;
      // Order matters: flip the flag first so a continuation that runs during
      // the drain takes the fast `Promise.resolve(fallback)` path instead of
      // parking a new entry behind us.
      disposed = true;
      cancelPending('host_shutdown');
      clearPortableState();
      unsupported.clear();
      emitReset(reason);
      pending.clear();
    },
    pendingCount: () => pending.size,
  };
}
