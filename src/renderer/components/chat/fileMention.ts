/**
 * T-07 Composer @ 文件引用 — 纯函数（迁移自 EnhancedInput.tsx）。
 *
 * CC 原生识别 `@path` 形式的纯文本，所以选择文件后只是把 `@qux`
 * 在 textarea 内替换成 `@relativePath `（尾随空格断词）。不做拖拽/
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
 * Walk back from `cursorPos` looking for an unopened `@` token. Returns the
 * substring AFTER the `@` up to the cursor when the token is open and has no
 * inner whitespace/newline — otherwise null (no active mention).
 *
 * 行内换行/空格都断开 token；开头就是 @ 也算开 token（允许段落首）。
 */
export function extractMentionQuery(text: string, cursorPos: number): string | null {
  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '@') {
      // @ 必须由行首或空白前导，mid-token 的 @（如 a@foo）不算开 mention。
      const prev = i > 0 ? text[i - 1] : ' ';
      if (prev !== ' ' && prev !== '\n' && prev !== '\r') {
        return null;
      }
      return text.slice(i + 1, cursorPos);
    }
    if (ch === ' ' || ch === '\n' || ch === '\r') {
      return null;
    }
  }
  return null;
}

/**
 * Replace the open `@query` token ending at `cursorPos` with
 * `@<relativePath> ` (trailing space, so the next keystroke does not get
 * glued to the path). Returns the new text + new cursor position, or null
 * when no `@` was found before the cursor.
 *
 * 与 EnhancedInput 同名实现行为一致（保持端到端体验）；分离出来是为了
 * 让 ChatComposer 与 EnhancedInput 共享而不耦合到那个 900 行组件。
 */
export function replaceMention(
  text: string,
  cursorPos: number,
  selected: FileSearchResult
): MentionInsertion | null {
  let atPos = -1;
  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '@') {
      const prev = i > 0 ? text[i - 1] : ' ';
      if (prev !== ' ' && prev !== '\n' && prev !== '\r') {
        return null;
      }
      atPos = i;
      break;
    }
    if (ch === ' ' || ch === '\n' || ch === '\r') {
      return null;
    }
  }
  if (atPos === -1) return null;
  // 自适应尾随空格：cursor 之后已是空格 / 换行（含 \r\n），不再补（避免双空格）；
  // 文末或后面是普通字符时补一个空格断词，让用户继续打的字不会黏在路径上。
  const nextChar = text[cursorPos] ?? '';
  const isWhitespace = nextChar === ' ' || nextChar === '\n' || nextChar === '\r';
  const needTrailing = !isWhitespace;
  const replacement = `@${selected.relativePath}${needTrailing ? ' ' : ''}`;
  const nextText = text.slice(0, atPos) + replacement + text.slice(cursorPos);
  return { text: nextText, cursor: atPos + replacement.length };
}

/**
 * Scan `text` for every `@path` token and return display chips. Used by
 * ChatComposer to render a row of selected references below the textarea.
 * Not鸣 token 的 path 必须非空（裸 `@` 不算）。允许行首 `@`；token 以空格/
 * 换行/文本结束为终止符（与 extractMentionQuery 一致）。
 */
export interface MentionChip {
  path: string;
  /** Absolute path (FileSearchResult.path), kept in case UI wants to open. */
  absolute?: string;
}

export function parseMentionChips(text: string): MentionChip[] {
  const chips: MentionChip[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    // 允许段落首 @ 或前面是空白（与 extractMentionQuery 一致）
    const prev = i > 0 ? text[i - 1] : ' ';
    if (prev !== ' ' && prev !== '\n' && prev !== '\r') continue;
    let j = i + 1;
    while (j < text.length && text[j] !== ' ' && text[j] !== '\n' && text[j] !== '\r') {
      j += 1;
    }
    if (j > i + 1) {
      chips.push({ path: text.slice(i + 1, j) });
    }
  }
  return chips;
}
