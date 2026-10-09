/**
 * Decision 166 (GitHub issue #5): starting a goal from the composer.
 *
 * - The permission menu's 「设定目标…」 puts `/goal ` in the message box
 *   (`goalPrefill`). It is off while the chat has an unfinished goal (DSH
 *   refuses a second one) or a send of this chat is in flight
 *   (`goalEntryState`).
 * - A goal-creating `/goal <objective>` moves the chat to a posture its rounds
 *   can run under, right before the line is dispatched (`planGoalStart`):
 *   execute mode, and full auto unless the chat is already on full auto or
 *   bypass. Starting a goal is the explicit intent, so full auto skips its
 *   usual confirmation here; bypass is never chosen for the user.
 *
 * Pure apart from the two `applyGoalStart*`, whose effects are injected.
 */

import type { Translate } from '@shared/i18n';
import {
  PERMISSION_PRESET_LABELS,
  presetOf,
  type RuntimePermissionSettings,
} from '@shared/types/runtimePermission';
import type { GoalBarView } from './sessionPanelsModel';
import { parseSlashLine } from './slashCommands';

/**
 * DSH's goal-creating form (dsh-command-goal `parseGoalCommand`): `/goal`
 * with an objective. The bare `/goal` (show) and the control forms `clear`,
 * `pause`, `resume`, `edit …` create nothing.
 */
export function isGoalCreatingLine(text: string): boolean {
  const parsed = parseSlashLine(text);
  if (parsed?.name !== 'goal' || parsed.args === '') return false;
  const control = parsed.args.toLowerCase();
  if (control === 'clear' || control === 'pause' || control === 'resume' || control === 'edit')
    return false;
  return !/^edit\s/iu.test(parsed.args);
}

/** A goal DSH will not replace: `/goal <objective>` is refused until it completes or is cleared. */
export function hasUnfinishedGoal(goal: GoalBarView | null): boolean {
  return goal !== null && goal.state !== 'complete';
}

/** Execute mode, at least full auto; null when `current` already is. Never bypass. */
export function goalStartPosture(
  current: RuntimePermissionSettings
): RuntimePermissionSettings | null {
  const gear = current.gear === 'auto' || current.gear === 'bypass' ? current.gear : 'auto';
  if (current.mode === 'agent' && gear === current.gear) return null;
  return { mode: 'agent', gear };
}

export interface GoalStart {
  previous: RuntimePermissionSettings;
  next: RuntimePermissionSettings;
}

/**
 * The posture switch dispatching `text` brings, or null: only a goal-creating
 * line, only when DSH would create the goal, only when the posture changes.
 */
export function planGoalStart(
  text: string,
  current: RuntimePermissionSettings,
  goal: GoalBarView | null
): GoalStart | null {
  if (!isGoalCreatingLine(text) || hasUnfinishedGoal(goal)) return null;
  const next = goalStartPosture(current);
  return next ? { previous: current, next } : null;
}

/** Hints of a disabled 「设定目标…」, as dictionary keys. */
export const GOAL_ENTRY_HINT_LIVE =
  'This chat has an unfinished goal. Pause, resume, edit or clear it from the goal bar.';
/** No live worker: the goal bar has no buttons, but `/goal` lines still run. */
export const GOAL_ENTRY_HINT_OFFLINE =
  'This chat has an unfinished goal. Send /goal to see it, or /goal clear to end it.';
export const GOAL_ENTRY_HINT_SENDING = 'Available once the current message is sent.';

export interface GoalEntryState {
  disabled: boolean;
  /** Dictionary key; null while the entry is available. */
  hint: string | null;
}

export function goalEntryState(goal: GoalBarView | null, sendingHere: boolean): GoalEntryState {
  if (goal !== null && hasUnfinishedGoal(goal))
    return { disabled: true, hint: goal.controls ? GOAL_ENTRY_HINT_LIVE : GOAL_ENTRY_HINT_OFFLINE };
  if (sendingHere) return { disabled: true, hint: GOAL_ENTRY_HINT_SENDING };
  return { disabled: false, hint: null };
}

/** `/goal ` ahead of whatever the box holds (once), caret at the end. */
export function goalPrefill(value: string): { text: string; cursor: number } {
  const body = value.trimStart().replace(/^\/goal(?=\s|$)\s*/u, '');
  const text = `/goal ${body}`;
  return { text, cursor: text.length };
}

export interface GoalStartEffects {
  t: Translate;
  writeSessionPermissions(sessionId: string, settings: RuntimePermissionSettings): void;
  /** `chat.setPermissions`, for a chat whose worker is up. */
  setPermissions(sessionId: string, settings: RuntimePermissionSettings): Promise<unknown>;
  /** Makes the composer chip read the stored posture again. */
  notePostureSynced(sessionId: string): void;
  toast(toast: { type: 'info' | 'error'; title: string; description?: string }): void;
}

function presetName(settings: RuntimePermissionSettings, t: Translate): string {
  return t(PERMISSION_PRESET_LABELS[presetOf(settings)]);
}

function announce(start: GoalStart, effects: GoalStartEffects): void {
  effects.toast({
    type: 'info',
    title: effects.t('Switched to {{preset}} so the goal can run round after round', {
      preset: presetName(start.next, effects.t),
    }),
  });
}

/**
 * A chat whose worker this send brings up (create or resume): the posture is
 * stored for this chat only — never as the new-chat default — and the spawn
 * carries it.
 */
export function applyGoalStartBeforeSpawn(
  sessionId: string,
  start: GoalStart,
  effects: GoalStartEffects
): void {
  effects.writeSessionPermissions(sessionId, start.next);
  effects.notePostureSynced(sessionId);
  announce(start, effects);
}

/**
 * A chat whose worker is up: switch it before the line goes out. Stored only
 * once the worker took it, as the chip's own picks are. A refusal (the agent
 * running a turn of its own answers `WORKER_SESSION_BUSY` to a mode change)
 * is reported and the goal is sent anyway. True when the switch took.
 */
export async function applyGoalStartLive(
  sessionId: string,
  start: GoalStart,
  effects: GoalStartEffects
): Promise<boolean> {
  try {
    await effects.setPermissions(sessionId, start.next);
  } catch (failure) {
    effects.toast({
      type: 'error',
      title: effects.t('Could not switch to {{preset}}', {
        preset: presetName(start.next, effects.t),
      }),
      description: effects.t(
        'The goal was sent anyway and may stop to ask for approval. ({{error}})',
        { error: failure instanceof Error ? failure.message : String(failure) }
      ),
    });
    return false;
  }
  effects.writeSessionPermissions(sessionId, start.next);
  effects.notePostureSynced(sessionId);
  announce(start, effects);
  return true;
}
