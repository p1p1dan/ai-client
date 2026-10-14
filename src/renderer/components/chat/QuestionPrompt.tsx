import type { QuestionItem } from '@shared/types/runtimeEvents';
import { Check } from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatBlock } from '@/stores/chatSessions';
import {
  buildChatAboutPayload,
  buildOptionRows,
  buildRespondPayload,
  deriveQuestionPrimary,
  deriveQuestionTabStrip,
  emptySelection,
  isQuestionAnswered,
  type OptionRow,
  optionLetter,
  type QuestionSelection,
  questionReactKey,
  SKIP_LABEL,
  setOtherText,
  toggleOption,
  toggleOther,
} from './questionCardModel';

/**
 * The live question card. It takes the composer's place while the turn waits
 * (`PendingQuestionDock`), so it is laid out to fit a typical question — three
 * options, Other and "Chat about this" — inside the 40% height cap without
 * scrolling: one row of tabs, borderless 28px option rows, descriptions on the
 * option's own line, and a 34px footer.
 *
 * Picking an option only selects it. The single primary button walks forward —
 * next question, then the confirmation page, then submit — and Enter presses
 * it. Esc is not handled here: it bubbles to the dock, which interrupts the turn.
 */

export interface QuestionPromptProps {
  block: ChatBlock;
  onSubmit: (payload: { answers: Record<string, string> }) => Promise<boolean> | undefined;
  onChatAbout: (payload: { response: string }) => Promise<boolean> | undefined;
  onSkip: () => Promise<boolean> | undefined;
}

const PRIMARY_LABEL = {
  next: 'Next question',
  review: 'Review answers',
  submit: 'Submit',
} as const;

