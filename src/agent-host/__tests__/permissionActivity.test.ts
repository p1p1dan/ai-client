import { describe, expect, it, vi } from 'vitest';
import {
  createPermissionActivityObserver,
  PERMISSIONS_DECISION_CHANNEL,
  PERMISSIONS_UI_PROMPT_CHANNEL,
  projectDecisionEvent,
  projectUiPromptEvent,
} from '../permissionActivity.ts';

/**
 * T08-b — projecting the permission plugin's broadcasts onto our timeline.
 *
 * Everything here reads a THIRD-PARTY best-effort broadcast, so the shape is not
 * ours to assume. Two rules the tests hold to:
 *
 *  - a record that cannot be correlated (`requestId` missing) is dropped, not
 *    guessed at — an uncorrelatable row is noise in a timeline, not evidence;
 *  - the observer never throws into the plugin, whose emit helpers discard
 *    listener errors on purpose, so a throw would lose the reason and block
 *    nothing.
 */

const PROMPT = {
  requestId: 'req-1',
  source: 'local',
  surface: 'bash',
  value: 'rm -rf /tmp/build',
  agentName: 'main',
  request: { surface: 'bash' },
  forwarding: null,
};

const DECISION = {
  requestId: 'req-1',
  surface: 'bash',
  value: 'rm -rf /tmp/build',
  result: 'allow',
  resolution: 'user_approved',
  origin: 'project',
  agentName: 'main',
  matchedPattern: 'rm *',
};

describe('projectUiPromptEvent', () => {
  it('projects a local prompt', () => {
    expect(projectUiPromptEvent(PROMPT)).toEqual({
      phase: 'prompt',
      requestId: 'req-1',
      surface: 'bash',
      value: 'rm -rf /tmp/build',
      agentName: 'main',
    });
  });

  it('uses the nested request surface for cross-cutting gates and retains the tool surface', () => {
    expect(
      projectUiPromptEvent({
        ...PROMPT,
        surface: 'read',
        value: '~/.pilab/default/settings.json',
        request: { surface: 'path', matchedPattern: '~/.pilab/*' },
      })
    ).toMatchObject({
      phase: 'prompt',
      surface: 'path',
      toolSurface: 'read',
      matchedPattern: '~/.pilab/*',
    });
  });

  /**
   * Approving a SUBAGENT's request is a different act from approving one's own,
   * and the two are otherwise indistinguishable in the timeline.
   */
  it('marks a forwarded subagent ask and names the requester', () => {
    const parsed = projectUiPromptEvent({
      ...PROMPT,
      forwarding: { requesterAgentName: 'researcher', requesterSessionId: 's-9' },
    });
    expect(parsed).toMatchObject({ forwarded: true, requesterAgentName: 'researcher' });
  });

  it('does not mark an ordinary prompt as forwarded', () => {
    const parsed = projectUiPromptEvent(PROMPT);
    expect(parsed && 'forwarded' in parsed).toBe(false);
  });

  it('drops a record with no request id to correlate on', () => {
    expect(projectUiPromptEvent({ ...PROMPT, requestId: undefined })).toBeUndefined();
    expect(projectUiPromptEvent({ ...PROMPT, requestId: '' })).toBeUndefined();
    expect(projectUiPromptEvent({ ...PROMPT, requestId: 42 })).toBeUndefined();
  });

  it('omits fields the broadcast left null rather than emitting empty ones', () => {
    const parsed = projectUiPromptEvent({
      requestId: 'r',
      surface: null,
      value: null,
      agentName: null,
    });
    expect(parsed).toEqual({ phase: 'prompt', requestId: 'r' });
  });

  it('refuses a non-object payload', () => {
    for (const value of [null, undefined, 'x', 7, []]) {
      expect(projectUiPromptEvent(value)).toBeUndefined();
    }
  });
});

