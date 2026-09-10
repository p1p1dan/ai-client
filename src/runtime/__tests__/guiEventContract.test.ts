import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PiWorkerRpcServer } from '../../agent-host/piWorkerRpcServer.ts';
import type { RuntimeEvent } from '../../shared/types/runtimeEvents.ts';
import {
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerRpcResponse,
} from '../../shared/types/workerRpc.ts';
import { createRuntime } from '../bootstrap.ts';
import type { RuntimeHostConfig } from '../contracts.ts';
import { NativeWorkerRuntime } from '../worker/nativeWorkerRuntime.ts';

/**
 * P4-5, runtime half — the event stream a GUI session actually receives.
 *
 * The renderer is not reached from here: `src/renderer` is outside this
 * package's type-check gate (it has no `@shared` path mapping and no DOM lib),
 * and importing a zustand store into the runtime program would break
 * `typecheck:runtime` for everyone. So the two halves meet on a FIXTURE instead:
 * this file records what the native backend emits, and
 * `src/renderer/stores/__tests__/nativeStreamReplay.test.ts` replays that exact
 * recording through the real reducers to assert what the user ends up seeing.
 *
 * The fixture is normalized (see `normalize`) so it says what the GUI depends on
 * and nothing else — a re-recorded token count or a temp directory must not fail
 * a timeline test. Everything the renderer reads survives verbatim.
 *
 * Regenerate with `AICLIENT_UPDATE_FIXTURES=1 pnpm vitest run guiEventContract`,
 * and read the diff before committing it: a field that vanishes here is a field
 * the GUI stops receiving.
 */

const FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  'shared',
  '__tests__',
  'fixtures',
  'nativeGuiEventStream.json'
);
const HOST: RuntimeHostConfig = {
  carrier: 'electron-utility',
  tsdReadFallback: 'disabled',
  exec: { mode: 'pipe' },
  childEnv: {},
  cleanupTimeoutMs: 2000,
};
const MODEL = 'faux/faux-e2e';
const SESSION = 'logical-gui';

let workspace: string;
let agentDir: string;
let server: PiWorkerRpcServer | undefined;
let faux: ReturnType<typeof fauxProvider>;
let outbound: unknown[];

function responses(): WorkerRpcResponse[] {
  return outbound.filter(
    (message): message is WorkerRpcResponse => (message as { kind?: string }).kind === 'response'
  );
}
function events(): RuntimeEvent[] {
  return outbound
    .filter((message) => (message as { type?: string }).type === 'runtime.event')
    .map((message) => (message as { payload: RuntimeEvent }).payload);
}

/** Every context the provider was handed, so a dropped attachment is provable. */
let providerContexts: unknown[];

let requestSequence = 0;
async function call<T>(type: string, payload: unknown): Promise<T> {
  const requestId = `rpc-${++requestSequence}`;
  server?.receive({
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    kind: 'request',
    generation: 1,
    requestId,
    type,
    payload,
  });
  const response = await waitFor(
    () => responses().find((item) => item.requestId === requestId),
    `response to ${type}`
  );
  if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
  return response.result as T;
}

async function waitFor<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replace the temp workspace with `<workspace>`, in both the plain and the
 * JSON-escaped spelling, and normalize the separators that follow it.
 *
 * One recording serves both platforms: Windows emits `<workspace>\notes.txt`
 * where Linux emits `<workspace>/notes.txt`, and a tool result that embeds JSON
 * carries the same path with its backslashes doubled. Only the substituted path
 * run is touched, because a string can hold a backslash of its own — the read
 * result is literally `the answer is 42\n` — and that one is content, not a
 * separator.
 */
