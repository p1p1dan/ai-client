import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';

// No CLI is started: `query()` is replaced by a fake whose message stream the test feeds,
// so the runtime's real pump and ingest run on SDK messages shaped as 2.1.300 sends them.
// No process is sampled or signalled either (appendix B1): processTree is replaced too.
interface FakeQuery {
  options: Record<string, unknown>;
  push: (message: Record<string, unknown>) => void;
  end: () => void;
  setModel: ReturnType<typeof vi.fn>;
  applyFlagSettings: ReturnType<typeof vi.fn>;
}
const sdk = vi.hoisted(() => ({ queries: [] as FakeQuery[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionMessages: vi.fn(async () => []),
  query: ({ options }: { options: Record<string, unknown> }) => {
    const items: Array<Record<string, unknown>> = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const fake: FakeQuery = {
      options,
      push: (message) => {
        items.push(message);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
      setModel: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async () => {}),
    };
    sdk.queries.push(fake);
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (items.length > 0) yield items.shift();
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      },
      close: () => fake.end(),
      interrupt: vi.fn(async () => {}),
      setModel: fake.setModel,
      applyFlagSettings: fake.applyFlagSettings,
      setPermissionMode: vi.fn(async () => {}),
    };
  },
}));
vi.mock('../processTree.ts', () => ({
  sampleProcesses: vi.fn(async () => new Map()),
  descendantsOf: vi.fn(() => []),
  msysToolProcesses: vi.fn(async () => []),
  reap: vi.fn(() => []),
}));

const { ClaudeSdkSessionRuntime } = await import('../sdkSessionRuntime.ts');

const KEY = 'sk-fake-runtime-test-key';
const PINS = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18950', DISABLE_AUTOUPDATER: '1' };

let configDir = '';
let events: RuntimeEventDraft[] = [];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'ccsdk-runtime-test-'));
  events = [];
  sdk.queries.length = 0;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function runtime(model = 'gw/claude-opus-5-5') {
  return new ClaudeSdkSessionRuntime(
    {
      logicalSessionId: 'chat-1',
      cwd: configDir,
      model,
      projectTrusted: true,
      emit: (event) => events.push(event),
    },
    {
      configDir,
      settingSources: ['project'],
      cliEnv: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: PINS.ANTHROPIC_BASE_URL },
      settingsEnv: PINS,
      secrets: [KEY],
    },
    () => {}
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const statuses = () =>
  events
    .filter((e) => e.type === 'session.status')
    .map((e) => (e as Extract<RuntimeEventDraft, { type: 'session.status' }>).payload);

async function started() {
  const rt = runtime();
  await rt.bootstrap();
  const q = sdk.queries[0];
  return { rt, q };
}

async function send(
  rt: InstanceType<typeof ClaudeSdkSessionRuntime>,
  model = 'gw/claude-opus-5-5'
) {
  await rt.startSend({
    logicalSessionId: 'chat-1',
    requestId: 'req-1',
    attemptId: 'a-1',
    text: 'hi',
    model,
  });
}

describe('the CLI launch (decision 6)', () => {
  it('passes the pinned env in the flag tier and never the key there', async () => {
    const { rt, q } = await started();
    const settings = q.options.settings as { attribution: boolean; env: Record<string, string> };
    expect(settings).toEqual({ attribution: false, env: PINS });
    expect(JSON.stringify(settings)).not.toContain(KEY);
    // The key travels in the child's environment only.
    expect((q.options.env as Record<string, string>).ANTHROPIC_API_KEY).toBe(KEY);
    await rt.dispose();
  });

  it('never sends env through applyFlagSettings', async () => {
    const { rt, q } = await started();
    await rt.startSend({
      logicalSessionId: 'chat-1',
      requestId: 'req-1',
      attemptId: 'a-1',
      text: 'hi',
      effort: 'high',
    });
    expect(q.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'high' });
    for (const [patch] of q.applyFlagSettings.mock.calls) expect(patch).not.toHaveProperty('env');
    q.end();
    await rt.dispose();
  });
});

