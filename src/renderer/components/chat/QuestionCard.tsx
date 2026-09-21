import type { PermissionDecisionId, QuestionItem } from '@shared/types/runtimeEvents';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatBlock } from '@/stores/chatSessions';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import {
  buildOptionRows,
  buildRespondPayload,
  CONTINUE_CHORD,
  CONTINUE_LABEL,
  canContinue,
  deriveCardTitle,
  deriveFrozenPairs,
  derivePermissionCardView,
  derivePermissionRowView,
  deriveQuestionCardState,
  deriveQuestionTabStrip,
  emptySelection,
  type FrozenPair,
  type OptionRow,
  PERMISSION_DIFF_CLAMPED_MARK,
  PERMISSION_WAITING,
  type PermissionDetailView,
  type PermissionRisk,
  permissionSecondsLeft,
  QUESTION_CARD_BODY_MAX_CLASS,
  QUESTION_TITLE,
  type QuestionSelection,
  type QuestionTabStrip,
  questionReactKey,
  SKIP_LABEL,
  SKIPPED_MARK,
  setOtherText,
  toggleOption,
  toggleOther,
} from './questionCardModel';
import { derivePermissionOrigin } from './subagentActivityModel';
import { ToolRow } from './ToolRows';

/**
 * T-05 batch 3: renders `.qa` off `questionCardModel.ts`'s pure view models. No
 * business logic lives here — selection/pagination/payload assembly are all
 * pure-module calls, this file only turns their output into DOM.
 */

type QuestionCardVariant = 'interactive' | 'frozen' | 'permission';

