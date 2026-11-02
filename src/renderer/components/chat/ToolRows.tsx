import {
  ArrowDownToLine,
  Braces,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ClipboardList,
  FileOutput,
  FileText,
  Globe,
  Image,
  Layers,
  ListChecks,
  ListTree,
  PencilLine,
  Plug,
  ScanSearch,
  Search,
  SquareTerminal,
  Target,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Ident } from '@/components/ui/ident';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusIcon } from '@/components/ui/status-icon';
import { toastManager } from '@/components/ui/toast';
import { useElementWidth } from '@/hooks/useElementWidth';
import { useI18n } from '@/i18n';
import { unwrapIpcErrorMessage } from '@/lib/ipcError';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { diffTooNarrowToSplit, effectiveDiffLayout, useDiffLayoutStore } from '@/stores/diffLayout';
import { type FileOpenIntent, useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import {
  readToolExpandMemory,
  resolveToolRowOpen,
  useToolExpansionStore,
} from '@/stores/toolExpansion';
import { useToolLiveOutputStore } from '@/stores/toolLiveOutput';
import { CopyIconButton } from './CopyIconButton';
import {
  thoughtBodyMaxHeightClass,
  toolRowIconClass,
  turnProcessToneClass,
} from './chatTimelineLayout';
import { DiffLayoutToggle, SplitDiffBody } from './DiffLayout';
import { HitListPopover } from './HitListPopover';
import { LiveToolOutput } from './LiveToolOutput';
import {
  FINDING_OUTCOME_LABEL,
  FINDING_VERDICT_LABEL,
  type FindingOutcome,
  findingLabel,
  findingOpensAtFirst,
  findingTarget,
  REVIEW_LEVEL_LABEL,
  type ReviewFinding,
  type ReviewFindings,
} from './reviewFindings';
import { deriveSubagentPanelRows, subagentHeaderLiveness } from './subagentActivityModel';
import { TodoList } from './TodoCard';
import { canMoveToBackground } from './toolBackground';
import {
  composeRefArg,
  type FileLinkTarget,
  isDelegationTool,
  runningElapsedMs,
  shortPath,
  TOOL_RUN_OUTCOME_LABEL,
  type ToolArgRef,
  type ToolRowView,
  toolRowArgClass,
  toolRowPermissionClass,
  toolRowPermissionNoteClass,
  toolRowTitleClass,
  withStoppedOutput,
} from './toolCard';
import type { ToolDiff } from './toolDiff';
import { buildDiffView, diffHasLineNumbers, splitDiffItems } from './toolDiffView';
import { stoppedToolOutput } from './toolLiveOutputModel';
import { kilobytesLabel } from './toolOutputHead';
import type { StepResultLine, StepRowView } from './turnSteps';
import { formatWorkedForDuration } from './turnTiming';

/**
 * T-05 batch 2/4: bare tool-row rendering (A07 screen 5, groups A-E), plus
 * the two inline interactions from screen 5 group F — Read row click-to-open
 * and Grep/Glob row hover hit list. Every class here is the literal Tailwind
 * mapping from the T-05 spec §2.9 A07 class table — no invented visual
 * values, no icons, no borders, no dots.
 *
 * `deriveToolGroupRows` (toolCard.ts, batch 1) has already decided what to
 * show; this file only turns `ToolRowView`s into DOM and wires the two
 * click paths to `fileOpenIntent` + the shell's `editor` surface.
 */

/**
 * Default click path (T-05 §2.6, A07 F①/F②): record the navigation intent —
 * the CENTER editor column consumes it (`EditorColumn`'s fileOpenIntent
 * effect) and opens the file as a tab. `onOpenFile` lets a caller override
 * this; nothing does today.
 *
 * Round-10 inspection ⑥: this used to ALSO call `openSurface('editor')`.
 * Post-T-32 that surface id means the right-panel Files TREE (the editor
 * itself moved to the center column, see surfaceRegistry.ts), so the call
 * popped the wrong panel — and with zero tabs open the intent consumer
 * wasn't even mounted (see WorkspaceShell's intent-pending mount), which is
 * why clicking a file "only jumped to files". The intent alone is correct.
 */
function openFileTarget(target: FileLinkTarget, source: FileOpenIntent['source']) {
  useFileOpenIntentStore.getState().requestFileOpen({ ...target, source });
}

const ToolDiffVisibility = createContext(true);

interface ToolGroupProps {
  showDiff?: boolean;
  rows: ToolRowView[];
  onOpenFile?: (target: FileLinkTarget) => void;
  /**
   * T12-d: which session's expand memory these rows belong to. Optional
   * because `QuestionCard` renders a lone `ToolRow` outside any timeline —
   * without a session there is simply nothing to remember, which is the right
   * answer for a permission card's one-off row.
   */
  sessionId?: string;
}

/** Renders one `.ct` group — the A07 unit that wraps a contiguous tool/thinking stream. */
export function ToolGroup({ rows, onOpenFile, sessionId, showDiff }: ToolGroupProps) {
  const inherited = useContext(ToolDiffVisibility);
  if (rows.length === 0) return null;
  return (
    // T-30 P-17: no own margin — the parent turn body owns the item-to-item
    // gap (`turnBodyClass()`); a margin here would stack on top of it (and on
    // ReadingColumn's turn-to-turn space-y-5) instead of replacing it.
    <ToolDiffVisibility.Provider value={showDiff ?? inherited}>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <ToolRow
            key={row.key}
            view={row}
            depth={0}
            onOpenFile={onOpenFile}
            sessionId={sessionId}
          />
        ))}
      </div>
    </ToolDiffVisibility.Provider>
  );
}

interface ToolRowProps {
  view: ToolRowView;
  /** Always 0 — detail rows never indent further (A07 :2517). Kept for assertion readability. */
  depth?: 0;
  onOpenFile?: (target: FileLinkTarget) => void;
  /** T12-d: session scope for the expand memory. See `ToolGroupProps`. */
  sessionId?: string;
}

/**
 * Decision 034: every process row leads with an icon.
 *
 * The mapping lives here and the DECISION lives in `toolCard.toolIconKind()` —
 * that module is React-free by contract, so it returns a kind and this table
 * turns the kind into an element. A kind with no entry falls back to the
 * generic mark rather than rendering nothing, because a missing icon would
 * silently break the column the other rows align to.
 *
 * `size-3.5` is the chat area's SM icon tier (design system v2 §4.3), and the
 * icons inherit `currentColor` so they dim with the row instead of needing a
 * second colour decision.
 *
 * Design system v2 §6 / §7.4: once a row failed, the slot holds the shared
 * `StatusIcon` instead -- the one red cross. A running row keeps its own mark:
 * the turn head is the one line that spins and counts (user, 2026-10-23: two
 * lines both spinning and ticking read as the same thing said twice).
 * `plan` wears the plan review card's own mark, so it no longer shares the
 * directory listing's tree.
 */
const ROW_ICONS: Record<string, typeof Wrench> = {
  terminal: SquareTerminal,
  edit: PencilLine,
  read: FileText,
  search: Search,
  list: ListTree,
  web: Globe,
  delegate: Users,
  plan: ClipboardList,
  thinking: Braces,
  tool: Wrench,
  // dsh-rebase P1-7c (plan P1-7 shard 04 §1). `todo`, `goal` and `job` are
  // the marks the todo card, the goal bar and the background-tasks button
  // already wear, so a row and its panel read as one thing.
  image: Image,
  todo: ListChecks,
  goal: Target,
  job: Layers,
  workflow: Workflow,
  mcp: Plug,
  deliver: FileOutput,
  review: ScanSearch,
};