export function QuestionPrompt({ block, onSubmit, onChatAbout, onSkip }: QuestionPromptProps) {
  const { t } = useI18n();
  const items: readonly QuestionItem[] = block.questions ?? [];
  const [sel, setSel] = useState<QuestionSelection>(emptySelection);
  const [page, setPage] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const submitLatch = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Each page switch puts focus inside the new page, so Enter and the letter
  // keys keep working without a click, and scrolls a long page back to the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on page switch only
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    const target =
      bodyRef.current?.querySelector<HTMLElement>('textarea, input') ??
      bodyRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      cardRef.current;
    target?.focus({ preventScroll: true });
  }, [page]);

  if (items.length === 0) return null;

  const multi = items.length > 1;
  const reviewPage = items.length;
  const current = page >= 0 && page <= (multi ? reviewPage : 0) ? page : 0;
  const onReview = multi && current === reviewPage;
  const strip = deriveQuestionTabStrip(sel, items);
  const primary = deriveQuestionPrimary(sel, items, current);
  const primaryEnabled = primary.enabled && !submitting;

  const send = async (run: () => Promise<boolean> | undefined) => {
    if (submitLatch.current) return;
    submitLatch.current = true;
    setSubmitting(true);
    setSubmitError(false);
    try {
      // A transport failure resolves `false` and unlocks the card; a success
      // stays locked until `question.resolved` takes the card down.
      if ((await run()) === false) throw new Error('answer rejected');
    } catch {
      submitLatch.current = false;
      setSubmitting(false);
      setSubmitError(true);
    }
  };

  const pressPrimary = () => {
    if (!primaryEnabled) return;
    if (primary.action === 'submit') {
      void send(() => onSubmit(buildRespondPayload(sel, items)));
      return;
    }
    setPage(current + 1);
  };
  const chatAbout = () => void send(() => onChatAbout(buildChatAboutPayload()));
  const skip = () => void send(onSkip);

  const pick = (index: number, option: OptionRow) => {
    const multiSelect = Boolean(items[index]?.multiSelect);
    setSel((prev) =>
      option.isOther
        ? toggleOther(prev, index, multiSelect)
        : toggleOption(prev, index, option.label, multiSelect)
    );
  };

  const rows = onReview ? [] : buildOptionRows(items[current] as QuestionItem, t);
  // "Chat about this" takes the letter after the last option row.
  const chatLetter = optionLetter(rows.length);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || submitting) return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Enter') {
      // A focused button answers Enter itself.
      if (target.tagName === 'BUTTON') return;
      event.preventDefault();
      pressPrimary();
      return;
    }
    if (event.key.length !== 1) return;
    const letter = event.key.toUpperCase();
    if (letter === chatLetter) {
      event.preventDefault();
      chatAbout();
      return;
    }
    const row = rows.find((candidate) => candidate.letter === letter);
    if (row) {
      event.preventDefault();
      pick(current, row);
    }
  };

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex max-h-[40vh] min-h-0 flex-col overflow-hidden rounded-lg border border-primary/60 bg-card text-ui outline-none"
      data-testid="question-prompt"
    >
      {multi && (
        <div className="flex h-[30px] shrink-0 items-stretch border-b border-border">
          <div className="flex min-w-0 overflow-x-auto" role="tablist">
            {strip.tabs.map((tab) => (
              <PageTab
                key={tab.index}
                selected={current === tab.index}
                disabled={submitting}
                onClick={() => setPage(tab.index)}
                title={tab.header ?? undefined}
              >
                <span className="tabular-nums">{tab.label}</span>
                {tab.answered && <Check aria-hidden className="size-3 shrink-0 text-success" />}
              </PageTab>
            ))}
            <PageTab selected={onReview} disabled={submitting} onClick={() => setPage(reviewPage)}>
              {t('Confirm answers')}
            </PageTab>
          </div>
          <span className="ml-auto flex shrink-0 items-center px-2.5 text-meta tabular-nums text-muted-foreground">
            {t('Answered {{answered}} / {{total}}', {
              answered: strip.answeredCount,
              total: strip.total,
            })}
          </span>
        </div>
      )}
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-1.5 pb-1">
        {onReview ? (
          <ReviewPage items={items} sel={sel} onJump={setPage} disabled={submitting} />
        ) : (
          <QuestionPage
            item={items[current] as QuestionItem}
            index={current}
            rows={rows}
            sel={sel}
            disabled={submitting}
            onPick={(row) => pick(current, row)}
            onOtherText={(text) => setSel((prev) => setOtherText(prev, current, text))}
            onOtherDone={() => {
              if (isQuestionAnswered(sel, current)) pressPrimary();
            }}
          />
        )}
        <div className="mx-1.5 my-[3px] h-px bg-border" />
        <OptionButton
          letter={chatLetter}
          selected={false}
          disabled={submitting}
          onClick={chatAbout}
          muted
        >
          {t('Chat about this')}
          <span className="ml-2 text-meta font-normal text-muted-foreground">
            {t('Answer later and discuss these questions with the AI first')}
          </span>
        </OptionButton>
      </div>
      {submitError && (
        <p role="alert" className="shrink-0 px-3 pb-1 text-meta text-destructive">
          {t('Could not send your answer. Please try again.')}
        </p>
      )}
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-t border-border pr-1.5 pl-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="ghost"
                type="button"
                className="h-6 px-2 text-muted-foreground"
                disabled={submitting}
                onClick={skip}
              />
            }
          >
            {t(SKIP_LABEL)}
          </TooltipTrigger>
          <TooltipPopup>
            {t('Leave every question unanswered; the AI decides on its own and carries on.')}
          </TooltipPopup>
        </Tooltip>
        <span className="flex-1" />
        {submitting ? (
          <span role="status" className="text-meta text-status-running">
            {t('Submitting…')}
          </span>
        ) : (
          <span className="text-meta text-muted-foreground">{t('Esc interrupts')}</span>
        )}
        <Button
          size="sm"
          type="button"
          className="h-6 gap-1.5 px-2.5"
          disabled={!primaryEnabled}
          onClick={pressPrimary}
        >
          {t(PRIMARY_LABEL[primary.action])}
          <span className="text-meta opacity-70">↵</span>
        </Button>
      </div>
    </div>
  );
}

