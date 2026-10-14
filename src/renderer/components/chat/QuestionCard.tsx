import type { PermissionDecisionId } from '@shared/types/runtimeEvents';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatBlock } from '@/stores/chatSessions';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import {
  DISCUSSED_MARK,
  deriveCardTitle,
  deriveFrozenPairs,
  derivePermissionCardView,
  derivePermissionRowView,
  deriveQuestionCardState,
  type FrozenPair,
  OTHER_ANSWER_LINE,
  PERMISSION_DIFF_CLAMPED_MARK,
  PERMISSION_WAITING,
  type PermissionDetailView,
  type PermissionRisk,
  permissionSecondsLeft,
  SKIPPED_MARK,
  STOPPED_MARK,
} from './questionCardModel';
import { derivePermissionOrigin } from './subagentActivityModel';
import { ToolRow } from './ToolRows';

/**
 * T-05 batch 3: renders `.qa` off `questionCardModel.ts`'s pure view models. No
 * business logic lives here — selection/pagination/payload assembly are all
 * pure-module calls, this file only turns their output into DOM.
 */

type QuestionCardVariant = 'frozen' | 'permission';

/** The live, answerable question is `QuestionPrompt`; this renders the other two. */
interface QuestionCardProps {
  variant: QuestionCardVariant;
  block: ChatBlock;
  /** permission only. */
  canRespond?: boolean;
  /**
   * Takes the DECISION the pressed row carries, not a boolean: the allow/deny
   * boolean is derived from it exactly once, at the dock's call site. May
   * resolve `false` on an IPC failure, which unlocks the card again.
   */
  onRespondPermission?: (decision: PermissionDecisionId) => Promise<boolean> | undefined;
  /**
   * permission only — the dock's `2/5` queue marker, already worded by
   * `derivePermissionQueueProgress`.
   *
   * A finished string rather than a `{position, depth}` pair on purpose: both
   * rules that decide whether a marker appears at all (no lone `1/1`, nothing
   * when the worker did not report) are pure and testable where they live, and
   * this card stays a renderer. `null`/absent means draw nothing.
   */
  progress?: string | null;
}

const QA_SHELL_CLASS = 'overflow-hidden rounded-md border border-border bg-card';

/**
 * The permission card's three tiers, as tone rather than decoration: a write or
 * a command cannot be taken back, so its card carries the destructive edge that
 * every other card in the timeline deliberately does not.
 */
const PERMISSION_RISK_SHELL: Record<PermissionRisk, string> = {
  high: 'border-destructive/40',
  medium: 'border-border',
  low: 'border-border',
};
const PERMISSION_RISK_CHIP: Record<PermissionRisk, string> = {
  high: 'bg-destructive/10 text-destructive',
  medium: 'bg-muted text-muted-foreground',
  low: 'bg-muted text-muted-foreground',
};
/** Catalog keys — the chip was hard-coded Chinese, i.e. wrong in the other locale. */
const PERMISSION_RISK_LABEL: Record<PermissionRisk, string> = {
  high: 'High risk',
  medium: 'Needs confirmation',
  low: 'Low risk',
};
/**
 * Allow is the primary press, refusing is quiet. `cancel` shares deny's shape:
 * both refuse, and the card must not make aborting the turn look like the
 * ordinary way out.
 */
const PERMISSION_BUTTON_VARIANT: Record<PermissionDecisionId, 'default' | 'secondary' | 'ghost'> = {
  allow: 'default',
  allow_session: 'secondary',
  deny: 'ghost',
  cancel: 'ghost',
};

export function QuestionCard(props: QuestionCardProps) {
  if (props.variant === 'permission') {
    return (
      <PermissionQaCard
        key={props.block.permissionId ?? `permission-block-${props.block.id}`}
        block={props.block}
        canRespond={Boolean(props.canRespond)}
        onRespond={props.onRespondPermission}
        progress={props.progress ?? null}
      />
    );
  }
  return <FrozenQaCard block={props.block} />;
}

