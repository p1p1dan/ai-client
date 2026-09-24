/**
 * The reason behind a rejected `ipcRenderer.invoke`, without Electron's wrapper.
 *
 * Electron rewrites every rejection before the renderer sees it:
 * `Error invoking remote method '<channel>': <ErrorClass>: <message>`. On a
 * one-line surface that prefix is all that fits — the 2026-09-24 point-check
 * read 「切换分支失败: Error invoki…」 while git's own sentence sat in a tooltip.
 *
 * Unwraps generically (any channel, any `…Error:` class name) and never
 * translates or rewords what is left: the message belongs to whoever raised it
 * (git, WorkerManager). A message that was never wrapped comes back unchanged.
 *
 * `hooks/piTuiOpenError.ts` carries the same pattern for its own dictionary-key
 * lookup and predates this module.
 */

/** `Error invoking remote method 'x': [SomeError: ]<message>` */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?([\s\S]+)$/;

export function unwrapIpcErrorMessage(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error ?? '')).trim();
  const inner = IPC_WRAPPER.exec(text)?.[1]?.trim();
  return inner ? inner : text;
}
