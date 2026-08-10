import type { QuestionItem } from '@shared/types/runtimeEvents';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ChatBlock } from '@/stores/chatSessions';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import {
  buildOptionRows,
  buildRespondPayload,
  CONTINUE_KBD,
  CONTINUE_LABEL,
  canContinue,
  clampPage,
  deriveCardTitle,
  deriveFrozenPairs,
  derivePager,
  derivePermissionCardView,
  derivePermissionRowView,
  deriveQuestionCardState,
  emptySelection,
  type FrozenPair,
  type OptionRow,
  PERMISSION_ALLOW,
  PERMISSION_WAITING,
  QUESTION_CARD_BODY_MAX_CLASS,
  QUESTION_TITLE,
  type QuestionSelection,
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
  onRespondPermission?: (allow: boolean) => Promise<boolean> | undefined;
}

const QA_SHELL_CLASS = 'overflow-hidden rounded-md border border-border bg-card';

export function QuestionCard(props: QuestionCardProps) {
  if (props.variant === 'permission') {
    return (
      <PermissionQaCard
        block={props.block}
        canRespond={Boolean(props.canRespond)}
        onRespond={props.onRespondPermission}
      />
    );
  }
  if (props.variant === 'frozen') {
    return <FrozenQaCard block={props.block} />;
  }
  return (
    <InteractiveQaCard
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
  pager?: { visible: boolean; label: string; canPrev: boolean; canNext: boolean };
  onPrev?: () => void;
  onNext?: () => void;
  /** Present only on the interactive variant's collapsible strip. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/** `.qa-head` — 36px bar: title, optional pager, optional collapse chevron. */
function QaHead({ title, pager, onPrev, onNext, collapsed, onToggleCollapsed }: QaHeadProps) {
  return (
    <div className="flex h-9 items-center gap-2 px-3 text-muted-foreground">
      <span className="min-w-0 flex-1 truncate tracking-[0.01em]">{title}</span>
      {pager?.visible && (
        <span className="flex items-center gap-0.5 text-meta tabular-nums text-muted-foreground">
          <button
            type="button"
            className="grid size-6 place-items-center rounded-sm hover:bg-hover disabled:pointer-events-none disabled:opacity-40"
            disabled={!pager.canPrev}
            onClick={onPrev}
            aria-label="Previous question"
          >
            <ChevronLeft className="size-[13px]" />
          </button>
          <span>{pager.label}</span>
          <button
            type="button"
            className="grid size-6 place-items-center rounded-sm hover:bg-hover disabled:pointer-events-none disabled:opacity-40"
            disabled={!pager.canNext}
            onClick={onNext}
            aria-label="Next question"
          >
            <ChevronRight className="size-[13px]" />
          </button>
        </span>
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
        'flex h-7 w-full items-center gap-2.5 rounded-sm px-1.5',
        'hover:bg-hover',
        selected && 'bg-selection',
        disabled && 'pointer-events-none opacity-64'
      )}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is dynamic (radio vs checkbox per multiSelect); aria-checked is valid for both */}
      <button
        type="button"
        role={multiSelect ? 'checkbox' : 'radio'}
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-markdown text-foreground"
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
            className={cn('min-w-0 flex-1 truncate', option.isOther && 'text-muted-foreground')}
          >
            {option.label}
          </span>
        )}
      </button>
      {showOtherInput && (
        <input
          type={secret ? 'password' : 'text'}
          value={otherText ?? ''}
          onChange={(event) => onOtherTextChange(event.target.value)}
          disabled={disabled}
          placeholder={secret ? 'Value is hidden while you type' : 'Type your answer…'}
          // A credential must not reach the browser's autofill store or the
          // spellchecker (which ships text to the platform on some systems).
          autoComplete={secret ? 'off' : undefined}
          spellCheck={secret ? false : undefined}
          className="min-w-0 flex-1 bg-transparent text-markdown text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      )}
    </div>
  );
}

/** `.qa-frozen` — read-only Q/A pairs, same color and size, order-only distinction. */
function QaFrozenPairs({ pairs }: { pairs: FrozenPair[] }) {
  return (
    <div className="flex flex-col gap-2.5 px-3.5 pb-3">
      {pairs.map((pair) => (
        <div key={pair.key} className="flex flex-col gap-0.5 text-markdown leading-normal">
          <span className="text-foreground">{pair.question}</span>
          {pair.skipped ? (
            <span className="italic text-muted-foreground">{SKIPPED_MARK}</span>
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
  const state = deriveQuestionCardState(block);
  const title = deriveCardTitle(state);
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
  const items: readonly QuestionItem[] = block.questions ?? [];
  const [sel, setSel] = useState<QuestionSelection>(emptySelection);
  const [page, setPage] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const questionRefs = useRef<Record<number, HTMLDivElement | null>>({});

  if (items.length === 0) return null;

  const pager = derivePager(items.length, page);
  const canSubmit = canContinue(sel, items) && !submitting;

  const goToPage = (next: number) => {
    const clamped = clampPage(items.length, next);
    setPage(clamped);
    questionRefs.current[clamped]?.scrollIntoView({ block: 'nearest' });
  };

  // Await the store round-trip (T-05 adversarial fix #4): a transport
  // failure (e.g. rejected IPC call) resolves `false`, which unlocks the
  // card again instead of leaving Continue/Skip permanently disabled. A
  // success (`true`/`undefined`) stays locked — the store's `resolved` state
  // repaints this card as frozen once the runtime event lands.
  const handleContinue = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    const ok = await onSubmit?.(buildRespondPayload(sel, items));
    if (ok === false) {
      setSubmitting(false);
    }
  };

  const handleSkip = async () => {
    if (submitting) return;
    setSubmitting(true);
    const ok = await onSkip?.();
    if (ok === false) {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={QA_SHELL_CLASS}
      onKeyDown={(event) => {
        if (collapsed) return;
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          handleContinue();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onToggleCollapsed?.();
        }
      }}
    >
      <QaHead
        title={QUESTION_TITLE}
        pager={pager}
        onPrev={() => goToPage(page - 1)}
        onNext={() => goToPage(page + 1)}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
      />
      {!collapsed && (
        <>
          <div className={cn('flex flex-col gap-3 px-2.5', QUESTION_CARD_BODY_MAX_CLASS)}>
            {items.map((item, index) => (
              <div
                key={questionReactKey(item, index)}
                ref={(el) => {
                  questionRefs.current[index] = el;
                }}
              >
                <div className="px-1 pb-1 text-markdown leading-normal text-foreground">
                  {item.question}
                </div>
                {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is dynamic (group vs radiogroup per multiSelect); aria-label is valid for both */}
                <div
                  className="flex flex-col gap-0.5"
                  role={item.multiSelect ? 'group' : 'radiogroup'}
                  aria-label={item.question}
                >
                  {buildOptionRows(item).map((option) => {
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
          <div className="flex items-center justify-end gap-1.5 p-2.5">
            <button
              type="button"
              className="inline-flex h-6 items-center rounded-sm px-2 text-muted-foreground hover:bg-hover disabled:pointer-events-none disabled:opacity-64"
              disabled={submitting}
              onClick={handleSkip}
            >
              {SKIP_LABEL}
            </button>
            <button
              type="button"
              className="inline-flex h-6 items-center gap-1.5 rounded-sm bg-primary px-2.5 text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary disabled:pointer-events-none disabled:opacity-64"
              disabled={!canSubmit}
              onClick={handleContinue}
            >
              <span>{CONTINUE_LABEL}</span>
              <span className="text-meta opacity-70">{CONTINUE_KBD}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Permission variant (thin adapter over the same shell) ----

function PermissionQaCard({
  block,
  canRespond,
  onRespond,
}: {
  block: ChatBlock;
  canRespond: boolean;
  onRespond?: (allow: boolean) => Promise<boolean> | undefined;
}) {
  const view = derivePermissionCardView(block, canRespond);
  const [submitting, setSubmitting] = useState(false);
  // T-34: "from subagent" chip, fed by the adjacent activity store's
  // permissionId → origin index. Null for main-agent requests, old Hosts
  // (no `agentId` on the event) and resolved cards (the index entry is
  // deleted on permission.resolved) — the card is then byte-identical to
  // pre-T-34. Selector returns an existing reference or null.
  const origin = useSubagentActivityStore((s) =>
    block.permissionId ? (s.permissionOrigin[block.permissionId] ?? null) : null
  );
  const originView = derivePermissionOrigin(origin);
  const originChip = originView ? (
    <p className="px-3.5 pb-1 text-meta text-muted-foreground">{originView.label}</p>
  ) : null;

  // 2026-08-10 ruling: a decided permission collapses to a single tool-row
  // (Allowed/Denied + description) instead of keeping the full QA shell —
  // only pending/waiting permissions still render as a QA card below.
  if (view.state === 'resolved') {
    const rowView = derivePermissionRowView(block, originView?.label ?? null);
    if (!rowView) return null;
    return <ToolRow view={rowView} />;
  }

  return (
    <div className={QA_SHELL_CLASS}>
      <QaHead title={view.title} />
      {originChip}
      <div className="flex flex-col gap-3 px-2.5 pb-3">
        <p className="px-1 pb-1 text-markdown leading-normal text-foreground">{view.prompt}</p>
        {view.waiting ? (
          <p className="px-1 text-markdown text-muted-foreground">{PERMISSION_WAITING}</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {view.options.map((option) => (
              <QaOptionRow
                key={option.letter}
                option={option}
                selected={false}
                multiSelect={false}
                disabled={submitting}
                onSelect={async () => {
                  setSubmitting(true);
                  // Same await-and-unlock pattern as Continue/Skip above
                  // (T-05 adversarial fix #4).
                  const ok = await onRespond?.(option.label === PERMISSION_ALLOW);
                  if (ok === false) {
                    setSubmitting(false);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
