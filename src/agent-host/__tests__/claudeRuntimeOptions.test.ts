import { describe, expect, it } from 'vitest';
import { ClaudeRuntime, normalizeEffort } from '../claudeRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';

/**
 * #8 behavior lock: the exact `thinking` / `effort` options ClaudeRuntime hands
 * to the Agent SDK query().
 *
 * Why assert options rather than output: `pnpm typecheck` excludes
 * src/agent-host/, and the two defects behind #8 were both silent — a wrong
 * `thinking` shape is a runtime 400, and a missing `display` yields thinking
 * blocks with empty text and no error at all. Neither surfaces in a type check
 * or in a smoke that only asserts "a turn completed", so the option payload is
 * pinned here deterministically (standard #4, assert the process first).
 *
 * Shapes verified live by spikes/c16-thinking-shape-probe.ts against the CCH
 * gateway on claude-opus-4-8[1m] (SDK 0.3.218): {type:'adaptive'} alone yields
 * thinkingTextLen 0, while adding display:'summarized' yields 408.
 */

type CapturedOptions = Record<string, unknown>;

/** Minimal fake query() that records options and closes the turn immediately. */
function makeCapturingQueryFn(captured: CapturedOptions[]) {
  return (params: { prompt: string | AsyncIterable<unknown>; options?: CapturedOptions }) => {
    captured.push(params.options ?? {});
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'rt-opts' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'result', subtype: 'success', result: 'ok' };
      },
      close() {
        /* nothing to tear down */
      },
    };
  };
}

function makeRuntime(captured: CapturedOptions[]): ClaudeRuntime {
  return new ClaudeRuntime({
    driver: 'agent-sdk',
    cliPath: 'unused-in-fake',
    env: {},
    emit: () => undefined,
    log: () => undefined,
    registry: new SessionRegistry(),
    queryFn: makeCapturingQueryFn(captured),
  });
}

describe('claudeRuntime query options — thinking shape (#8)', () => {
  it('sends adaptive thinking with summarized display', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's1', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's1', text: 'hi' });

    expect(captured).toHaveLength(1);
    // display is the load-bearing half: without it thinking text is empty.
    expect(captured[0].thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('never sends the removed fixed-budget thinking shape', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's2', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's2', text: 'hi' });

    const thinking = captured[0].thinking as Record<string, unknown>;
    // `{type:'enabled', budgetTokens}` is deprecated on Opus 4.6/Sonnet 4.6 and
    // removed on Opus 4.8/4.7, Sonnet 5, Fable 5 — a latent 400.
    expect(thinking.type).not.toBe('enabled');
    expect(thinking).not.toHaveProperty('budgetTokens');
  });

  it('omits effort entirely when none is configured', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's3', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's3', text: 'hi' });

    // Absent (not undefined) so the model default applies.
    expect(captured[0]).not.toHaveProperty('effort');
  });
});

describe('claudeRuntime query options — effort threading (T-20 base)', () => {
  it('applies the session default effort from session.create', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's4', workspacePath: process.cwd(), effort: 'high' });
    await rt.send({ sessionId: 's4', text: 'hi' });

    // Top-level option — NOT output_config.effort (SDK 0.3.218 Options.effort).
    expect(captured[0].effort).toBe('high');
    expect(captured[0]).not.toHaveProperty('output_config');
  });

  it('lets a per-send effort override the session default', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's5', workspacePath: process.cwd(), effort: 'low' });
    await rt.send({ sessionId: 's5', text: 'hi', effort: 'xhigh' });

    expect(captured[0].effort).toBe('xhigh');
  });

  it('falls back to the session default when a send omits effort', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's6', workspacePath: process.cwd(), effort: 'medium' });
    await rt.send({ sessionId: 's6', text: 'hi' });

    expect(captured[0].effort).toBe('medium');
  });

  it('drops an unknown effort value instead of forwarding it to the API', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    // Raw NDJSON from Main is untrusted; a bogus level must not reach query().
    rt.createSession({ sessionId: 's7', workspacePath: process.cwd(), effort: 'ludicrous' });
    await rt.send({ sessionId: 's7', text: 'hi', effort: 42 });

    expect(captured[0]).not.toHaveProperty('effort');
  });

  it('keeps the session default when a send carries an invalid override', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's8', workspacePath: process.cwd(), effort: 'high' });
    await rt.send({ sessionId: 's8', text: 'hi', effort: 'turbo' });

    expect(captured[0].effort).toBe('high');
  });
});

describe('normalizeEffort', () => {
  it('accepts every level the SDK declares', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(normalizeEffort(level)).toBe(level);
    }
  });

  it('rejects unknown, empty, and non-string values', () => {
    for (const bad of ['', 'HIGH', 'ultra', 0, 1, null, undefined, {}, ['high'], true]) {
      expect(normalizeEffort(bad)).toBeUndefined();
    }
  });
});
