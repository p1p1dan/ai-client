import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import { Ident } from '@/components/ui/ident';
import { cn } from '@/lib/utils';
import type { ChatBlock } from '@/stores/chatSessions';
import { derivePermissionActivityRow, type PermissionActivityTone } from './permissionActivityRow';

/**
 * T08-b — the audit line for a gate the permission plugin resolved.
 *
 * Deliberately quiet. This row is EVIDENCE, not a control: the plugin asks its
 * question through the Extension UI modal, and a row here that looked
 * answerable would offer buttons that answer nothing. `policy_allow` in
 * particular has to be recorded without shouting — it is the only proof the call
 * was gated at all, and drawing it as loudly as a decision the user made would
 * train them to ignore the ones they did make.
 *
 * Every string comes off a third-party plugin's broadcast and is rendered as
 * TEXT — React escapes it. Nothing here may reach for `dangerouslySetInnerHTML`.
 */

const TONE_CLASS: Record<PermissionActivityTone, string> = {
  pending: 'text-muted-foreground',
  allowed: 'text-muted-foreground',
  // The only arm that gets colour: a refusal is the one outcome that explains a
  // turn which did less than it was asked to.
  denied: 'text-destructive',
  auto: 'text-muted-foreground/80',
};

const TONE_ICON: Record<PermissionActivityTone, typeof ShieldCheck> = {
  pending: ShieldQuestion,
  allowed: ShieldCheck,
  denied: ShieldX,
  auto: ShieldAlert,
};

export function PermissionActivityRows({ blocks }: { blocks: readonly ChatBlock[] }) {
  const views = blocks
    .map((block) => block.permissionActivity)
    .filter((record): record is NonNullable<typeof record> => record !== undefined)
    .map(derivePermissionActivityRow);
  if (views.length === 0) return null;

  return (
    <ul className="flex list-none flex-col gap-1 py-1 pl-0">
      {views.map((view) => {
        const Icon = TONE_ICON[view.tone];
        return (
          <li
            key={view.requestId}
            data-tone={view.tone}
            // `text-meta`, not a raw size (D25 §6.3): this is a meta row, the
            // same domain as timestamps and the status line.
            className={cn('flex min-w-0 items-start gap-2 text-meta', TONE_CLASS[view.tone])}
          >
            <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{view.label}</span>
              {view.detail ? (
                <>
                  {' '}
                  {/* Mono because the payload is a command or a path — D25 §2.5. */}
                  <Ident className="break-all">{view.detail}</Ident>
                </>
              ) : null}
              {view.note ? <span className="opacity-80"> · {view.note}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
