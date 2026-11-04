import { Check, Copy } from 'lucide-react';
import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import {
  type ChatCodeToken,
  chatCodeTokenStyle,
  chatMarkdownCodeBlockClass,
  chatMarkdownCodeFrameClass,
  chatMarkdownCodeHeadClass,
} from './chatMarkdownPolicy';
import { highlightChatCodeNow, prepareChatHighlight } from './chatShiki';
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
 *
 * ## Design system v2 §7.5: one closed frame with a head bar
 *
 * The frame is the wrapper; a 32px head (the fence's language, the ghost copy
 * button) sits over a hairline, and `<pre>` below it is only the scroll box.
 * The head is what holds the button now, so it no longer floats over the code.
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
  // PiLab R2 (07.7): tokens are read synchronously once the grammar is loaded,
  // and from this block's previous result, so a flush re-tokenises only the
  // lines that changed (normally the last one) and keeps the rest's rows by
  // reference for `CodeLine`'s memo. `ready` bumps when a load finishes. A
  // light/dark flip still starts from nothing: the previous rows are in the
  // other theme, and `highlightChatCodeNow` will not reuse them.
  const [ready, setReady] = useState(0);
  const previous = useRef<ChatCodeToken[][] | null>(null);
  const highlighted = useMemo(() => {
    void ready;
    return highlightChatCodeNow({ code, language, isDark, previous: previous.current });
  }, [code, language, isDark, ready]);
  previous.current = highlighted ?? null;

  useEffect(() => {
    if (highlighted !== undefined) return;
    let cancelled = false;
    void prepareChatHighlight({ code, language, isDark }).then((loaded) => {
      if (loaded && !cancelled) setReady((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [highlighted, code, language, isDark]);
  const lines = highlighted ?? null;

  // The info string's first word is the language; the rest is fence metadata.
  const label = language?.trim().split(/\s+/, 1)[0] ?? '';
  return (
    <div className={chatMarkdownCodeFrameClass()}>
      <div className={chatMarkdownCodeHeadClass()}>
        {/* A selection across the block copies the code, not its language. */}
        <span className="min-w-0 select-none truncate lowercase">{label}</span>
        <CodeCopyButton code={code} />
      </div>
      <pre className={chatMarkdownCodeBlockClass()}>
        <code>
          {lines
            ? lines.map((line, lineIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: token lines have no identity beyond their position
                <Fragment key={lineIndex}>
                  <CodeLine line={line} />
                  {lineIndex < lines.length - 1 ? '\n' : null}
                </Fragment>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
});

/** One line's tokens. Unchanged rows arrive by reference, so they skip re-rendering. */
const CodeLine = memo(function CodeLine({ line }: { line: ChatCodeToken[] }) {
  return (
    <>
      {line.map((token, tokenIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ditto, within a line
        <span key={tokenIndex} style={chatCodeTokenStyle(token)}>
          {token.content}
        </span>
      ))}
    </>
  );
});

const COPY_CONFIRM_MS = 1500;

/**
 * Copy affordance for a prose fence (FB2, D53 (1)).
 *
 * Always visible -- F-B15 forbids the `opacity-0` / `group-hover:` pair, because
 * a control only a mouse can discover is unreachable by touch and keyboard. D55
 * (3) asks for restraint instead of concealment; design system v2 gives that
 * job to the ghost button inside the head bar (muted ink, hover fill, the coss
 * focus ring).
 *
 * The clipboard behaviour is `TurnCopyButton`'s, verbatim: no `execCommand`
 * fallback, silent on refusal, 1.5s `Check` confirmation. Two copy buttons that
 * fail differently would be worse than one that fails.
 */
function CodeCopyButton({ code }: { code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const handleCopy = async (button: HTMLElement) => {
    // Decision 209 §3: the clipboard of the window the button is in. With the
    // side chat's own window focused, the main page may not write it.
    const clipboard = button.ownerDocument.defaultView?.navigator.clipboard ?? navigator.clipboard;
    try {
      await clipboard.writeText(code);
    } catch {
      // A button that lies about having copied is worse than one that appears
      // to do nothing (TurnCopyButton's rule, kept identical here).
      return;
    }
    setCopied(true);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
  };

  const label = copied ? t('Copied') : t('Copy code');
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="shrink-0"
      onClick={(event) => void handleCopy(event.currentTarget)}
      aria-label={label}
      title={label}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
