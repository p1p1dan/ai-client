import type { DshTodoItem } from '@shared/types/runtimeEvents';
import type { TodoCardView } from '@/components/chat/sessionPanelsModel';
import { type RunStatus, StatusIcon } from '@/components/ui/status-icon';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { RailCard } from './RailCard';

/** A todo's status as the shared run state (design system v2 §6; `TodoCard`'s mapping). */
const TODO_RUN_STATUS: Record<DshTodoItem['status'], RunStatus> = {
  pending: 'idle',
  in_progress: 'running',
  completed: 'success',
};

/**
 * Layout 5e: the session's todo list (DSH's `todos`, the list the model keeps
 * with `todo_write`), `done / total` in the header. Not drawn while empty.
 * While the rail is on screen the strip above the composer steps aside.
 */
export function TodoRailCard({ view }: { view: TodoCardView }) {
  const { t } = useI18n();
  return (
    <RailCard id="todo" title={t('Todo')} summary={<span>{`${view.done} / ${view.total}`}</span>}>
      <ul className="flex max-h-60 flex-col overflow-y-auto" data-rail-todo="">
        {view.items.map((item, index) => (
          <li
            // Items are replaced whole on every write and may repeat a text.
            // biome-ignore lint/suspicious/noArrayIndexKey: the index is the item's identity here
            key={index}
            className={cn(
              'flex min-h-6 min-w-0 items-center gap-2',
              item.status === 'completed' ? 'text-muted-foreground' : 'text-foreground'
            )}
            data-status={item.status}
          >
            <StatusIcon status={TODO_RUN_STATUS[item.status] ?? 'idle'} />
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                item.status === 'completed' && 'line-through'
              )}
              title={item.content}
            >
              {item.content}
            </span>
          </li>
        ))}
      </ul>
    </RailCard>
  );
}
