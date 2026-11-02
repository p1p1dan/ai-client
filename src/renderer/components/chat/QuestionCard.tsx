import type { PermissionDecisionId } from '@shared/types/runtimeEvents';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DockCard,
  DockCardBody,
  DockCardFooter,
  DockCardHeader,
  DockCardTitle,
} from '@/components/ui/dock-card';
import { Ident } from '@/components/ui/ident';
import { StatusIcon } from '@/components/ui/status-icon';
import { useI18n } from '@/i18n';
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

/**
 * The permission card's three tiers, as tone rather than decoration (design
 * system v2 §7.6): a write or a command cannot be taken back, so its card
 * carries the destructive edge; every other live card is `pending`, the clay
 * edge of "waiting on you".
 */
const PERMISSION_RISK_TONE: Record<PermissionRisk, 'risk' | 'pending'> = {
  high: 'risk',
  medium: 'pending',
  low: 'pending',
};
const PERMISSION_RISK_BADGE: Record<PermissionRisk, 'error' | 'secondary'> = {
  high: 'error',
  medium: 'secondary',
  low: 'secondary',
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
/**
 * Design system v2 §7.6: the footer reads quiet → loud, the primary press
 * last. A stable sort, so rows of one weight keep the order the engine sent.
 */
const PERMISSION_BUTTON_RANK = { ghost: 0, secondary: 1, default: 2 } as const;

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
  /** Layout 5c: in the reading flow the title drops to the 13px UI tier. */
  quiet?: boolean;
  /** Answer progress, e.g. `2 / 4`. Absent when the card has nothing to count. */
  progress?: string | null;
}

/** `.qa-head` — the dock card's 32px head: title and an optional progress tag. */
function QaHead({ title, progress, quiet }: QaHeadProps) {
  return (
    <DockCardHeader>
      <DockCardTitle className={quiet ? 'text-ui' : undefined}>{title}</DockCardTitle>
      {progress && (
        <Badge variant="secondary" className="tabular-nums">
          {progress}
        </Badge>
      )}
    </DockCardHeader>
  );
}

