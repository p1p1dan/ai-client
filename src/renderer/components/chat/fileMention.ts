/**
 * T-07 Composer @ 文件引用 — 纯函数（迁移自 EnhancedInput.tsx）。
 *
 * CC 原生识别 `@path` 形式的纯文本，所以选择文件后只是把 `@qux`
 * 在 textarea 内替换成 `@relativePath `（尾随空格断词）；路径带空格时写成
 * `@"relative path"`（PiLab R2，与 Claude Code 相同）。不做拖拽/
 * 图片/IPC 附件协议（任务说明明确）。
 *
 * §12 验证先行：fileMention.test.ts 覆盖。
 */
import type { FileSearchResult } from '@shared/types/search';

export interface MentionInsertion {
  text: string;
  cursor: number;
}

/**
 * The `@` token around the caret (PiLab R2, as Claude Code's composer reads it):
 * an `@` at the start or after whitespace, then either a quoted path —
 * `@"My Docs/a.md"`, how a path with spaces is written — or a run of
 * non-whitespace. `start` is the `@`; `end` is the end of the WHOLE token,
 * past the caret, so a completion never leaves half the old word behind.
 */
interface MentionToken {
  start: number;
  end: number;
  /** What was typed after the `@` (and its quote) up to the caret. */
  query: string;
}

const QUOTED_OPEN = /(?:^|\s)@"([^"\n]*)$/;
const PLAIN_OPEN = /(?:^|\s)@([^\s"]\S*|)$/;

function mentionTokenAt(text: string, cursorPos: number): MentionToken | null {
  const before = text.slice(0, cursorPos);
  const quoted = QUOTED_OPEN.exec(before);
  if (quoted) {
    const start = cursorPos - quoted[1].length - 2;
    const rest = text.slice(cursorPos);
    const close = /^[^"\n]*"/.exec(rest);
    const end = cursorPos + (close ? close[0].length : (/^\S*/.exec(rest)?.[0].length ?? 0));
    return { start, end, query: quoted[1] };
  }
  const plain = PLAIN_OPEN.exec(before);
  if (!plain) return null;
  const start = cursorPos - plain[1].length - 1;
  const end = cursorPos + (/^\S*/.exec(text.slice(cursorPos))?.[0].length ?? 0);
  return { start, end, query: plain[1] };
}

/**
 * The open mention's query at the caret: the text after `@` up to it, or null
 * when the caret is not in one. `a@b.com` / `obj@decorator` open none: the `@`
 * must start the text or follow whitespace.
 */
export function extractMentionQuery(text: string, cursorPos: number): string | null {
  return mentionTokenAt(text, cursorPos)?.query ?? null;
}

/** `@path`, or `@"path"` when the path has whitespace in it (Claude Code's form). */
export function formatMention(relativePath: string): string {
  return /\s/.test(relativePath) ? `@"${relativePath}"` : `@${relativePath}`;
}

/**
 * Replace the whole `@` token at the caret with the picked path, plus a space
 * when the next character is not whitespace already (so the next keystroke is
 * not glued to the path). Null when the caret is in no token.
 */
export function replaceMention(
  text: string,
  cursorPos: number,
  selected: FileSearchResult
): MentionInsertion | null {
  const token = mentionTokenAt(text, cursorPos);
  if (!token) return null;
  const nextChar = text[token.end] ?? '';
  const needTrailing = !/\s/.test(nextChar);
  const replacement = `${formatMention(selected.relativePath)}${needTrailing ? ' ' : ''}`;
  const nextText = text.slice(0, token.start) + replacement + text.slice(token.end);
  return { text: nextText, cursor: token.start + replacement.length };
}

/**
 * D4 (round-5) retired `insertMentionTrigger` (T-30b2 §4.6, F-A12) with its
 * only caller. It programmatically wrote an `@` at the caret for the ⊕ button,
 * which existed because this app had no renderer-side "read a file into bytes"
 * IPC and could therefore only offer a REFERENCE, not an attachment.
 * `file:readAttachment` closed that gap: ⊕ is now "Attach files" and nothing
 * inserts an `@` on the user's behalf.
 *
 * Typing `@` by hand is unaffected and remains fully covered here —
 * `extractMentionQuery` (the popup trigger) and `replaceMention` (the
 * completion) are what that path is actually made of.
 */

/**
 * Scan `text` for every `@path` / `@"path"` token and return display chips.
 * Used by ChatComposer to render a row of selected references below the
 * textarea. A bare `@` is none; the boundary is the one `extractMentionQuery` uses.
 */
export interface MentionChip {
  path: string;
  /** Absolute path (FileSearchResult.path), kept in case UI wants to open. */
  absolute?: string;
}

const CHIP = /(?:^|\s)@(?:"([^"\n]+)"|([^\s"]\S*))/g;

export function parseMentionChips(text: string): MentionChip[] {
  const chips: MentionChip[] = [];
  for (const match of text.matchAll(CHIP)) {
    chips.push({ path: match[1] ?? match[2] });
  }
  return chips;
}
