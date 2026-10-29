import { CircleHelp } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function SettingsPageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <h2 className="text-title font-semibold text-balance">{title}</h2>
      {children}
    </div>
  );
}

/**
 * Design system v2 §7.12: one settings group is ONE card — `rounded-md`,
 * `border-soft`, `--surface-2` — with a hairline between its items instead of
 * a frame per item. The title and description sit above the card.
 *
 * `bare`: the children bring their own frames (a framed list, notices, folder
 * cards), so they are stacked without the group card around them — one closed
 * border along any line of sight (§1).
 */
export function SettingsSectionBlock({
  title,
  description,
  bare = false,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  bare?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-2">
      <div className="min-w-0 space-y-0.5 px-1">
        <h3 className="text-heading font-semibold">{title}</h3>
        {description && <div className="text-ui text-muted-foreground">{description}</div>}
      </div>
      {children && <div className={bare ? 'space-y-4' : SETTINGS_CARD_CLASS}>{children}</div>}
    </section>
  );
}

/**
 * The group card's frame and dividers, for hand-rolled groups and lists whose
 * rows carry their own padding.
 */
export const SETTINGS_CARD_FRAME_CLASS =
  'min-w-0 divide-y divide-border-soft rounded-md border border-border-soft bg-surface-2';

/** The group card with the standard item padding (`px-4 py-3`, §4.2). */
export const SETTINGS_CARD_CLASS = `${SETTINGS_CARD_FRAME_CLASS} *:px-4 *:py-3`;

export function SettingsRow({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'grid min-w-0 grid-cols-1 items-start gap-2 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4',
        className
      )}
      {...props}
    />
  );
}

/**
 * A question mark beside a section title whose hover shows the how-to text,
 * so the page itself carries no explanatory paragraphs.
 */
export function SettingsHelpTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            aria-label={label}
          />
        }
      >
        <CircleHelp />
      </TooltipTrigger>
      <TooltipPopup className="max-w-sm">
        <div className="space-y-1.5 text-small">{children}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
