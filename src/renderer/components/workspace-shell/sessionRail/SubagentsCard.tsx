import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { SubagentConversationDialog } from '@/components/chat/SubagentConversationDialog';
import { Button } from '@/components/ui/button';
import { type RunStatus, StatusIcon } from '@/components/ui/status-icon';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { TaskStop } from '../panes/backgroundTasksModel';
import { RailCard } from './RailCard';
import type { SubagentCardRow, SubagentCardStatus, SubagentsCardView } from './subagentsCardModel';

const STATUS_ICON: Record<SubagentCardStatus, RunStatus> = {
  running: 'running',
  waiting: 'waiting',
  completed: 'success',
  failed: 'failed',
  interrupted: 'stopped',
};

const STATUS_WORD: Record<SubagentCardStatus, string> = {
  running: 'Running',
  waiting: 'Waiting for your approval',
  completed: 'Completed',
  failed: 'Errored',
  interrupted: 'Interrupted',
};

/**
 * Decision 207 §8 item 3: the session's subagents (DSH 0.2.1 runs them all in
 * the background), after open-claude-ui's CoworkAgentCanvas member rows. A row
 * opens its actions — 「查看对话」 and, while it runs, 「打断」 (a one-shot
 * child, the Claude engine's: 「停止」); no instructions are sent to a child
 * (decision 203 §7). Ended ones fold under 「已结束 N」.
 */
export function SubagentsCard({
  sessionId,
  view,
  onInterrupt,
}: {
  sessionId: string;
  view: SubagentsCardView;
  onInterrupt: (target: TaskStop) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const [endedOpen, setEndedOpen] = useState(false);
  const [viewing, setViewing] = useState<SubagentCardRow | null>(null);

  const summary =
    view.waiting > 0 ? (
      <>
        <StatusIcon status="waiting" />
        <span>{t('{{count}} waiting for your approval', { count: view.waiting })}</span>
      </>
    ) : view.running > 0 ? (
      <span>{t('{{count}} running', { count: view.running })}</span>
    ) : undefined;

  const rowProps = {
    selected,
    onSelect: (key: string) => setSelected((current) => (current === key ? null : key)),
    onView: setViewing,
    onInterrupt,
  };

  return (
    <RailCard id="subagents" title={t('Subagents')} summary={summary}>
      <div data-rail-subagents="">
        {view.live.length > 0 && (
          <ul className="flex flex-col">
            {view.live.map((row) => (
              <SubagentRow key={row.key} row={row} {...rowProps} />
            ))}
          </ul>
        )}
        {view.ended.length > 0 && (
          <div className={cn(view.live.length > 0 && 'mt-1 border-t border-border-soft pt-1')}>
            <button
              type="button"
              aria-expanded={endedOpen}
              onClick={() => setEndedOpen((open) => !open)}
              className="-mx-1 flex h-6 items-center gap-1 rounded-sm px-1 text-muted-foreground transition-colors focus-ring hover:bg-fill-ghost-hover hover:text-foreground"
              data-rail-subagents-ended=""
            >
              <span className="tabular-nums">
                {t('Ended {{count}}', { count: view.ended.length })}
              </span>
              {endedOpen ? (
                <ChevronDown aria-hidden className="size-3 shrink-0" />
              ) : (
                <ChevronRight aria-hidden className="size-3 shrink-0" />
              )}
            </button>
            {endedOpen && (
              <ul className="flex flex-col">
                {view.ended.map((row) => (
                  <SubagentRow key={row.key} row={row} {...rowProps} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {viewing?.childId && (
        <SubagentConversationDialog
          sessionId={sessionId}
          childId={viewing.childId}
          title={viewing.name || t('Delegated subagent')}
          running={viewing.status === 'running' || viewing.status === 'waiting'}
          onClose={() => setViewing(null)}
        />
      )}
    </RailCard>
  );
}

function SubagentRow({
  row,
  selected,
  onSelect,
  onView,
  onInterrupt,
}: {
  row: SubagentCardRow;
  selected: string | null;
  onSelect: (key: string) => void;
  onView: (row: SubagentCardRow) => void;
  onInterrupt: (target: TaskStop) => void;
}) {
  const { t } = useI18n();
  const open = selected === row.key;
  const control = row.interrupt ?? row.stop;
  const actions = row.conversation || control !== null;
  return (
    <li className="-mx-1" data-subagent-row={row.status}>
      <button
        type="button"
        aria-expanded={actions ? open : undefined}
        onClick={() => onSelect(row.key)}
        className={cn(
          'flex w-full min-w-0 items-start gap-2 rounded-sm px-1 py-1 text-left transition-colors focus-ring',
          open ? 'bg-fill-ghost-selected' : 'hover:bg-fill-ghost-hover'
        )}
      >
        <span className="flex h-4.5 shrink-0 items-center">
          <StatusIcon status={STATUS_ICON[row.status]} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium" title={row.name}>
              {row.name || t('Delegated subagent')}
            </span>
            <span
              className={cn(
                'shrink-0',
                row.status === 'waiting' ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {t(STATUS_WORD[row.status])}
            </span>
          </span>
          {row.kind && <span className="truncate text-foreground-faint">{row.kind}</span>}
          {(row.detail || row.duration) && (
            <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
              <span className="min-w-0 flex-1 truncate" title={row.detail ?? undefined}>
                {row.detail}
              </span>
              {row.duration && (
                <span className="shrink-0 text-foreground-faint tabular-nums">{row.duration}</span>
              )}
            </span>
          )}
        </span>
      </button>
      {open && actions && (
        <div className="flex gap-1 pt-0.5 pb-1 pl-6">
          {row.conversation && (
            <Button type="button" size="xs" variant="ghost" onClick={() => onView(row)}>
              {t('View conversation')}
            </Button>
          )}
          {control && (
            <Button type="button" size="xs" variant="ghost" onClick={() => onInterrupt(control)}>
              {control.type === 'interrupt' ? t('Interrupt') : t('Stop')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
