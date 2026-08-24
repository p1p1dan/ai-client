import { Check, Copy } from 'lucide-react';
import { Fragment, memo, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  type ChatCodeToken,
  chatCodeTokenStyle,
  chatMarkdownCodeBlockClass,
} from './chatMarkdownPolicy';
import { highlightChatCode } from './chatShiki';
import { turnCopyButtonClass } from './chatTimelineLayout';
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
 *
 * ## FB2: the copy button
 *
 * D53 (1) scopes it to PROSE fences only. Tool input/output never reaches here
 * -- `ToolRows` does not import this component and `ChatMarkdown`'s `code`
 * renderer is its only call site -- so `turnCopy.ts`'s exclusion of tool bodies
 * (R2) is preserved by the render path itself, with no branch to maintain.
 *
 * The button sits on a wrapper, NOT inside `<pre>`: `<pre>` is the horizontal
 * scroll container (`overflow-x-auto`), so a button parented to it would ride
 * away with the scroll on a long line.
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
    <div className="relative">
      <CodeCopyButton code={code} />
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
    </div>
  );
});

const COPY_CONFIRM_MS = 1500;

/**
 * Copy affordance for a prose fence (FB2, D53 (1)).
 *
 * Always visible -- F-B15 forbids the `opacity-0` / `group-hover:` pair, because
 * a control only a mouse can discover is unreachable by touch and keyboard. D55
 * (3) asks for restraint instead of concealment, so the resting state drops one
 * tier to `text-muted-foreground/60` (the repo's existing ghost-icon tier) and
 * `focus-visible` brings it back for keyboard users.
 *
 * The clipboard behaviour is `TurnCopyButton`'s, verbatim: no `execCommand`
 * fallback, silent on refusal, 1.5s `Check` confirmation. Two copy buttons that
 * fail differently would be worse than one that fails.
 */
function CodeCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // A button that lies about having copied is worse than one that appears
      // to do nothing (TurnCopyButton's rule, kept identical here).
      return;
    }
    setCopied(true);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
  };

  const label = copied ? 'Copied' : 'Copy code';
  return (
    <button
      type="button"
      className={cn(
        turnCopyButtonClass(),
        'absolute top-1.5 right-1.5 z-10 text-muted-foreground/70',
        'focus-visible:text-foreground'
      )}
      onClick={() => void handleCopy()}
      aria-label={label}
      title={label}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}
