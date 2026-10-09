// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import type { PermissionGear, RuntimePermissionSettings } from '@shared/types/runtimePermission';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyGoalStartBeforeSpawn,
  applyGoalStartLive,
  GOAL_ENTRY_HINT_LIVE,
  GOAL_ENTRY_HINT_OFFLINE,
  GOAL_ENTRY_HINT_SENDING,
  type GoalStartEffects,
  goalEntryState,
  goalPrefill,
  goalStartPosture,
  isGoalCreatingLine,
  planGoalStart,
} from '../goalStart';
import type { GoalBarState, GoalBarView } from '../sessionPanelsModel';
import {
  DEFAULT_PERMISSIONS_STORAGE_KEY,
  readDefaultPermissions,
  readSessionPermissions,
  writeDefaultPermissions,
  writeSessionPermissions,
} from '../sessionPreferenceStore';

/**
 * Decision 166 (GitHub issue #5): the pure half of starting a goal from the
 * composer, and the two effectful steps with their effects injected. Where
 * `runSend` calls them is pinned by `goalStartWiringStatic.test.ts`.
 */

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

function goal(state: GoalBarState, controls = true): GoalBarView {
  return {
    state,
    goalId: 'g1',
    revision: 1,
    objective: 'ship it',
    round: 1,
    maxRounds: 256,
    createdAt: 0,
    updatedAt: 0,
    action: null,
    actionDisabled: false,
    controls,
  };
}

const posture = (mode: 'plan' | 'agent', gear: PermissionGear): RuntimePermissionSettings => ({
  mode,
  gear,
});

describe('which lines create a goal (dsh-command-goal parseGoalCommand)', () => {
  it('is `/goal` with an objective', () => {
    expect(isGoalCreatingLine('/goal ship the release')).toBe(true);
    expect(isGoalCreatingLine('  /goal ship it  ')).toBe(true);
    expect(isGoalCreatingLine('/goal make CI green\nand keep it green')).toBe(true);
    // `edit` only as its own word.
    expect(isGoalCreatingLine('/goal editorial pass over the docs')).toBe(true);
  });

  it('is not the bare command or a control form', () => {
    for (const line of [
      '/goal',
      '/goal   ',
      '/goal clear',
      '/goal CLEAR',
      '/goal pause',
      '/goal resume',
      '/goal edit',
      '/goal edit a new objective',
      '/goal Edit a new objective',
    ])
      expect(isGoalCreatingLine(line), line).toBe(false);
  });

  it('is not another command or prose', () => {
    expect(isGoalCreatingLine('/goals ship it')).toBe(false);
    expect(isGoalCreatingLine('/compact keep the goal')).toBe(false);
    expect(isGoalCreatingLine('set a /goal ship it')).toBe(false);
  });
});

describe('the posture a goal starts on', () => {
  it('leaves plan mode, and raises ask and auto-edit to full auto', () => {
    expect(goalStartPosture(posture('plan', 'auto'))).toEqual(posture('agent', 'auto'));
    expect(goalStartPosture(posture('plan', 'ask'))).toEqual(posture('agent', 'auto'));
    expect(goalStartPosture(posture('agent', 'ask'))).toEqual(posture('agent', 'auto'));
    expect(goalStartPosture(posture('agent', 'accept-edits'))).toEqual(posture('agent', 'auto'));
  });

  it('keeps full auto and bypass, and never reaches bypass on its own', () => {
    expect(goalStartPosture(posture('agent', 'auto'))).toBeNull();
    expect(goalStartPosture(posture('agent', 'bypass'))).toBeNull();
    // A stored plan + bypass only leaves plan mode.
    expect(goalStartPosture(posture('plan', 'bypass'))).toEqual(posture('agent', 'bypass'));
    for (const gear of ['ask', 'accept-edits', 'auto'] as const)
      for (const mode of ['plan', 'agent'] as const)
        expect(goalStartPosture(posture(mode, gear))?.gear).not.toBe('bypass');
  });

  it('switches only for a goal-creating line that DSH will accept', () => {
    const current = posture('agent', 'ask');
    expect(planGoalStart('/goal ship it', current, null)).toEqual({
      previous: current,
      next: posture('agent', 'auto'),
    });
    expect(planGoalStart('/goal clear', current, null)).toBeNull();
    expect(planGoalStart('/goal pause', posture('plan', 'auto'), null)).toBeNull();
    expect(planGoalStart('ship it', current, null)).toBeNull();
    // DSH refuses a second goal while one is unfinished, so nothing switches.
    for (const state of ['running', 'waiting', 'suspended', 'paused', 'blocked'] as const)
      expect(planGoalStart('/goal ship it', current, goal(state)), state).toBeNull();
    // A completed goal can be replaced.
    expect(planGoalStart('/goal ship it', current, goal('complete'))?.next).toEqual(
      posture('agent', 'auto')
    );
    expect(planGoalStart('/goal ship it', posture('agent', 'auto'), null)).toBeNull();
  });
});