function withoutWorkspacePath(value: string, workspacePath: string): string {
  return value
    .split(workspacePath.replace(/\\/g, '\\\\'))
    .join('<workspace>')
    .split(workspacePath)
    .join('<workspace>')
    .replace(/<workspace>[^\s"]*/g, (path) => path.replace(/\\+/g, '/'));
}

/**
 * Strip what changes run to run, keep what the renderer reads.
 *
 * Ids are renumbered rather than blanked because the GUI's whole timeline is
 * built by MATCHING them — a `tool.started` whose `messageId` names no open
 * message is silently dropped, so a fixture that lost the correspondence would
 * hide exactly the defect this pair of tests exists to catch.
 */
function normalize(stream: readonly RuntimeEvent[], workspacePath: string): unknown[] {
  const ids = new Map<string, string>();
  const walk = (value: unknown, zeroNumbers: boolean): unknown => {
    if (typeof value === 'number') return zeroNumbers ? 0 : value;
    if (typeof value === 'string') {
      const withoutWorkspace = withoutWorkspacePath(value, workspacePath);
      if (!UUID.test(withoutWorkspace)) return withoutWorkspace;
      const existing = ids.get(withoutWorkspace);
      if (existing) return existing;
      const minted = `id-${ids.size + 1}`;
      ids.set(withoutWorkspace, minted);
      return minted;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, zeroNumbers));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walk(item, zeroNumbers)])
      );
    }
    return value;
  };
  return stream.map((event) => {
    // `seq` and `timestamp` are stamped by the RPC server on the way out and
    // carry no GUI meaning beyond their order, which the array already holds.
    const { seq: _seq, timestamp: _timestamp, ...rest } = event;
    // Token counts move whenever the system prompt or the tool list does, and a
    // prompt edit in a later phase must not fail a timeline test. The SHAPE is
    // what the renderer's metadata row reads, so that is what is kept.
    return walk(rest, event.type === 'usage.updated');
  });
}

function startServer(): void {
  outbound = [];
  server = new PiWorkerRpcServer({
    port: { postMessage: (message: unknown) => outbound.push(message) },
    generation: 1,
    projectTrusted: true,
    createRuntime: (options) =>
      new NativeWorkerRuntime({
        ...options,
        host: HOST,
        agentDir,
        create: (bootstrapOptions) =>
          createRuntime({ ...bootstrapOptions, providers: [faux.provider] }),
      }),
  });
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'runtime-gui-work-'));
  agentDir = await mkdtemp(join(tmpdir(), 'runtime-gui-agent-'));
  await writeFile(join(workspace, 'notes.txt'), 'the answer is 42\n');
  faux = fauxProvider({
    provider: 'faux',
    // The golden stream compares event boundaries too. Faux defaults to random
    // token sizes, so even a final punctuation mark can become an extra delta.
    tokenSize: { min: 128, max: 128 },
    models: [{ id: 'faux-e2e', name: 'Faux GUI', contextWindow: 128_000, maxTokens: 4_096 }],
  });
  requestSequence = 0;
  providerContexts = [];
  startServer();
});

afterEach(async () => {
  await call('worker.dispose', { reason: 'test' }).catch(() => undefined);
  server = undefined;
  await rm(workspace, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
});

/**
 * One session that touches every surface P4-5 signs off: a prompt with an
 * attachment (composer), a tool the policy allows without asking and one the
 * user is asked about (timeline + permission card), and a closing answer.
 */
async function runGuiSession(): Promise<RuntimeEvent[]> {
  faux.setResponses([
    (context) => {
      providerContexts.push(context);
      return fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-1' })], {
        stopReason: 'toolUse',
      });
    },
    fauxAssistantMessage(
      [fauxToolCall('write', { path: 'created.txt', content: 'hi\n' }, { id: 'call-2' })],
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage('The note says the answer is 42, and I wrote the file.'),
  ]);
  await call('worker.bootstrap', {
    logicalSessionId: SESSION,
    cwd: workspace,
    permissions: { mode: 'agent', gear: 'ask' },
  });
  await call('worker.send', {
    logicalSessionId: SESSION,
    requestId: 'turn-1',
    attemptId: 'attempt-1',
    text: 'read then write',
    model: MODEL,
    attachments: [{ kind: 'text', mediaType: 'text/plain', name: 'spec.md', data: '# spec\n' }],
  });

  const request = await waitFor(
    () =>
      events().find((event) => event.type === 'permission.requested') as
        | Extract<RuntimeEvent, { type: 'permission.requested' }>
        | undefined,
    'the permission request'
  );
  await call('worker.permission.respond', {
    logicalSessionId: SESSION,
    permissionId: request.payload.permissionId,
    decision: 'allow',
  });
  await waitFor(
    () =>
      events().find((event) => event.type === 'session.status' && event.payload.status === 'idle'),
    'the turn to go idle'
  );
  return events();
}

