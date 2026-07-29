/**
 * T-22 (D19) acceptance ③: the reading column that centers the message
 * timeline and the composer under the same max width. The only chat-side file
 * that reads `useShellLayoutStore` — chat must not import components/workspace-shell
 * (that dependency direction is inverted on purpose, see T-22 spec §2.13).
 *
 * T-28's two-column middle pane can reuse this component as-is.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useReadingColumnClass } from '@/stores/shellLayout';

interface ReadingColumnProps {
  className?: string;
  children: ReactNode;
}

export function ReadingColumn({ className, children }: ReadingColumnProps) {
  const readingColumnClass = useReadingColumnClass();
  return <div className={cn('mx-auto w-full', readingColumnClass, className)}>{children}</div>;
}