function PageTab({
  selected,
  disabled,
  onClick,
  title,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        'flex shrink-0 cursor-pointer items-center gap-1 border-r border-border border-b-2 border-b-transparent px-2.5 text-meta',
        'hover:bg-hover disabled:pointer-events-none disabled:opacity-64',
        selected
          ? 'border-b-primary bg-background font-medium text-foreground'
          : 'text-muted-foreground'
      )}
    >
      {children}
    </button>
  );
}

function OptionButton({
  letter,
  selected,
  disabled,
  onClick,
  muted,
  role,
  children,
}: {
  letter: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  muted?: boolean;
  role?: 'radio' | 'checkbox';
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is radio/checkbox whenever aria-checked is set
    <button
      type="button"
      role={role}
      aria-checked={role ? selected : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-7 w-full items-start gap-2 rounded-sm px-1.5 py-1 text-left leading-5',
        'hover:bg-hover disabled:pointer-events-none disabled:opacity-64',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        selected && 'bg-selection',
        muted && !selected ? 'text-muted-foreground' : 'text-foreground'
      )}
    >
      <span
        className={cn(
          'mt-px grid size-[18px] shrink-0 place-items-center rounded-xs border text-2xs leading-none',
          selected
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-muted text-muted-foreground'
        )}
      >
        {letter}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</span>
    </button>
  );
}

function QuestionPage({
  item,
  index,
  rows,
  sel,
  disabled,
  onPick,
  onOtherText,
  onOtherDone,
}: {
  item: QuestionItem;
  index: number;
  rows: OptionRow[];
  sel: QuestionSelection;
  disabled: boolean;
  onPick: (row: OptionRow) => void;
  onOtherText: (text: string) => void;
  onOtherDone: () => void;
}) {
  const { t } = useI18n();
  const multiSelect = Boolean(item.multiSelect);
  const otherSelected = sel.otherSelected[index] ?? false;
  // Plain Enter moves on; Shift+Enter is a newline.
  const onOtherKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    onOtherDone();
  };
  return (
    <div key={questionReactKey(item, index)}>
      <div className="flex items-baseline gap-1.5 px-1 pt-0.5 pb-1.5 leading-normal">
        {item.header && (
          <span className="shrink-0 rounded-xs bg-muted px-[5px] text-meta text-muted-foreground">
            {item.header}
          </span>
        )}
        <span className="min-w-0 whitespace-pre-wrap break-words font-semibold text-foreground">
          {item.question}
          {multiSelect && (
            <span className="ml-1.5 text-meta font-normal text-muted-foreground">
              {t('Multiple choice')}
            </span>
          )}
        </span>
      </div>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is dynamic (group vs radiogroup); aria-label is valid for both */}
      <div
        className="flex flex-col gap-px"
        role={multiSelect ? 'group' : 'radiogroup'}
        aria-label={item.question}
      >
        {rows.map((row) => {
          const selected = row.isOther
            ? otherSelected
            : (sel.byQuestion[index] ?? []).includes(row.label);
          if (row.isOther && selected) {
            return (
              <div
                key={row.letter}
                className="flex min-h-7 items-start gap-2 rounded-sm bg-selection px-1.5 py-1"
              >
                {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is dynamic (radio vs checkbox); both take aria-checked */}
                <button
                  type="button"
                  role={multiSelect ? 'checkbox' : 'radio'}
                  aria-checked
                  disabled={disabled}
                  onClick={() => onPick(row)}
                  className="flex shrink-0 items-start gap-2 leading-5 text-foreground"
                >
                  <span className="mt-px grid size-[18px] shrink-0 place-items-center rounded-xs border border-primary bg-primary text-2xs leading-none text-primary-foreground">
                    {row.letter}
                  </span>
                  <span>{t('Other:')}</span>
                </button>
                {item.isSecret ? (
                  <Input
                    autoFocus
                    size="sm"
                    type="password"
                    aria-label={t('Your answer')}
                    value={sel.otherText[index] ?? ''}
                    disabled={disabled}
                    onChange={(event) => onOtherText(event.target.value)}
                    onKeyDown={onOtherKeyDown}
                    placeholder={t('Value is hidden while you type')}
                    // A credential must not reach autofill or the spellchecker.
                    autoComplete="off"
                    spellCheck={false}
                    className="-my-[3px] min-w-0 flex-1 text-ui"
                  />
                ) : (
                  <textarea
                    // biome-ignore lint/a11y/noAutofocus: the user just picked Other to type here
                    autoFocus
                    rows={1}
                    aria-label={t('Your answer')}
                    value={sel.otherText[index] ?? ''}
                    disabled={disabled}
                    onChange={(event) => onOtherText(event.target.value)}
                    onKeyDown={onOtherKeyDown}
                    placeholder={t(
                      'Type your answer (Enter to continue, Shift+Enter for a new line)'
                    )}
                    className="-my-[3px] field-sizing-content max-h-30 min-h-[26px] min-w-0 flex-1 resize-none overflow-y-auto rounded-sm border border-input bg-background px-2 py-0.5 leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
                  />
                )}
              </div>
            );
          }
          return (
            <OptionButton
              key={row.letter}
              letter={row.letter}
              role={multiSelect ? 'checkbox' : 'radio'}
              selected={selected}
              disabled={disabled}
              onClick={() => onPick(row)}
              muted={row.isOther}
            >
              {row.label}
              {row.description && (
                // font-normal: Segoe UI has no 500, so a medium description
                // would render the same weight as its label on Win10.
                <span className="ml-2 text-meta font-normal text-muted-foreground">
                  {row.description}
                </span>
              )}
            </OptionButton>
          );
        })}
      </div>
    </div>
  );
}