/** `.qa-frozen` — read-only Q/A pairs, same color and size, order-only distinction. */
function QaFrozenPairs({ pairs }: { pairs: FrozenPair[] }) {
  const { t } = useI18n();
  return (
    <DockCardBody className="flex flex-col gap-2.5">
      {pairs.map((pair) => (
        <div key={pair.key} className="flex flex-col gap-1 break-words whitespace-pre-wrap text-ui">
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
    </DockCardBody>
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
  // In the timeline, settled: the strip form (no elevation, not waiting).
  return (
    <DockCard kind="strip">
      <QaHead title={title} quiet />
      <QaFrozenPairs pairs={pairs} />
    </DockCard>
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
    <div className="flex min-w-0 flex-col gap-1">
      {/* FR-05.5: the whole command, every line — an approval of an ellipsis
          is not an approval of the command. Long ones scroll inside. */}
      {detail.command !== null && (
        <Ident className="block max-h-32 min-w-0 overflow-auto whitespace-pre-wrap break-all text-foreground">
          {detail.command}
        </Ident>
      )}
      {detail.files.map((file) => (
        <div key={file.key} className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary" className="shrink-0">
            {file.badge}
          </Badge>
          <Ident className="min-w-0 flex-1 truncate text-foreground" title={file.path}>
            {file.path}
          </Ident>
          {file.stat && (
            <span className="shrink-0 text-small tabular-nums text-foreground-faint">
              {file.stat}
            </span>
          )}
          {file.truncated && (
            <span className="shrink-0 text-small text-muted-foreground">
              {t(PERMISSION_DIFF_CLAMPED_MARK)}
            </span>
          )}
        </div>
      ))}
      {detail.meta.map((line) => (
        <p key={line} className="min-w-0 truncate text-small text-muted-foreground" title={line}>
          {line}
        </p>
      ))}
      {detail.warnings.map((line) => (
        <p key={line} className="text-small text-destructive">
          {line}
        </p>
      ))}
      {detail.notes.map((line) => (
        <p key={line} className="text-small italic text-muted-foreground">
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
  // FR-05.8: a reply that did not reach the engine says so (as QuestionPrompt
  // does) instead of only unlocking the buttons.
  const [submitError, setSubmitError] = useState(false);
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
      if (ok === false) {
        setSubmitting(false);
        setSubmitError(true);
      }
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
    <p className="text-small text-muted-foreground">{originView.label}</p>
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
    <DockCard tone={PERMISSION_RISK_TONE[view.risk]} className="max-h-[40vh] min-h-0">
      <DockCardHeader>
        <StatusIcon status="waiting" />
        <DockCardTitle>{t(view.title)}</DockCardTitle>
        {/* `tabular-nums` because it is replaced in place as the queue
            advances, and a proportional `1` would shift the tag a pixel on
            every card. */}
        {progress && (
          <Badge variant="secondary" className="tabular-nums">
            {progress}
          </Badge>
        )}
        <Badge variant={PERMISSION_RISK_BADGE[view.risk]}>
          {t(PERMISSION_RISK_LABEL[view.risk])}
        </Badge>
      </DockCardHeader>
      <DockCardBody className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {originChip}
        <p className="whitespace-pre-wrap break-words text-ui font-semibold text-foreground">
          {view.prompt}
        </p>
        {/* The thing being approved, above everything the engine has to say
            about it: PI-Desktop puts the content first because that is what the
            answer is about. A neutral fill, no frame (§1 rule 1). */}
        {view.content && (
          <div>
            <p className="pb-1 text-small text-muted-foreground">{t(view.content.label)}</p>
            <Ident className="block max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-fill-neutral px-2.5 py-2 text-code text-foreground">
              {view.content.text}
            </Ident>
          </div>
        )}
        {view.detail && <PermissionDetailBody detail={view.detail} />}
        {/* P1-6d: why this card is up when the gear would have let the call
            through — the command could not be read statically. */}
        {view.askReasonNote && (
          <p className="text-small text-muted-foreground">{view.askReasonNote}</p>
        )}
        {(view.workspace || secondsLeft !== null) && (
          <div className="flex min-w-0 items-center gap-2 text-small text-muted-foreground">
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
          // T104 adjudication: stays on the body tier. It is the single line a
          // reader stares at while a permission decision blocks the whole turn
          // -- not passive chrome, so not demoted to the small tier.
          <p className="text-chat-body text-muted-foreground">{t(PERMISSION_WAITING)}</p>
        )}
        {/* T002 — decision 003: the grant behind "Allow for session" is
            session-scoped, not delegate-scoped, so it also covers the parent
            and every other subagent. The button text alone cannot say that. */}
        {view.sessionScopeNote && (
          <p className="text-right text-small text-muted-foreground">{view.sessionScopeNote}</p>
        )}
        {/* C9: the "decisions we could not model" line is pinned to the card
            bottom, so a narrowed choice never reads as the whole choice. */}
        {view.omittedNote && <p className="text-small text-muted-foreground">{view.omittedNote}</p>}
      </DockCardBody>
      {submitError && !view.waiting && (
        <p role="alert" className="shrink-0 px-4 pb-2 text-small text-destructive">
          {t('Could not send your answer. Please try again.')}
        </p>
      )}
      {!view.waiting && (
        // Right-aligned and compact: a decision is one press, not a menu, and
        // four full-width rows are what made the old card swallow the screen.
        <DockCardFooter className="flex-wrap">
          <span className="mr-auto text-small text-foreground-faint">{t('Esc interrupts')}</span>
          {sortPermissionOptions(view.options).map((option) => (
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
                setSubmitError(false);
                // Same await-and-unlock pattern as Continue/Skip above
                // (T-05 adversarial fix #4).
                const ok = await onRespond?.(decision);
                if (ok === false) {
                  setSubmitting(false);
                  setSubmitError(true);
                }
              }}
            >
              {t(option.label)}
            </Button>
          ))}
        </DockCardFooter>
      )}
    </DockCard>
  );
}

/** Footer order (§7.6): ghost → secondary → primary, stable within a weight. */
function sortPermissionOptions<T extends { decision?: PermissionDecisionId }>(
  options: readonly T[]
): T[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort(
      (a, b) =>
        PERMISSION_BUTTON_RANK[PERMISSION_BUTTON_VARIANT[a.option.decision ?? 'deny']] -
          PERMISSION_BUTTON_RANK[PERMISSION_BUTTON_VARIANT[b.option.decision ?? 'deny']] ||
        a.index - b.index
    )
    .map(({ option }) => option);
}
