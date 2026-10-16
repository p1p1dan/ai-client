import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import type { ResolvePath } from '../sdkSessionRuntime.ts';

// No CLI is started: `query()` is replaced by a fake whose message stream the test feeds,
// so the runtime's real pump and ingest run on SDK messages shaped as 2.1.300 sends them.
// No process is sampled or signalled either (appendix B1): processTree is replaced too.
interface FakeQuery {
  options: Record<string, unknown>;
  push: (message: Record<string, unknown>) => void;
  end: () => void;
  setModel: ReturnType<typeof vi.fn>;
  applyFlagSettings: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
}
/** `init`: what the next CLI's `initializationResult()` waits on (S-5 H-4); ready at once if unset. */
const sdk = vi.hoisted(() => ({
  queries: [] as FakeQuery[],
  init: null as Promise<unknown> | null,
}));

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
      setPermissionMode: vi.fn(async () => {}),
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
      setPermissionMode: fake.setPermissionMode,
      initializationResult: () => sdk.init ?? Promise.resolve({}),
    };
  },
}));
vi.mock('../processTree.ts', () => ({
  sampleProcesses: vi.fn(async () => new Map()),
  descendantsOf: vi.fn(() => []),
  msysToolProcesses: vi.fn(async () => []),
  reap: vi.fn(() => []),
}));

const { ClaudeSdkSessionRuntime, isUserHomeDir, launchSettingSources, userClaudeDirExcludes } =
  await import('../sdkSessionRuntime.ts');

const KEY = 'sk-fake-runtime-test-key';
const PINS = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18950', DISABLE_AUTOUPDATER: '1' };

