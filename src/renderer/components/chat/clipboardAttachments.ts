/**
 * T-18 paste intent — pure decision, DOM stays in the hook.
 *
 * The single most important guarantee here: a paste that carries text is never
 * intercepted. Plain text, code and rich text keep the browser's native insert
 * (cursor position, undo stack, IME buffer), because the paste handler only
 * ever adds attachments — it never writes the textarea value.
 *
 * §12 verification first: __tests__/clipboardAttachments.test.ts.
 */

export interface PastedItemDescriptor {
  /** DataTransferItem.kind — 'string' | 'file' in practice. */
  kind: string;
  /** DataTransferItem.type — a MIME type, often '' for files on Windows. */
  type: string;
}

export type ClipboardItemRole = 'image' | 'file' | 'text' | 'ignore';

export interface PastePlan {
  /** Indices into the original item list, in clipboard order. */
  fileIndices: number[];
  preventDefault: boolean;
}

/** Narrow one DataTransferItem to the role the Composer cares about. */
export function classifyClipboardItem(item: PastedItemDescriptor): ClipboardItemRole {
  if (item.kind === 'file') {
    return item.type.toLowerCase().startsWith('image/') ? 'image' : 'file';
  }
  if (item.kind === 'string' && item.type.toLowerCase().startsWith('text/')) {
    return 'text';
  }
  return 'ignore';
}

/**
 * Decide what a paste should do.
 *
 * - No file items at all -> never intercept. This is the plain-text regression
 *   guard: the handler returns before touching anything.
 * - File items present and the clipboard has no text flavour (screenshot tools)
 *   -> intercept, because suppressing a native insert that would insert nothing
 *   is lossless.
 * - File items present alongside text (Explorer copy, Word/browser rich text)
 *   -> attach the files but let the text land natively. Not one character the
 *   user copied is ever dropped.
 */
export function planPaste(items: readonly PastedItemDescriptor[], plainText = ''): PastePlan {
  const fileIndices: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const role = classifyClipboardItem(items[index]);
    if (role === 'image' || role === 'file') fileIndices.push(index);
  }
  return {
    fileIndices,
    preventDefault: fileIndices.length > 0 && plainText.length === 0,
  };
}
