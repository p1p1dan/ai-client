import { englishTranslate } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it, vi } from 'vitest';
import { applyPlanApprovalPosture } from '../planApprovalPosture';

/**
 * dsh-rebase decision 169 — a plan review's approval switched a chat's
 * posture inside its worker (or Main restates it): the chat's stored posture
 * becomes that one, the chip reads it again, and an approval says so.
 */

function effects() {
  return {
    t: englishTranslate,
    writeSessionPermissions: vi.fn(),
    notePostureSynced: vi.fn(),
    toast: vi.fn(),
  };
}

const event = (payload: Record<string, unknown>, sessionId: string | null = 's1') =>
  ({
    type: 'session.permissions',
    seq: 1,
    timestamp: 1,
    ...(sessionId ? { sessionId } : {}),
    payload,
  }) as unknown as RuntimeEvent;

describe('applyPlanApprovalPosture', () => {
  it('stores an approval’s posture for that chat, re-reads the chip and says so', () => {
    const fx = effects();
    applyPlanApprovalPosture(
      event({
        permissions: { mode: 'agent', gear: 'auto' },
        cause: 'plan-approved',
        questionId: 'q1',
        goal: { set: true },
      }),
      fx
    );
    expect(fx.writeSessionPermissions).toHaveBeenCalledWith('s1', { mode: 'agent', gear: 'auto' });
    expect(fx.notePostureSynced).toHaveBeenCalledWith('s1');
    expect(fx.toast).toHaveBeenCalledWith({
      type: 'info',
      title: 'Plan approved: switched to Full auto',
    });
  });

  it('says why the goal was not set', () => {
    const fx = effects();
    applyPlanApprovalPosture(
      event({
        permissions: { mode: 'agent', gear: 'bypass' },
        cause: 'plan-approved',
        goal: { set: false, reason: 'goal exists' },
      }),
      fx
    );
    expect(fx.toast).toHaveBeenCalledWith({
      type: 'warning',
      title: 'Plan approved: switched to Bypass all prompts',
      description: 'Goal not set: goal exists',
    });
  });

  it('a restated posture (sync) is stored quietly', () => {
    const fx = effects();
    applyPlanApprovalPosture(
      event({ permissions: { mode: 'agent', gear: 'auto' }, cause: 'sync' }),
      fx
    );
    expect(fx.writeSessionPermissions).toHaveBeenCalledOnce();
    expect(fx.notePostureSynced).toHaveBeenCalledOnce();
    expect(fx.toast).not.toHaveBeenCalled();
  });

  it('ignores other events, a malformed posture and a sessionless event', () => {
    const fx = effects();
    applyPlanApprovalPosture(
      { type: 'session.status', sessionId: 's1', payload: { status: 'idle' } } as RuntimeEvent,
      fx
    );
    applyPlanApprovalPosture(event({ permissions: { mode: 'god', gear: 'auto' } }), fx);
    applyPlanApprovalPosture(
      event({ permissions: { mode: 'agent', gear: 'auto' }, cause: 'sync' }, null),
      fx
    );
    expect(fx.writeSessionPermissions).not.toHaveBeenCalled();
    expect(fx.toast).not.toHaveBeenCalled();
  });
});