// ---- Shared bits ----

interface QaHeadProps {
  title: string;
  /** Answer progress, e.g. `2 / 4`. Absent when the card has nothing to count. */
  progress?: string | null;
}

/** `.qa-head` — 36px bar: title and an optional progress counter. */
function QaHead({ title, progress }: QaHeadProps) {
  return (
    <div className="flex min-h-9 items-start gap-2 border-b border-border px-3 py-2 text-muted-foreground">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-semibold tracking-[0.01em]">
        {title}
      </span>
      {progress && (
        <span className="shrink-0 text-meta tabular-nums text-muted-foreground">{progress}</span>
      )}
    </div>
  );
}

/** `.qa-frozen` — read-only Q/A pairs, same color and size, order-only distinction. */
function QaFrozenPairs({ pairs }: { pairs: FrozenPair[] }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2.5 px-3.5 pb-3">
      {pairs.map((pair) => (
        <div
          key={pair.key}
          className="flex flex-col gap-1 break-words whitespace-pre-wrap text-ui leading-relaxed"
        >
          {pair.question && <span className="text-foreground">{pair.question}</span>}
          {pair.skipped ? (
            <span className="italic text-muted-foreground">
              {t(pair.discussed ? DISCUSSED_MARK : pair.stopped ? STOPPED_MARK : SKIPPED_MARK)}
            </span>
          ) : pair.answerParts ? (
            // Decision 144 (problem 8): one line per pick. Joined with ", " the
            // answer could not be read when a label itself holds a comma.
            <ul className="list-disc space-y-0.5 pl-5 text-foreground">
              {pair.answerParts.map((part) => (
                <li key={`${part.other ? 'other' : 'label'}:${part.text}`}>
                  {part.other ? t(OTHER_ANSWER_LINE, { text: part.text }) : part.text}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-foreground">{pair.answer}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---- Frozen variant ----

function FrozenQaCard({ block }: { block: ChatBlock }) {
  const { t } = useI18n();
  const state = deriveQuestionCardState(block);
  // `deriveCardTitle` returns a catalog key (T067) — the card words it.
  const title = t(deriveCardTitle(state));
  const pairs = deriveFrozenPairs(block);
  if (pairs.length === 0) return null;
  return (
    <div className={QA_SHELL_CLASS}>
      <QaHead title={title} />
      <QaFrozenPairs pairs={pairs} />
    </div>
  );
}

// ---- Permission variant (thin adapter over the same shell) ----

/**
 * The card body: what is actually being asked for. Every line comes out of
 * `derivePermissionDetailView` already formatted — this function only chooses
 * type domains (mono for command/path idents, meta for secondary lines) and
 * emphasis (destructive for grants that outlive the single request).
 *
 * Deliberately NOT rendered: the diff body. The repo's only diff surface is a
 * Monaco `DiffEditor` bound to git paths rather than unified-diff strings, so a
 * real patch view is its own task; until then the file list plus +/- counts is
 * what this card honestly has.
 */
function PermissionDetailBody({ detail }: { detail: PermissionDetailView }) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 flex-col gap-1 px-1">
      {detail.command !== null && (
        <Ident className="min-w-0 truncate text-foreground" title={detail.command}>
          {detail.command}
        </Ident>
      )}
      {detail.files.map((file) => (
        <div key={file.key} className="flex min-w-0 items-center gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-xs border border-border bg-muted text-meta leading-none text-muted-foreground">
            {file.badge}
          </span>
          <Ident className="min-w-0 flex-1 truncate text-foreground" title={file.path}>
            {file.path}
          </Ident>
          {file.stat && (
            <span className="shrink-0 text-meta tabular-nums text-muted-foreground">
              {file.stat}
            </span>
          )}
          {file.truncated && (
            <span className="shrink-0 text-meta text-muted-foreground">
              {t(PERMISSION_DIFF_CLAMPED_MARK)}
            </span>
          )}
        </div>
      ))}
      {detail.meta.map((line) => (
        <p key={line} className="min-w-0 truncate text-meta text-muted-foreground" title={line}>
          {line}
        </p>
      ))}
      {detail.warnings.map((line) => (
        <p key={line} className="text-meta text-destructive">
          {line}
        </p>
      ))}
      {detail.notes.map((line) => (
        <p key={line} className="text-meta italic text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}

function PermissionQaCard({
  block,
  canRespond,
  onRespond,
  progress,
}: {
  block: ChatBlock;
  canRespond: boolean;
  onRespond?: (decision: PermissionDecisionId) => Promise<boolean> | undefined;
  progress: string | null;
}) {
  const { t } = useI18n();
  const view = derivePermissionCardView(block, canRespond, t);
  const [submitting, setSubmitting] = useState(false);
  // PI-Desktop PermissionCard: tick once a second toward the deadline the
  // engine enforces, and answer `deny` once at zero — the same answer its own
  // abort gives, so whichever lands first reports the same outcome.
  const expiresAt = view.state === 'resolved' ? undefined : block.permissionExpiresAt;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (expiresAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  const secondsLeft = permissionSecondsLeft(expiresAt, now);
  const autoDenied = useRef(false);
  useEffect(() => {
    if (secondsLeft !== 0 || view.waiting || submitting || autoDenied.current) return;
    autoDenied.current = true;
    setSubmitting(true);
    void Promise.resolve(onRespond?.('deny')).then((ok) => {
      if (ok === false) setSubmitting(false);
    });
  }, [secondsLeft, view.waiting, submitting, onRespond]);
  // T-34: "from subagent" chip, fed by the adjacent activity store's
  // permissionId → origin index. Null for main-agent requests, old Hosts
  // (no `agentId` on the event) and resolved cards (the index entry is
  // deleted on permission.resolved) — the card is then byte-identical to
  // pre-T-34. Selector returns an existing reference or null.
  const origin = useSubagentActivityStore((s) =>
    block.permissionId ? (s.permissionOrigin[block.permissionId] ?? null) : null
  );
  const originView = derivePermissionOrigin(origin, t);
  const originChip = originView ? (
    <p className="px-3.5 pb-1 text-meta text-muted-foreground">{originView.label}</p>
  ) : null;

  // 2026-08-10 ruling: a decided permission collapses to a single tool-row
  // (Allowed/Denied + description) instead of keeping the full QA shell —
  // only pending/waiting permissions still render as a QA card below.
  if (view.state === 'resolved') {
    const rowView = derivePermissionRowView(block, originView?.label ?? null, t);
    if (!rowView) return null;
    return <ToolRow view={rowView} />;
  }

  // In the composer's slot: capped at 40% of the window, the body scrolls and
  // the decision buttons stay pinned under it.
  return (
    <div
      className={cn(
        QA_SHELL_CLASS,
        'flex max-h-[40vh] min-h-0 flex-col',
        PERMISSION_RISK_SHELL[view.risk]
      )}
    >
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        {/* Top-left, ahead of the title: it answers "how much of this is left"
            before the user reads what THIS one asks. `tabular-nums` because it
            is replaced in place as the queue advances, and a proportional `1`
            would shift the title a pixel on every card. */}
        {progress && (
          <span className="shrink-0 rounded-xs bg-muted px-1.5 py-0.5 text-meta tabular-nums text-muted-foreground">
            {progress}
          </span>
        )}
        <span className="min-w-0 flex-1 font-semibold tracking-[0.01em] text-foreground">
          {t(view.title)}
        </span>
        <span
          className={cn(
            'shrink-0 rounded-sm px-1.5 py-0.5 text-meta',
            PERMISSION_RISK_CHIP[view.risk]
          )}
        >
          {t(PERMISSION_RISK_LABEL[view.risk])}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-2">
        {originChip}
        <p className="px-1 pt-2 whitespace-pre-wrap break-words text-ui font-semibold leading-relaxed text-foreground">
          {view.prompt}
        </p>
        {/* The thing being approved, above everything the engine has to say
            about it: PI-Desktop puts the content first because that is what the
            answer is about. */}
        {view.content && (
          <div className="px-1">
            <p className="pb-1 text-meta text-muted-foreground">{t(view.content.label)}</p>
            <Ident className="block max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2.5 text-chat-body text-foreground">
              {view.content.text}
            </Ident>
          </div>
        )}
        {view.detail && <PermissionDetailBody detail={view.detail} />}
        {/* P1-6d: why this card is up when the gear would have let the call
            through — the command could not be read statically. */}
        {view.askReasonNote && (
          <p className="px-1 text-meta text-muted-foreground">{view.askReasonNote}</p>
        )}
        {(view.workspace || secondsLeft !== null) && (
          <div className="flex min-w-0 items-center gap-2 px-1 text-meta text-muted-foreground">
            {view.workspace && (
              <p className="min-w-0 flex-1 truncate" title={view.workspace}>
                {t('Project: {{name}}', { name: view.workspace })}
              </p>
            )}
            {secondsLeft !== null && (
              <span role="timer" className="ml-auto shrink-0 tabular-nums">
                {t('Denied automatically if unanswered within {{seconds}}s', {
                  seconds: secondsLeft,
                })}
              </span>
            )}
          </div>
        )}
        {view.waiting && (
          // T104 adjudication (the task brief left this one open): stays on the
          // body tier. It is explanatory, but it is the single line a reader
          // stares at while a permission decision blocks the whole turn --
          // the same "not passive chrome" test that put the turn status line
          // on `text-ui` (T097, design-system.md "已记录偏离"). Demoting it to
          // `text-meta` (13px, same as the process tier) would put the one line
          // that matters below the tool rows surrounding it.
          <p className="px-1 text-chat-body text-muted-foreground">{t(PERMISSION_WAITING)}</p>
        )}
        {/* T002 — decision 003: the grant behind "Allow for session" is
            session-scoped, not delegate-scoped, so it also covers the parent
            and every other subagent. The button text alone cannot say that. */}
        {view.sessionScopeNote && (
          <p className="px-1 text-right text-meta text-muted-foreground">{view.sessionScopeNote}</p>
        )}
        {/* C9: the "decisions we could not model" line is pinned to the card
            bottom, so a narrowed choice never reads as the whole choice. */}
        {view.omittedNote && (
          <p className="px-1 text-meta text-muted-foreground">{view.omittedNote}</p>
        )}
      </div>
      {!view.waiting && (
        // Right-aligned and compact: a decision is one press, not a menu, and
        // four full-width rows are what made the old card swallow the screen.
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-2.5 py-1.5">
          <span className="mr-auto text-meta text-muted-foreground">{t('Esc interrupts')}</span>
          {view.options.map((option) => (
            <Button
              key={option.letter}
              type="button"
              size="sm"
              variant={PERMISSION_BUTTON_VARIANT[option.decision ?? 'deny']}
              disabled={submitting}
              onClick={async () => {
                // The row carries its own decision. Unreachable when absent
                // (every permission row is built with one), and doing nothing
                // is the right failure.
                //
                // What this replaced was NOT fail-open: `option.label ===
                // PERMISSION_ALLOW` answered false for every row it did not
                // recognise, so an unrecognised row was sent as a DENY. The
                // direction was safe; the meaning was wrong. The moment a
                // third row exists, pressing "Allow for session" would have
                // gone out as a refusal and the card would have come back
                // Denied — the user's grant silently inverted.
                const { decision } = option;
                if (!decision) return;
                setSubmitting(true);
                // Same await-and-unlock pattern as Continue/Skip above
                // (T-05 adversarial fix #4).
                const ok = await onRespond?.(decision);
                if (ok === false) {
                  setSubmitting(false);
                }
              }}
            >
              {t(option.label)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