function ToolRowIcon({ view }: { view: ToolRowView }) {
  if (view.failed || view.reviewDenied) {
    return <StatusIcon status="failed" className="self-center" />;
  }
  const Icon = ROW_ICONS[view.iconKind ?? 'tool'] ?? Wrench;
  return <Icon className={toolRowIconClass()} aria-hidden />;
}

/**
 * Design system v2 §6: on a failed row only the icon and the one-line reason
 * are red. The reason is the word that says how the call ended (the
 * permission word, the outcome word); the name and the argument keep their ink.
 */
function failedReasonClass(view: Pick<ToolRowView, 'failed' | 'reviewDenied'>): string | false {
  return view.failed || view.reviewDenied ? 'text-destructive' : false;
}

/** One `.ct-row`: verb + arg, optionally expandable into an output/detail/thinking body. */
export function ToolRow(props: ToolRowProps) {
  const { view } = props;
  if (view.findings) {
    return (
      <ReviewFindingsCard
        view={view}
        report={view.findings}
        onOpenFile={props.onOpenFile}
        sessionId={props.sessionId}
      />
    );
  }
  if (view.toolName && isDelegationTool(view.toolName) && view.toolCallId) {
    // dsh-rebase P1-7b: `data-tool-call-id` is how the subagents window's
    // 「定位」 finds this row (`locateToolRow`), which marks it for a moment.
    return (
      <div
        data-tool-call-id={view.toolCallId}
        className="rounded-sm transition-colors duration-250 data-[located]:bg-fill-ghost-selected"
      >
        <SubagentActivity
          {...props}
          parentToolCallId={view.toolCallId}
          parentRunning={view.running}
        />
      </div>
    );
  }
  return <ToolRowContent {...props} />;
}

/**
 * dsh-rebase P1-7c: an argument naming a background job or a subagent, with
 * the label the session's panels know for it (`ToolArgRef`). A leaf of its
 * own so a jobs-projection change re-renders this span, never the derivation
 * above it. The selectors return strings, so a job's progress line changing
 * does not re-render a row whose label did not.
 */
function RefToolRowArg({
  view,
  argRef,
  sessionId,
}: {
  view: ToolRowView;
  argRef: ToolArgRef;
  sessionId?: string;
}) {
  const panelLabel = useSessionPanelsStore((state) => {
    if (!sessionId) return undefined;
    const panels = state.bySession[sessionId];
    return argRef.kind === 'job'
      ? panels?.jobs?.find((job) => job.id === argRef.id)?.label
      : panels?.subagentCatalog?.find((entry) => entry.id === argRef.id)?.label;
  });
  // A child the catalog has not listed yet is often already a lane.
  const laneLabel = useSubagentActivityStore((state) => {
    if (argRef.kind !== 'subagent') return undefined;
    const parent = state.agentIndex[argRef.id];
    return parent ? (state.lanes[parent]?.description ?? undefined) : undefined;
  });
  const composed = composeRefArg(view, argRef, panelLabel ?? laneLabel);
  if (!composed.text) return null;
  return (
    <span className={toolRowArgClass({ failed: view.failed, argKind: composed.kind })}>
      {composed.text}
    </span>
  );
}

