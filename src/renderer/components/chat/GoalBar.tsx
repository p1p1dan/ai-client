/**
 * dsh-rebase P1-7a: the goal bar above the composer — DSH's `goal` projection
 * and the bridge's `goalActivation` (plan P1-7 shard 03 §2, prototype scene B;
 * decisions 072, 109, 111, 118).
 *
 * One line folded: an icon, the state, the round count and the objective, then
 * the one action the state allows and the ⋯ menu (edit, copy, clear). Open,
 * the whole objective and when it was set and last changed. Every control is
 * DSH's own `/goal` command, run out of band through `worker.command`:
 *
 *   暂停   `/goal pause`   — DSH cancels the round that is running
 *   继续   `/goal resume`  — a paused, blocked or suspended goal; refused by
 *                           DSH (and offered disabled here) with no rounds left
 *   编辑   `/goal edit …`  — in a dialog
 *   清除   `/goal clear`   — after a confirmation
 *   收起   (complete)     — this window only; the next change brings it back
 *
 * A goal no live worker holds (a chat that is not running) shows without its
 * buttons. There is no "paused by an interjection" state: a Ctrl+Enter message
 * joins the running round and the goal goes on (decisions 093, 111).
 */

import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Copy,
  Ellipsis,
  EyeOff,
  Pause,
  Pencil,
  Play,
  Target,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Menu, MenuItem, MenuPopup } from '@/components/ui/menu';
import { toastManager } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { GoalEditDialog } from './GoalEditDialog';
import { formatAbsoluteTime } from './messageMetadata';
import {
  panelStripActionClass,
  panelStripBodyClass,
  panelStripClass,
  panelStripHeadClass,
  panelStripIconButtonClass,
  panelStripLabelClass,
  panelStripTextClass,
} from './sessionPanelsLayout';
import {
  type GoalBarState,
  type GoalBarView,
  goalCommandLine,
  goalDismissKey,
} from './sessionPanelsModel';

/** The state word and what follows it, before the objective (prototype `GOAL_STATES`). */
export function goalBarLead(view: GoalBarView, t: TFunction): { title: string; detail: string } {
  const rounds = { round: view.round, max: view.maxRounds };
  switch (view.state) {
    case 'running':
      return { title: t('Goal'), detail: t('Round {{round}}/{{max}} · In progress', rounds) };
    case 'waiting':
      return {
        title: t('Goal'),
        detail: t('Round {{round}}/{{max}} · Waiting for the next round', rounds),
      };
    case 'suspended':
      return {
        title: t('Goal suspended'),
        detail: t('Resume by hand after reopening, rewinding or stopping'),
      };
    case 'paused':
      return { title: t('Goal paused'), detail: t('Round {{round}}/{{max}}', rounds) };
    case 'blocked':
      return { title: t('Goal blocked'), detail: view.blockedMessage ?? '' };
    case 'roundLimit':
      return { title: t('Goal used all {{max}} rounds', rounds), detail: '' };
    case 'complete':
      return { title: t('Goal complete'), detail: t('{{round}} rounds in all', rounds) };
    default:
      return { title: t('Goal'), detail: '' };
  }
}

function GoalStateIcon({ state }: { state: GoalBarState }) {
  const className = 'size-3.5 shrink-0';
  switch (state) {
    case 'running':
    case 'waiting':
      // Armed: the engine continues it by itself.
      return <Target className={cn(className, 'text-status-running')} aria-hidden />;
    case 'paused':
      return <Pause className={cn(className, 'text-muted-foreground')} aria-hidden />;
    case 'blocked':
    case 'roundLimit':
      return <TriangleAlert className={cn(className, 'text-muted-foreground')} aria-hidden />;
    case 'complete':
      return <CircleCheck className={cn(className, 'text-muted-foreground')} aria-hidden />;
    default:
      return <Target className={cn(className, 'text-muted-foreground')} aria-hidden />;
  }
}

