import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { type FileOpenIntent, useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { HitListPopover } from './HitListPopover';
import type { FileLinkTarget, ToolRowView } from './toolCard';

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
 * Default click path (T-05 §2.6, A07 F①/F②): record the navigation intent,
 * then open the (still-placeholder) editor surface — an honest empty state
 * until T-13 lands. `onOpenFile` lets a caller override this; nothing does
 * today (MessageTimeline stays untouched in batch 4 per the file-conflict
 * table), so production rows always take this branch.
 */
function openFileTarget(target: FileLinkTarget, source: FileOpenIntent['source']) {
  useFileOpenIntentStore.getState().requestFileOpen({ ...target, source });
  useShellLayoutStore.getState().openSurface('editor');
}

interface ToolGroupProps {
  rows: ToolRowView[];
  onOpenFile?: (target: FileLinkTarget) => void;
}

/** Renders one `.ct` group — the A07 unit that wraps a contiguous tool/thinking stream. */
export function ToolGroup({ rows, onOpenFile }: ToolGroupProps) {
  if (rows.length === 0) return null;
  return (
    <div className="my-2.5 flex flex-col gap-1">
      {rows.map((row) => (
        <ToolRow key={row.key} view={row} depth={0} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

interface ToolRowProps {
  view: ToolRowView;
  /** Always 0 — detail rows never indent further (A07 :2517). Kept for assertion readability. */
  depth?: 0;
  onOpenFile?: (target: FileLinkTarget) => void;
}

/** One `.ct-row`: verb + arg, optionally expandable into an output/detail/thinking body. */
export function ToolRow({ view, onOpenFile }: ToolRowProps) {
  const rowClass = cn(
    'group/row flex w-full items-baseline gap-1.5 text-left text-markdown leading-normal',
    view.failed ? 'text-destructive' : 'text-muted-foreground'
  );
  const verbClass = cn('shrink-0', !view.failed && 'group-hover/row:text-foreground');

  const rowContent = (
    <>
      <span className={verbClass}>{view.verb}</span>
      <ToolRowArg view={view} onOpenFile={onOpenFile} />
    </>
  );

  if (!view.expandable) {
    return <div className={rowClass}>{rowContent}</div>;
  }

  return (
    <Collapsible defaultOpen={view.failed}>
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
        <ToolRowBody view={view} onOpenFile={onOpenFile} />
      </CollapsibleContent>
    </Collapsible>
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
  const argClass = cn('min-w-0 truncate', view.failed ? 'text-destructive/70' : 'text-tool-arg');

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
}: {
  view: ToolRowView;
  onOpenFile?: (target: FileLinkTarget) => void;
}) {
  return (
    <>
      {view.input && (
        <ToolRowInputSegment input={view.input} maxHeightClass={view.inputMaxHeightClass} />
      )}
      <ToolRowOutputSegment view={view} onOpenFile={onOpenFile} />
    </>
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
          'm-0 overflow-auto whitespace-pre-wrap pt-1 pb-2 text-code leading-[1.55] text-muted-foreground',
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
}: {
  view: ToolRowView;
  onOpenFile?: (target: FileLinkTarget) => void;
}) {
  switch (view.body) {
    case 'output':
      return (
        <div className="ml-0.5 border-l border-border pl-3.5">
          <pre
            className={cn(
              'm-0 overflow-auto whitespace-pre-wrap pt-1 pb-2 text-code leading-[1.55] text-muted-foreground',
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
            <ToolRow key={row.key} view={row} depth={0} onOpenFile={onOpenFile} />
          ))}
        </div>
      );
    case 'thinking':
    case 'stats':
      return (
        <div className="mt-1 flex flex-col gap-1.5 text-markdown leading-[1.55] text-tool-arg">
          <p className="whitespace-pre-wrap">{view.output}</p>
        </div>
      );
    default:
      return null;
  }
}