describe('background tasks on session.status (decision 8)', () => {
  it('reports the level without ambient tasks, under the open turn, and every status carries it', async () => {
    const { rt, q } = await started();
    await send(rt);
    q.push({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 't1', task_type: 'local_agent', description: 'child' },
        { task_id: 'w1', task_type: 'monitor', description: 'watch', ambient: true },
      ],
    });
    await flush();
    expect(statuses().at(-1)).toEqual({ status: 'running', backgroundTasks: 1 });
    q.push({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
    await flush();
    // The turn ends; the idle status still says one task runs.
    expect(events.some((e) => e.type === 'session.completed')).toBe(true);
    expect(statuses().at(-1)).toEqual({ status: 'idle', backgroundTasks: 1 });
    // The task finishes between turns: idle, back to 0.
    q.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await flush();
    expect(statuses().at(-1)).toEqual({ status: 'idle', backgroundTasks: 0 });
    // An unchanged level emits nothing.
    const count = statuses().length;
    q.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await flush();
    expect(statuses().length).toBe(count);
    q.end();
    await rt.dispose();
  });

  it('falls back to task_started / task_notification when the CLI never sends the level', async () => {
    const { rt, q } = await started();
    q.push({ type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_agent' });
    q.push({ type: 'system', subtype: 'task_started', task_id: 'a1', ambient: true });
    await flush();
    expect(statuses().at(-1)).toEqual({ status: 'idle', backgroundTasks: 1 });
    q.push({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' });
    await flush();
    expect(statuses().at(-1)).toEqual({ status: 'idle', backgroundTasks: 0 });
    q.end();
    await rt.dispose();
  });

  it('drops to 0 when the CLI process goes away', async () => {
    const { rt, q } = await started();
    q.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1' }] });
    await flush();
    expect(statuses().at(-1)?.backgroundTasks).toBe(1);
    q.end();
    await flush();
    expect(statuses().at(-1)).toEqual({ status: 'idle', backgroundTasks: 0 });
    await rt.dispose();
  });
});

describe('failed turns (decision 7)', () => {
  it('maps the CLI error result with the assistant error class, and never shows the CLI hint', async () => {
    const { rt, q } = await started();
    await send(rt);
    q.push({
      type: 'assistant',
      parent_tool_use_id: null,
      error: 'authentication_failed',
      message: { content: [{ type: 'text', text: 'Invalid API key · Fix external API key' }] },
    });
    q.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      terminal_reason: 'api_error',
      result: 'Invalid API key · Fix external API key',
    });
    await flush();
    const failed = events.find((e) => e.type === 'session.failed');
    expect(failed?.payload).toEqual({
      errorCode: 'PROVIDER_UNAUTHORIZED',
      error: 'Upstream request failed (HTTP 401)',
    });
    expect(statuses().at(-1)).toEqual({ status: 'idle', backgroundTasks: 0 });
    q.end();
    await rt.dispose();
  });

  it('a CLI that exits mid-turn fails it as claude_engine_exited', async () => {
    const { rt, q } = await started();
    await send(rt);
    q.end();
    await flush();
    const failed = events.find((e) => e.type === 'session.failed');
    expect(failed?.payload).toEqual({
      errorCode: 'claude_engine_exited',
      error: 'The Claude engine exited',
    });
    await rt.dispose();
  });

  it('signals of one turn do not leak into the next', async () => {
    const { rt, q } = await started();
    await send(rt);
    q.push({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1,
      error_status: 529,
      error: 'overloaded',
    });
    q.push({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
    await flush();
    events = [];
    await send(rt);
    q.push({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      errors: ['Reached maximum number of turns (1)'],
    });
    await flush();
    expect(events.find((e) => e.type === 'session.failed')?.payload).toEqual({
      error: 'The turn reached its step limit',
    });
    q.end();
    await rt.dispose();
  });

  it('a retry the gateway then answered does not decide how the same turn ends', async () => {
    const { rt, q } = await started();
    await send(rt);
    q.push({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1,
      error_status: 429,
      error: 'rate_limit',
    });
    // The retried request is answered: a new model step starts.
    q.push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'msg-1', usage: {} } },
    });
    q.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      api_error_status: null,
      errors: ['something internal'],
    });
    await flush();
    const failed = events.find((e) => e.type === 'session.failed');
    expect(failed).toBeDefined();
    expect((failed?.payload as { errorCode?: string } | undefined)?.errorCode).not.toBe(
      'PROVIDER_RATE_LIMITED'
    );
    q.end();
    await rt.dispose();
  });

  it('never writes the gateway key into its failure log', async () => {
    const lines: string[] = [];
    const rt = new ClaudeSdkSessionRuntime(
      {
        logicalSessionId: 'chat-1',
        cwd: configDir,
        model: 'gw/claude-opus-5-5',
        projectTrusted: true,
        emit: (event) => events.push(event),
      },
      {
        configDir,
        settingSources: ['project'],
        cliEnv: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: PINS.ANTHROPIC_BASE_URL },
        settingsEnv: PINS,
        secrets: [KEY],
      },
      (...args: unknown[]) => lines.push(args.map(String).join(' '))
    );
    await rt.bootstrap();
    const q = sdk.queries[0];
    await send(rt);
    // A gateway that echoes the key in its error, quoted by the CLI.
    q.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      result: `Failed to authenticate. API Error: 401 invalid x-api-key ${KEY}`,
    });
    await flush();
    const failureLog = lines.find((line) => line.includes('turn failed'));
    expect(failureLog).toBeDefined();
    expect(failureLog).not.toContain(KEY);
    q.end();
    await rt.dispose();
  });
});

describe('the stub model (S-1 contract)', () => {
  const stubModel = (rt: InstanceType<typeof ClaudeSdkSessionRuntime>) =>
    rt.bootstrap().then((boot) => JSON.parse(readFileSync(String(boot.sessionFile), 'utf8')).model);

  it('is written at create and follows a model switch the CLI took', async () => {
    const { rt, q } = await started();
    expect(await stubModel(rt)).toBe('gw/claude-opus-5-5');
    await send(rt, 'gw/claude-sonnet-5');
    expect(q.setModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(await stubModel(rt)).toBe('gw/claude-sonnet-5');
    q.end();
    await rt.dispose();
  });

  it('stays put when the CLI refuses the switch', async () => {
    const { rt, q } = await started();
    q.setModel.mockRejectedValueOnce(new Error('model refused'));
    await send(rt, 'gw/claude-sonnet-5');
    expect(await stubModel(rt)).toBe('gw/claude-opus-5-5');
    q.push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'm1', usage: {} } },
    });
    await flush();
    // The step is labelled with the model that really answered.
    const step = events.find((e) => e.type === 'message.started' && e.payload.role === 'assistant');
    expect(step?.payload).toMatchObject({ model: 'gw/claude-opus-5-5' });
    q.end();
    await rt.dispose();
  });
});
