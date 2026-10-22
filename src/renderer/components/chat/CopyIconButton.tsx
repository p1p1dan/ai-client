import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

const COPY_CONFIRM_MS = 1500;

/**
 * The chat's one ghost copy button (24px, design system v2 §1: ghost inside a
 * framed or frameless object alike): the code block head, the thinking body
 * and the user message's action row.
 *
 * Clipboard behaviour is `TurnCopyButton`'s: no `execCommand` fallback, silent
 * on refusal (a button that lies about having copied is worse than one that
 * appears to do nothing), 1.5s `Check` confirmation.
 */
export function CopyIconButton({
  text,
  label,
  copiedLabel,
}: {
  text: string;
  /** Accessible name at rest, already translated. */
  label: string;
  /** Accessible name while the confirmation shows, already translated. */
  copiedLabel: string;
}) {
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
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
  };

  const name = copied ? copiedLabel : label;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="shrink-0"
      onClick={() => void handleCopy()}
      aria-label={name}
      title={name}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
