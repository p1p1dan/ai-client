/**
 * dsh-rebase P1-7b (decisions 072 rule 5, 119; plan P1-7 shard 03 §4.1, the
 * bash plan's B6): the live tail of a running command, inside its row's open
 * body. A leaf of its own: it subscribes to one call's tail, so a new tail
 * re-renders this pane and nothing above it, and a folded row (whose body is
 * not mounted) costs nothing. It follows the end while the reader is at it
 * and stops once they scroll up.
 */

import { useLayoutEffect, useRef } from 'react';
import { useI18n } from '@/i18n';
import { useToolLiveOutputStore } from '@/stores/toolLiveOutput';

export function LiveToolOutput({ toolCallId }: { toolCallId: string }) {
  const { t } = useI18n();
  const output = useToolLiveOutputStore((state) => state.byCall[toolCallId]);
  const scroller = useRef<HTMLPreElement | null>(null);
  const following = useRef(true);
  const text = output?.text ?? '';

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current && text) element.scrollTop = element.scrollHeight;
  }, [text]);

  if (!output || !text) return null;
  return (
    <div className="ml-0.5 border-l border-border pl-3.5" data-testid="live-tool-output">
      <p className="pt-1 text-meta text-muted-foreground tabular-nums">
        {t('Live output')}
        {output.omittedBytes > 0 &&
          ` · ${t('Earlier {{size}} not shown', {
            size: `${Math.max(1, Math.round(output.omittedBytes / 1024))} KB`,
          })}`}
      </p>
      <pre
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
        }}
        className="m-0 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words pb-2 text-code text-muted-foreground leading-[1.55]"
      >
        {text}
      </pre>
    </div>
  );
}