function ReviewPage({
  items,
  sel,
  onJump,
  disabled,
}: {
  items: readonly QuestionItem[];
  sel: QuestionSelection;
  onJump: (index: number) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <div>
      <div className="flex items-baseline gap-1.5 px-1 pt-0.5 pb-1.5 leading-normal">
        <span className="font-semibold text-foreground">{t('Check your answers')}</span>
        <span className="text-meta text-muted-foreground">{t('Click a row to change it')}</span>
      </div>
      <div className="flex flex-col gap-px">
        {items.map((item, index) => {
          const answer = reviewAnswer(sel, index, item, t);
          return (
            <button
              key={questionReactKey(item, index)}
              type="button"
              disabled={disabled}
              onClick={() => onJump(index)}
              title={item.question}
              className="grid min-h-7 w-full grid-cols-[26px_minmax(0,1fr)_minmax(0,1fr)] items-baseline gap-2 rounded-sm px-1.5 py-1 text-left leading-5 hover:bg-hover disabled:pointer-events-none"
            >
              <span className="text-meta text-muted-foreground tabular-nums">Q{index + 1}</span>
              <span className="truncate text-muted-foreground">{item.question}</span>
              {answer ? (
                <span className="whitespace-pre-wrap break-words text-foreground">{answer}</span>
              ) : (
                <span className="text-destructive">{t('Not answered yet')}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function reviewAnswer(
  sel: QuestionSelection,
  index: number,
  item: QuestionItem,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  const parts = [...(sel.byQuestion[index] ?? [])];
  const text = (sel.otherText[index] ?? '').trim();
  if (sel.otherSelected[index] && text) {
    parts.push(
      item.isSecret ? t('Other: {{text}}', { text: '••••' }) : t('Other: {{text}}', { text })
    );
  }
  return parts.join('、');
}
