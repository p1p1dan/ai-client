import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { type FileOpenIntent, useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import {
  readToolExpandMemory,
  resolveToolRowOpen,
  useToolExpansionStore,
} from '@/stores/toolExpansion';
import { HitListPopover } from './HitListPopover';
import { deriveSubagentPanelRows } from './subagentActivityModel';
import {
  type FileLinkTarget,
  isDelegationTool,
  type ToolRowView,
  toolRowArgClass,
  toolRowPermissionClass,
  toolRowPermissionNoteClass,
} from './toolCard';
import type { ToolDiff } from './toolDiff';

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

interface ToolGroupProps {
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
export function ToolGroup({ rows, onOpenFile, sessionId }: ToolGroupProps) {
  if (rows.length === 0) return null;
  return (
    // T-30 P-17: no own margin — the parent `AssistantMessage` article owns
    // the 10px item-to-item gap via `gap-2.5`; a margin here would stack on
    // top of it (and on ReadingColumn's turn-to-turn space-y-5) instead of
    // replacing it.
    <div className="flex flex-col gap-1">
      {rows.map((row) => (
        <ToolRow key={row.key} view={row} depth={0} onOpenFile={onOpenFile} sessionId={sessionId} />
      ))}
    </div>
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

/** One `.ct-row`: verb + arg, optionally expandable into an output/detail/thinking body. */
export function ToolRow({ view, onOpenFile, sessionId }: ToolRowProps) {
  // T12-d: the row's opening state, seeded ONCE from the session's memory.
  //
  // Seeded rather than controlled, deliberately. `defaultOpen` is read by the
  // collapsible at mount only, and that is what preserves T-34's live subagent
  // panel: its `defaultOpen: true` disappears the moment the lane stops being
  // live, and a controlled `open` bound to the same expression would slam the
  // panel shut under a reader mid-sentence. Seeding also makes the aggregation
  // case work for free — an aggregate that swallows an open row is a NEW
  // mount, so it evaluates `resolveToolRowOpen` against fresh memory.
  const [initialOpen] = useState(() => resolveToolRowOpen(view, readToolExpandMemory(sessionId)));
  const setToolRowExpanded = useToolExpansionStore((state) => state.setToolRowExpanded);
  const rowClass = cn(
    'group/row flex w-full items-baseline gap-1.5 text-left text-markdown leading-normal',
    view.failed ? 'text-destructive' : 'text-muted-foreground'
  );
  const verbClass = cn('shrink-0', !view.failed && 'group-hover/row:text-foreground');

  const rowContent = (
    <>
      <span className={verbClass}>{view.verb}</span>
      <ToolRowArg view={view} onOpenFile={onOpenFile} />
      <ToolRowPermission view={view} />
    </>
  );

  // T-34: a delegation row carries its live subagent panel directly below
  // itself (the arbitration's mount point — attached to ITS row, not the
  // group). Only the panel component subscribes to the adjacent store, so a
  // task_progress heartbeat re-renders this one small subtree and nothing
  // above it. Non-delegation rows return the exact pre-T-34 tree.
  const subagentSlot =
    view.toolName && isDelegationTool(view.toolName) && view.toolCallId ? (
      <SubagentActivity
        parentToolCallId={view.toolCallId}
        parentRunning={view.running}
        sessionId={sessionId}
      />
    ) : null;

  const row = !view.expandable ? (
    <div className={rowClass}>{rowContent}</div>
  ) : (
    // 2026-08-25 (user decision): rows open only when something explicitly asks
    // them to. Failures used to auto-expand (sign-off ②) — with the turn-level
    // collapse gone, that put a wall of output on screen for every failed or
    // denied call, in restored history and live turns alike. Red on the row and
    // a click is enough. `defaultOpen` is still honoured: T-34's LIVE subagent
    // panel sets it, and T12-d's remembered choice outranks it.
    <Collapsible
      defaultOpen={initialOpen}
      onOpenChange={(open) => {
        if (sessionId) setToolRowExpanded(sessionId, view.key, open);
      }}
    >
      <CollapsibleTrigger
        className={cn(rowClass, '[&[data-panel-open]>svg]:rotate-180')}
        // A Read row nests a real <button> inside the trigger for its
        // clickable file name (F①) — a native <button> can't contain one,
        // so those rows render the trigger as a <div role="button"> instead
        // (Base UI's documented escape hatch for a non-button render target).
        nativeButton={!view.link}
        render={view.link ? <div /> : undefined}
      >
        {rowContent}
        <ChevronDown className="size-[13px] shrink-0 self-center text-tool-arg transition-transform duration-150" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ToolRowBody view={view} onOpenFile={onOpenFile} sessionId={sessionId} />
      </CollapsibleContent>
    </Collapsible>
  );

  if (!subagentSlot) return row;
  return (
    <div className="flex flex-col gap-1">
      {row}
      {subagentSlot}
    </div>
  );
}

/**
 * T-34: the delegation row's live subagent panel — the ONLY subscriber to the
 * subagent-activity store. Defined here rather than its own module because it
 * renders through `ToolGroup` (a separate file would form an import cycle).
 * Renders nothing while the lane is absent or content-free — a delegation row
 * without live data stays byte-identical to pre-T-34.
 */
function SubagentActivity({
  parentToolCallId,
  parentRunning,
  sessionId,
}: {
  parentToolCallId: string;
  parentRunning: boolean;
  sessionId?: string;
}) {
  const lane = useSubagentActivityStore((s) => s.lanes[parentToolCallId] ?? null);
  const rows = useMemo(
    () => deriveSubagentPanelRows(lane, { parentRunning }),
    [lane, parentRunning]
  );
  if (rows.length === 0) return null;
  return (
    <div className="ml-0.5 border-l border-border pl-3.5">
      <ToolGroup rows={rows} sessionId={sessionId} />
    </div>
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
  if (!view.permissionVerb) return null;
  return (
    <>
      <span className={toolRowPermissionClass()}>· {view.permissionVerb}</span>
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
        {view.arg}
      </button>
    );
  }

  if (view.hitSource) {
    return (
      <HitListPopover
        source={view.hitSource}
        onOpenFile={onOpenFile ?? ((target) => openFileTarget(target, 'hit-list'))}
      >
        <span className={argClass}>{view.arg}</span>
      </HitListPopover>
    );
  }

  return <span className={argClass}>{view.arg}</span>;
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
      {view.diff && <ToolRowDiffSegment diff={view.diff} />}
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
function ToolRowDiffSegment({ diff }: { diff: ToolDiff }) {
  return (
    <div className="ml-0.5 border-l border-border pl-3.5">
      <div className="flex items-center gap-2 pt-1 pb-1 text-meta tabular-nums">
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
        <div className="mt-1 flex flex-col gap-1">
          {(view.detail ?? []).map((row) => (
            <ToolRow
              key={row.key}
              view={row}
              depth={0}
              onOpenFile={onOpenFile}
              sessionId={sessionId}
            />
          ))}
        </div>
      );
    case 'thinking':
    case 'stats':
      return (
        <div className="mt-1 flex select-text flex-col gap-1.5 text-markdown leading-[1.55] text-tool-arg">
          <p className="whitespace-pre-wrap">{view.output}</p>
        </div>
      );
    default:
      return null;
  }
}