describe('projectDecisionEvent', () => {
  it('projects a decision with its resolution and matched rule', () => {
    expect(projectDecisionEvent(DECISION)).toEqual({
      phase: 'decision',
      requestId: 'req-1',
      surface: 'bash',
      value: 'rm -rf /tmp/build',
      agentName: 'main',
      result: 'allow',
      resolution: 'user_approved',
      origin: 'project',
      matchedPattern: 'rm *',
    });
  });

  /**
   * The evidence that a call was gated at all: a policy allow never raises a
   * dialog, so this record is the only thing distinguishing it from no gate.
   */
  it('records a decision nobody was asked about', () => {
    const parsed = projectDecisionEvent({
      requestId: 'req-2',
      surface: 'read',
      value: 'src/index.ts',
      result: 'allow',
      resolution: 'policy_allow',
    });
    expect(parsed).toMatchObject({ result: 'allow', resolution: 'policy_allow' });
  });

  /**
   * A word we do not recognise, rendered beside a tool call, reads as a real
   * verdict. `resolution` is passed through (it is a third-party enum that will
   * grow) but `result` is not — it is the allow/deny itself.
   */
  it('drops an unrecognised result but keeps an unrecognised resolution', () => {
    const parsed = projectDecisionEvent({
      ...DECISION,
      result: 'maybe',
      resolution: 'some_future_resolution',
    });
    expect(parsed && 'result' in parsed).toBe(false);
    expect(parsed).toMatchObject({ resolution: 'some_future_resolution' });
  });

  it('keeps a deny', () => {
    expect(
      projectDecisionEvent({ ...DECISION, result: 'deny', resolution: 'user_denied' })
    ).toMatchObject({ result: 'deny', resolution: 'user_denied' });
  });

  it('marks a decision made while serving a forwarded ask', () => {
    expect(
      projectDecisionEvent({ ...DECISION, forwarding: { requesterAgentName: 'researcher' } })
    ).toMatchObject({ forwarded: true, requesterAgentName: 'researcher' });
  });

  it('drops a record with no request id', () => {
    expect(projectDecisionEvent({ ...DECISION, requestId: undefined })).toBeUndefined();
  });
});

describe('createPermissionActivityObserver', () => {
  function fakePi() {
    const handlers = new Map<string, (data: unknown) => void>();
    return {
      pi: { events: { on: (c: string, h: (d: unknown) => void) => void handlers.set(c, h) } },
      handlers,
    };
  }

  it('subscribes to both channels and forwards what it projects', () => {
    const onActivity = vi.fn();
    const { pi, handlers } = fakePi();
    createPermissionActivityObserver({ onActivity })(pi);

    expect([...handlers.keys()]).toEqual([
      PERMISSIONS_UI_PROMPT_CHANNEL,
      PERMISSIONS_DECISION_CHANNEL,
    ]);

    handlers.get(PERMISSIONS_UI_PROMPT_CHANNEL)?.(PROMPT);
    handlers.get(PERMISSIONS_DECISION_CHANNEL)?.(DECISION);
    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(onActivity.mock.calls[0][0]).toMatchObject({ phase: 'prompt' });
    expect(onActivity.mock.calls[1][0]).toMatchObject({ phase: 'decision' });
  });

  it('forwards nothing for a broadcast it cannot project', () => {
    const onActivity = vi.fn();
    const { pi, handlers } = fakePi();
    createPermissionActivityObserver({ onActivity })(pi);
    handlers.get(PERMISSIONS_DECISION_CHANNEL)?.({ no: 'requestId' });
    expect(onActivity).not.toHaveBeenCalled();
  });

  /**
   * The plugin discards listener throws, so escaping here would lose the reason
   * and block nothing. It must be caught and logged instead.
   */
  it('never throws into the plugin when the consumer fails', () => {
    const log = vi.fn();
    const { pi, handlers } = fakePi();
    createPermissionActivityObserver({
      log,
      onActivity: () => {
        throw new Error('renderer gone');
      },
    })(pi);
    expect(() => handlers.get(PERMISSIONS_DECISION_CHANNEL)?.(DECISION)).not.toThrow();
    expect(log).toHaveBeenCalled();
  });

  /** No bus is a missing log line, not a reason to fail the whole bind. */
  it('degrades quietly when the SDK exposes no event bus', () => {
    const log = vi.fn();
    const observer = createPermissionActivityObserver({ onActivity: vi.fn(), log });
    expect(() => observer({})).not.toThrow();
    expect(() => observer({ events: {} })).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('survives a bus whose on() throws', () => {
    const log = vi.fn();
    const observer = createPermissionActivityObserver({ onActivity: vi.fn(), log });
    expect(() =>
      observer({
        events: {
          on: () => {
            throw new Error('bus closed');
          },
        },
      })
    ).not.toThrow();
    expect(log).toHaveBeenCalled();
  });
});
