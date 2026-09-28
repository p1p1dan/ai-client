/**
 * dsh-rebase P1-7a: the todo card above the composer — DSH's `todos`
 * projection, the list the model keeps with `todo_write` (plan P1-7 shard 03
 * §3, prototype scene B).
 *
 * Folded, one line: 「待办 3/5 · 正在：…」, with 「… 等 N 项」 when several are in
 * progress and 「待办 5/5 已完成」 once all are done. Open, the list: a circle
 * for what waits, a dotted one for what is in progress, a check (dimmed and
 * struck through) for what is done; past eight rows it scrolls. Only the
 * session's own list: a subagent keeps its own and it does not come here.
 */

import type { DshTodoItem } from '@shared/types/runtimeEvents';
import { ChevronDown, ChevronUp, Circle, CircleCheck, CircleDot, ListChecks } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import {
  panelStripBodyClass,
  panelStripClass,
  panelStripHeadClass,
  panelStripIconButtonClass,
  panelStripLabelClass,
  panelStripTextClass,
} from './sessionPanelsLayout';
import type { TodoCardView } from './sessionPanelsModel';

/** One list row: 24 px, indented under the head's icon. */
export function todoItemClass(status: 'pending' | 'in_progress' | 'completed'): string {
  return cn(
    'flex h-6 min-w-0 items-center gap-2 pl-5',
    status === 'completed' ? 'text-muted-foreground' : 'text-foreground'
  );
}

export function TodoCard({ sessionId, view }: { sessionId: string; view: TodoCardView }) {
  const { t } = useI18n();
  const open = useSessionPanelsStore((state) => state.open[sessionId]?.todo === true);
  const setOpen = useSessionPanelsStore((state) => state.setOpen);
  const toggle = () => setOpen(sessionId, 'todo', !open);

  const counts = { done: view.done, total: view.total };
  const summary = view.allDone
    ? t('Todo {{done}}/{{total}} done', counts)
    : view.current.length > 1
      ? t('Todo {{done}}/{{total}} · Doing: {{item}} ({{count}} in progress)', {
          ...counts,
          item: view.current[0] ?? '',
          count: view.current.length,
        })
      : view.current.length === 1
        ? t('Todo {{done}}/{{total}} · Doing: {{item}}', { ...counts, item: view.current[0] ?? '' })
        : view.next !== undefined
          ? t('Todo {{done}}/{{total}} · Next: {{item}}', { ...counts, item: view.next })
          : t('Todo {{done}}/{{total}}', counts);

  return (
    <section className={panelStripClass()} data-testid="todo-card" aria-label={t('Todo')}>
      <div className={panelStripHeadClass()}>
        <button
          type="button"
          className={panelStripLabelClass()}
          aria-expanded={open}
          onClick={toggle}
        >
          <ListChecks className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className={cn(panelStripTextClass(), 'tabular-nums')} title={summary}>
            {summary}
          </span>
        </button>
        <button
          type="button"
          className={panelStripIconButtonClass()}
          aria-label={open ? t('Collapse') : t('Expand')}
          onClick={toggle}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </button>
      </div>
      {open && (
        <TodoList
          items={view.items}
          className={cn(panelStripBodyClass(), 'max-h-48 overflow-y-auto')}
        />
      )}
    </section>
  );
}

/**
 * The list itself: a circle for what waits, a dotted one for what is in
 * progress, a dimmed, struck-through check for what is done. Exported for the
 * `todo_write` tool row's expanded body (P1-7c), which draws the list a write
 * set in the same form (plan P1-7 shard 03 §3).
 */
export function TodoList({
  items,
  className,
}: {
  items: readonly DshTodoItem[];
  className?: string;
}) {
  return (
    <ul className={className}>
      {items.map((item, index) => {
        const Icon =
          item.status === 'completed'
            ? CircleCheck
            : item.status === 'in_progress'
              ? CircleDot
              : Circle;
        return (
          <li
            // Items are replaced whole on every write and may repeat a text.
            // biome-ignore lint/suspicious/noArrayIndexKey: the index is the item's identity here
            key={index}
            className={todoItemClass(item.status)}
            data-status={item.status}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span
              className={cn(panelStripTextClass(), item.status === 'completed' && 'line-through')}
              title={item.content}
            >
              {item.content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