let configDir = '';
let events: RuntimeEventDraft[] = [];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'ccsdk-runtime-test-'));
  events = [];
  sdk.queries.length = 0;
  sdk.init = null;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function runtime(
  model = 'gw/claude-opus-5-5',
  launch: {
    cwd?: string;
    projectTrusted?: boolean;
    settingSources?: Array<'user' | 'project' | 'local'>;
    homeDir?: string;
  } = {}
) {
  return new ClaudeSdkSessionRuntime(
    {
      logicalSessionId: 'chat-1',
      cwd: launch.cwd ?? configDir,
      model,
      projectTrusted: launch.projectTrusted ?? true,
      emit: (event) => events.push(event),
    },
    {
      configDir,
      settingSources: launch.settingSources ?? ['project'],
      cliEnv: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: PINS.ANTHROPIC_BASE_URL },
      settingsEnv: PINS,
      secrets: [KEY],
      ...(launch.homeDir ? { homeDir: launch.homeDir } : {}),
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
    // Ruling 20: plan mode is the CLI's own, Auto's check included (no pin).
    expect(settings).toEqual({
      attribution: false,
      env: PINS,
      claudeMdExcludes: userClaudeDirExcludes(configDir, [homedir()]),
    });
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

describe('project settings (S-3 P-1..P-7)', () => {
  /** A project directory apart from the config dir, so a mix-up of the two shows. */
  const project = () => {
    const dir = join(configDir, 'project');
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  /** No links anywhere: each path resolves to itself. */
  const asSpelled: ResolvePath = (target) => target;
  const slashed = (dir: string) => dir.replace(/\\/g, '/');

  it('a bound chat reads the user layer, the project and local settings, as a trusted workspace', async () => {
    const cwd = project();
    const rt = runtime(undefined, { cwd, settingSources: ['user', 'project', 'local'] });
    await rt.bootstrap();
    const { options } = sdk.queries[0];
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.workspaceTrust).toEqual({ accepted: true, directory: cwd });
    // Rulings 5, 18: hooks, allow rules and plugin marketplaces as the CLI has them.
    expect(options).not.toHaveProperty('managedSettings');
    await rt.dispose();
  });

  it('a scratch chat reads the user layer only and is not declared trusted', async () => {
    const rt = runtime(undefined, {
      cwd: project(),
      settingSources: ['user', 'project', 'local'],
      projectTrusted: false,
    });
    await rt.bootstrap();
    const { options } = sdk.queries[0];
    expect(options.settingSources).toEqual(['user']);
    expect(options).not.toHaveProperty('workspaceTrust');
    expect(options).not.toHaveProperty('managedSettings');
    await rt.dispose();
  });

  it('a chat bound to the home directory itself is opened as a scratch chat', async () => {
    const home = project();
    const rt = runtime(undefined, {
      cwd: home,
      settingSources: ['user', 'project', 'local'],
      homeDir: home,
    });
    await rt.bootstrap();
    const { options } = sdk.queries[0];
    expect(options.settingSources).toEqual(['user']);
    expect(options).not.toHaveProperty('workspaceTrust');
    await rt.dispose();
  });

  it("excludes both the user's and a stand-in home directory's .claude", async () => {
    const cwd = project();
    const home = join(configDir, 'fake-home');
    const rt = runtime(undefined, { cwd, homeDir: home });
    await rt.bootstrap();
    const settings = sdk.queries[0].options.settings as { claudeMdExcludes: string[] };
    expect(settings.claudeMdExcludes).toContain(`${slashed(home)}/.claude/**`);
    expect(settings.claudeMdExcludes).toEqual(userClaudeDirExcludes(cwd, [homedir(), home]));
    await rt.dispose();
  });

  it('a home directory reached through a link is excluded as the cwd spells it', () => {
    // Resolved first, so the only link in these paths is the one made here (macOS: /var).
    const base = realpathSync(configDir);
    const real = join(base, 'real-home');
    const link = join(base, 'linked-home');
    mkdirSync(join(real, 'repo'), { recursive: true });
    // A junction needs no privilege on Windows; the type is ignored elsewhere.
    symlinkSync(real, link, 'junction');
    // HOME is the link, the project is opened by its real path.
    expect(userClaudeDirExcludes(join(real, 'repo'), [link])).toEqual([
      `${slashed(link)}/.claude/**`,
      `${slashed(real)}/.claude/**`,
    ]);
    // HOME is the real path, the project is opened through the link.
    expect(userClaudeDirExcludes(join(link, 'repo'), [real])).toEqual([
      `${slashed(real)}/.claude/**`,
      `${slashed(link)}/.claude/**`,
    ]);
    expect(isUserHomeDir(link, [real])).toBe(true);
    expect(isUserHomeDir(join(link, 'repo'), [real])).toBe(false);
    expect(isUserHomeDir(join(base, 'missing'), [real])).toBe(false);
  });

  it('launchSettingSources: the configured sources, project and local only when trusted', () => {
    expect(launchSettingSources(['project', 'local'], true)).toEqual(['project', 'local']);
    expect(launchSettingSources(['project', 'local'], false)).toEqual([]);
    expect(launchSettingSources(['project', 'local'], undefined)).toEqual([]);
    expect(launchSettingSources(['user', 'project'], false)).toEqual(['user']);
    // Ruling 19: the user layer (the app's own config dir) holds for every chat.
    expect(launchSettingSources(['user', 'project', 'local'], true)).toEqual([
      'user',
      'project',
      'local',
    ]);
    expect(launchSettingSources([], true)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')(
    "userClaudeDirExcludes on Windows: the cwd's spelling, forward slashes",
    () => {
      const home = 'C:\\Users\\Ann';
      // Measured: the CLI matches case-sensitively against the cwd's own spelling.
      expect(userClaudeDirExcludes('c:\\Users\\Ann\\repo', [home], asSpelled)).toEqual([
        'C:/Users/Ann/.claude/**',
        'c:/Users/Ann/.claude/**',
      ]);
      expect(userClaudeDirExcludes('C:/USERS/ann/repo', ['C:\\Users\\Ann\\'], asSpelled)).toEqual([
        'C:/Users/Ann/.claude/**',
        'C:/USERS/ann/.claude/**',
      ]);
      expect(userClaudeDirExcludes(home, [home], asSpelled)).toEqual(['C:/Users/Ann/.claude/**']);
      // Not under the home directory (a sibling with the same prefix included).
      expect(userClaudeDirExcludes('c:\\users\\anna\\repo', [home], asSpelled)).toEqual([
        'C:/Users/Ann/.claude/**',
      ]);
      expect(userClaudeDirExcludes('D:\\work', [home], asSpelled)).toEqual([
        'C:/Users/Ann/.claude/**',
      ]);
      // A substituted drive for the home directory (`subst H: C:\Users\Ann`).
      const subst: ResolvePath = (target) =>
        /^h:/i.test(target) ? `${home}${target.slice(2).replace(/\\$/, '')}` : target;
      expect(userClaudeDirExcludes('H:\\repo', [home], subst)).toEqual([
        'C:/Users/Ann/.claude/**',
        'H:/.claude/**',
      ]);
      // Glob syntax in a folder name matches only itself.
      expect(
        userClaudeDirExcludes('C:\\Users\\Jane (Work)\\repo', ['C:\\Users\\Jane (Work)'], asSpelled)
      ).toEqual(['C:/Users/Jane [(]Work[)]/.claude/**']);
      expect(isUserHomeDir('c:\\users\\ann\\', [home], asSpelled)).toBe(true);
      expect(isUserHomeDir('C:\\Users\\Ann\\repo', [home], asSpelled)).toBe(false);
    }
  );

  it.runIf(process.platform !== 'win32')('userClaudeDirExcludes elsewhere: as spelled', () => {
    expect(userClaudeDirExcludes('/home/ann/repo', ['/home/ann/'], asSpelled)).toEqual([
      '/home/ann/.claude/**',
    ]);
    expect(userClaudeDirExcludes('/home/anna/repo', ['/home/ann'], asSpelled)).toEqual([
      '/home/ann/.claude/**',
    ]);
    // Case matters here: another directory.
    expect(userClaudeDirExcludes('/Home/ann/repo', ['/home/ann'], asSpelled)).toEqual([
      '/home/ann/.claude/**',
    ]);
    // `/home` a link to `/var/home` (ostree systems), HOME the real path.
    const varHome: ResolvePath = (target) => target.replace(/^\/home(?=\/|$)/, '/var/home');
    expect(userClaudeDirExcludes('/home/ann/repo', ['/var/home/ann'], varHome)).toEqual([
      '/var/home/ann/.claude/**',
      '/home/ann/.claude/**',
    ]);
    expect(userClaudeDirExcludes('/home/a{b}/repo', ['/home/a{b}'], asSpelled)).toEqual([
      '/home/a[{]b[}]/.claude/**',
    ]);
    expect(isUserHomeDir('/home/ann/', ['/home/ann'], asSpelled)).toBe(true);
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
      error: 'The Agent SDK engine exited',
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

// ---- Route B, S-2: permission modes (topic s2-permission-modes.md §3.1 items 1-5) ----

const { cliPermissionMode, permissionsForCliMode } = await import('../sdkSessionRuntime.ts');
type Posture = { mode: 'plan' | 'agent'; gear: 'ask' | 'accept-edits' | 'auto' | 'bypass' };

async function startedOn(permissions: Posture) {
  const rt = new ClaudeSdkSessionRuntime(
    {
      logicalSessionId: 'chat-1',
      cwd: configDir,
      model: 'gw/claude-opus-5-5',
      projectTrusted: true,
      permissions,
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
  await rt.bootstrap();
  return { rt, q: sdk.queries[0] as FakeQuery };
}

type CanUse = (
  toolName: string,
  input: Record<string, unknown>,
  opts: Record<string, unknown>
) => Promise<Record<string, unknown>>;
const canUse = (q: FakeQuery) => q.options.canUseTool as CanUse;
const toolOpts = (toolUseID: string) => ({
  toolUseID,
  signal: new AbortController().signal,
  suggestions: [],
});
const ofType = <T extends RuntimeEventDraft['type']>(type: T) =>
  events.filter((e) => e.type === type) as Extract<RuntimeEventDraft, { type: T }>[];
/** A promise whose settling the test decides. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('the five modes (S-2 A-1)', () => {
  const PAIRS: Array<[Posture, string]> = [
    [{ mode: 'agent', gear: 'ask' }, 'default'],
    [{ mode: 'agent', gear: 'accept-edits' }, 'acceptEdits'],
    [{ mode: 'plan', gear: 'auto' }, 'plan'],
    [{ mode: 'plan', gear: 'ask' }, 'plan'],
    [{ mode: 'agent', gear: 'auto' }, 'auto'],
    [{ mode: 'agent', gear: 'bypass' }, 'bypassPermissions'],
  ];

  it('maps each stored pair to one CLI mode, Auto to the CLI auto mode', () => {
    for (const [pair, mode] of PAIRS)
      expect(cliPermissionMode(pair), JSON.stringify(pair)).toBe(mode);
  });

  it('maps every CLI mode back to the pair the composer stores, and none it never sets', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']) {
      const pair = permissionsForCliMode(mode);
      expect(pair && cliPermissionMode(pair), mode).toBe(mode);
    }
    expect(permissionsForCliMode('plan')).toEqual({ mode: 'plan', gear: 'auto' });
    expect(permissionsForCliMode('dontAsk')).toBeNull();
  });

  it('launches the CLI on the mode the chat comes up on', async () => {
    for (const [pair, mode] of PAIRS) {
      sdk.queries.length = 0;
      const { rt, q } = await startedOn(pair);
      expect(q.options.permissionMode, JSON.stringify(pair)).toBe(mode);
      expect(q.options.allowDangerouslySkipPermissions).toBe(true);
      await rt.dispose();
    }
  });
});

describe('what reaches canUseTool is never answered by the host (S-2 A-2, ruling 20)', () => {
  it('in plan mode, on any gear, a change the CLI asks about is the user card (official)', async () => {
    for (const pair of [
      { mode: 'plan', gear: 'auto' },
      { mode: 'plan', gear: 'bypass' },
      { mode: 'plan', gear: 'ask' },
    ] as Posture[]) {
      sdk.queries.length = 0;
      events = [];
      const { rt, q } = await startedOn(pair);
      const settled: string[] = [];
      for (const [tool, input] of [
        ['Write', { file_path: join(configDir, 'x.txt'), content: 'x' }],
        ['Bash', { command: 'mkdir build' }],
      ] as const) {
        void canUse(q)(tool, input, toolOpts(`t-${tool}`)).then(() => settled.push(tool));
      }
      await flush();
      expect(
        ofType('permission.requested').map((e) => e.payload.toolName),
        JSON.stringify(pair)
      ).toEqual(['Write', 'Bash']);
      expect(settled, JSON.stringify(pair)).toEqual([]);
      await rt.dispose();
    }
  });

  it('in every other mode, a card, never an allow of its own (Auto and Bypass too)', async () => {
    for (const pair of [
      { mode: 'agent', gear: 'ask' },
      { mode: 'agent', gear: 'accept-edits' },
      { mode: 'agent', gear: 'auto' },
      { mode: 'agent', gear: 'bypass' },
    ] as Posture[]) {
      sdk.queries.length = 0;
      events = [];
      const { rt, q } = await startedOn(pair);
      let settled = false;
      void canUse(q)(
        'Write',
        { file_path: join(configDir, 'x.txt'), content: 'x' },
        toolOpts('t-1')
      ).then(() => {
        settled = true;
      });
      await flush();
      expect(ofType('permission.requested'), JSON.stringify(pair)).toHaveLength(1);
      expect(settled, JSON.stringify(pair)).toBe(false);
      await rt.dispose();
    }
  });
});

describe('mode switches (S-2 A-3, A-5)', () => {
  it('waits for the CLI to take the mode before it counts', async () => {
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'ask' });
    const answer = deferred();
    q.setPermissionMode.mockImplementationOnce(() => answer.promise);
    let done = false;
    const switching = rt.setPermissions({ mode: 'agent', gear: 'auto' }).then(() => {
      done = true;
    });
    await flush();
    expect(q.setPermissionMode).toHaveBeenCalledWith('auto');
    expect(done).toBe(false);
    answer.resolve();
    await switching;
    expect(done).toBe(true);
    // The CLI's report of the mode it took is not a change of its own.
    q.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'auto' });
    await flush();
    expect(ofType('session.permissions')).toEqual([]);
    await rt.dispose();
  });

  it('a refused mode fails the request with our code and reason, and the mode stays', async () => {
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'ask' });
    // As 2.1.300 rejects (s2 topic §4.1): the code in `errorCode`, never in the message.
    q.setPermissionMode.mockRejectedValueOnce(
      Object.assign(
        new Error('Cannot set permission mode to auto: auto mode unavailable for this model'),
        {
          errorClass: 'control_request_failed',
          errorCode: 'auto_mode_model',
        }
      )
    );
    const failure = await rt.setPermissions({ mode: 'agent', gear: 'auto' }).catch((e) => e);
    expect(failure).toMatchObject({
      code: 'WORKER_PERMISSION_MODE_REFUSED',
      message: 'auto_mode_model',
    });
    // Never the CLI's own sentence.
    expect(String(failure.message)).not.toContain('unavailable for this model');
    q.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
    await flush();
    expect(ofType('session.permissions')).toEqual([]);
    // Still Manual: the next switch starts from it.
    await rt.setPermissionGear('accept-edits');
    expect(q.setPermissionMode).toHaveBeenLastCalledWith('acceptEdits');
    await rt.dispose();
  });

  it('a switch the CLI does not answer in 8 s fails as `timeout`; a late take is followed (README §9.2 #34)', async () => {
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'ask' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Queued behind a slow request (e.g. a stop on Windows): no answer in time.
      q.setPermissionMode.mockImplementationOnce(() => new Promise<void>(() => {}));
      const failure = rt.setPermissions({ mode: 'agent', gear: 'auto' }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(7_999);
      expect(ofType('session.permissions')).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await failure).toMatchObject({
        code: 'WORKER_PERMISSION_MODE_REFUSED',
        message: 'timeout',
      });
      // Manual is still what PiLab holds: the next switch starts from it.
      await rt.setPermissionGear('accept-edits');
      expect(q.setPermissionMode).toHaveBeenLastCalledWith('acceptEdits');
      // The CLI took the timed-out mode after all, after the newer one: its report wins,
      // so PiLab and the CLI agree again (and say so).
      q.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'auto' });
      await vi.advanceTimersByTimeAsync(0);
      expect(ofType('session.permissions').map((e) => e.payload)).toEqual([
        { permissions: { mode: 'agent', gear: 'auto' }, cause: 'engine' },
      ]);
    } finally {
      vi.useRealTimers();
    }
    await rt.dispose();
  });

  it('a switch before the CLI is ready is taken at once and sent when it is (S-5 H-4, #42)', async () => {
    const ready = deferred();
    sdk.init = ready.promise;
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'ask' });
    // Answered at once: Main's budget never meets a slow start.
    await rt.setPermissions({ mode: 'agent', gear: 'accept-edits' });
    await rt.setPermissions({ mode: 'agent', gear: 'auto' });
    expect(q.setPermissionMode).not.toHaveBeenCalled();
    // The CLI reports the mode it started on meanwhile: not a change of its own.
    q.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
    await flush();
    expect(ofType('session.permissions')).toEqual([]);
    ready.resolve();
    await flush();
    // Only the last mode picked is sent, once.
    expect(q.setPermissionMode.mock.calls).toEqual([['auto']]);
    expect(ofType('session.permissions')).toEqual([]);
    // The next switch goes straight to the CLI again.
    await rt.setPermissionGear('ask');
    expect(q.setPermissionMode).toHaveBeenLastCalledWith('default');
    await rt.dispose();
  });

  it('a mode the CLI refuses once ready is taken back, with its reason (S-5 H-4)', async () => {
    const ready = deferred();
    sdk.init = ready.promise;
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'ask' });
    q.setPermissionMode.mockRejectedValueOnce(
      Object.assign(new Error('Cannot set permission mode to bypassPermissions'), {
        errorCode: 'bypass_disabled',
      })
    );
    await rt.setPermissions({ mode: 'agent', gear: 'bypass' });
    ready.resolve();
    await flush();
    expect(ofType('session.permissions').map((e) => e.payload)).toEqual([
      {
        permissions: { mode: 'agent', gear: 'ask' },
        cause: 'engine',
        refusedReason: 'bypass_disabled',
      },
    ]);
    // Manual is what PiLab holds again: the next switch starts from it.
    await rt.setPermissionGear('accept-edits');
    expect(q.setPermissionMode).toHaveBeenLastCalledWith('acceptEdits');
    await rt.dispose();
  });

  it('a refusal it cannot name is `other`', async () => {
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'ask' });
    q.setPermissionMode.mockRejectedValueOnce(new Error('something else'));
    await expect(rt.setPermissions({ mode: 'agent', gear: 'bypass' })).rejects.toMatchObject({
      code: 'WORKER_PERMISSION_MODE_REFUSED',
      message: 'other',
    });
    await rt.dispose();
  });

  it('leaves a card already up to the user when the mode widens', async () => {
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'ask' });
    let settled = false;
    void canUse(q)('Bash', { command: 'rm -rf build' }, toolOpts('t-2')).then(() => {
      settled = true;
    });
    await flush();
    await rt.setPermissionGear('bypass');
    await rt.setPermissions({ mode: 'agent', gear: 'auto' });
    await flush();
    expect(settled).toBe(false);
    expect(ofType('permission.resolved')).toEqual([]);
    await rt.dispose();
  });

  it('with no CLI running, the next launch starts on the mode', async () => {
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'ask' });
    q.end();
    await flush();
    await rt.setPermissions({ mode: 'agent', gear: 'accept-edits' });
    expect(q.setPermissionMode).not.toHaveBeenCalled();
    await send(rt);
    expect(sdk.queries[1]?.options.permissionMode).toBe('acceptEdits');
    await rt.dispose();
  });
});

describe('the CLI changes its own mode (S-2 A-6)', () => {
  it('reports a mode it entered by itself as `engine`, in the pair the composer stores', async () => {
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'accept-edits' });
    q.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' });
    await flush();
    expect(ofType('session.permissions').map((e) => e.payload)).toEqual([
      { permissions: { mode: 'plan', gear: 'auto' }, cause: 'engine' },
    ]);
    // Said once: the same report again changes nothing.
    q.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' });
    await flush();
    expect(ofType('session.permissions')).toHaveLength(1);
    await rt.dispose();
  });

  it('reads the mode the CLI came up on (init), and ignores a mode it never sets', async () => {
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'auto' });
    q.push({ type: 'system', subtype: 'init', permissionMode: 'default', slash_commands: [] });
    await flush();
    expect(ofType('session.permissions').map((e) => e.payload.permissions)).toEqual([
      { mode: 'agent', gear: 'ask' },
    ]);
    q.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'dontAsk' });
    await flush();
    expect(ofType('session.permissions')).toHaveLength(1);
    await rt.dispose();
  });

  it('takes no report as a change while a switch of its own is in flight', async () => {
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'ask' });
    const answer = deferred();
    q.setPermissionMode.mockImplementationOnce(() => answer.promise);
    const switching = rt.setPermissions({ mode: 'agent', gear: 'bypass' });
    await flush();
    q.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
    await flush();
    expect(ofType('session.permissions')).toEqual([]);
    answer.resolve();
    await switching;
    await flush();
    expect(ofType('session.permissions')).toEqual([]);
    await rt.dispose();
  });
});

describe('the plan review on this engine (S-2 A-7)', () => {
  async function reviewUp(q: FakeQuery) {
    const allowed = canUse(q)('ExitPlanMode', { plan: '# Ship it\n\n1. step' }, toolOpts('t-plan'));
    // The host waits up to 2 s for the streamed plan before it raises the card.
    for (let i = 0; i < 300 && ofType('question.requested').length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 10));
    const card = ofType('question.requested')[0];
    return { allowed, card };
  }

  it('offers the modes to continue in, no goals, Edit automatically first', async () => {
    const { rt, q } = await startedOn({ mode: 'plan', gear: 'auto' });
    const { card } = await reviewUp(q);
    expect(card?.payload.review?.choices).toEqual([
      'run:accept-edits',
      'run:ask',
      'run:auto',
      'run:bypass',
      'keep-planning',
    ]);
    await rt.dispose();
  }, 10_000);

  it('an approval switches to the chosen mode before the CLI hears it, and says so at once', async () => {
    const { rt, q } = await startedOn({ mode: 'plan', gear: 'auto' });
    const { allowed, card } = await reviewUp(q);
    const questionId = card?.payload.questionId as string;
    expect(rt.respondQuestion({ questionId, answers: { 'plan-review': 'run:accept-edits' } })).toBe(
      true
    );
    expect(q.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(ofType('session.permissions').map((e) => e.payload)).toEqual([
      { permissions: { mode: 'agent', gear: 'accept-edits' }, cause: 'plan-approved', questionId },
    ]);
    await expect(allowed).resolves.toMatchObject({ behavior: 'allow' });
    await rt.dispose();
  }, 10_000);

  it('a mode the CLI refused after an approval is corrected by its own report', async () => {
    const { rt, q } = await startedOn({ mode: 'plan', gear: 'auto' });
    const { card } = await reviewUp(q);
    q.setPermissionMode.mockRejectedValueOnce(
      Object.assign(new Error('Cannot set permission mode to auto'), {
        errorCode: 'auto_mode_model',
      })
    );
    rt.respondQuestion({
      questionId: card?.payload.questionId as string,
      answers: { 'plan-review': 'run:auto' },
    });
    // Leaving plan mode put the CLI back on the mode before it.
    q.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
    await flush();
    await flush();
    expect(
      ofType('session.permissions').map((e) => [e.payload.cause, e.payload.permissions])
    ).toEqual([
      ['plan-approved', { mode: 'agent', gear: 'auto' }],
      ['engine', { mode: 'agent', gear: 'ask' }],
    ]);
    await rt.dispose();
  }, 10_000);

  it('a goal choice is not one this card offers: the review closes', async () => {
    const { rt, q } = await startedOn({ mode: 'plan', gear: 'auto' });
    const { allowed, card } = await reviewUp(q);
    rt.respondQuestion({
      questionId: card?.payload.questionId as string,
      answers: { 'plan-review': 'goal:auto' },
    });
    await expect(allowed).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    expect(q.setPermissionMode).not.toHaveBeenCalled();
    expect(ofType('session.permissions')).toEqual([]);
    await rt.dispose();
  }, 10_000);
});

// ---- Route B, S-2 review fixes ----

const { cliRefusalText } = await import('../sdkSessionRuntime.ts');

describe('plan mode is the CLI own (ruling 20, official behaviour)', () => {
  it('no plan-mode pin, no hook and no policy tier of PiLab', async () => {
    const { rt, q } = await startedOn({ mode: 'plan', gear: 'auto' });
    expect(q.options.settings).not.toHaveProperty('useAutoModeDuringPlan');
    expect(q.options).not.toHaveProperty('hooks');
    expect(q.options).not.toHaveProperty('managedSettings');
    expect(q.options.permissionMode).toBe('plan');
    await rt.dispose();
  });

  it('a read outside the workspace, a web fetch and an edit are all the user cards', async () => {
    const { rt, q } = await startedOn({ mode: 'plan', gear: 'auto' });
    const settled: string[] = [];
    for (const [tool, input] of [
      ['Read', { file_path: join(tmpdir(), 'outside.txt') }],
      ['WebFetch', { url: 'http://127.0.0.1:1/docs', prompt: 'read' }],
      ['Edit', { file_path: join(configDir, 'x.txt') }],
    ] as const) {
      void canUse(q)(tool, input, toolOpts(`t-${tool}`)).then(() => settled.push(tool));
    }
    await flush();
    expect(ofType('permission.requested').map((e) => e.payload.toolName)).toEqual([
      'Read',
      'WebFetch',
      'Edit',
    ]);
    expect(settled).toEqual([]);
    await rt.dispose();
  });
});

describe('an approval whose mode the CLI refuses (S-2 A-7, review)', () => {
  async function approveWithRefusal(firstAnswer: 'reject' | 'reject-both') {
    const { rt, q } = await startedOn({ mode: 'plan', gear: 'auto' });
    // The CLI reported plan mode for the turn; it put Bypass permissions away as the earlier mode.
    q.push({ type: 'system', subtype: 'init', permissionMode: 'plan', slash_commands: [] });
    await flush();
    const allowed = canUse(q)('ExitPlanMode', { plan: '# Ship it' }, toolOpts('t-plan'));
    for (let i = 0; i < 300 && ofType('question.requested').length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 10));
    const card = ofType('question.requested')[0];
    q.setPermissionMode.mockRejectedValueOnce(
      Object.assign(new Error('Cannot set permission mode to auto'), {
        errorCode: 'auto_mode_model',
      })
    );
    if (firstAnswer === 'reject-both') q.setPermissionMode.mockRejectedValueOnce(new Error('no'));
    rt.respondQuestion({
      questionId: card?.payload.questionId as string,
      answers: { 'plan-review': 'run:auto' },
    });
    return { rt, q, allowed };
  }

  it('runs the plan in Manual, says why, and only then lets the CLI leave plan mode', async () => {
    const { rt, q, allowed } = await approveWithRefusal('reject');
    await expect(allowed).resolves.toMatchObject({ behavior: 'allow' });
    expect(q.setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(['auto', 'default']);
    expect(ofType('session.permissions').map((e) => e.payload)).toEqual([
      expect.objectContaining({
        cause: 'plan-approved',
        permissions: { mode: 'agent', gear: 'auto' },
      }),
      {
        cause: 'engine',
        permissions: { mode: 'agent', gear: 'ask' },
        refusedReason: 'auto_mode_model',
      },
    ]);
    // Its own report of Manual changes nothing more.
    q.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });
    await flush();
    expect(ofType('session.permissions')).toHaveLength(2);
    await rt.dispose();
  }, 10_000);

  it('if even Manual is refused, the plan does not run and the chat stays in plan mode', async () => {
    const { rt, allowed } = await approveWithRefusal('reject-both');
    await expect(allowed).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    expect(ofType('session.permissions').at(-1)?.payload).toEqual({
      cause: 'engine',
      permissions: { mode: 'plan', gear: 'auto' },
      refusedReason: 'auto_mode_model',
    });
    await rt.dispose();
  }, 10_000);
});

describe('CLI refusals in our words (S-2 A-18, review)', () => {
  const BLOCK =
    "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Irreversible Local Destruction]. If it keeps failing, continue with other tasks that don't require this action and come back to it later.";
  const DOWN =
    'claude-opus-5-5 is temporarily unavailable, so auto mode cannot determine the safety of Bash right now. Wait a moment and then try this action again.';

  async function toolTurn() {
    const { rt, q } = await started();
    await send(rt);
    q.push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: 'm1', usage: {} } },
    });
    q.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'node -e 1' } }],
      },
    });
    await flush();
    return { rt, q };
  }
  const result = (q: FakeQuery, content: string) =>
    q.push({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content }],
      },
    });
  const completed = () => ofType('tool.completed').at(-1)?.payload;

  it('a classifier refusal with its event: refused, the reason kept, never the CLI sentence', async () => {
    const { rt, q } = await toolTurn();
    q.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_use_id: 'tu1',
      tool_name: 'Bash',
      decision_reason_type: 'classifier',
      decision_reason: '[Irreversible Local Destruction]',
      message: BLOCK,
    });
    result(q, BLOCK);
    await flush();
    const text = "Auto mode's safety check blocked this call: [Irreversible Local Destruction].";
    expect(completed()).toMatchObject({
      ok: false,
      output: { content: [{ type: 'text', text }], details: { refused: true } },
      error: text,
    });
    expect(JSON.stringify(completed())).not.toMatch(/claude code/i);
    q.end();
    await rt.dispose();
  });

  it('the sentence alone (no event) and the check being down read our way too', async () => {
    const { rt, q } = await toolTurn();
    result(q, DOWN);
    await flush();
    expect(completed()?.error).toBe(
      "Auto mode's safety check was not available, so this call did not run."
    );
    expect(JSON.stringify(completed())).not.toMatch(/claude code/i);
    q.end();
    await rt.dispose();
  });

  it('an unrelated failure passes through unchanged', async () => {
    const { rt, q } = await toolTurn();
    result(q, 'Exit code 1: boom');
    await flush();
    expect(completed()?.error).toBe('Exit code 1: boom');
    q.end();
    await rt.dispose();
  });

  it('a safety-check reason naming the product reads naturally', () => {
    for (const reason of [
      'This writes to the Claude Code shell-snapshots folder. Each Bash command first runs a file from there, without asking anyone.',
      'This writes to the Claude Code session-env folder. Claude Code runs the scripts there ahead of Bash commands, without asking anyone.',
    ]) {
      const text = cliRefusalText('safetyCheck', reason);
      expect(text).not.toMatch(/claude code/i);
      expect(text).not.toMatch(/\bthe the\b/i);
      expect(text).not.toMatch(/\.\.$/);
      expect(text).not.toMatch(/\. the agent/);
    }
    expect(cliRefusalText('mode', undefined)).toBe('The permission settings refused this call.');
  });

  it('a reopened chat shows the refusal as it did live', async () => {
    const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
    const rt = runtime();
    await rt.bootstrap();
    (rt as unknown as { stub: { started: boolean } }).stub.started = true;
    vi.mocked(getSessionMessages).mockResolvedValueOnce([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'node -e 1' } }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: BLOCK }],
        },
      },
    ] as never);
    const page = await rt.history({ logicalSessionId: 'chat-1', offset: 0, limit: 80 });
    expect(JSON.stringify(page)).not.toMatch(/claude code/i);
    expect(JSON.stringify(page)).toContain("Auto mode's safety check blocked this call");
    await rt.dispose();
  });
});

describe('the card offers what the CLI will remember (review)', () => {
  it('no "Allow for session" when the CLI has no rule to keep', async () => {
    const { rt, q } = await startedOn({ mode: 'agent', gear: 'ask' });
    void canUse(q)('Bash', { command: 'rm -rf build' }, { ...toolOpts('t-1'), suggestions: [] });
    void canUse(q)(
      'Bash',
      { command: 'rm -rf dist' },
      {
        ...toolOpts('t-2'),
        suppressAlwaysAllowRule: true,
        suggestions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }],
      }
    );
    void canUse(q)(
      'Bash',
      { command: 'touch x' },
      {
        ...toolOpts('t-3'),
        suggestions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }],
      }
    );
    await flush();
    expect(ofType('permission.requested').map((e) => e.payload.decisions)).toEqual([
      ['allow', 'deny'],
      ['allow', 'deny'],
      ['allow', 'allow_session', 'deny'],
    ]);
    await rt.dispose();
  });
});
