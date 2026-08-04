import { Fragment, memo, useEffect, useState } from 'react';
import { type ChatCodeToken, chatCodeTokenStyle, chatMarkdownCodeBlockClass } from './chatMarkdown';
import { highlightChatCode } from './chatShiki';
import { useDarkClass } from './useDarkClass';

/**
 * T-29: a fenced code block in assistant prose.
 *
 * ## No layout shift while the highlighter loads
 *
 * The un-highlighted and highlighted renderings are the SAME `<pre><code>` box
 * with the same class, the same padding and the same text — only the colour of
 * the runs inside differs. shiki arrives one or two frames later over a dynamic
 * import, and when it does, nothing reflows: `<pre>` preserves whitespace, and
 * the highlighted form re-emits the identical characters (token contents
 * concatenated, plus the newlines between lines) as text children. That is why
 * the lines are joined with real `\n` text nodes instead of `display: block`
 * line wrappers — a block-per-line rendering has to re-create empty lines with
 * a min-height, which is exactly where a one-pixel drift would come from.
 *
 * ## Trust boundary
 *
 * Nothing here calls `dangerouslySetInnerHTML`. `token.content` is a substring
 * of the model's own fence and is rendered as a React text child; `token.color`
 * comes from a bundled shiki theme and is applied through a style OBJECT. See
 * `chatMarkdown.chatCodeTokenStyle` for the full argument.
 */
export const ChatCodeBlock = memo(function ChatCodeBlock({
  code,
  language,
}: {
  code: string;
  /** The fence's raw info string; normalisation and the unknown-language fallback live in `chatShiki`. */
  language: string | null;
}) {
  const isDark = useDarkClass();
  const [lines, setLines] = useState<ChatCodeToken[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Drop the previous theme's tokens immediately on a light/dark flip, so the
    // block falls back to un-coloured text for the frame or two the re-highlight
    // takes rather than showing dark-theme colours on a light surface.
    setLines(null);
    void highlightChatCode({ code, language, isDark }).then((result) => {
      if (!cancelled) setLines(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, isDark]);

  return (
    <pre className={chatMarkdownCodeBlockClass()}>
      <code>
        {lines
          ? lines.map((line, lineIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: token lines have no identity beyond their position
              <Fragment key={lineIndex}>
                {line.map((token, tokenIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: ditto, within a line
                  <span key={tokenIndex} style={chatCodeTokenStyle(token)}>
                    {token.content}
                  </span>
                ))}
                {lineIndex < lines.length - 1 ? '\n' : null}
              </Fragment>
            ))
          : code}
      </code>
    </pre>
  );
});
