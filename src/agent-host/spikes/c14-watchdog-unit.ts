/**
 * C-14 unit smoke: stall watchdog semantics in ClaudeRuntime.send.
 * Injects a fake SDK queryFn (ClaudeRuntimeOptions.queryFn test seam) — no
 * network. AICLIENT_HOST_STALL_TIMEOUT_MS=300 for fast scenarios.
 *
 * Scenarios:
 *   hang      — stream never yields → watchdog aborts → session.failed(stall)
 *   flowing   — events every 100ms → no kill → session.completed
 *   parked    — canUseTool permission pending across the stall window → spared;
 *               respond later → result → session.completed
 *   open-tool — tool.started with no result across the stall window → spared;
 *               tool_result + result later → session.completed
 *   retry-storm — only `system` control events flow (endless api_retry, the
 *               invalid-model signature) → still killed: non-productive
 *               events must not reset the watchdog
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c14-watchdog-unit.ts
 */

process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '300';

import { ClaudeRuntime } from '../claudeRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${message}`);
}

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string }
) => Promise<unknown>;

interface FakeQueryContext {
  canUseTool: CanUseToolFn;
  abort: AbortController;
}

/** Build a queryFn from a script that drives an event queue. */
function makeQueryFn(
  script: (push: (event: unknown) => void, end: () => void, ctx: FakeQueryContext) => void
) {
  return (params: { prompt: string; options?: Record<string, unknown> }) => {
    const options = params.options ?? {};
    const abort = options.abortController as AbortController;
    const canUseTool = options.canUseTool as CanUseToolFn;
    const queue: unknown[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const push = (event: unknown) => {
      queue.push(event);
      wake?.();
    };
    const end = () => {
      ended = true;
      wake?.();
    };
    abort.signal.addEventListener('abort', () => wake?.(), { once: true });
    script(push, end, { canUseTool, abort });
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            for (;;) {
              if (abort.signal.aborted) {
                // Mirror the real SDK: an aborted query surfaces as a throw.
                throw new Error('AbortError: aborted');
              }
              if (queue.length > 0) return { value: queue.shift(), done: false };
              if (ended) return { value: undefined, done: true };
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = null;
            }
          },
        };
      },
      close() {
        end();
      },
    };
  };
}

function makeRuntime(
  queryFn: ReturnType<typeof makeQueryFn>,
  events: Array<Record<string, unknown>>
): ClaudeRuntime {
  return new ClaudeRuntime({
    driver: 'agent-sdk',
    cliPath: 'unused-in-fake',
    env: {},
    emit: (event) => {
      events.push(event);
    },
    log: () => undefined,
    registry: new SessionRegistry(),
    queryFn,
  });
}

const has = (events: Array<Record<string, unknown>>, type: string) =>
  events.some((e) => e.type === type);
const payloadOf = (events: Array<Record<string, unknown>>, type: string) =>
  events.find((e) => e.type === type)?.payload as Record<string, unknown> | undefined;