function ToolRowContent({ view: derived, onOpenFile, sessionId }: ToolRowProps) {
  const { t } = useI18n();
  // P1-7e (problem 20): a call Stop cut short shows what it printed before the
  // stop, while this window still holds its last live tail.
  const kept = useToolLiveOutputStore((state) =>
    derived.outcome === 'stopped'
      ? stoppedToolOutput(state, sessionId, derived.toolCallId)
      : undefined
  );
  const view = useMemo(() => withStoppedOutput(derived, kept), [derived, kept]);
  // Decision 203: the Claude engine can move this running call to the background.
  const engine = useChatSessionsStore((state) =>
    sessionId ? state.sessions.find((item) => item.id === sessionId)?.engine : undefined
  );
  const backgroundable = canMoveToBackground(view, engine);
  // Where diffs are hidden (the main timeline shows them in the review pane), a
  // row whose only body is its diff has nothing to open. It used to toggle open
  // onto nothing — a refused or stopped Edit (PiLab R2).
  const showDiff = useContext(ToolDiffVisibility);
  const diffOnly = Boolean(view.diff) && !view.body && !view.input && !view.todos;
  const expandable = view.expandable && (showDiff || !diffOnly);
  // The dim rung of the 2026-09-18 reading ladder (see
  // `chatTimelineLayout.ts`). It used to be `text-muted-foreground`, which is
  // the same tier the work-group head above these rows now uses — so the head
  // and the rows it summarises were indistinguishable, and the "importance is
  // brightness" rule the user asked for had only two steps instead of three.
  // The row ARG has been on this token since T-05; this aligns the verb with
  // it, which is also what the reference client does.
  //
  // T104: the whole row moved from `text-chat-body` to `text-chat-process`.
  // Tool rows used to share the body tier with the prose they interrupt, which
  // is exactly the "process is not distinguishable from content" complaint
  // (the head/arg tier split above only separated them by brightness). This
  // token is runtime-configurable, so the row follows the reader's process
  // size setting.
  //
  // Design system v2 §7.4: frameless, one line; the tool name is the muted ink
  // at 500, everything after it (argument, counts, clock) the faint ink. A
  // failed row no longer turns red as a whole (§6) -- see `ToolRowIcon` and
  // `failedReasonClass`.
  const rowClass = cn(
    'group/row flex w-full items-baseline gap-1.5 rounded-xs text-left text-chat-process leading-normal focus-ring',
    turnProcessToneClass()
  );
  const verbClass = 'shrink-0 font-medium text-muted-foreground group-hover/row:text-foreground';

  const rowContent = (
    <>
      {/* Decision 034: the aggregate row is gone, so every row words itself
          from its own closed-vocabulary verb — there is no count branch left. */}
      <ToolRowIcon view={view} />
      {/* dsh-rebase decision 131: a plugin's own title for the call says what
          the verb and the argument would, in the plugin's words (never
          translated, decision 073 rule 1). */}
      {view.title !== undefined ? (
        <span data-slot="tool-row-title" className={toolRowTitleClass(view)}>
          {view.title}
        </span>
      ) : (
        <>
          <span className={verbClass}>{t(view.verb)}</span>
          {view.argRef ? (
            <RefToolRowArg view={view} argRef={view.argRef} sessionId={sessionId} />
          ) : (
            <ToolRowArg view={view} onOpenFile={onOpenFile} />
          )}
        </>
      )}
      <ToolRowPermission view={view} />
      {/* N5: a call that never did its work says so in words — 「已拒绝」 for a
          runtime refusal, 「未执行」 for one the run ended before. Same slot and
          class as the permission word, since both say how the call ended.
          dsh-rebase P1-4d1: a call refused by the card the user answered
          already says so in its permission word, and says it once. */}
      {view.outcome && !(view.outcome === 'refused' && view.permissionVerb) && (
        <span
          data-slot="tool-row-outcome"
          className={cn(toolRowPermissionClass(), failedReasonClass(view))}
        >
          · {t(TOOL_RUN_OUTCOME_LABEL[view.outcome])}
        </span>
      )}
      {/* Decision 192: what the review model did with the call, already worded. */}
      {view.reviewNote && (
        <span data-slot="tool-row-review" className={toolRowPermissionNoteClass()}>
          · {view.reviewNote}
        </span>
      )}
      {/* Decision 169: how the plan review the call raised ended — an answer,
          in the outcome word's slot and tone, never red. */}
      {view.planReview && (
        <span data-slot="tool-row-plan-review" className={toolRowPermissionClass()}>
          · {t(view.planReview.key, view.planReview.params)}
        </span>
      )}
      {/* dsh-rebase P1-7c (plan P1-7 shard 04 §4): where the call left its
          work — 「后台 · bash-2」 for `run_in_background`, 「已转后台 · bash-3」
          for a command its timeout moved there — and a shell's non-zero exit,
          「退出码 1」. Same slot and tone as the outcome word: neither is a
          failure, so neither is red. */}
      {view.backgroundJob && (
        <span data-slot="tool-row-job" className={toolRowPermissionClass()}>
          · {t(view.backgroundJob.promoted ? 'Moved to background' : 'In background')}
          {view.backgroundJob.id ? ` · ${view.backgroundJob.id}` : null}
        </span>
      )}
      {/* Decision 202: a delegate still working after its call settled runs
          in the background; it does not hold the conversation, so it never
          takes the foreground running state. */}
      {view.backgroundRunning && (
        <span data-slot="tool-row-background" className={toolRowPermissionClass()}>
          · {t('Running in background')}
        </span>
      )}
      {typeof view.exitCode === 'number' && (
        <span data-slot="tool-row-exit" className={cn(toolRowPermissionClass(), 'tabular-nums')}>
          · {t('Exit code {{code}}', { code: view.exitCode })}
        </span>
      )}
      {/* Decision 190: what grep found, or how a fetched page came back
          (「3 个文件」「HTTP 404」「已截断」) — the exit code's slot and tone. */}
      {view.resultNote && (
        <span data-slot="tool-row-result" className={cn(toolRowPermissionClass(), 'tabular-nums')}>
          · {t(view.resultNote.key, view.resultNote.params)}
        </span>
      )}
      {/* 2026-09-23 (user report: a 1800s command gave no sign of progress):
          the live clock on a running row — elapsed since `tool.started`, and
          the deadline the runtime will apply when the input named one (on DSH,
          P1-7c: "12s · to background at 2m", since DSH moves a command to the
          background at its timeout instead of killing it). A leaf of its own
          so the per-second tick re-renders this span and nothing above it.
          T146 — once `execStartedAtMs` is known (bash, past approval and path
          checks), both numbers switch to that origin instead, and the limit
          is withheld until then — see `deriveToolRowView`. */}
      {/* User, 2026-10-23: the turn head already spins and counts, so a row's
          own seconds are drawn only with what the head cannot say -- the
          deadline DSH moves the command to the background at. */}
      {view.running &&
        typeof view.runningStartedAtMs === 'number' &&
        typeof view.runningTimeoutMs === 'number' && (
          <RunningToolClock
            startedAtMs={view.runningStartedAtMs}
            timeoutMs={view.runningTimeoutMs}
          />
        )}
      {!view.diff && view.changeStat && (
        <span data-slot="tool-row-change" className="shrink-0 tabular-nums">
          <span className="text-success">+{view.changeStat.added}</span>{' '}
          <span className="text-destructive">−{view.changeStat.removed}</span>
        </span>
      )}
      {/* PiLab R1 (2026-10-30): an edit's +/− counts are part of the step's
          one line in every surface; only the diff BODY follows the setting. */}
      {view.diff && (
        <span className="shrink-0 tabular-nums">
          {/* Decision 034: the ordinary settled edit prints the NUMBERS only.
              The label 「已修改」 restated the row's own verb one span to the
              right, which is the per-row redundancy the zcode comparison was
              about. A preview, a failure and a whole-file write keep theirs —
              those three say something the verb does not. */}
          {view.running || view.outcome || view.failed || view.diff.source === 'write-content' ? (
            <>
              {t(
                // A call that never ran shows what it ASKED to change (N5).
                view.running || view.outcome
                  ? 'Modification preview'
                  : view.failed
                    ? 'Modification failed'
                    : 'Written content'
              )}{' '}
              ·{' '}
            </>
          ) : null}
          <span className="text-success">+{view.diff.added}</span>{' '}
          <span className="text-destructive">−{view.diff.removed}</span>
        </span>
      )}
    </>
  );

  // 2026-09-23 (user decision: thoughts start collapsed and a click opens the
  // whole text): a thought row is an ordinary collapsible row again — the
  // special `ThinkingPreview` branch (always-visible 200-char preview + inline
  // expand/collapse button) was the shape the user asked to remove. What
  // survives from it is the blank-line filtering, now inside `ToolRowBody`'s
  // 'thinking' case.
  // PiLab R1 (2026-10-30): what came of the step, one line under it
  // (`turnSteps.ts`), and a running command's last lines while its body is closed.
  const resultLine = (view as StepRowView).resultLine;
  const liveTail =
    view.running && view.iconKind === 'terminal' && view.toolCallId ? view.toolCallId : null;
  const after = (open: boolean) => (
    <>
      {resultLine && <StepResult line={resultLine} />}
      {liveTail && !open && <LiveToolOutput toolCallId={liveTail} compact />}
    </>
  );
  const row = !expandable ? (
    <div>
      <div className={rowClass}>{rowContent}</div>
      {after(false)}
    </div>
  ) : (
    <ToolRowCollapsible
      // The seed is re-taken when a row crosses from live to settled — see the
      // component's note. Everything that is not a streaming row keys as
      // `settled` from its first render and therefore never re-seeds.
      key={view.running ? 'live' : 'settled'}
      view={view}
      rowClass={rowClass}
      onOpenFile={onOpenFile}
      sessionId={sessionId}
      after={after}
    >
      {rowContent}
    </ToolRowCollapsible>
  );

  if (!backgroundable || !sessionId || !view.toolCallId) return row;
  // A sibling of the row, never inside its disclosure trigger (a button).
  return (
    <div className="flex min-w-0 items-start gap-1">
      <div className="min-w-0 flex-1">{row}</div>
      <MoveToBackgroundButton sessionId={sessionId} toolCallId={view.toolCallId} />
    </div>
  );
}

/** A step `turnSteps.ts` merged from several calls. */
function isMergedStep(view: ToolRowView): boolean {
  return view.key.startsWith('lookup:') || view.key.startsWith('edits:');
}

/** `⎿ 38 passed · 12 行` — the one line under a step (`deriveStepResult`). */
function StepResult({ line }: { line: StepResultLine }) {
  return (
    <div
      data-slot="step-result"
      data-tone={line.tone}
      className={cn(
        'flex min-w-0 gap-1.5 pl-5 text-chat-process leading-normal',
        line.tone === 'bad'
          ? 'text-destructive'
          : line.tone === 'unknown'
            ? 'text-warning'
            : 'text-muted-foreground'
      )}
    >
      <span className="shrink-0 text-foreground-faint" aria-hidden>
        ⎿
      </span>
      <span className="min-w-0 truncate" title={line.text}>
        {line.text}
      </span>
    </div>
  );
}

/**
 * Decision 203: 「转到后台」 on a running call of a Claude engine chat — the
 * CLI's Ctrl+B for this one call. The call returns at once and its work goes
 * on as a background task (the jobs window lists it); the row then reads
 * 「后台」 and the button goes with the running state.
 */
