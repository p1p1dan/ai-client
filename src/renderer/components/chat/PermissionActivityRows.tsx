import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatBlock } from '@/stores/chatSessions';
import {
  derivePermissionActivityRow,
  isQuietPermissionActivity,
  type PermissionActivityTone,
} from './permissionActivityRow';

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
 *
 * ## `PermissionActivityDetails` removed (user decision 2026-09-18)
 *
 * 「输出过程中不要再显示『授权详情』这个项目了，不需要。」 It was the sibling
 * `<details>` that held the QUIET gates — the `policy_allow` records nobody
 * decided — behind a 「授权详情 (N)」 summary appended once per turn. With the
 * turn-level work group now hiding the whole process behind one line, a second
 * disclosure inside it was a fold within a fold for the least interesting rows
 * on the transcript.
 *
 * What deliberately stayed is this component: it renders the NON-quiet records
 * (denied, and gate errors) unconditionally, and it is the only visible exit a
 * refused authorization has. Removing it too would make a denial silent, which
 * is the opposite of what the decision asked for.
 *
 * The cost, recorded rather than hidden: a `policy_allow` gate now has no
 * surface at all in the UI. It is still in the message blocks and still in the
 * session log; `isQuietPermissionActivity` below is what draws the line, and
 * `includeAllowed` is the parameter that would bring them back.
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

export function PermissionActivityRows({
  blocks,
  includeAllowed = false,
}: {
  blocks: readonly ChatBlock[];
  includeAllowed?: boolean;
}) {
  const { t } = useI18n();
  const views = blocks
    .filter((block) => includeAllowed || !isQuietPermissionActivity(block.permissionActivity))
    .map((block) => block.permissionActivity)
    .filter((record): record is NonNullable<typeof record> => record !== undefined)
    .map((record) => derivePermissionActivityRow(record, t));
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