async function main(): Promise<void> {
  const notes: string[] = [];

  // 1. hang — silent stream is killed with an explicit failed terminal.
  {
    const events: Array<Record<string, unknown>> = [];
    const rt = makeRuntime(
      makeQueryFn(() => {
        // never push, never end — pure silence
      }),
      events
    );
    rt.createSession({ sessionId: 's-hang', workspacePath: process.cwd() });
    const started = Date.now();
    await rt.send({ sessionId: 's-hang', text: 'hi' });
    const took = Date.now() - started;
    assert(has(events, 'session.failed'), 'hang: session.failed emitted');
    const err = String(payloadOf(events, 'session.failed')?.error ?? '');
    assert(err.includes('stall watchdog'), `hang: error mentions watchdog (got: ${err})`);
    assert(!has(events, 'session.stopped'), 'hang: no session.stopped (failed, not stopped)');
    assert(took < 5000, `hang: killed promptly (took ${took}ms)`);
    const statuses = events
      .filter((e) => e.type === 'session.status')
      .map((e) => (e.payload as { status: string }).status);
    assert(statuses[statuses.length - 1] === 'failed', 'hang: final status failed');
    notes.push(`hang killed in ${took}ms`);
  }

  // 2. flowing — events under the stall window are never killed.
  {
    const events: Array<Record<string, unknown>> = [];
    const rt = makeRuntime(
      makeQueryFn((push, end) => {
        void (async () => {
          push({ type: 'system', subtype: 'init', session_id: 'rt-flow' });
          for (let i = 0; i < 6; i += 1) {
            await sleep(100);
            push({
              type: 'assistant',
              message: { content: [{ type: 'text', text: `chunk${i} ` }] },
            });
          }
          push({ type: 'result', result: 'done' });
          end();
        })();
      }),
      events
    );
    rt.createSession({ sessionId: 's-flow', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's-flow', text: 'hi' });
    assert(has(events, 'session.completed'), 'flowing: completed');
    assert(!has(events, 'session.failed'), 'flowing: no failed');
    notes.push('flowing survived 6x100ms > 300ms total');
  }

  // 3. parked — pending permission across the stall window is spared.
  {
    const events: Array<Record<string, unknown>> = [];
    const rt = makeRuntime(
      makeQueryFn((push, end, ctx) => {
        void (async () => {
          push({ type: 'system', subtype: 'init', session_id: 'rt-park' });
          // Park on canUseTool — stream stays silent well past the stall
          // window while the user "thinks".
          const result = (await ctx.canUseTool(
            'Bash',
            { command: 'echo hi' },
            { signal: ctx.abort.signal, toolUseID: 'toolu_c14_perm' }
          )) as { behavior: string };
          push({
            type: 'assistant',
            message: { content: [{ type: 'text', text: `perm:${result.behavior}` }] },
          });
          push({ type: 'result', result: 'done' });
          end();
        })();
      }),
      events
    );
    rt.createSession({ sessionId: 's-park', workspacePath: process.cwd() });
    const sendDone = rt.send({ sessionId: 's-park', text: 'hi' });
    await sleep(900); // 3x the stall window with zero stream events
    assert(!has(events, 'session.failed'), 'parked: not killed while permission pending');
    assert(has(events, 'permission.requested'), 'parked: permission.requested emitted');
    const permissionId = String(payloadOf(events, 'permission.requested')?.permissionId);
    rt.respondPermission({ sessionId: 's-park', permissionId, allow: true });
    await sendDone;
    assert(has(events, 'session.completed'), 'parked: completed after respond');
    assert(!has(events, 'session.failed'), 'parked: still no failed');
    notes.push('parked permission spared across 900ms silence');
  }

  // 4. open-tool — in-flight local tool execution is spared.
  {
    const events: Array<Record<string, unknown>> = [];
    const rt = makeRuntime(
      makeQueryFn((push, end) => {
        void (async () => {
          push({ type: 'system', subtype: 'init', session_id: 'rt-tool' });
          push({
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: 'tool_c14_1', name: 'Bash', input: {} }],
            },
          });
          await sleep(900); // tool "runs" locally, stream silent past stall
          push({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'tool_c14_1', content: 'ok' }],
            },
          });
          push({ type: 'result', result: 'done' });
          end();
        })();
      }),
      events
    );
    rt.createSession({ sessionId: 's-tool', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's-tool', text: 'hi' });
    assert(has(events, 'tool.started'), 'open-tool: tool.started emitted');
    assert(has(events, 'tool.completed'), 'open-tool: tool.completed emitted');
    assert(!has(events, 'session.failed'), 'open-tool: not killed during tool run');
    assert(has(events, 'session.completed'), 'open-tool: completed');
    notes.push('open tool spared across 900ms silence');
  }

  // 5. retry-storm — a stream of system-only events (api_retry loop) is a
  //    hang in disguise: productive-event gating must still kill it.
  {
    const events: Array<Record<string, unknown>> = [];
    const rt = makeRuntime(
      makeQueryFn((push, _end, ctx) => {
        const pump = setInterval(() => {
          push({ type: 'system', subtype: 'api_retry', session_id: 'rt-storm' });
        }, 100);
        ctx.abort.signal.addEventListener('abort', () => clearInterval(pump), { once: true });
      }),
      events
    );
    rt.createSession({ sessionId: 's-storm', workspacePath: process.cwd() });
    const started = Date.now();
    await rt.send({ sessionId: 's-storm', text: 'hi' });
    const took = Date.now() - started;
    assert(has(events, 'session.failed'), 'retry-storm: session.failed emitted');
    const err = String(payloadOf(events, 'session.failed')?.error ?? '');
    assert(err.includes('stall watchdog'), 'retry-storm: watchdog error message');
    assert(took < 5000, `retry-storm: killed promptly despite flowing events (${took}ms)`);
    notes.push(`retry-storm killed in ${took}ms with system events flowing`);
  }

  console.log(JSON.stringify({ ok: true, notes }));
}

main().catch((err) => {
  console.error(err);
  console.log(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(2);
});