function MoveToBackgroundButton({
  sessionId,
  toolCallId,
}: {
  sessionId: string;
  toolCallId: string;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const move = async (): Promise<void> => {
    setPending(true);
    try {
      const { backgrounded } = await window.electronAPI.chat.backgroundTool({
        sessionId,
        toolCallId,
      });
      if (!backgrounded) {
        toastManager.add({ type: 'error', title: t('This call cannot move to the background') });
      }
    } catch (error) {
      toastManager.add({
        type: 'error',
        title: t('This call cannot move to the background'),
        description: unwrapIpcErrorMessage(error),
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <Button
      size="xs"
      variant="ghost"
      className="h-6 shrink-0 gap-1 px-1.5 text-muted-foreground"
      disabled={pending}
      title={t('Move to background — the turn goes on and this keeps running as a background task')}
      onClick={() => void move()}
    >
      <ArrowDownToLine className="size-3.5" />
      {t('Move to background')}
    </Button>
  );
}

/**
 * The row panel opens and closes in ONE frame: the Base UI panel's measured
 * height transition (`COLLAPSIBLE_PANEL_BASE_CLASS`, 150ms) is switched off.
 *
 * The timeline's scroll-follower tells a disclosure from new content by
 * comparing the height it sees against the one `ThinkingFollowContext`
 * recorded in the toggle's layout pass. With the transition on, that record is
 * the height BEFORE the animation (the panel starts at `h-0`), every frame of
 * the animation missed it, and each one was followed as new content — so
 * opening a long thought while pinned to the bottom of a streaming turn
 * scrolled the row just clicked out of view, frame by frame. With the panel at
 * its final height inside the toggle's own commit, the record and the next
 * resize agree, as they did for the retired instant-toggle `ThinkingPreview`.
 *
 * `duration-0` is also what makes Base UI classify the panel as unanimated, so
 * it mounts and unmounts the body synchronously instead of waiting for
 * `transitionend`. The turn's own process group (a native `<details>`) has
 * never animated either, so the timeline's disclosures now behave alike.
 */
const TOOL_ROW_PANEL_CLASS =
  'h-auto transition-none duration-0 data-starting-style:h-auto data-ending-style:h-auto';

/**
 * Seed from session memory when a body first appears. Explicit choices survive
 * live/settled transitions. Thoughts open only on a click (2026-09-23, the
 * preview-and-button shape retired the same day); completions fold with the
 * turn. Delegations start closed, with one disclosure for the header and
 * operations.
 */
function ToolRowCollapsible({
  view,
  rowClass,
  onOpenFile,
  sessionId,
  after,
  children,
}: {
  view: ToolRowView;
  rowClass: string;
  onOpenFile?: (target: FileLinkTarget) => void;
  sessionId?: string;
  /** Under the trigger, above the body: the step's result line and live tail. */
  after?: (open: boolean) => ReactNode;
  children: ReactNode;
}) {
  const [initialOpen] = useState(() => resolveToolRowOpen(view, readToolExpandMemory(sessionId)));
  const setToolRowExpanded = useToolExpansionStore((state) => state.setToolRowExpanded);
  // Controlled on purpose: a disclosure changes LAYOUT, and the timeline's
  // scroll-follower needs to be told AFTER the panel has actually grown or
  // shrunk — `ThinkingFollowContext`'s callback records the new scrollHeight
  // so the follow logic does not read the disclosure as new content, and an
  // OPEN pauses following (C3). An uncontrolled Collapsible never re-renders
  // this component on toggle, so there is no effect to hang that on.
  //
  // Every row reports, not just thoughts: a tool row opened at the bottom of a
  // streaming turn grows the page exactly the same way, and without the
  // report the follower scrolled its header out from under the click.
  const [open, setOpen] = useState(initialOpen);
  const markUserToggle = useUserDisclosureReport(open);
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        markUserToggle();
        setOpen(next);
        if (sessionId) setToolRowExpanded(sessionId, view.key, next);
      }}
    >
      <CollapsibleTrigger
        className={rowClass}
        // A Read row nests a real <button> inside the trigger for its
        // clickable file name (F①) — a native <button> can't contain one,
        // so those rows render the trigger as a <div role="button"> instead
        // (Base UI's documented escape hatch for a non-button render target).
        nativeButton={!view.link}
        render={view.link ? <div /> : undefined}
      >
        {/* Decision 034 (2026-09-22, user decision): NO CHEVRON. The whole row
            is the trigger, and it always was — the chevron only advertised
            that. At one per row it was also the single densest thing on the
            surface, which is what 「一团乱麻」 and the zcode comparison were
            about. The cost is recorded rather than hidden: a row that CAN
            expand now looks exactly like one that cannot, and the only way to
            find out is to click. That is the trade the user chose after
            seeing both in `docs/examples/process-rows-zcode-style.html`. */}
        {children}
      </CollapsibleTrigger>
      {after?.(open)}
      <CollapsibleContent className={TOOL_ROW_PANEL_CLASS}>
        <ToolRowBody view={view} onOpenFile={onOpenFile} sessionId={sessionId} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One delegation header owns the child operations; no second agent header. */
function SubagentActivity({
  parentToolCallId,
  parentRunning,
  view,
  onOpenFile,
  sessionId,
}: ToolRowProps & { parentToolCallId: string; parentRunning: boolean }) {
  const { t } = useI18n();
  const lane = useSubagentActivityStore((s) => s.lanes[parentToolCallId] ?? null);
  const panel = useMemo(
    () => deriveSubagentPanelRows(lane, { parentRunning, t })[0],
    [lane, parentRunning, t]
  );
  const liveness = subagentHeaderLiveness(lane?.status, parentRunning);
  const merged = panel
    ? {
        ...view,
        arg: [lane?.agentType, view.arg ?? lane?.description].filter(Boolean).join(' '),
        argKind: 'prose' as const,
        running: liveness === 'running',
        backgroundRunning: liveness === 'background',
        failed: view.failed || panel.failed,
        expandable: true,
        body: 'detail' as const,
        input: undefined,
        defaultOpen: false,
        detail: [
          ...(panel.detail ?? []),
          ...(panel.arg
            ? [
                {
                  ...panel,
                  key: `${view.key}~status`,
                  verb: 'Status',
                  expandable: false,
                  body: undefined,
                  detail: undefined,
                },
              ]
            : []),
          ...(view.input || view.output
            ? [
                {
                  ...view,
                  key: `${view.key}~result`,
                  toolName: undefined,
                  verb: view.output ? 'Result' : 'Input',
                  expandable: true,
                  defaultOpen: false,
                  arg: undefined,
                },
              ]
            : []),
        ],
      }
    : view;
  return <ToolRowContent view={merged} onOpenFile={onOpenFile} sessionId={sessionId} />;
}

// Design system v2 §1 rule 1: tags inside the card are fills, not frames.
const FINDING_OUTCOME_BADGE: Readonly<Record<FindingOutcome, 'success' | 'warning' | 'secondary'>> =
  {
    fixed: 'success',
    skipped: 'warning',
    no_change_needed: 'secondary',
  };

/**
 * Route B S-6: the card a `ReportFindings` call is drawn as. The head says how many
 * findings (or none) and how deep the review ran; each finding is a row — its label,
 * where it points (opened in the editor), its category, verdict and outcome — that opens
 * onto the whole summary and the failure scenario. Shares the card shell of the plan
 * review card (`PlanReviewCard`).
 */
function ReviewFindingsCard({
  view,
  report,
  onOpenFile,
  sessionId,
}: {
  view: ToolRowView;
  report: ReviewFindings;
  onOpenFile?: (target: FileLinkTarget) => void;
  sessionId?: string;
}) {
  const { t } = useI18n();
  const total = report.findings.length;
  return (
    <section
      data-testid="review-findings-card"
      aria-label={t('Review findings')}
      className="overflow-hidden rounded-md border border-border-soft bg-surface-2 text-ui"
    >
      {/* Design system v2 §4.2: a card head is 32px, over one hairline. */}
      <div
        className={cn(
          'flex h-8 items-center gap-2 px-3 text-muted-foreground',
          total > 0 && 'border-b border-border-soft'
        )}
      >
        <ScanSearch className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-semibold">{t('Review findings')}</span>
        <span className="min-w-0 truncate text-foreground tabular-nums">
          {total > 0 ? t('{{count}} found', { count: total }) : t('No issues found')}
        </span>
        {report.level && (
          <span className="shrink-0">
            · {t('Review depth: {{level}}', { level: t(REVIEW_LEVEL_LABEL[report.level]) })}
          </span>
        )}
      </div>
      {total > 0 && (
        <ul className="flex flex-col py-1">
          {report.findings.map((finding, index) => (
            <ReviewFindingRow
              // A report is replaced whole, never edited in place.
              // biome-ignore lint/suspicious/noArrayIndexKey: a finding's place in its report is its identity
              key={index}
              finding={finding}
              rowKey={`${view.key}~finding-${index}`}
              defaultOpen={findingOpensAtFirst(index, total)}
              onOpenFile={onOpenFile}
              sessionId={sessionId}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One finding. Its open state is remembered per session like a tool row's, so the card
 * keeps it when the settled turn moves it out of the work group (a remount).
 */
function ReviewFindingRow({
  finding,
  rowKey,
  defaultOpen,
  onOpenFile,
  sessionId,
}: {
  finding: ReviewFinding;
  rowKey: string;
  defaultOpen: boolean;
  onOpenFile?: (target: FileLinkTarget) => void;
  sessionId?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(() =>
    resolveToolRowOpen({ key: rowKey, defaultOpen }, readToolExpandMemory(sessionId))
  );
  const setToolRowExpanded = useToolExpansionStore((state) => state.setToolRowExpanded);
  const markUserToggle = useUserDisclosureReport(open);
  const target = findingTarget(finding);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li data-slot="review-finding">
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          markUserToggle();
          setOpen(next);
          if (sessionId) setToolRowExpanded(sessionId, rowKey, next);
        }}
      >
        {/* The label keeps half the row at least: on a narrow column the place and the tags
            go to a line of their own rather than squeezing it to a few words. */}
        <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-0.5">
          <CollapsibleTrigger className="flex min-w-0 grow basis-1/2 items-center gap-1.5 rounded-xs text-left text-foreground focus-ring">
            <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{findingLabel(finding)}</span>
          </CollapsibleTrigger>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {target && (
              <button
                type="button"
                title={target.line ? `${target.path}:${target.line}` : target.path}
                className="cursor-pointer border-b border-transparent text-foreground-faint hover:border-current hover:text-foreground"
                onClick={() =>
                  (onOpenFile ?? ((link: FileLinkTarget) => openFileTarget(link, 'tool-row')))(
                    target
                  )
                }
              >
                <Ident>
                  {shortPath(target.path)}
                  {target.line ? `:${target.line}` : null}
                </Ident>
              </button>
            )}
            {finding.category && (
              <Badge variant="secondary" size="lg" className="font-normal">
                {finding.category}
              </Badge>
            )}
            {finding.verdict && (
              <Badge variant="secondary" size="lg" className="font-normal">
                {t(FINDING_VERDICT_LABEL[finding.verdict])}
              </Badge>
            )}
            {finding.outcome && (
              <Badge
                variant={FINDING_OUTCOME_BADGE[finding.outcome]}
                size="lg"
                className="font-normal"
              >
                {t(FINDING_OUTCOME_LABEL[finding.outcome])}
              </Badge>
            )}
          </div>
        </div>
        <CollapsibleContent className={TOOL_ROW_PANEL_CLASS}>
          <div className="flex select-text flex-col gap-1 pr-3 pb-2 pl-8">
            <p className="whitespace-pre-wrap break-words text-foreground">{finding.summary}</p>
            {finding.failureScenario && (
              <p
                data-slot="review-finding-scenario"
                className="whitespace-pre-wrap break-words text-small text-muted-foreground"
              >
                <span className="font-semibold">{t('Failure scenario')}</span> ·{' '}
                {finding.failureScenario}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * FB7: the tail of a row that carries its own authorization record — the
 * decision word, then the `auto:` note when the Host answered for the user.
 * One round-trip now reads as ONE line ("Edited x.txt · Denied") instead of a
 * tool row followed by a separate "Denied Write — x.txt".
 *
 * Neither span sets a colour: they inherit the row, so the decision is red on
 * a denied row and grey on an allowed one without this file deciding twice
 * what colour a refusal is. Rows that needed no approval render nothing here,
 * which is what keeps "allowed but failed" (red, no badge) readable next to
 * "denied" (red, badge).
 */
function ToolRowPermission({ view }: { view: ToolRowView }) {
  const { t } = useI18n();
  // Compared against the KEY, not the rendered word — the check has to keep
  // working in a locale where the row reads 「已允许」.
  // PiLab R1 (2026-10-30): a plain 「已允许」 is what the user just clicked —
  // the step's line carries what the call DID, not the approval. A denial, an
  // automatic answer or a session grant still says so.
  if (!view.permissionVerb || view.permissionVerb === 'Allowed') return null;
  return (
    <>
      <span className={cn(toolRowPermissionClass(), failedReasonClass(view))}>
        · {t(view.permissionVerb)}
      </span>
      {view.permissionAutoNote ? (
        <span className={toolRowPermissionNoteClass()}>· {view.permissionAutoNote}</span>
      ) : null}
    </>
  );
}

/**
 * The `.ct-a` cell: plain text, a silent Read-row file link (F①), or a
 * Grep/Glob row's hover hit list (F②). `link` and `hitSource` never both
 * populate the same view (toolCard.ts only sets one or the other).
 */
/**
 * A path-shaped argument, as zcode writes it: the FILE NAME first, the
 * directory behind it and dimmer (decision 034).
 *
 * `chat/ToolRows.tsx` becomes `ToolRows.tsx  chat/`. The reordering is the
 * point, not the dimming: the name is what tells two adjacent edit rows apart,
 * and putting it first means the reader finds it at a fixed left offset
 * instead of at wherever the directory happened to end.
 *
 * Display-only, and deliberately built by splitting the finished `arg` rather
 * than by threading a second field through `deriveToolRowView`: the shortening
 * rule (`shortPath`) already ran, the link's `title` still carries the whole
 * path, and a row whose arg is not a path (a command, a pattern, a duration)
 * must come through untouched — which the `includes('/')` guard is for.
 *
 * ⚠️ Only the leading token is split. An arg like `ToolRows.tsx · 已收到 12 行`
 * keeps its suffix intact, because the suffix is not part of the path and a
 * naive `lastIndexOf('/')` would have swallowed it.
 */
function splitPathArg(arg: string): { name: string; dir: string } | null {
  const [head, ...rest] = arg.split(' ');
  if (!head.includes('/')) return null;
  const cut = head.lastIndexOf('/');
  const name = head.slice(cut + 1);
  if (!name) return null;
  return { name: [name, ...rest].join(' '), dir: `${head.slice(0, cut)}/` };
}

function ArgText({ arg, pattern }: { arg: string; pattern?: boolean }) {
  // P1-7e (problem 18): a search pattern (`**/*`) is shown as written.
  const split = pattern ? null : splitPathArg(arg);
  if (!split) return <>{arg}</>;
  return (
    <>
      {split.name}{' '}
      <span className="text-[color-mix(in_oklab,currentColor_55%,var(--background))]">
        {split.dir}
      </span>
    </>
  );
}

function ToolRowArg({
  view,
  onOpenFile,
}: {
  view: ToolRowView;
  onOpenFile?: (target: FileLinkTarget) => void;
}) {
  if (!view.arg) return null;
  const argClass = toolRowArgClass(view);

  if (view.link) {
    const link = view.link;
    return (
      <button
        type="button"
        title={link.path}
        className={cn(
          argClass,
          'cursor-pointer border-b border-transparent hover:border-current hover:text-foreground'
        )}
        onClick={(event) => {
          // Keep this click from also toggling the row's own expand/collapse
          // trigger (see the `nativeButton={false}` note above).
          event.stopPropagation();
          (onOpenFile ?? ((target: FileLinkTarget) => openFileTarget(target, 'tool-row')))(link);
        }}
      >
        <ArgText arg={view.arg} pattern={view.argPattern} />
      </button>
    );
  }

  if (view.hitSource) {
    return (
      <HitListPopover
        source={view.hitSource}
        onOpenFile={onOpenFile ?? ((target) => openFileTarget(target, 'hit-list'))}
      >
        <span className={argClass}>
          <ArgText arg={view.arg} pattern={view.argPattern} />
        </span>
      </HitListPopover>
    );
  }

  return <span className={argClass}>{view.arg}</span>;
}

/** How close to the bottom still counts as "following the tail", in px. */
const SUBAGENT_FOLLOW_SLACK_PX = 24;

/**
 * P5-2-6 — the delegation panel's own scroll area.
 *
 * Two behaviours the contract asks for, and they pull against each other:
 * a running delegate's panel should follow its newest row, and a user who has
 * scrolled up to read something should be left where they put themselves —
 * while the rows behind them keep arriving.
 *
 * Resolved by only auto-scrolling when the view was ALREADY at the bottom
 * before this render. Scrolling up is therefore a decision that sticks, and
 * scrolling back down re-arms the follow without a control to find.
 *
 * Bounded height is the other half: without it a 40-row panel pushes the rest
 * of the conversation off screen, and "local scroll" becomes page scroll. This
 * is the only `body: 'detail'` producer in the app — the subagent panel — so
 * the bound belongs to it rather than to a generic row.
 */
function SubagentDetail({ children, nested = false }: { children: ReactNode; nested?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  });

  return (
    <div
      ref={ref}
      data-slot="subagent-detail"
      className={cn(
        'mt-1 flex max-h-72 flex-col gap-1 overflow-y-auto overscroll-contain',
        // A merged step's calls (`turnSteps.ts`) read as ITS detail, not as siblings.
        nested && 'ml-0.5 border-l border-border-soft pl-3.5'
      )}
      onScroll={(event) => {
        const node = event.currentTarget;
        following.current =
          node.scrollHeight - node.scrollTop - node.clientHeight <= SUBAGENT_FOLLOW_SLACK_PX;
      }}
    >
      {children}
    </div>
  );
}

/**
 * Expand body: an optional input segment (`.fx-in`, T-05 adversarial fix #3)
 * always renders above whatever `body` produces — `.fx-body`/`.fx-out` for
 * tool output, `.ct-sub` for aggregate detail, `.ct-think` for thought/stats
 * text.
 */
function ToolRowBody({
  view,
  onOpenFile,
  sessionId,
}: {
  view: ToolRowView;
  onOpenFile?: (target: FileLinkTarget) => void;
  sessionId?: string;
}) {
  const showDiff = useContext(ToolDiffVisibility);
  // Round-10 inspection ⑤ (user ruling): when a row expands into BOTH an
  // input segment and an output body, they share ONE scroll container — the
  // previous two independent scroll windows (T-05 adversarial fix #3's 240px
  // input tier stacked above the output tier) put two inner scrollbars inside
  // one expanded row, which read as separate modules (worst on Delegated
  // rows: prompt JSON scrolling apart from the report). Input-only and
  // output-only rows keep their original single-window shapes.
  if (view.input && view.body === 'output') {
    return <ToolOutputBody view={view} />;
  }
  return (
    <>
      {showDiff && view.diff && (
        <ToolRowDiffSegment
          diff={view.diff}
          failed={view.failed}
          previewOnly={view.running || Boolean(view.outcome)}
        />
      )}
      {view.input && (
        <ToolRowInputSegment input={view.input} maxHeightClass={view.inputMaxHeightClass} />
      )}
      {/* dsh-rebase P1-7b: a running command's live tail (`tool.output`),
          only while it runs; the settled output below replaces it. */}
      {view.running && view.toolCallId && <LiveToolOutput toolCallId={view.toolCallId} />}
      <ToolRowOutputSegment view={view} onOpenFile={onOpenFile} sessionId={sessionId} />
    </>
  );
}

/** Lines in a tool output, a trailing newline not counting as one more. */
export function toolOutputLineCount(output: string): number {
  const text = output.replace(/\n+$/, '');
  return text === '' ? 0 : text.split('\n').length;
}

/**
 * A settled call's output (PiLab R2, FR-05.3; user, 2026-11-02, preview
 * `docs/design/2026-11-02-tool-output-copy-view-preview.html`). The body keeps
 * its height cap; a copy button — shown while the pointer is over the output,
 * or a key focuses it — copies all of it, not the part in view. Once the
 * output is taller than the cap, a line under it gives the line count and
 * 「查看全部」, which opens the whole of it in a dialog. Only settled calls reach this
 * body (`showOutputBody` excludes running ones), so nothing is copied half-way.
 * When the engine kept only the end, the copy is what there is, and the
 * button's name and the dialog say the start is missing.
 */
function ToolOutputBody({ view }: { view: ToolRowView }) {
  const { t } = useI18n();
  const output = view.output ?? '';
  // The element that scrolls: the output's own <pre>, or — when the row shows
  // its input too (round-10 inspection ⑤) — the one window both share.
  const scrollRef = useRef<HTMLElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [viewing, setViewing] = useState(false);
  const viewAllRef = useRef<HTMLButtonElement | null>(null);
  // Measured after layout and again on resize: the cap is a viewport fraction.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the text changes
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const measure = () => setOverflowing(box.scrollHeight > box.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [output]);
  const count = toolOutputLineCount(output);
  const copyLabel = view.outputHeadOmitted
    ? t('Copy all output (start omitted)')
    : t('Copy all output');
  return (
    <div className="group/output relative ml-0.5 border-l border-border-soft pl-3.5">
      {view.input ? (
        <div
          ref={(node) => {
            scrollRef.current = node;
          }}
          className={cn('overflow-auto overscroll-contain', 'pr-8', view.outputMaxHeightClass)}
        >
          <pre className="m-0 select-text whitespace-pre-wrap pt-1 font-mono text-code leading-[1.55] text-muted-foreground">
            {view.input}
          </pre>
          {/* P1-7e (problem 21): when the output lost its start, the rule
            between input and output sits above the note that says so. */}
          <OutputHeadNote
            omitted={view.outputHeadOmitted}
            className="mt-1 border-t border-border-soft pt-2"
          />
          <pre
            className={cn(
              'm-0 select-text whitespace-pre-wrap pb-2 font-mono text-code leading-[1.55] text-muted-foreground',
              view.outputHeadOmitted ? 'pt-1' : 'mt-1 border-t border-border-soft pt-2'
            )}
          >
            {view.output}
          </pre>
        </div>
      ) : (
        <>
          <OutputHeadNote omitted={view.outputHeadOmitted} className="pt-1" />
          <pre
            ref={(node) => {
              scrollRef.current = node;
            }}
            className={cn(
              'm-0 select-text overflow-auto overscroll-contain whitespace-pre-wrap pt-1 pb-2 font-mono text-code leading-[1.55] text-muted-foreground',
              // Room for the copy button, which sits over the top-right corner.
              'pr-8',
              view.outputMaxHeightClass
            )}
          >
            {output}
          </pre>
        </>
      )}
      <div
        data-slot="tool-output-copy"
        className="absolute top-0.5 right-0 rounded-sm bg-background opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/output:opacity-100"
      >
        <CopyIconButton text={output} label={copyLabel} copiedLabel={t('Copied')} />
      </div>
      {/* User, 2026-11-02: only under an output taller than its box — a short
          one shows all its lines, and the row head already counts them. */}
      {overflowing && count > 0 && (
        <div className="flex items-center gap-2 pb-1.5 text-small text-foreground-faint tabular-nums">
          <span>{t('{{count}} lines', { count })}</span>
          <button
            ref={viewAllRef}
            type="button"
            className="rounded-xs text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground focus-ring"
            onClick={() => setViewing(true)}
          >
            {t('View all')}
          </button>
        </div>
      )}
      {viewing && (
        <ToolOutputDialog
          view={view}
          output={output}
          copyLabel={copyLabel}
          returnFocus={viewAllRef}
          onClose={() => setViewing(false)}
        />
      )}
    </div>
  );
}

/** 「查看全部」: the whole output, numbered, in its own scroll. */
function ToolOutputDialog({
  view,
  output,
  copyLabel,
  returnFocus,
  onClose,
}: {
  view: ToolRowView;
  output: string;
  copyLabel: string;
  /** Where focus goes back to on close: the 「查看全部」 that opened it. */
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const lines = useMemo(() => output.replace(/\n+$/, '').split('\n'), [output]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-4xl" finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-16">
            <span className="shrink-0">{view.title ?? t(view.verb)}</span>
            {view.title === undefined && view.arg && (
              <Ident className="min-w-0 truncate font-normal text-muted-foreground">
                {view.arg}
              </Ident>
            )}
          </DialogTitle>
          <DialogDescription className="tabular-nums">
            {t('{{count}} lines', { count: lines.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="absolute end-11 top-3.5">
          <CopyIconButton text={output} label={copyLabel} copiedLabel={t('Copied')} />
        </div>
        {/* As in SubagentConversationDialog: `DialogPanel` cannot cap its height. */}
        <ScrollArea className="max-h-[70vh] px-6 pb-6">
          <OutputHeadNote omitted={view.outputHeadOmitted} className="pb-1.5" />
          <div data-slot="tool-output-all" className="font-mono text-code leading-[1.6]">
            {lines.map((line, index) => (
              // Positional: two identical lines are ordinary output.
              // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity
              <div key={index} className="flex">
                <span className="w-12 shrink-0 select-none pr-3 text-right text-foreground-faint tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-all pr-3 text-foreground">
                  {line}
                </span>
              </div>
            ))}
          </div>
        </ScrollArea>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * dsh-rebase P1-7e (problem 21, decision 140): the line above an output that
 * lost its start — 「已省略前 x KB」 when the bytes are known (the jobs window's
 * and the live pane's wording), 「已省略前面的输出」 when DSH's record does not
 * say how much it dropped.
 */
function OutputHeadNote({
  omitted,
  className,
}: {
  omitted: ToolRowView['outputHeadOmitted'];
  className?: string;
}) {
  const { t } = useI18n();
  if (!omitted) return null;
  return (
    <p
      className={cn('text-small text-muted-foreground tabular-nums', className)}
      data-testid="tool-output-head-omitted"
    >
      {omitted.bytes
        ? t('Earlier {{size}} not shown', { size: kilobytesLabel(omitted.bytes) })
        : t('Earlier output not shown')}
    </p>
  );
}

/**
 * T12-b slice 2: the file change an `edit`/`write` call describes, rendered as
 * a diff instead of as the raw `oldText`/`newText` JSON that used to sit here.
 *
 * Colours come from the semantic `--success` / `--destructive` tokens, not a
 * raw green/red palette: `StatusLine.tsx` already spells `+N` / `-N` that way,
 * and the reference implementation's `text-green-600 dark:text-green-400`
 * would have been both a second vocabulary for the same idea and a violation
 * of the design system's "no raw palette" rule.
 *
 * Design system v2 §7.5: one closed frame (`lg` radius, the card surface, the
 * soft edge) with a 32px head -- what the preview is, then the counts -- over
 * a hairline; added and removed lines at a 12% wash of their colour.
 */
function ToolRowDiffSegment({
  diff,
  failed,
  previewOnly,
}: {
  diff: ToolDiff;
  failed: boolean;
  /**
   * Still running, or never applied (refused, not started, stopped, unknown):
   * the diff is only what the arguments ask for. Such a call is not `failed`,
   * and used to fall through to 「修改成功」 (PiLab R2, DEF-030). Same word as
   * the row's own label.
   */
  previewOnly: boolean;
}) {
  const { t } = useI18n();
  // Issue #26 item 2: which folded runs the reader opened. Opening one grows
  // the page, so it is reported like any other disclosure (C3).
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
  const markUserToggle = useUserDisclosureReport(openFolds.size > 0);
  const items = useMemo(() => buildDiffView(diff.rows, openFolds), [diff.rows, openFolds]);
  const numbered = diffHasLineNumbers(diff.rows);
  // PiLab R2 (FR-07.3): the shared 「上下 / 并排」 choice, unified while too narrow.
  const layout = useDiffLayoutStore((state) => state.layout);
  const [frameRef, frameWidth] = useElementWidth<HTMLDivElement>();
  const shownLayout = effectiveDiffLayout(layout, frameWidth);
  const openFold = (key: string) => {
    markUserToggle();
    setOpenFolds((previous) => new Set(previous).add(key));
  };
  return (
    <div
      ref={frameRef}
      className="mt-1 overflow-hidden rounded-lg border border-border-soft bg-surface-2"
    >
      <div className="flex h-8 items-center gap-2 border-b border-border-soft px-3 text-small text-muted-foreground tabular-nums">
        <span className="min-w-0 truncate">
          {t(
            previewOnly
              ? 'Modification preview'
              : failed
                ? 'Failed — preview only; application unconfirmed'
                : diff.source === 'write-content'
                  ? 'Written content — previous content unavailable'
                  : diff.source === 'sdk'
                    ? 'Applied diff'
                    : 'Successful edit — argument preview'
          )}
        </span>
        <span className="text-success">+{diff.added}</span>
        <span className="text-destructive">-{diff.removed}</span>
        <span className="ml-auto">
          <DiffLayoutToggle narrow={diffTooNarrowToSplit(frameWidth)} />
        </span>
      </div>
      <div className="max-h-72 overflow-auto overscroll-contain py-1 font-mono text-code leading-[1.55]">
        {shownLayout === 'split' ? (
          <SplitDiffBody
            items={splitDiffItems(items)}
            numbered={numbered}
            onOpenFold={openFold}
            insetClass="px-3"
          />
        ) : (
          items.map((item) => {
            if (item.kind === 'fold') {
              return (
                // Issue #26 item 2: an unchanged run, folded; a click opens it in place.
                <button
                  key={item.key}
                  type="button"
                  data-slot="diff-fold"
                  className="flex w-full items-center gap-2 px-3 py-0.5 text-left font-sans text-small text-muted-foreground transition-colors duration-150 hover:bg-fill-ghost-hover hover:text-foreground focus-ring"
                  onClick={() => openFold(item.key)}
                >
                  <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
                  {t('{{count}} unchanged lines', { count: item.count })}
                </button>
              );
            }
            if (item.kind === 'gap') {
              return (
                <div
                  key={item.key}
                  data-slot="diff-gap"
                  className="select-none px-3 text-foreground-faint"
                  aria-hidden
                >
                  ⋯
                </div>
              );
            }
            const { row } = item;
            return (
              <div
                // Rows are positional and can repeat verbatim (two identical blank
                // lines are ordinary), so the position IS the identity here.
                key={item.key}
                className={cn(
                  'flex',
                  row.kind === 'add' && 'bg-success/12',
                  row.kind === 'del' && 'bg-destructive/12'
                )}
              >
                {numbered && (
                  <>
                    <span data-slot="diff-old-line" className={DIFF_LINE_NUMBER_CLASS}>
                      {row.oldLine ?? ''}
                    </span>
                    <span data-slot="diff-new-line" className={DIFF_LINE_NUMBER_CLASS}>
                      {row.newLine ?? ''}
                    </span>
                  </>
                )}
                <span
                  className={cn(
                    'w-6 shrink-0 select-none text-center',
                    row.kind === 'add' && 'text-success',
                    row.kind === 'del' && 'text-destructive',
                    row.kind === 'same' && 'text-muted-foreground/40'
                  )}
                >
                  {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 select-text whitespace-pre-wrap break-all pr-3 pl-1',
                    row.kind === 'same' ? 'text-muted-foreground/70' : 'text-foreground'
                  )}
                >
                  {row.text}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** A diff gutter cell: the old or new line number, tabular and faint, never selected. */
const DIFF_LINE_NUMBER_CLASS =
  'w-10 shrink-0 select-none pr-2 text-right tabular-nums text-foreground-faint';

/** Structured-input scroll window — always 240px, rendered above the output segment. */
function ToolRowInputSegment({
  input,
  maxHeightClass,
}: {
  input: string;
  maxHeightClass?: string;
}) {
  return (
    <div className="ml-0.5 border-l border-border-soft pl-3.5">
      <pre
        className={cn(
          'm-0 select-text overflow-auto overscroll-contain whitespace-pre-wrap pt-1 pb-2 font-mono text-code leading-[1.55] text-muted-foreground',
          maxHeightClass
        )}
      >
        {input}
      </pre>
    </div>
  );
}

function ToolRowOutputSegment({
  view,
  onOpenFile,
  sessionId,
}: {
  view: ToolRowView;
  onOpenFile?: (target: FileLinkTarget) => void;
  sessionId?: string;
}) {
  switch (view.body) {
    case 'output':
      return <ToolOutputBody view={view} />;
    case 'detail':
      return (
        <SubagentDetail nested={isMergedStep(view)}>
          {(view.detail ?? []).map((row) => (
            <ToolRow
              key={row.key}
              view={row}
              depth={0}
              onOpenFile={onOpenFile}
              sessionId={sessionId}
            />
          ))}
        </SubagentDetail>
      );
    case 'thinking':
      return <ThinkingBody text={view.output ?? ''} />;
    case 'todos':
      // dsh-rebase P1-7c (decision 118's handoff): the list a `todo_write`
      // set, drawn by the todo card's own component.
      return (
        <div className="ml-0.5 border-l border-border-soft pl-3.5">
          <TodoList items={view.todos ?? []} className="pt-1 pb-2" />
        </div>
      );
    case 'stats':
      return (
        <div className="mt-1 flex select-text flex-col gap-1.5 text-chat-process leading-[1.55] text-foreground-faint">
          <p className={cn('whitespace-pre-wrap', thoughtBodyMaxHeightClass())}>{view.output}</p>
        </div>
      );
    default:
      return null;
  }
}

/**
 * The timeline's disclosure hook (`preserveDisclosurePosition`), called after
 * layout by every row that opens or closes, with the direction: opening pauses
 * the timeline's bottom-following (`followAfterDisclosure`), closing does not.
 * The name predates tool rows joining the thoughts in using it.
 */
export const ThinkingFollowContext = createContext<((opened: boolean) => void) | null>(null);

/**
 * Report a USER toggle to the timeline, after the commit that resized it.
 *
 * Returns the function the click handler calls before it changes `open`. The
 * deps-less layout effect (the retired `ThinkingPreview`'s pattern) consumes
 * that mark on the next commit — the first one with the panel at its final
 * height, which is the height the timeline has to record — and reports only if
 * `open` really moved. A disclosure that opens or folds WITHOUT a click (a
 * turn settling, a pending authorization forcing its group open) is not the
 * reader's choice and is never reported, so it cannot pause following.
 */
export function useUserDisclosureReport(open: boolean): () => void {
  const report = useContext(ThinkingFollowContext);
  const toggledFrom = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const from = toggledFrom.current;
    if (from === null) return;
    toggledFrom.current = null;
    if (from !== open) report?.(open);
  });
  return () => {
    toggledFrom.current = open;
  };
}

/**
 * The timeline's one-second clock (`useSecondsTick`), for running rows only.
 *
 * A context rather than a prop so the tick reaches the one leaf that prints it
 * (`RunningToolClock`) without passing through `deriveToolGroupRows` — a prop
 * would re-derive every row of every group in the running turn once a second,
 * which is the whole-turn scan review batch F7 split `ToolGroupItem` out to
 * remove. `null` outside the timeline (e.g. `QuestionCard`'s lone row): no
 * clock, no readout.
 */
export const ToolRowClockContext = createContext<number | null>(null);

/** The two timeline-scoped row contexts, provided together by `MessageTimeline`. */
export function ToolRowTimelineContext({
  follow,
  nowMs,
  children,
}: {
  follow: (opened: boolean) => void;
  nowMs: number;
  children: ReactNode;
}) {
  return (
    <ThinkingFollowContext value={follow}>
      <ToolRowClockContext value={nowMs}>{children}</ToolRowClockContext>
    </ThinkingFollowContext>
  );
}

function RunningToolClock({ startedAtMs, timeoutMs }: { startedAtMs: number; timeoutMs?: number }) {
  const { t } = useI18n();
  const nowMs = useContext(ToolRowClockContext);
  const elapsedMs = runningElapsedMs(startedAtMs, nowMs);
  if (elapsedMs === undefined) return null;
  return (
    <span data-slot="tool-row-clock" className="shrink-0 tabular-nums">
      · {formatWorkedForDuration(elapsedMs)}
      {/* dsh-rebase P1-7c (plan P1-7 shard 04 §4): DSH does not kill a
          command at its timeout, it moves it to the background, so the limit
          reads as when that happens (「12s · 2m 后转后台」), not as "/ 2m". */}
      {typeof timeoutMs === 'number' &&
        ` · ${t('to background at {{limit}}', { limit: formatWorkedForDuration(timeoutMs) })}`}
    </span>
  );
}

/**
 * A thought's expanded body (2026-09-23): the full text, nothing trimmed, no
 * preview tier. Only the display cleanup of the retired `ThinkingPreview`
 * survives — blank lines are dropped so a stream of `\n\n` separators between
 * paragraphs does not open gaps — and the page-level full-text flow (decision
 * 038) is kept: no inner height limit.
 */
export function ThinkingBody({ text }: { text: string }) {
  const { t } = useI18n();
  const displayText = text
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim().length > 0)
    .join('\n');
  // Issue #26 item 8: a copy button once the thought is open (it only renders
  // open); the thought itself is never forced open for it.
  return (
    <div className="mt-1 flex items-start gap-1">
      <p
        data-slot="thinking-text"
        className="min-w-0 flex-1 select-text whitespace-pre-wrap text-chat-process leading-[1.55] text-foreground-faint"
      >
        {displayText}
      </p>
      <CopyIconButton text={text} label={t('Copy thinking')} copiedLabel={t('Copied')} />
    </div>
  );
}