describe('the stream the GUI receives from the native backend (P4-5)', () => {
  it('still matches the recording the renderer replays', async () => {
    const recorded = normalize(await runGuiSession(), workspace);
    if (process.env.AICLIENT_UPDATE_FIXTURES) {
      await writeFile(FIXTURE, `${JSON.stringify(recorded, null, 2)}\n`);
    }
    expect(recorded).toEqual(JSON.parse(await readFile(FIXTURE, 'utf8')));
  }, 30_000);

  it('echoes the send attempt on the user message', async () => {
    // The composer shows the prompt optimistically and retires that bubble when
    // the authoritative echo carrying its own attemptId arrives. Without it the
    // user's message stays on screen twice for the life of the session.
    const echo = (await runGuiSession()).find(
      (event) => event.type === 'message.started' && event.payload.role === 'user'
    );
    expect(echo?.payload).toMatchObject({
      attemptId: 'attempt-1',
      attachments: [{ kind: 'text', mediaType: 'text/plain', name: 'spec.md' }],
    });
  }, 30_000);

  it('sends the attachment to the model rather than dropping it', async () => {
    await runGuiSession();
    // Asserted on what the PROVIDER was handed, not on the session file: a
    // transcript that records the document while the request omits it is
    // exactly the silent failure here — the user watches the attachment go up
    // and the model answers as though it never arrived.
    expect(JSON.stringify(providerContexts[0])).toContain('# spec');
  }, 30_000);

  it('records both gates, including the one nobody was asked about', async () => {
    const activity = (await runGuiSession()).filter(
      (event) => event.type === 'permission.activity'
    );
    // The policy allow is the load-bearing one: it raises no dialog, so this row
    // is the only evidence the call was gated rather than simply unchecked.
    expect(activity.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        phase: 'decision',
        requestId: 'call-1',
        surface: 'read',
        result: 'allow',
        resolution: 'policy_allow',
      }),
      expect.objectContaining({ phase: 'prompt', requestId: 'call-2', surface: 'write' }),
      expect.objectContaining({
        phase: 'decision',
        requestId: 'call-2',
        surface: 'write',
        result: 'allow',
        resolution: 'user_approved',
      }),
    ]);
  }, 30_000);

  it('keeps its own bookkeeping entries off the wire', async () => {
    // `aiclient.permissions` records which gate the branch ran under. The
    // renderer turns every custom entry into a visible system message and opens
    // a turn around it, so leaking one puts a row of raw JSON at the top of the
    // conversation.
    const custom = (await runGuiSession()).filter(
      (event) => event.type === 'custom.entry' || event.type === 'custom.message'
    );
    expect(custom).toEqual([]);
  }, 30_000);

  it('opens every message a tool row is attached to', async () => {
    // `applyRuntimeEvent` looks the message up by id and returns `{}` when it
    // finds nothing — a tool call addressed to an unopened message does not
    // error, it just never appears.
    const stream = await runGuiSession();
    const opened = new Set(
      stream.flatMap((event) => (event.type === 'message.started' ? [event.payload.messageId] : []))
    );
    for (const event of stream) {
      if (event.type.startsWith('tool.')) {
        expect(opened).toContain((event.payload as { messageId: string }).messageId);
      }
    }
  }, 30_000);
});