describe('「设定目标…」', () => {
  it('is available with no goal, or a completed one', () => {
    expect(goalEntryState(null, false)).toEqual({ disabled: false, hint: null });
    expect(goalEntryState(goal('complete'), false)).toEqual({ disabled: false, hint: null });
  });

  it('is off while the chat has an unfinished goal, and says where to manage it', () => {
    expect(goalEntryState(goal('paused'), false)).toEqual({
      disabled: true,
      hint: GOAL_ENTRY_HINT_LIVE,
    });
    // No live worker: the goal bar has no buttons, so the hint names the commands.
    expect(goalEntryState(goal('suspended', false), false)).toEqual({
      disabled: true,
      hint: GOAL_ENTRY_HINT_OFFLINE,
    });
    expect(zh(GOAL_ENTRY_HINT_LIVE)).toContain('目标条');
    expect(zh(GOAL_ENTRY_HINT_OFFLINE)).toContain('/goal clear');
  });

  it('is off while this chat is sending', () => {
    expect(goalEntryState(null, true)).toEqual({ disabled: true, hint: GOAL_ENTRY_HINT_SENDING });
    expect(zh(GOAL_ENTRY_HINT_SENDING)).toBe('当前消息发出后可用。');
  });

  it('puts `/goal ` ahead of the draft, once, with the caret at the end', () => {
    expect(goalPrefill('')).toEqual({ text: '/goal ', cursor: 6 });
    expect(goalPrefill('make CI green')).toEqual({ text: '/goal make CI green', cursor: 19 });
    expect(goalPrefill('  /goal make CI green')).toEqual({
      text: '/goal make CI green',
      cursor: 19,
    });
    expect(goalPrefill('/goal')).toEqual({ text: '/goal ', cursor: 6 });
  });
});

describe('applying the switch', () => {
  let toasts: Array<{ type: string; title: string; description?: string }>;
  let synced: string[];
  let setPermissions: ReturnType<typeof vi.fn>;
  let effects: GoalStartEffects;

  beforeEach(() => {
    localStorage.clear();
    toasts = [];
    synced = [];
    setPermissions = vi.fn(async () => undefined);
    effects = {
      t: zh,
      writeSessionPermissions,
      setPermissions,
      notePostureSynced: (sessionId) => synced.push(sessionId),
      toast: (toast) => toasts.push(toast),
    };
  });

  it('stores a new chat’s posture for that chat only, never as the new-chat default', () => {
    writeDefaultPermissions(posture('plan', 'auto'));
    const before = localStorage.getItem(DEFAULT_PERMISSIONS_STORAGE_KEY);
    const start = planGoalStart(
      '/goal ship it',
      readDefaultPermissions() ?? posture('agent', 'ask'),
      null
    );
    expect(start).not.toBeNull();
    if (!start) return;
    applyGoalStartBeforeSpawn('new-chat', start, effects);
    expect(readSessionPermissions('new-chat')).toEqual(posture('agent', 'auto'));
    expect(localStorage.getItem(DEFAULT_PERMISSIONS_STORAGE_KEY)).toBe(before);
    expect(readDefaultPermissions()).toEqual(posture('plan', 'auto'));
    expect(setPermissions).not.toHaveBeenCalled();
    expect(synced).toEqual(['new-chat']);
    expect(toasts).toEqual([{ type: 'info', title: '已切换到「全自动」，目标会自动多轮推进' }]);
  });

  it('switches a live chat before storing it', async () => {
    const start = { previous: posture('agent', 'accept-edits'), next: posture('agent', 'auto') };
    setPermissions.mockImplementation(async () => {
      // Nothing is stored until the worker took it.
      expect(readSessionPermissions('s1')).toBeNull();
    });
    expect(await applyGoalStartLive('s1', start, effects)).toBe(true);
    expect(setPermissions).toHaveBeenCalledWith('s1', posture('agent', 'auto'));
    expect(readSessionPermissions('s1')).toEqual(posture('agent', 'auto'));
    expect(synced).toEqual(['s1']);
    expect(toasts.map((toast) => toast.type)).toEqual(['info']);
  });

  it('reports a refused switch and leaves the stored posture alone', async () => {
    writeSessionPermissions('s1', posture('plan', 'auto'));
    setPermissions.mockRejectedValue(
      new Error('WORKER_SESSION_BUSY: The mode cannot change while the agent runs')
    );
    const start = { previous: posture('plan', 'auto'), next: posture('agent', 'auto') };
    expect(await applyGoalStartLive('s1', start, effects)).toBe(false);
    expect(readSessionPermissions('s1')).toEqual(posture('plan', 'auto'));
    expect(synced).toEqual([]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: 'error', title: '未能切换到「全自动」' });
    expect(toasts[0]?.description).toContain('目标仍已发出');
    expect(toasts[0]?.description).toContain('WORKER_SESSION_BUSY');
  });
});
