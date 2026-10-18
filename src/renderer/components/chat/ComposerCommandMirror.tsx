/**
 * A recognised slash command in the composer, painted as the official client
 * does: the name in the accent colour, the command's argument hint greyed in
 * after it while nothing follows, and the name's description over it on a
 * click.
 *
 * A `<textarea>` cannot style part of its text, so while this is on the
 * composer makes its own text transparent and this layer, laid exactly over
 * the textarea (same box, padding, font and wrapping, copied from its computed
 * style), draws every character instead. The textarea keeps the caret, the
 * selection and every event; this layer takes no pointer events.
 */

import type { CSSProperties, RefObject } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Computed-style properties that decide where a glyph of the textarea lands. */
const COPIED = [
  'boxSizing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontFeatureSettings',
  'fontVariationSettings',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textIndent',
  'textTransform',
  'tabSize',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
] as const;

export interface ComposerCommandMirrorProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  /** Where the command's name (with its slash) stops in `value`. */
  end: number;
  name: string;
  description: string;
  argumentHint?: string;
  /** The description is showing (the name was clicked). */
  infoOpen: boolean;
}

export function ComposerCommandMirror({
  textareaRef,
  value,
  end,
  name,
  description,
  argumentHint,
  infoOpen,
}: ComposerCommandMirrorProps) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<CSSProperties>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new value re-reads the box and the scroll.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const sync = () => {
      const style = getComputedStyle(textarea);
      const next: Record<string, string | number> = {
        left: textarea.offsetLeft,
        top: textarea.offsetTop,
        // `client*` leaves a scrollbar out, so the text column matches.
        width: textarea.clientWidth,
        height: textarea.clientHeight,
      };
      for (const key of COPIED) next[key] = style[key];
      // Borders are kept for their width only; the textarea draws its own.
      next.borderStyle = 'solid';
      next.borderColor = 'transparent';
      setBox((previous) =>
        Object.keys(next).every((key) => (previous as Record<string, unknown>)[key] === next[key])
          ? previous
          : (next as CSSProperties)
      );
      if (mirrorRef.current) mirrorRef.current.scrollTop = textarea.scrollTop;
    };
    sync();
    textarea.addEventListener('scroll', sync);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    observer?.observe(textarea);
    return () => {
      textarea.removeEventListener('scroll', sync);
      observer?.disconnect();
    };
  }, [textareaRef, value]);

  const rest = value.slice(end);
  const showHint = Boolean(argumentHint) && rest.trim() === '' && !rest.includes('\n');
  const token = (
    <span
      className={cn('rounded-sm text-primary', infoOpen && 'bg-primary/10')}
      data-testid="composer-command-token"
    />
  );

  return (
    <div
      ref={mirrorRef}
      aria-hidden
      data-testid="composer-command-mirror"
      className="pointer-events-none absolute overflow-hidden text-foreground"
      style={box}
    >
      <Tooltip open={infoOpen}>
        <TooltipTrigger render={token}>{value.slice(0, end)}</TooltipTrigger>
        <TooltipPopup side="top" align="start" className="max-w-80 text-meta">
          <div className="flex flex-col gap-1 py-1">
            <span className="text-muted-foreground">/{name}</span>
            {description ? <span>{description}</span> : null}
          </div>
        </TooltipPopup>
      </Tooltip>
      {rest}
      {showHint ? (
        <span className="text-muted-foreground">
          {rest === '' ? ' ' : ''}
          {argumentHint}
        </span>
      ) : null}
      {/* A trailing newline needs a glyph after it, or the mirror's last line collapses. */}
      {value.endsWith('\n') ? '\u200b' : null}
    </div>
  );
}
