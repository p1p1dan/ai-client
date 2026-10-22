import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionRailCardOpen, useSessionRailStore } from '@/stores/sessionRail';
import type { SessionRailCardId } from './sessionRailModel';

/**
 * Layout 5e: one card of the session rail — a 32px header (12px semibold
 * title, the fold chevron right after it, a summary at the right end) over a
 * 12px body. The fold is the user's, persisted per card.
 */
export function RailCard({
  id,
  title,
  summary,
  children,
}: {
  id: SessionRailCardId;
  title: string;
  /** The header's right end: a percentage, line counts, `N / M`… */
  summary?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const open = useSessionRailCardOpen(id);
  const toggleCard = useSessionRailStore((state) => state.toggleCard);
  return (
    <section
      className="shrink-0 rounded-md border border-border-soft bg-surface-2"
      data-rail-card={id}
      aria-label={title}
    >
      <div className="flex h-8 min-w-0 items-center gap-1 pr-2.5 pl-1">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${title} · ${open ? t('Collapse') : t('Expand')}`}
          onClick={() => toggleCard(id)}
          className="flex h-6 min-w-0 shrink items-center gap-1 rounded-sm px-1.5 text-small font-semibold text-foreground transition-colors hover:bg-fill-ghost-hover focus-visible:bg-fill-ghost-hover"
        >
          <span className="min-w-0 truncate">{title}</span>
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform duration-150',
              !open && '-rotate-90'
            )}
          />
        </button>
        {summary !== undefined && summary !== null && (
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 text-small text-muted-foreground tabular-nums">
            {summary}
          </div>
        )}
      </div>
      {open && <div className="min-w-0 px-2.5 pb-2 text-small text-foreground">{children}</div>}
    </section>
  );
}

/** A body row: 24px, a 14px faint icon, text that truncates, an optional faint tail. */
export function RailRow({
  icon,
  children,
  tail,
  title,
}: {
  icon: ReactNode;
  children: ReactNode;
  tail?: ReactNode;
  title?: string;
}) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-2" title={title}>
      <span aria-hidden className="flex size-3.5 shrink-0 items-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {tail !== undefined && tail !== null && (
        <span className="shrink-0 text-foreground-faint">{tail}</span>
      )}
    </div>
  );
}