export function GoalBar({ sessionId, view }: { sessionId: string; view: GoalBarView }) {
  const { t } = useI18n();
  const open = useSessionPanelsStore((state) => state.open[sessionId]?.goal === true);
  const setOpen = useSessionPanelsStore((state) => state.setOpen);
  const pending = useSessionPanelsStore((state) => state.commandPending[sessionId] === true);
  const runGoalCommand = useSessionPanelsStore((state) => state.runGoalCommand);
  const dismissGoal = useSessionPanelsStore((state) => state.dismissGoal);
  const [editing, setEditing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const toggle = () => setOpen(sessionId, 'goal', !open);

  /** One `/goal …`; DSH's refusal (or a failed request) says why in a toast. */
  const run = async (line: string): Promise<boolean> => {
    try {
      const result = await runGoalCommand(sessionId, line);
      if (result && !result.ok) {
        toastManager.add({
          type: 'error',
          title: t('The goal was not changed'),
          description: result.error,
        });
        return false;
      }
      return result !== undefined;
    } catch (error) {
      toastManager.add({
        type: 'error',
        title: t('The goal was not changed'),
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const lead = goalBarLead(view, t);
  // Prototype: the state in the body colour, the round and state words muted,
  // then the objective — 「目标 · 第 3/256 轮 · 进行中 · 让 CI 全绿……」.
  const middle = lead.detail ? ` · ${lead.detail} · ` : ' · ';

  const action = (() => {
    if (view.action === 'pause') {
      return (
        <Button
          size="xs"
          variant="ghost"
          className={panelStripActionClass()}
          disabled={pending}
          onClick={() => void run(goalCommandLine('pause'))}
        >
          <Pause className="size-3.5" />
          {t('Pause')}
        </Button>
      );
    }
    if (view.action === 'resume') {
      const blockedHint = view.actionDisabled
        ? t('Ask the assistant to raise the round limit, or clear the goal and start again')
        : undefined;
      return (
        // The wrapper carries the disabled hint: a disabled button gets no pointer events.
        <span className="flex shrink-0" title={blockedHint}>
          <Button
            size="xs"
            variant="ghost"
            className={panelStripActionClass()}
            disabled={pending || view.actionDisabled}
            onClick={() => void run(goalCommandLine('resume'))}
          >
            <Play className="size-3.5" />
            {t('Resume')}
          </Button>
        </span>
      );
    }
    if (view.action === 'dismiss') {
      return (
        <Button
          size="xs"
          variant="ghost"
          className={panelStripActionClass()}
          onClick={() => dismissGoal(sessionId, goalDismissKey(view.goalId, view.revision))}
        >
          <EyeOff className="size-3.5" />
          {t('Put away')}
        </Button>
      );
    }
    return null;
  })();

  return (
    <section
      className={panelStripClass()}
      data-testid="goal-bar"
      data-state={view.state}
      aria-label={t('Goal')}
    >
      <div className={panelStripHeadClass()}>
        <button
          type="button"
          className={panelStripLabelClass()}
          aria-expanded={open}
          onClick={toggle}
          title={view.objective}
        >
          <GoalStateIcon state={view.state} />
          <span className={cn(panelStripTextClass(), 'tabular-nums')}>
            {lead.title}
            <span className="text-muted-foreground">{middle}</span>
            {view.objective}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {action}
          <Menu>
            <MenuPrimitive.Trigger
              className={panelStripIconButtonClass()}
              aria-label={t('Goal menu')}
              render={<button type="button" />}
            >
              <Ellipsis className="size-3.5" />
            </MenuPrimitive.Trigger>
            <MenuPopup side="top" align="end" className="min-w-40">
              {view.controls && (
                <MenuItem disabled={pending} onClick={() => setEditing(true)}>
                  <Pencil />
                  {t('Edit goal…')}
                </MenuItem>
              )}
              <MenuItem
                onClick={() => {
                  void navigator.clipboard
                    .writeText(view.objective)
                    .then(() => toastManager.add({ type: 'success', title: t('Copied') }))
                    .catch(() => undefined);
                }}
              >
                <Copy />
                {t('Copy goal text')}
              </MenuItem>
              {view.controls && (
                <MenuItem
                  variant="destructive"
                  disabled={pending}
                  onClick={() => setClearing(true)}
                >
                  <Trash2 />
                  {t('Clear goal…')}
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
          <button
            type="button"
            className={panelStripIconButtonClass()}
            aria-label={open ? t('Collapse') : t('Expand')}
            onClick={toggle}
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        </div>
      </div>
      {open && <GoalBarBody view={view} t={t} />}
      <GoalEditDialog
        open={editing}
        objective={view.objective}
        pending={pending}
        onOpenChange={setEditing}
        onSave={async (objective) => {
          if (await run(goalCommandLine('edit', objective))) setEditing(false);
        }}
      />
      <AlertDialog open={clearing} onOpenChange={setClearing}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Clear the goal?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'The goal stops and its bar goes away. The conversation and the work done so far stay as they are.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">{t('Cancel')}</Button>} />
            <Button
              variant="destructive"
              disabled={pending}
              onClick={async () => {
                if (await run(goalCommandLine('clear'))) setClearing(false);
              }}
            >
              {t('Clear')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

/** The open bar: the whole objective, why it is blocked, when it was set and changed. */
function GoalBarBody({ view, t }: { view: GoalBarView; t: TFunction }) {
  return (
    <div className={cn(panelStripBodyClass(), 'space-y-0.5 pl-7')}>
      <p className="select-text whitespace-pre-wrap break-words text-foreground">
        {view.objective}
      </p>
      {view.blockedMessage && (
        <p className="select-text whitespace-pre-wrap break-words text-muted-foreground">
          {t('Blocked: {{reason}}', { reason: view.blockedMessage })}
        </p>
      )}
      <p className="text-muted-foreground tabular-nums">
        {t('Set at {{created}} · Last changed {{updated}} · Round {{round}}/{{max}} used', {
          created: formatAbsoluteTime(view.createdAt),
          updated: formatAbsoluteTime(view.updatedAt),
          round: view.round,
          max: view.maxRounds,
        })}
      </p>
    </div>
  );
}