interface QuestionCardProps {
  variant: QuestionCardVariant;
  block: ChatBlock;
  /** interactive only. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /**
   * Store round-trip (T-05 adversarial fix #4): may resolve `Promise<boolean>`
   * (store's `respondQuestion`/`respondPermission` — `false` on IPC failure)
   * so the card can unlock itself instead of staying submitted-forever.
   */
  onSubmit?: (payload: { answers: Record<string, string> }) => Promise<boolean> | undefined;
  onSkip?: () => Promise<boolean> | undefined;
  /** permission only. */
  canRespond?: boolean;
  /**
   * Takes the DECISION the pressed row carries, not a boolean: the allow/deny
   * boolean is derived from it exactly once, at the dock's call site.
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
        block={props.block}
        canRespond={Boolean(props.canRespond)}
        onRespond={props.onRespondPermission}
        progress={props.progress ?? null}
      />
    );
  }
  if (props.variant === 'frozen') {
    return <FrozenQaCard block={props.block} />;
  }
  return (
    <InteractiveQaCard
      key={props.block.questionId ?? props.block.id}
      block={props.block}
      collapsed={Boolean(props.collapsed)}
      onToggleCollapsed={props.onToggleCollapsed}
      onSubmit={props.onSubmit}
      onSkip={props.onSkip}
    />
  );
}

// ---- Shared bits ----

interface QaHeadProps {
  title: string;
  /** Answer progress, e.g. `2 / 4`. Absent when the card has nothing to count. */
  progress?: string | null;
  /** Present only on the interactive variant's collapsible strip. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/** `.qa-head` — 36px bar: title, optional progress counter, optional collapse chevron. */
function QaHead({ title, progress, collapsed, onToggleCollapsed }: QaHeadProps) {
  return (
    <div className="flex min-h-9 items-start gap-2 border-b border-border px-3 py-2 text-muted-foreground">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-semibold tracking-[0.01em]">
        {title}
      </span>
      {progress && (
        <span className="shrink-0 text-meta tabular-nums text-muted-foreground">{progress}</span>
      )}
      {onToggleCollapsed && (
        <button
          type="button"
          className="grid size-6 place-items-center rounded-sm hover:bg-hover"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand questions' : 'Collapse questions'}
        >
          {collapsed ? (
            <ChevronUp className="size-[14px]" />
          ) : (
            <ChevronDown className="size-[14px]" />
          )}
        </button>
      )}
    </div>
  );
}

/**
 * `.qa-tabs` — one tab per question, replacing the `1 of 4` pager (2026-09-20
 * user decision; the reasoning is on `deriveQuestionTabStrip`).
 *
 * A plain `<button role="tab">` strip rather than `ui/tabs.tsx`: that primitive
 * animates a sliding indicator and sizes itself `w-fit`, both of which fight a
 * strip that must scroll horizontally once the questions outnumber the column
 * width. What is kept from it is the part that matters — the roles, the
 * roving-selection semantics and the keyboard handling below.
 *
 * The mark is a CHECK, not a dot: "answered" is the only state the user needs
 * to find at a glance, and a filled dot cannot say which of several tabs are
 * done. Unanswered tabs carry no mark at all, so the strip reads as "these are
 * left" rather than as a wall of identical dots.
 */
function QaTabs({
  strip,
  active,
  disabled,
  onActivate,
}: {
  strip: QuestionTabStrip;
  active: number;
  disabled: boolean;
  onActivate: (index: number) => void;
}) {
  const { t } = useI18n();
  const refs = useRef<Record<number, HTMLButtonElement | null>>({});
  // Left/Right walk the strip, Home/End jump to its ends — the WAI-ARIA tab
  // pattern. Activation follows focus (`onActivate`), which is the "automatic
  // activation" variant and the right one here: every panel is cheap to render
  // and the user's intent in moving focus is plainly to read that question.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const last = strip.tabs.length - 1;
    if (last < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : (active + (event.key === 'ArrowRight' ? 1 : -1) + strip.tabs.length) %
            strip.tabs.length;
    onActivate(next);
    refs.current[next]?.focus();
  };
  return (
    <div
      className="flex shrink-0 items-stretch overflow-x-auto border-b border-border"
      onKeyDown={onKeyDown}
      role="tablist"
    >
      {strip.tabs.map((tab) => {
        const selected = tab.index === active;
        return (
          <button
            key={tab.index}
            ref={(el) => {
              refs.current[tab.index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            // Focusable, but not in the Tab order: the strip is one stop and the
            // arrows move within it, so a card with eight questions does not
            // cost eight presses to walk past.
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onActivate(tab.index)}
            title={tab.header ? `${tab.label} · ${tab.header}` : tab.label}
            className={cn(
              'flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border border-b-2 border-b-transparent px-2.5 py-1.5 text-ui',
              'hover:bg-hover disabled:pointer-events-none disabled:opacity-64',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary',
              selected
                ? 'border-b-primary bg-background font-medium text-foreground'
                : 'text-muted-foreground'
            )}
          >
            <span className="tabular-nums">{tab.label}</span>
            {tab.answered && <Check aria-hidden className="size-3 shrink-0 text-success" />}
          </button>
        );
      })}
      {strip.total > 1 && (
        <span className="ml-auto flex shrink-0 items-center px-2.5 text-meta tabular-nums text-muted-foreground">
          {t('{{answered}} of {{total}} answered', {
            answered: strip.answeredCount,
            total: strip.total,
          })}
        </span>
      )}
    </div>
  );
}

interface QaOptionRowProps {
  option: OptionRow;
  selected: boolean;
  multiSelect: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** Other row only: current free-text value + change handler. */
  otherText?: string;
  onOtherTextChange?: (text: string) => void;
  /**
   * Other row only: the question is marked `isSecret`, so the free-text input
   * is a password field. Codex flags API-key questions this way; typing a
   * credential in plain sight and leaving it in the timeline is the thing the
   * Host-side stderr redaction (T-35) already refuses to do.
   */
  secret?: boolean;
}

/**
 * `.qa-opt` — 28px full-row option: 20px letter chip + label, whole row
 * clickable. The Other row's free-text `<input>` used to render *inside* the
 * selection `<button>`, which is invalid HTML (a button can't contain
 * interactive content) and needed an `onClick` `stopPropagation` workaround
 * just to let typing not re-toggle selection. The outer element is now a
 * plain non-interactive container; the selection entry is its own `<button>`
 * and the `<input>` renders as a sibling, not nested inside it (T-05
 * adversarial fix #7). Visuals (height, tokens, hover/selected background)
 * are unchanged — the background just moved from a CSS `aria-checked:`/
 * `group-aria-checked:` variant to a plain `selected`-driven class, since the
 * checked state is already a known prop.
 */
function QaOptionRow({
  option,
  selected,
  multiSelect,
  disabled,
  onSelect,
  otherText,
  onOtherTextChange,
  secret,
}: QaOptionRowProps) {
  const showOtherInput = option.isOther && selected && onOtherTextChange;
  return (
    <div
      className={cn(
        'flex min-h-9 w-full flex-wrap items-start gap-2.5 rounded-md border border-border px-2 py-2',
        'hover:bg-hover',
        selected && 'bg-selection',
        disabled && 'pointer-events-none opacity-64'
      )}
    >
      <Button
        variant="ghost"
        type="button"
        role={multiSelect ? 'checkbox' : 'radio'}
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        className="h-auto sm:h-auto whitespace-normal normal-case flex min-w-0 flex-1 items-start gap-2.5 rounded-sm text-left text-ui leading-relaxed text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-xs border border-border bg-muted text-meta leading-none text-muted-foreground',
            selected && 'border-primary text-primary'
          )}
        >
          {option.letter}
        </span>
        {!showOtherInput && (
          <span
            className={cn(
              'min-w-0 flex-1 whitespace-pre-wrap break-words',
              option.isOther && 'text-muted-foreground'
            )}
          >
            {option.label}
            {option.description && (
              // font-normal, not the button base class's 500: a description is
              // body text, and on Win10 (Segoe UI has no 500) 500 renders as
              // 400 anyway, so the label/description contrast would vanish.
              <span className="mt-1 block text-meta font-normal text-muted-foreground">
                {option.description}
              </span>
            )}
          </span>
        )}
      </Button>
      {showOtherInput && (
        <Input
          autoFocus
          aria-label="Your answer"
          type={secret ? 'password' : 'text'}
          value={otherText ?? ''}
          onChange={(event) => onOtherTextChange(event.target.value)}
          disabled={disabled}
          placeholder={secret ? 'Value is hidden while you type' : 'Type your answer…'}
          // A credential must not reach the browser's autofill store or the
          // spellchecker (which ships text to the platform on some systems).
          autoComplete={secret ? 'off' : undefined}
          spellCheck={secret ? false : undefined}
          className="min-w-0 flex-1 bg-transparent text-chat-body text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
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
          <span className="text-foreground">{pair.question}</span>
          {pair.skipped ? (
            <span className="italic text-muted-foreground">{t(SKIPPED_MARK)}</span>
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

// ---- Interactive variant ----

interface InteractiveQaCardProps {
  block: ChatBlock;
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onSubmit?: (payload: { answers: Record<string, string> }) => Promise<boolean> | undefined;
  onSkip?: () => Promise<boolean> | undefined;
}

function InteractiveQaCard({
  block,
  collapsed,
  onToggleCollapsed,
  onSubmit,
  onSkip,
}: InteractiveQaCardProps) {
  const { t } = useI18n();
  const items: readonly QuestionItem[] = block.questions ?? [];
  const [sel, setSel] = useState<QuestionSelection>(emptySelection);
  const [active, setActive] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const submitLatch = useRef(false);
  const questionRefs = useRef<Record<number, HTMLDivElement | null>>({});

  if (items.length === 0) return null;

  const strip = deriveQuestionTabStrip(sel, items);
  // Defensive, not decorative: `items` is re-read from the block on every
  // render and a question list that shrank (a re-delivered `question.requested`)
  // would otherwise leave the card showing no panel at all.
  const activeIndex = active >= 0 && active < items.length ? active : 0;
  const canSubmit = canContinue(sel, items) && !submitting;
  // `1 of 4` is what the header says now — the tab strip carries WHICH ones are
  // left, so the two are not the same information twice.
  const progress = items.length > 1 ? `${strip.answeredCount} / ${strip.total}` : null;

  /**
   * Activate a tab and bring its panel to the top.
   *
   * The panel is the only one rendered, so the card's height changes on every
   * switch and the old `scrollIntoView` would have nothing to correct. What is
   * still needed is bringing the CARD back into view for a question the user
   * jumped to from far down the timeline — `block: 'nearest'` so a card that is
   * already fully visible does not move.
   */
  const goToQuestion = (next: number) => {
    if (next < 0 || next >= items.length) return;
    setActive(next);
    questionRefs.current[next]?.scrollIntoView({ block: 'nearest' });
  };

  /** The first question still unanswered, or `null` when there is none. */
  const firstUnanswered = () => {
    const tab = strip.tabs.find((candidate) => !candidate.answered);
    return tab ? tab.index : null;
  };

  // Await the store round-trip (T-05 adversarial fix #4): a transport
  // failure (e.g. rejected IPC call) resolves `false`, which unlocks the
  // card again instead of leaving Continue/Skip permanently disabled. A
  // success (`true`/`undefined`) stays locked — the store's `resolved` state
  // repaints this card as frozen once the runtime event lands.
  const submitAnswer = async (skip: boolean) => {
    if (submitLatch.current || (!skip && !canSubmit)) return;
    submitLatch.current = true;
    setSubmitting(true);
    setSubmitError(false);
    try {
      const ok = skip ? await onSkip?.() : await onSubmit?.(buildRespondPayload(sel, items));
      if (ok === false) throw new Error('answer rejected');
    } catch {
      submitLatch.current = false;
      setSubmitting(false);
      setSubmitError(true);
    }
  };
  const handleContinue = () => submitAnswer(false);
  const handleSkip = () => submitAnswer(true);

  return (
    <div
      className={QA_SHELL_CLASS}
      onKeyDown={(event) => {
        if (collapsed || event.nativeEvent.isComposing) return;
        if (
          event.key === 'Enter' &&
          (event.ctrlKey || event.metaKey) &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          handleContinue();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onToggleCollapsed?.();
        }
      }}
    >
      <QaHead
        title={t(QUESTION_TITLE)}
        progress={progress}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
      />
      {!collapsed && (
        <>
          <QaTabs
            strip={strip}
            active={activeIndex}
            disabled={submitting}
            onActivate={goToQuestion}
          />
          <div className={cn('flex flex-col px-2.5', QUESTION_CARD_BODY_MAX_CLASS)}>
            {items.map((item, index) => (
              <div
                key={questionReactKey(item, index)}
                ref={(el) => {
                  questionRefs.current[index] = el;
                }}
                // Hidden rather than unmounted: a question the user half-
                // answered and switched away from keeps its scrolled position
                // and its DOM, and the option-row arrow-key handler below still
                // has rows to walk when the user comes back.
                hidden={index !== activeIndex}
              >
                {item.header && (
                  // D22 — `QuestionItem.header` is the SDK's ~12-char tag for
                  // this question. The ask tool carries it through untouched,
                  // so a card that never draws it drops what the model paid
                  // tokens to say.
                  <div className="px-1 pt-2">
                    <span className="inline-block rounded-sm bg-muted px-1.5 py-0.5 text-meta text-muted-foreground">
                      {item.header}
                    </span>
                  </div>
                )}
                <div
                  className={cn(
                    'px-1 pb-2 whitespace-pre-wrap break-words text-ui font-semibold leading-relaxed text-foreground',
                    item.header ? 'pt-1' : 'pt-2'
                  )}
                >
                  {item.question}
                </div>
                {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is dynamic (group vs radiogroup per multiSelect); aria-label is valid for both */}
                <div
                  className="flex flex-col gap-2"
                  onKeyDown={(event) => {
                    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                    const options = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        '[role="radio"], [role="checkbox"]'
                      )
                    );
                    const current = options.indexOf(document.activeElement as HTMLButtonElement);
                    if (current < 0) return;
                    event.preventDefault();
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? options.length - 1
                          : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
                            options.length;
                    options[next]?.focus();
                    if (!item.multiSelect) options[next]?.click();
                  }}
                  role={item.multiSelect ? 'group' : 'radiogroup'}
                  aria-label={item.question}
                >
                  {buildOptionRows(item, t).map((option) => {
                    const otherSelected = sel.otherSelected[index] ?? false;
                    const selected = option.isOther
                      ? otherSelected
                      : (sel.byQuestion[index] ?? []).includes(option.label);
                    return (
                      <QaOptionRow
                        key={option.letter}
                        option={option}
                        selected={selected}
                        multiSelect={Boolean(item.multiSelect)}
                        disabled={submitting}
                        onSelect={() =>
                          setSel((prev) =>
                            option.isOther
                              ? toggleOther(prev, index, Boolean(item.multiSelect))
                              : toggleOption(prev, index, option.label, Boolean(item.multiSelect))
                          )
                        }
                        secret={option.isOther && item.isSecret === true}
                        otherText={option.isOther ? (sel.otherText[index] ?? '') : undefined}
                        onOtherTextChange={
                          option.isOther
                            ? (text) => setSel((prev) => setOtherText(prev, index, text))
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {submitError && (
            <p role="alert" className="px-3 pt-2 text-meta text-destructive">
              {t('Could not send your answer. Please try again.')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-border p-2.5">
            {submitting ? (
              <span role="status" className="mr-auto text-meta text-status-running">
                {t('Submitting…')}
              </span>
            ) : (
              /* What the state of the answers IS, said where the press is. The
                 tab strip marks WHICH questions are left; this says HOW MANY,
                 and it is the same count Continue gates on — the button is
                 disabled for exactly the reason printed beside it. */
              <span className="mr-auto text-meta tabular-nums text-muted-foreground">
                {strip.unansweredCount > 0
                  ? t('Unanswered: {{count}}', { count: strip.unansweredCount })
                  : t('All questions answered')}
              </span>
            )}
            {strip.unansweredCount > 0 && (
              <Button
                size="sm"
                variant="secondary"
                type="button"
                className="inline-flex h-6 items-center rounded-sm px-2"
                disabled={submitting}
                onClick={() => {
                  const next = firstUnanswered();
                  if (next !== null) goToQuestion(next);
                }}
              >
                {t('Next unanswered')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              type="button"
              className="inline-flex h-6 items-center rounded-sm px-2 text-muted-foreground hover:bg-hover disabled:pointer-events-none disabled:opacity-64"
              disabled={submitting}
              onClick={handleSkip}
            >
              {t(SKIP_LABEL)}
            </Button>
            <Button
              size="sm"
              type="button"
              className="inline-flex h-6 items-center gap-1.5 rounded-sm bg-primary px-2.5 text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary disabled:pointer-events-none disabled:opacity-64"
              disabled={!canSubmit}
              onClick={handleContinue}
            >
              <span>{t(CONTINUE_LABEL)}</span>
              <span className="text-meta opacity-70">{t(CONTINUE_CHORD)}</span>
            </Button>
          </div>
        </>
      )}
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

  return (
    <div className={cn(QA_SHELL_CLASS, PERMISSION_RISK_SHELL[view.risk])}>
      <div className="flex min-h-9 items-center gap-2 border-b border-border px-3 py-2">
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
      {originChip}
      <div className="flex flex-col gap-3 px-2.5 pb-3">
        <p className="px-1 pb-1 pt-2 whitespace-pre-wrap break-words text-ui font-semibold leading-relaxed text-foreground">
          {view.prompt}
        </p>
        {/* The thing being approved, above everything the engine has to say
            about it: PI-Desktop puts the content first because that is what the
            answer is about. */}
        {view.content && (
          <div className="px-1">
            <p className="pb-1 text-meta text-muted-foreground">{t(view.content.label)}</p>
            <Ident className="block max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2.5 text-chat-body text-foreground">
              {view.content.text}
            </Ident>
          </div>
        )}
        {view.detail && <PermissionDetailBody detail={view.detail} />}
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
        {view.waiting ? (
          // T104 adjudication (the task brief left this one open): stays on the
          // body tier. It is explanatory, but it is the single line a reader
          // stares at while a permission decision blocks the whole turn --
          // the same "not passive chrome" test that put the turn status line
          // on `text-ui` (T097, design-system.md "已记录偏离"). Demoting it to
          // `text-meta` (13px, same as the process tier) would put the one line
          // that matters below the tool rows surrounding it.
          <p className="px-1 text-chat-body text-muted-foreground">{t(PERMISSION_WAITING)}</p>
        ) : (
          // Right-aligned and compact: a decision is one press, not a menu, and
          // four full-width rows are what made the old card swallow the screen.
          <div className="flex flex-wrap items-center justify-end gap-2 px-1">
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
    </div>
  );
}
