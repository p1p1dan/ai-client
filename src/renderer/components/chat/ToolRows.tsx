import {
  Braces,
  FileText,
  Globe,
  ListTree,
  PencilLine,
  Search,
  SquareTerminal,
  Users,
  Wrench,
} from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { type FileOpenIntent, useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import {
  readToolExpandMemory,
  resolveToolRowOpen,
  useToolExpansionStore,
} from '@/stores/toolExpansion';
import { thoughtBodyMaxHeightClass, turnProcessToneClass } from './chatTimelineLayout';
import { HitListPopover } from './HitListPopover';
import { deriveSubagentPanelRows } from './subagentActivityModel';
import {
  type FileLinkTarget,
  isDelegationTool,
  runningElapsedMs,
  TOOL_RUN_OUTCOME_LABEL,
  type ToolRowView,
  toolRowArgClass,
  toolRowPermissionClass,
  toolRowPermissionNoteClass,
} from './toolCard';
import type { ToolDiff } from './toolDiff';
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
 * `size-[13px]` matches the row's own `--text-chat-process` tier, and the icons
 * inherit `currentColor` so they dim with the row instead of needing a second
 * colour decision.
 */
const ROW_ICONS: Record<string, typeof Wrench> = {
  terminal: SquareTerminal,
  edit: PencilLine,
  read: FileText,
  search: Search,
  list: ListTree,
  web: Globe,
  delegate: Users,
  plan: ListTree,
  thinking: Braces,
  tool: Wrench,
};

function ToolRowIcon({ kind }: { kind?: string }) {
  const Icon = ROW_ICONS[kind ?? 'tool'] ?? Wrench;
  return <Icon className="size-[13px] shrink-0 self-center opacity-80" aria-hidden />;
}

/** One `.ct-row`: verb + arg, optionally expandable into an output/detail/thinking body. */
export function ToolRow(props: ToolRowProps) {
  const { view } = props;
  if (view.toolName && isDelegationTool(view.toolName) && view.toolCallId) {
    return (
      <SubagentActivity
        {...props}
        parentToolCallId={view.toolCallId}
        parentRunning={view.running}
      />
    );
  }
  return <ToolRowContent {...props} />;
}

function ToolRowContent({ view, onOpenFile, sessionId }: ToolRowProps) {
  const showDiff = useContext(ToolDiffVisibility);
  const { t } = useI18n();
  // The dim rung of the 2026-09-18 reading ladder (see
  // `chatTimelineLayout.ts`). It used to be `text-muted-foreground`, which is
  // the same tier the work-group head above these rows now uses — so the head
  // and the rows it summarises were indistinguishable, and the "importance is
  // brightness" rule the user asked for had only two steps instead of three.
  // The row ARG has been on this token since T-05; this aligns the verb with
  // it, which is also what the reference client does.
  //
  // T104: the whole row moved from `text-markdown` to `text-chat-process`.
  // Tool rows used to share the body tier with the prose they interrupt, which
  // is exactly the "process is not distinguishable from content" complaint
  // (the head/arg tier split above only separated them by brightness). This
  // token is runtime-configurable, so the row follows the reader's process
  // size setting.
  const rowClass = cn(
    'group/row flex w-full items-baseline gap-1.5 text-left text-chat-process leading-normal',
    view.failed ? 'text-destructive' : turnProcessToneClass()
  );
  const verbClass = cn('shrink-0', !view.failed && 'group-hover/row:text-foreground');

  const rowContent = (
    <>
      {/* Decision 034: the aggregate row is gone, so every row words itself
          from its own closed-vocabulary verb — there is no count branch left. */}
      <ToolRowIcon kind={view.iconKind} />
      <span className={verbClass}>{t(view.verb)}</span>
      <ToolRowArg view={view} onOpenFile={onOpenFile} />
      <ToolRowPermission view={view} />
      {/* N5: a call that never did its work says so in words — 「已拒绝」 for a
          runtime refusal, 「未执行」 for one the run ended before. Same slot and
          class as the permission word, since both say how the call ended. */}
      {view.outcome && (
        <span data-slot="tool-row-outcome" className={toolRowPermissionClass()}>
          · {t(TOOL_RUN_OUTCOME_LABEL[view.outcome])}
        </span>
      )}
      {/* 2026-09-23 (user report: a 1800s command gave no sign of progress):
          the live clock on a running row — elapsed since `tool.started`, and
          the deadline the runtime will enforce when the input named one.
          "12s / 30m" reads without a label because the row's own verb already
          says Running. A leaf of its own so the per-second tick re-renders
          this span and nothing above it.
          T146 — once `execStartedAtMs` is known (bash, past approval and path
          checks), both numbers switch to that origin instead, and the limit
          is withheld until then — see `deriveToolRowView`. */}
      {view.running && typeof view.runningStartedAtMs === 'number' && (
        <RunningToolClock startedAtMs={view.runningStartedAtMs} timeoutMs={view.runningTimeoutMs} />
      )}
      {showDiff && view.diff && (
        <span className="shrink-0 text-meta tabular-nums">
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
  const row = !view.expandable ? (
    <div className={rowClass}>{rowContent}</div>
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
    >
      {rowContent}
    </ToolRowCollapsible>
  );

  return row;
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
  children,
}: {
  view: ToolRowView;
  rowClass: string;
  onOpenFile?: (target: FileLinkTarget) => void;
  sessionId?: string;
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
  const merged = panel
    ? {
        ...view,
        arg: [lane?.agentType, view.arg ?? lane?.description].filter(Boolean).join(' '),
        argKind: 'prose' as const,
        running: lane?.status === 'running' || (lane?.status === null && parentRunning),
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
  if (!view.permissionVerb || (view.permissionAutoNote && view.permissionVerb === 'Allowed'))
    return null;
  return (
    <>
      <span className={toolRowPermissionClass()}>· {t(view.permissionVerb)}</span>
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

function ArgText({ arg }: { arg: string }) {
  const split = splitPathArg(arg);
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
          'cursor-pointer border-b border-transparent hover:border-primary hover:text-primary'
        )}
        onClick={(event) => {
          // Keep this click from also toggling the row's own expand/collapse
          // trigger (see the `nativeButton={false}` note above).
          event.stopPropagation();
          (onOpenFile ?? ((target: FileLinkTarget) => openFileTarget(target, 'tool-row')))(link);
        }}
      >
        <ArgText arg={view.arg} />
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
          <ArgText arg={view.arg} />
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
function SubagentDetail({ children }: { children: ReactNode }) {
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
      className="mt-1 flex max-h-72 flex-col gap-1 overflow-y-auto"
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
    return (
      <div className="ml-0.5 border-l border-border pl-3.5">
        <div className={cn('overflow-auto', view.outputMaxHeightClass)}>
          <pre className="m-0 select-text whitespace-pre-wrap pt-1 font-mono text-code leading-[1.55] text-muted-foreground">
            {view.input}
          </pre>
          <pre className="m-0 mt-1 select-text whitespace-pre-wrap border-t border-border pt-2 pb-2 font-mono text-code leading-[1.55] text-muted-foreground">
            {view.output}
          </pre>
        </div>
      </div>
    );
  }
  return (
    <>
      {showDiff && view.diff && (
        <ToolRowDiffSegment diff={view.diff} failed={view.failed} running={view.running} />
      )}
      {view.input && (
        <ToolRowInputSegment input={view.input} maxHeightClass={view.inputMaxHeightClass} />
      )}
      <ToolRowOutputSegment view={view} onOpenFile={onOpenFile} sessionId={sessionId} />
    </>
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
 */
function ToolRowDiffSegment({
  diff,
  failed,
  running,
}: {
  diff: ToolDiff;
  failed: boolean;
  running: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="ml-0.5 border-l border-border pl-3.5">
      <div className="flex items-center gap-2 pt-1 pb-1 text-meta tabular-nums">
        <span>
          {t(
            running
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
      </div>
      <div className="max-h-72 overflow-auto pb-2 font-mono text-code leading-[1.55]">
        {diff.rows.map((row, index) => (
          <div
            // Rows are positional and can repeat verbatim (two identical blank
            // lines are ordinary), so the index IS the identity here.
            key={`${index}-${row.kind}`}
            className={cn(
              'flex',
              row.kind === 'add' && 'bg-success/10',
              row.kind === 'del' && 'bg-destructive/10'
            )}
          >
            <span
              className={cn(
                'w-4 shrink-0 select-none text-center',
                row.kind === 'add' && 'text-success',
                row.kind === 'del' && 'text-destructive',
                row.kind === 'same' && 'text-muted-foreground/40'
              )}
            >
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 select-text whitespace-pre-wrap break-all px-1',
                row.kind === 'same' ? 'text-muted-foreground/70' : 'text-foreground'
              )}
            >
              {row.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Structured-input scroll window — always 240px, rendered above the output segment. */
function ToolRowInputSegment({
  input,
  maxHeightClass,
}: {
  input: string;
  maxHeightClass?: string;
}) {
  return (
    <div className="ml-0.5 border-l border-border pl-3.5">
      <pre
        className={cn(
          'm-0 select-text overflow-auto whitespace-pre-wrap pt-1 pb-2 font-mono text-code leading-[1.55] text-muted-foreground',
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
      return (
        <div className="ml-0.5 border-l border-border pl-3.5">
          <pre
            className={cn(
              'm-0 select-text overflow-auto whitespace-pre-wrap pt-1 pb-2 font-mono text-code leading-[1.55] text-muted-foreground',
              view.outputMaxHeightClass
            )}
          >
            {view.output}
          </pre>
        </div>
      );
    case 'detail':
      return (
        <SubagentDetail>
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
    case 'stats':
      return (
        <div className="mt-1 flex select-text flex-col gap-1.5 text-chat-process leading-[1.55] text-tool-arg">
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
  const nowMs = useContext(ToolRowClockContext);
  const elapsedMs = runningElapsedMs(startedAtMs, nowMs);
  if (elapsedMs === undefined) return null;
  return (
    <span data-slot="tool-row-clock" className="shrink-0 text-meta tabular-nums">
      · {formatWorkedForDuration(elapsedMs)}
      {typeof timeoutMs === 'number' && ` / ${formatWorkedForDuration(timeoutMs)}`}
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
function ThinkingBody({ text }: { text: string }) {
  const displayText = text
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim().length > 0)
    .join('\n');
  return (
    <p
      data-slot="thinking-text"
      className="mt-1 select-text whitespace-pre-wrap text-chat-process leading-[1.55] text-tool-arg"
    >
      {displayText}
    </p>
  );
}
