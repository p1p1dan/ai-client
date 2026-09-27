/**
 * dsh-rebase P1-9g — generate the legacy pi session corpus.
 *
 * Writes `src/shared/__tests__/fixtures/legacy-pi/*.jsonl` and `manifest.json`:
 * session files exactly as 1.0.x (and the writers it shared files with) left
 * them on disk, for the migration to be tested against after P1-12 deletes the
 * runtime that wrote them. Run it BEFORE P1-12; afterwards there is no native
 * writer left to run.
 *
 *   node --experimental-strip-types scripts/gen-legacy-pi-fixtures.ts [--keep]
 *
 * Needs `src/runtime`'s own npm dependencies (`npm ci` in there) and the root
 * `node_modules` (pi-coding-agent, for the CLI's v3 writer).
 *
 * Every byte is synthetic. The writers are the real ones — `createRuntime` with
 * pi-ai's faux provider, `JsonlSessionStore`, `prepareSessionConfig`,
 * `NativeLegacyImportWriter`, pi-coding-agent's `SessionManager` — fed made-up
 * conversations in a scratch tree under a FIXED path (so the paths the files
 * record are stable and name no real machine), with `$HOME` pointed into it
 * before anything can read the real one. Only v1/v2 and PI-Desktop sources are
 * written by hand: no writer for those formats ships any more.
 *
 * Ids and times are whatever the writers minted, so a second run produces a
 * different (equally valid) corpus. The goldens are computed from the committed
 * corpus (`legacyPiCorpus.test.ts`), so regenerating means re-recording them
 * too: `AICLIENT_UPDATE_FIXTURES=1 pnpm vitest run legacyPiCorpus`.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..');
const OUT = join(REPO, 'src', 'shared', '__tests__', 'fixtures', 'legacy-pi');
/** Fixed rather than mkdtemp'd: every path below ends up inside the corpus. */
const ROOT = '/tmp/aiclient-legacy-pi-corpus';
const HOME = join(ROOT, 'home');
const WORKSPACE = join(ROOT, 'workspace');
const SESSIONS = join(ROOT, 'sessions');
const AGENT_DIR = join(ROOT, 'agent');
const keep = process.argv.includes('--keep');

rmSync(ROOT, { recursive: true, force: true });
for (const dir of [HOME, WORKSPACE, SESSIONS, AGENT_DIR]) mkdirSync(dir, { recursive: true });
// Before the first dynamic import: nothing below may see the real home.
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

mkdirSync(join(WORKSPACE, 'src'), { recursive: true });
writeFileSync(join(WORKSPACE, 'notes.txt'), 'alpha\nbeta\n');
writeFileSync(join(WORKSPACE, 'src', 'app.ts'), 'export const answer = 42;\n');
writeFileSync(join(WORKSPACE, 'src', 'AGENTS.md'), 'Corpus rule: keep src/ files small.\n');

const { createRuntime } = await import('../src/runtime/bootstrap.ts');
const { standaloneHost } = await import('../src/runtime/host/config.ts');
const { resolveWorkerShell } = await import('../src/runtime/host/shell.ts');
const { prepareSessionConfig } = await import('../src/runtime/plugins/session/legacy.ts');
const { NativeLegacyImportWriter } = await import('../src/runtime/worker/nativeImport.ts');
// The runtime's own pi-ai copy, so the faux provider shares its module instance.
const faux = await import(
  '../src/runtime/node_modules/@earendil-works/pi-ai/dist/providers/faux.js'
);
// The CLI's session module by path, as `sessionInterop.test.ts` loads it: the
// package entry drags in the whole TUI graph.
const { SessionManager } = await import(
  pathToFileURL(
    join(REPO, 'node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js')
  ).href
);

type Runtime = Awaited<ReturnType<typeof createRuntime>>;
type Options = Parameters<typeof createRuntime>[0];
type Faux = ReturnType<typeof faux.fauxProvider>;
type Step = Parameters<Faux['setResponses']>[0][number];

interface ManifestEntry {
  file: string;
  /** Which of the five generations (or `damaged`) this file is. */
  generation: string;
  /** Who wrote the bytes. */
  writer: string;
  /** How the regression test reads it: `v4` decode, `legacy` convert-then-decode, raw `bytes`. */
  read: 'v4' | 'legacy' | 'bytes';
  /** Where the file lived when it was written; the conversion ids of v1 depend on it. */
  sourcePath: string;
  cwd: string;
  covers: string[];
  derivedFrom?: string;
  copyOf?: string;
}

const manifest: ManifestEntry[] = [];
const SYSTEM = 'You are the corpus probe.';
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
/** pi-ai's error text for a request it will not retry (see providerRetry). */
const TERMINAL_FAILURE = '400: upstream rejected the request';

function record(entry: ManifestEntry, bytes: Buffer | string): void {
  writeFileSync(join(OUT, entry.file), bytes);
  manifest.push(entry);
}

function keepFile(entry: Omit<ManifestEntry, 'sourcePath'>, path: string): Buffer {
  const bytes = readFileSync(path);
  record({ ...entry, sourcePath: path }, bytes);
  return bytes;
}

function provider(extra: Record<string, unknown> = {}): Faux {
  return faux.fauxProvider({
    provider: 'faux',
    models: [
      {
        id: 'faux-corpus',
        name: 'Corpus probe',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    ],
    ...extra,
  });
}

async function runtime(
  file: string,
  mode: 'create' | 'resume',
  model: Faux,
  extra: Partial<Options> = {}
): Promise<Runtime> {
  const { permissions, loop, ...rest } = extra as Options & object;
  return createRuntime({
    env: {},
    traceDir: null,
    providers: [model.provider],
    host: standaloneHost({ PATH: process.env.PATH }),
    tools: {
      cwd: WORKSPACE,
      shellPath: resolveWorkerShell(process.env as Record<string, string>),
    },
    permissions: {
      approve: async () => 'allow-once' as const,
      gear: 'auto',
      projectTrusted: true,
      ...permissions,
    },
    session: { file, cwd: WORKSPACE, mode },
    loop: { singleTurn: false, ...loop },
    ...rest,
  });
}

async function ask(handle: Runtime, prompt: string, extra: Record<string, unknown> = {}) {
  const result = await handle.run({ prompt, systemPrompt: SYSTEM, ...extra });
  await handle.session?.flush();
  return result;
}

function entryIds(handle: Runtime, predicate: (entry: Record<string, unknown>) => boolean) {
  return (handle.session?.snapshot().entries ?? [])
    .filter((entry) => predicate(entry as unknown as Record<string, unknown>))
    .map((entry) => entry.id);
}

function isRole(role: string) {
  return (entry: Record<string, unknown>) =>
    entry.type === 'message' && (entry.message as { role?: string }).role === role;
}

const toolUse = (calls: ReturnType<typeof faux.fauxToolCall>[], text?: string) =>
  faux.fauxAssistantMessage([...(text ? [faux.fauxText(text)] : []), ...calls], {
    stopReason: 'toolUse',
  });

// ---------------------------------------------------------------------------
// native v4 — createRuntime + faux
// ---------------------------------------------------------------------------

async function basic(): Promise<Buffer> {
  const file = join(SESSIONS, 'v4-basic.jsonl');
  const model = provider();
  model.setResponses([
    faux.fauxAssistantMessage(
      [
        { ...faux.fauxThinking('The notes file should answer this.'), thinkingSignature: 'sig-1' },
        faux.fauxText('Reading the notes.'),
        faux.fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-read-1' }),
      ],
      { stopReason: 'toolUse', responseId: 'resp-basic-1' }
    ),
    faux.fauxAssistantMessage(
      [{ ...faux.fauxText('The notes say alpha and beta.'), textSignature: 'tsig-2' }],
      {
        responseId: 'resp-basic-2',
      }
    ),
    faux.fauxAssistantMessage('A single red pixel.'),
    toolUse([
      faux.fauxToolCall(
        'write',
        { path: 'out/summary.md', content: '# Summary\n\nalpha, beta\n' },
        { id: 'call-write-1' }
      ),
    ]),
    faux.fauxAssistantMessage('Wrote out/summary.md.'),
  ]);
  const handle = await runtime(file, 'create', model);
  await ask(handle, 'What do the notes say?', { thinkingLevel: 'medium' });
  await ask(handle, 'What is in this picture?', {
    attachments: [{ kind: 'image', mediaType: 'image/png', data: PNG_1X1, name: 'pixel.png' }],
  });
  await ask(handle, 'Write a short summary file.', { thinkingLevel: 'high' });
  const firstAnswer = entryIds(handle, isRole('assistant'))[1];
  await handle.session?.rename('Corpus basics');
  if (firstAnswer) await handle.session?.label(firstAnswer, 'notes answer');
  await handle.dispose();
  return keepFile(
    {
      file: 'v4-basic.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore (createRuntime + faux)',
      read: 'v4',
      cwd: WORKSPACE,
      covers: [
        'user',
        'assistant',
        'thinking+signature',
        'text-signature',
        'responseId',
        'tool-call+result (read, write with details)',
        'image attachment (aiclientName)',
        'model_change',
        'thinking_level_change',
        'aiclient.permissions',
        'session name fact',
        'label fact',
      ],
    },
    file
  );
}

async function compaction(): Promise<void> {
  const file = join(SESSIONS, 'v4-compaction.jsonl');
  const summary = provider();
  summary.setResponses([
    faux.fauxAssistantMessage('Step one is done.'),
    toolUse([faux.fauxToolCall('new_context', {}, { id: 'call-rotate-1' })], 'Rotating context.'),
    faux.fauxAssistantMessage('Summary: step one done, step two under way.'),
    faux.fauxAssistantMessage('Continuing after the checkpoint.'),
  ]);
  const first = await runtime(file, 'create', summary, { context: { family: 'summary' } });
  await ask(first, 'Start the long task.');
  await ask(first, 'Continue, and rotate the context when you need to.');
  await first.dispose();
  const fresh = provider();
  fresh.setResponses([
    toolUse([faux.fauxToolCall('new_context', {}, { id: 'call-rotate-2' })]),
    faux.fauxAssistantMessage('Fresh window, carrying on.'),
    faux.fauxAssistantMessage('All steps done.'),
  ]);
  const second = await runtime(file, 'resume', fresh, { context: { family: 'fresh_window' } });
  await ask(second, 'Rotate again and keep going.');
  // What the store writes when a checkpoint keeps nothing: no retained tail,
  // so no `firstKeptEntryId` for the CLI (store.ts `compactionAnchor`).
  await second.session?.appendCompaction({
    summary: 'Checkpoint that retained nothing.',
    tokensBefore: 321,
    retainedTail: [],
  } as never);
  await ask(second, 'Wrap it up.');
  await second.dispose();
  keepFile(
    {
      file: 'v4-compaction.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore (createRuntime + faux)',
      read: 'v4',
      cwd: WORKSPACE,
      covers: [
        'compaction (summary family, new_context tool)',
        'compaction (fresh_window family, second pass)',
        'firstKeptEntryId anchor',
        'retainedTail',
        'compaction with an empty tail and no anchor (store appendCompaction)',
      ],
    },
    file
  );
}

async function branches(): Promise<void> {
  const file = join(SESSIONS, 'v4-branches.jsonl');
  const forkFile = join(SESSIONS, 'v4-branches.fork.jsonl');
  const model = provider();
  model.setResponses([
    faux.fauxAssistantMessage('First answer.'),
    faux.fauxAssistantMessage('half an answ', {
      stopReason: 'error',
      errorMessage: TERMINAL_FAILURE,
    }),
    faux.fauxAssistantMessage('Second answer, retried.'),
    faux.fauxAssistantMessage('Third answer.'),
    faux.fauxAssistantMessage('Answer to the rephrased second question.'),
  ]);
  const handle = await runtime(file, 'create', model);
  const session = handle.session;
  if (!session) throw new Error('no session');
  await ask(handle, 'First question.');
  await ask(handle, 'Second question.');
  const retry = await session.prepareRetry();
  if (!retry?.abandoned) throw new Error('expected a failed reply to retry over');
  await handle.run({ prompt: '', retry: true, systemPrompt: SYSTEM });
  await ask(handle, 'Third question.');
  const users = entryIds(handle, isRole('user'));
  const oldTip = session.metadata().leaf.activeEntryId;
  await session.rewind(users[1] as string, true);
  await ask(handle, 'Second question, rephrased.');
  const newTip = session.metadata().leaf.activeEntryId;
  if (!oldTip || !newTip) throw new Error('missing branch tips');
  await session.navigate(oldTip);
  await session.label(oldTip, 'original branch');
  await session.navigate(newTip);
  const firstAnswer = entryIds(handle, isRole('assistant'))[0] as string;
  const fork = await session.fork(forkFile, firstAnswer);
  session.acceptFork(fork.file);
  await handle.dispose();
  keepFile(
    {
      file: 'v4-branches.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore (createRuntime + faux)',
      read: 'v4',
      cwd: WORKSPACE,
      covers: [
        'failed reply (stopReason error) left on a retry branch',
        'retry run (no user message)',
        'rewind before a user message',
        'lane rows (navigate away and back)',
        'empty aiclient.permissionGrants written by each navigation',
        'label on an abandoned branch',
        'leaf on the newest branch',
      ],
    },
    file
  );
  const forkModel = provider();
  forkModel.setResponses([faux.fauxAssistantMessage('Answer inside the fork.')]);
  const forked = await runtime(forkFile, 'resume', forkModel);
  await ask(forked, 'A question only the fork sees.');
  await forked.dispose();
  keepFile(
    {
      file: 'v4-branches.fork.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore.fork, then one resumed turn',
      read: 'v4',
      cwd: WORKSPACE,
      covers: ['fork file (parentSessionId, copied branch, name and labels)'],
    },
    forkFile
  );
}

async function stopAndInterject(): Promise<void> {
  const file = join(SESSIONS, 'v4-stop-interject.jsonl');
  // Slow enough that a Stop lands mid-reply.
  const model = provider({ tokensPerSecond: 40 });
  model.setResponses([
    faux.fauxAssistantMessage(
      'Once upon a time there was a session file that kept every line it was ever given, and it never forgot a single one of them.'
    ),
    toolUse(
      [faux.fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-read-stop' })],
      'Checking.'
    ),
    faux.fauxAssistantMessage('Here is the summary you asked for.'),
  ]);
  const handle = await runtime(file, 'create', model);
  const stop = new AbortController();
  await handle
    .run({
      prompt: 'Tell me a story.',
      systemPrompt: SYSTEM,
      signal: stop.signal,
      onEvent: (event: { type: string; assistantMessageEvent?: { type?: string } }) => {
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta')
          stop.abort();
      },
    })
    .catch(() => undefined);
  await handle.session?.flush();
  await ask(handle, 'Check the notes, then continue.', {
    onEvent: (event: { type: string }) => {
      if (event.type === 'tool_execution_start') handle.loop.interject();
    },
  });
  await ask(handle, 'Now summarize.');
  await handle.dispose();
  keepFile(
    {
      file: 'v4-stop-interject.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore (createRuntime + faux)',
      read: 'v4',
      cwd: WORKSPACE,
      covers: [
        'aborted reply with partial text (user Stop)',
        'aiclient.runStop user_stop',
        'aiclient.runStop interjected (Ctrl+Enter at a tool boundary)',
      ],
    },
    file
  );
}

async function permissions(): Promise<void> {
  const file = join(SESSIONS, 'v4-permissions.jsonl');
  const model = provider();
  model.setResponses([
    toolUse([
      faux.fauxToolCall('write', { path: 'draft.md', content: '# Draft\n' }, { id: 'call-w' }),
    ]),
    faux.fauxAssistantMessage('Draft written.'),
    toolUse([faux.fauxToolCall('bash', { command: 'echo corpus' }, { id: 'call-bash' })]),
    faux.fauxAssistantMessage('The command printed corpus.'),
    faux.fauxAssistantMessage('Plan: edit draft.md, then run the checks.'),
    faux.fauxAssistantMessage('Back in agent mode.'),
  ]);
  const handle = await runtime(file, 'create', model, {
    permissions: { gear: 'ask', approve: async () => 'allow-session' as const },
  });
  await ask(handle, 'Write a draft file.');
  await ask(handle, 'Run a harmless command.');
  handle.permissions?.configure({ mode: 'plan' });
  await ask(handle, 'Plan the next step.');
  handle.permissions?.configure({ mode: 'agent', gear: 'auto' });
  await ask(handle, 'Carry on.');
  await handle.dispose();
  keepFile(
    {
      file: 'v4-permissions.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore (createRuntime + faux)',
      read: 'v4',
      cwd: WORKSPACE,
      covers: [
        'aiclient.permissionGrants (path grant, command-prefix grant)',
        'aiclient.permissionGrants cleared on a mode change',
        'aiclient.permissions (agent/ask, plan/ask, agent/auto)',
        'bash tool result',
      ],
    },
    file
  );
}

async function subagent(): Promise<void> {
  const file = join(SESSIONS, 'v4-subagent.jsonl');
  const model = provider();
  let parent = 0;
  let delegate = 0;
  const parentSteps = [
    () =>
      toolUse([
        faux.fauxToolCall(
          'Task',
          { agent: 'explorer', task: 'Look at notes.txt.' },
          { id: 'call-task' }
        ),
      ]),
    () => faux.fauxAssistantMessage('Waiting for the explorer.'),
    () => faux.fauxAssistantMessage('Integrated: the explorer found two lines in notes.txt.'),
  ];
  const delegateSteps = [
    () => faux.fauxAssistantMessage('Explorer report: notes.txt holds alpha and beta.'),
  ];
  const route: Step = (context: { systemPrompt?: string }) => {
    const isDelegate = /You are the "[a-z0-9-]+" subagent/.test(context.systemPrompt ?? '');
    const steps = isDelegate ? delegateSteps : parentSteps;
    const index = isDelegate ? delegate++ : parent++;
    return (
      steps[Math.min(index, steps.length - 1)] as () => ReturnType<typeof faux.fauxAssistantMessage>
    )();
  };
  model.setResponses(Array.from({ length: 16 }, () => route));
  const handle = await runtime(file, 'create', model, { subagents: { home: HOME } });
  await handle.run({ prompt: 'Delegate a look at the notes.' });
  await handle.session?.flush();
  await handle.dispose();
  keepFile(
    {
      file: 'v4-subagent.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore (createRuntime + faux, Task delegation)',
      read: 'v4',
      cwd: WORKSPACE,
      covers: [
        'aiclient.subagent (started, message, settled)',
        'internal user message: subagent-report',
      ],
    },
    file
  );
}

async function internalMessages(): Promise<void> {
  const file = join(SESSIONS, 'v4-internal.jsonl');
  const model = provider();
  model.setResponses([
    toolUse([faux.fauxToolCall('read', { path: 'src/app.ts' }, { id: 'call-read-src' })]),
    faux.fauxAssistantMessage('src/app.ts exports answer = 42.'),
    toolUse([faux.fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-ceiling-1' })]),
    toolUse([faux.fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-ceiling-2' })]),
    toolUse([faux.fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-ceiling-3' })]),
    faux.fauxAssistantMessage('Summary at the turn ceiling: notes.txt read three times.'),
  ]);
  // Three turns: the first run stays under it, the second meets it.
  const handle = await runtime(file, 'create', model, { loop: { turnCeiling: 3 } });
  await handle.run({ prompt: 'Look at src/app.ts.' });
  await handle.run({ prompt: 'Keep reading until you are stopped.' });
  await handle.session?.flush();
  await handle.dispose();
  keepFile(
    {
      file: 'v4-internal.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore (createRuntime + faux)',
      read: 'v4',
      cwd: WORKSPACE,
      covers: [
        'internal user message: project-instructions (on-demand AGENTS.md)',
        'internal user message: turn-ceiling',
      ],
    },
    file
  );
}

async function crash(): Promise<void> {
  const file = join(SESSIONS, 'v4-crash.jsonl');
  let midStream: Buffer | undefined;
  let midTool: Buffer | undefined;
  let handle: Runtime | undefined;
  const model = provider();
  model.setResponses([
    async () => {
      // The provider was asked: the user message is on disk, no reply yet.
      await handle?.session?.flush();
      midStream = readFileSync(file);
      return toolUse(
        [
          faux.fauxToolCall(
            'write',
            { path: 'crash.txt', content: 'never written\n' },
            { id: 'call-crash' }
          ),
        ],
        'Writing the file.'
      );
    },
    faux.fauxAssistantMessage('The file is written.'),
  ]);
  handle = await runtime(file, 'create', model, {
    permissions: {
      gear: 'ask',
      // The tool is running: its call is on disk, its result is not.
      approve: async () => {
        await handle?.session?.flush();
        midTool = readFileSync(file);
        return 'allow-once' as const;
      },
    },
  });
  await ask(handle, 'Write crash.txt.');
  await handle.dispose();
  if (!midStream || !midTool) throw new Error('crash images were not captured');
  record(
    {
      file: 'v4-crash-midstream.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore, copied while the provider request was open',
      read: 'v4',
      sourcePath: file,
      cwd: WORKSPACE,
      covers: ['crash while streaming: user message with no reply'],
    },
    midStream
  );
  record(
    {
      file: 'v4-crash-dangling.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore, copied while the tool call was awaiting approval',
      read: 'v4',
      sourcePath: file,
      cwd: WORKSPACE,
      covers: ['crash mid-tool: dangling tool call with no result'],
    },
    midTool
  );
  // What 1.0.x does with that image on the next open: the dangling call gets
  // the fixed "interrupted" result before the new turn.
  const recovered = join(SESSIONS, 'v4-crash-recovered.jsonl');
  writeFileSync(recovered, midTool);
  const again = provider();
  again.setResponses([faux.fauxAssistantMessage('I am back; crash.txt may or may not exist.')]);
  const resumed = await runtime(recovered, 'resume', again);
  await ask(resumed, 'Are you still there?');
  await resumed.dispose();
  keepFile(
    {
      file: 'v4-crash-recovered.jsonl',
      generation: 'native-v4',
      writer: 'runtime JsonlSessionStore: the dangling image, resumed for one turn',
      read: 'v4',
      cwd: WORKSPACE,
      covers: ['synthetic interrupted tool result (recovery.ts)'],
      derivedFrom: 'v4-crash-dangling.jsonl',
    },
    recovered
  );
}

async function cliRows(): Promise<void> {
  const file = join(SESSIONS, 'v4-cli.jsonl');
  const model = provider();
  model.setResponses([faux.fauxAssistantMessage('Native answer before the terminal.')]);
  const first = await runtime(file, 'create', model);
  await ask(first, 'A native turn before the terminal opens.');
  const nativeAnswer = entryIds(first, isRole('assistant'))[0] as string;
  await first.dispose();

  // The embedded TUI continuing the same file (H/20): pi's own writer.
  let clock = Date.parse('2026-09-20T10:00:00.000Z');
  const at = () => {
    clock += 1000;
    return clock;
  };
  const cli = SessionManager.open(file);
  const cliUser = cli.appendMessage({
    role: 'user',
    content: 'Typed in the terminal.',
    timestamp: at(),
  });
  cli.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Answered in the terminal.' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-cli',
    usage: {
      input: 10,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 14,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: at(),
  });
  cli.appendMessage({
    role: 'bashExecution',
    command: 'ls',
    output: 'notes.txt\nsrc\n',
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: at(),
  });
  cli.appendCustomMessageEntry('cli-extension', 'A note an extension added for the model.', false);
  cli.appendCustomEntry('cli-extension-state', { step: 1 });
  cli.appendModelChange('anthropic', 'claude-cli');
  cli.appendThinkingLevelChange('low');
  cli.appendSessionInfo('Renamed in the TUI');
  cli.appendLabelChange(nativeAnswer, 'from the GUI');
  cli.appendCompaction('Terminal summary of everything so far.', cliUser, 900);
  cli.appendMessage({ role: 'user', content: 'After the terminal compaction.', timestamp: at() });

  const back = provider();
  back.setResponses([faux.fauxAssistantMessage('GUI answer after the terminal.')]);
  const second = await runtime(file, 'resume', back);
  await ask(second, 'Back in the GUI.');
  await second.dispose();
  keepFile(
    {
      file: 'v4-cli.jsonl',
      generation: 'native-v4+cli',
      writer:
        'runtime JsonlSessionStore, then pi-coding-agent 0.84.4 SessionManager, then the runtime again',
      read: 'v4',
      cwd: WORKSPACE,
      covers: [
        'CLI rows without kind/seq (v3 shape)',
        'custom_message',
        'bashExecution message',
        'session_info and label as inert pi-cli entries',
        'CLI compaction rebuilt from firstKeptEntryId',
        'native rows written after the CLI tip',
      ],
    },
    file
  );
}

async function imports(): Promise<void> {
  const host = standaloneHost({ PATH: process.env.PATH });
  const base = Date.parse('2026-08-01T09:00:00.000Z');
  const fingerprint = (identity: string) => ({
    stableSourceIdentity: identity,
    contentHash: `sha256:${'0'.repeat(56)}${identity.length.toString(16).padStart(8, '0')}`,
    size: 4096,
    mode: 0o100644,
    mtimeMs: base,
  });
  const conversations = [
    {
      id: 'import-claude-0001',
      file: 'v4-import-claude.jsonl',
      covers: [
        'aiclient.legacy-import.provenance',
        'aiclient.legacy-import.display: tool, attachment (redacted image), diagnostic',
        'imported assistant with thinking and a paired tool call/result (provider legacy-import, zero usage)',
      ],
      conversation: {
        schemaVersion: 1,
        importerVersion: 'b4-legacy-v2',
        sourceKind: 'claude-code',
        stableSourceIdentity: 'claude-code:corpus:0001',
        sourceSessionId: 'claude-session-0001',
        workspacePath: WORKSPACE,
        title: 'Imported Claude Code session',
        model: 'claude-legacy',
        startedAt: base,
        endedAt: base + 60_000,
        sourceFingerprint: fingerprint('claude-code:corpus:0001'),
        entries: [
          {
            kind: 'user',
            text: 'Please check the build.',
            timestamp: base + 1_000,
            sourceEntryId: 'c-1',
          },
          {
            kind: 'assistant',
            blocks: [
              { type: 'thinking', text: 'Run the build first.' },
              { type: 'text', text: 'Running the build.' },
              {
                type: 'tool_call',
                toolCallId: 'toolu_01',
                name: 'Bash',
                input: { command: 'npm run build' },
              },
            ],
            model: 'claude-legacy',
            timestamp: base + 2_000,
            sourceEntryId: 'c-2',
          },
          {
            kind: 'tool_result',
            toolCallId: 'toolu_01',
            toolName: 'Bash',
            output: 'build ok',
            isError: false,
            timestamp: base + 3_000,
          },
          {
            kind: 'display',
            displayKind: 'tool',
            title: 'Read',
            toolCallId: 'toolu_02',
            toolName: 'Read',
            input: { file_path: 'README.md' },
            output: '# Readme',
            timestamp: base + 4_000,
          },
          {
            kind: 'display',
            displayKind: 'attachment',
            title: 'screenshot.png',
            body: 'Image attachment was not imported.',
            redacted: true,
            timestamp: base + 5_000,
          },
          {
            kind: 'display',
            displayKind: 'diagnostic',
            title: 'Skipped entries',
            body: '1 unsupported entry was skipped.',
            timestamp: base + 6_000,
          },
          {
            kind: 'assistant',
            blocks: [{ type: 'text', text: 'The build passed.' }],
            timestamp: base + 7_000,
          },
        ],
        diagnostics: ['1 unsupported entry was skipped'],
      },
    },
    {
      id: 'import-codex-0001',
      file: 'v4-import-codex.jsonl',
      covers: [
        'aiclient.legacy-import.provenance',
        'aiclient.legacy-import.display: tool (display-only call), custom',
        'imported assistant (provider legacy-import, zero usage)',
      ],
      conversation: {
        schemaVersion: 1,
        importerVersion: 'b4-legacy-v2',
        sourceKind: 'codex',
        stableSourceIdentity: 'codex:corpus:0001',
        sourceSessionId: 'codex-rollout-0001',
        workspacePath: WORKSPACE,
        title: 'Imported Codex session',
        startedAt: base,
        endedAt: base + 30_000,
        sourceFingerprint: fingerprint('codex:corpus:0001'),
        entries: [
          { kind: 'user', text: 'List the files.', timestamp: base + 1_000 },
          {
            kind: 'display',
            displayKind: 'tool',
            title: 'shell',
            toolCallId: 'call_codex_1',
            toolName: 'shell',
            input: { command: ['ls'] },
            output: 'notes.txt\nsrc',
            isError: false,
            timestamp: base + 2_000,
          },
          {
            kind: 'display',
            displayKind: 'custom',
            title: 'Reasoning summary',
            body: 'Listed the workspace.',
            timestamp: base + 2_500,
          },
          {
            kind: 'assistant',
            blocks: [{ type: 'text', text: 'Two entries: notes.txt and src.' }],
            model: 'gpt-codex-legacy',
            timestamp: base + 3_000,
          },
        ],
        diagnostics: [],
      },
    },
  ];
  for (const item of conversations) {
    const writer = new NativeLegacyImportWriter(host, AGENT_DIR);
    try {
      await writer.create({
        logicalSessionId: `logical-${item.id}`,
        targetPiSessionId: item.id,
        conversation: item.conversation as never,
      });
    } finally {
      await writer.dispose();
    }
    keepFile(
      {
        file: item.file,
        generation: 'native-v4-import',
        writer: 'NativeLegacyImportWriter (the CC / Codex import path)',
        read: 'v4',
        cwd: WORKSPACE,
        covers: item.covers,
      },
      join(AGENT_DIR, 'sessions', `${item.id}.jsonl`)
    );
  }
}

// ---------------------------------------------------------------------------
// legacy sources and the `.native-v4.jsonl` copies 1.0.x made of them
// ---------------------------------------------------------------------------

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistantV3(content: unknown[], stopReason: string, timestamp: number) {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-legacy',
    usage: usage(40, 12),
    stopReason,
    timestamp,
  };
}

const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

function handWritten(): Record<string, string> {
  const t = (minute: number) => `2026-03-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const ms = (minute: number) => Date.parse(t(minute));
  const v1 = jsonl([
    {
      type: 'session',
      version: 1,
      id: 'legacy-v1-session',
      timestamp: t(0),
      cwd: WORKSPACE,
      tier: 'pragmatic',
    },
    {
      type: 'message',
      timestamp: t(1),
      message: { role: 'user', content: 'v1: list the files', timestamp: ms(1) },
    },
    {
      type: 'message',
      timestamp: t(2),
      message: assistantV3(
        [{ type: 'toolCall', id: 'v1-call-1', name: 'ls', arguments: { path: '.' } }],
        'toolUse',
        ms(2)
      ),
    },
    {
      type: 'message',
      timestamp: t(3),
      message: {
        role: 'toolResult',
        toolCallId: 'v1-call-1',
        toolName: 'ls',
        content: [{ type: 'text', text: 'notes.txt\nsrc' }],
        isError: false,
        timestamp: ms(3),
      },
    },
    {
      type: 'message',
      timestamp: t(4),
      message: assistantV3(
        [{ type: 'text', text: 'Two entries: notes.txt and src.' }],
        'stop',
        ms(4)
      ),
    },
    {
      type: 'message',
      timestamp: t(5),
      message: {
        role: 'hookMessage',
        customType: 'legacy-hook',
        content: 'A hook said hello.',
        display: true,
        timestamp: ms(5),
      },
    },
    {
      type: 'compaction',
      timestamp: t(6),
      summary: 'v1 summary: listed the files.',
      tokensBefore: 1200,
      firstKeptEntryIndex: 4,
    },
    {
      type: 'message',
      timestamp: t(7),
      message: { role: 'user', content: 'v1: continue after the compaction', timestamp: ms(7) },
    },
    {
      type: 'message',
      timestamp: t(8),
      message: assistantV3([{ type: 'text', text: 'Continuing.' }], 'stop', ms(8)),
    },
  ]);
  const v2 = jsonl([
    { type: 'session', version: 2, id: 'legacy-v2-session', timestamp: t(10), cwd: WORKSPACE },
    {
      type: 'message',
      id: 'v2-u1',
      parentId: null,
      timestamp: t(11),
      message: { role: 'user', content: 'v2: hello', timestamp: ms(11) },
    },
    {
      type: 'message',
      id: 'v2-a1',
      parentId: 'v2-u1',
      timestamp: t(12),
      message: assistantV3(
        [
          { type: 'thinking', thinking: 'Greet back.', thinkingSignature: 'v2-sig' },
          { type: 'text', text: 'Hello from v2.' },
        ],
        'stop',
        ms(12)
      ),
    },
    {
      type: 'message',
      id: 'v2-h1',
      parentId: 'v2-a1',
      timestamp: t(13),
      message: {
        role: 'hookMessage',
        customType: 'extension',
        content: 'v2 hook content',
        display: true,
        timestamp: ms(13),
      },
    },
    {
      type: 'model_change',
      id: 'v2-m1',
      parentId: 'v2-h1',
      timestamp: t(14),
      provider: 'openai',
      modelId: 'gpt-legacy',
    },
    {
      type: 'message',
      id: 'v2-u2',
      parentId: 'v2-m1',
      timestamp: t(15),
      message: { role: 'user', content: 'v2: second question', timestamp: ms(15) },
    },
    {
      type: 'message',
      id: 'v2-a2',
      parentId: 'v2-u2',
      timestamp: t(16),
      message: assistantV3([{ type: 'text', text: 'Second answer.' }], 'stop', ms(16)),
    },
    {
      type: 'message',
      id: 'v2-u3',
      parentId: 'v2-a1',
      timestamp: t(17),
      message: { role: 'user', content: 'v2: a branch off the first answer', timestamp: ms(17) },
    },
    {
      type: 'message',
      id: 'v2-a3',
      parentId: 'v2-u3',
      timestamp: t(18),
      message: assistantV3([{ type: 'text', text: 'Branch answer.' }], 'stop', ms(18)),
    },
  ]);
  const desktop = jsonl([
    { type: 'session', schema: 1, sessionId: 'desktop-session', createdAt: t(20) },
    {
      type: 'message',
      id: 'd-u1',
      role: 'user',
      blocks: [
        { type: 'text', text: 'desktop: read the notes' },
        {
          type: 'attachment',
          attachment: { name: 'diagram.png', mediaType: 'image/png', data: PNG_1X1 },
        },
      ],
      createdAt: t(21),
    },
    {
      type: 'message',
      id: 'd-a1',
      role: 'assistant',
      blocks: [
        { type: 'thinking', thinking: 'Read it first.' },
        { type: 'text', text: 'Reading.' },
      ],
      meta: {
        providerId: 'anthropic',
        modelId: 'claude-desktop',
        usage: { inputTokens: 40, outputTokens: 5 },
      },
      createdAt: t(22),
    },
    {
      type: 'message',
      id: 'd-t1',
      role: 'tool',
      toolName: 'read',
      blocks: [
        {
          type: 'tool_call',
          callId: 'd-call-1',
          name: 'read',
          args: { path: 'notes.txt' },
          result: { content: [{ type: 'text', text: 'alpha\nbeta' }] },
        },
      ],
      createdAt: t(23),
    },
    {
      type: 'message',
      id: 'd-sub',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Delegate-private text.' }],
      meta: { parentToolCallId: 'd-call-1' },
      createdAt: t(24),
    },
    {
      type: 'message',
      id: 'd-a2',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The notes hold alpha and beta.' }],
      createdAt: t(25),
    },
    {
      type: 'message',
      id: 'd-u2',
      role: 'user',
      blocks: [
        { type: 'text', text: 'desktop: thanks' },
        { type: 'attachment', attachment: { name: 'missing.pdf', path: '/nowhere/missing.pdf' } },
      ],
      createdAt: t(26),
    },
    {
      type: 'compaction',
      id: 'd-c1',
      summary: 'desktop summary',
      throughMessageId: 'd-a2',
      tokensBefore: 500,
      retainedTail: [{ role: 'user', content: 'kept desktop task', timestamp: ms(19) }],
      createdAt: t(27),
    },
    {
      type: 'message',
      id: 'd-a3',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Rate limited.' }],
      meta: { status: 'error', error: 'rate limited' },
      createdAt: t(28),
    },
  ]);
  return { 'legacy-pi-v1.jsonl': v1, 'legacy-pi-v2.jsonl': v2, 'legacy-desktop.jsonl': desktop };
}

/** A v3 file written by the CLI's own writer. */
function authorV3(name: string, withBranches: boolean): { file: string } {
  const dir = join(SESSIONS, `${name}.cli`);
  mkdirSync(dir, { recursive: true });
  let clock = Date.parse('2026-04-01T08:00:00.000Z');
  const at = () => {
    clock += 1000;
    return clock;
  };
  const sm = SessionManager.create(WORKSPACE, dir);
  sm.appendModelChange('anthropic', 'claude-legacy');
  sm.appendThinkingLevelChange('medium');
  sm.appendMessage({ role: 'user', content: 'v3: read the notes', timestamp: at() });
  sm.appendMessage(
    assistantV3(
      [
        { type: 'thinking', thinking: 'Reading first.', thinkingSignature: 'v3-sig' },
        { type: 'toolCall', id: 'v3-call-1', name: 'read', arguments: { path: 'notes.txt' } },
      ],
      'toolUse',
      at()
    )
  );
  sm.appendMessage({
    role: 'toolResult',
    toolCallId: 'v3-call-1',
    toolName: 'read',
    content: [{ type: 'text', text: 'alpha\nbeta\n' }],
    isError: false,
    timestamp: at(),
  });
  const answer = sm.appendMessage(
    assistantV3([{ type: 'text', text: 'The notes say alpha, beta.' }], 'stop', at())
  );
  if (withBranches) {
    sm.appendMessage({
      role: 'bashExecution',
      command: 'ls',
      output: 'notes.txt\nsrc\n',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: at(),
    });
    sm.appendCustomMessageEntry('legacy-extension', 'An extension note for the model.', true);
    sm.appendCustomEntry('aiclient-session-tier', 'handsoff');
    sm.appendSessionInfo('Legacy v3 session');
    const labelled = sm.appendLabelChange(answer, 'answered');
    sm.appendMessage({ role: 'user', content: 'v3: an idea we drop', timestamp: at() });
    sm.appendMessage(assistantV3([{ type: 'text', text: 'Dropped idea.' }], 'stop', at()));
    sm.branchWithSummary(labelled, 'Tried an idea and came back.');
    const second = sm.appendMessage({
      role: 'user',
      content: 'v3: second question',
      timestamp: at(),
    });
    sm.appendMessage(assistantV3([{ type: 'text', text: 'Second answer.' }], 'stop', at()));
    sm.appendCompaction('v3 summary: read the notes, answered twice.', second, 2400);
    sm.appendMessage({ role: 'user', content: 'v3: after the compaction', timestamp: at() });
    sm.appendMessage(
      assistantV3([{ type: 'text', text: 'Half an answer before the Stop' }], 'aborted', at())
    );
  }
  const written = readdirSync(dir).filter((item) => item.endsWith('.jsonl'));
  if (written.length !== 1) throw new Error(`expected one CLI session in ${dir}`);
  const file = join(SESSIONS, `${name}.jsonl`);
  writeFileSync(file, readFileSync(join(dir, written[0] as string)));
  return { file };
}

async function legacy(): Promise<void> {
  const bare = await createRuntime({ env: {}, traceDir: null, providers: [provider().provider] });
  try {
    for (const [name, content] of Object.entries(handWritten())) {
      const file = join(SESSIONS, name);
      writeFileSync(file, content);
      const generation = name.includes('desktop') ? 'pi-desktop-1' : `pi-${name.match(/v\d/)?.[0]}`;
      keepFile(
        {
          file: name,
          generation,
          writer: 'hand-written (no writer for this format ships any more)',
          read: 'legacy',
          cwd: WORKSPACE,
          covers:
            generation === 'pi-v1'
              ? ['v1 positional ids', 'firstKeptEntryIndex', 'hookMessage', 'header tier']
              : generation === 'pi-v2'
                ? ['v2 ids and parents', 'hookMessage', 'branch', 'thinking signature']
                : [
                    'PI-Desktop blocks',
                    'attachment block (image, missing)',
                    'tool row joined to its carrier',
                    'delegate row (legacy:subagent)',
                    'throughMessageId compaction',
                    'error status',
                  ],
        },
        file
      );
      await prepareSessionConfig(bare.hostIo, { file, cwd: WORKSPACE, mode: 'resume' });
      keepFile(
        {
          file: `${name}.native-v4.jsonl`,
          generation: 'native-v4',
          writer: 'prepareSessionConfig (1.0.x copy of a legacy file)',
          read: 'v4',
          cwd: WORKSPACE,
          covers: [
            'importedFrom / sourceSha256 / legacyHeader metadata',
            'converted entries',
            'trailing lane row',
          ],
          copyOf: name,
        },
        `${file}.native-v4.jsonl`
      );
    }

    // v3 by the CLI's writer, then opened (and continued) in 1.0.x.
    const v3 = authorV3('legacy-pi-v3', true);
    keepFile(
      {
        file: 'legacy-pi-v3.jsonl',
        generation: 'pi-v3',
        writer: 'pi-coding-agent 0.84.4 SessionManager',
        read: 'legacy',
        cwd: WORKSPACE,
        covers: [
          'v3 tree',
          'branch_summary (branchWithSummary)',
          'compaction by firstKeptEntryId',
          'bashExecution',
          'custom_message',
          'legacy tier entry (aiclient-session-tier)',
          'session_info',
          'label',
          'aborted reply',
        ],
      },
      v3.file
    );
    const model = provider();
    model.setResponses([faux.fauxAssistantMessage('Continued in 1.0.x.')]);
    const opened = await runtime(v3.file, 'resume', model);
    await ask(opened, 'Continue the legacy conversation.');
    await opened.dispose();
    keepFile(
      {
        file: 'legacy-pi-v3.jsonl.native-v4.jsonl',
        generation: 'native-v4',
        writer: 'prepareSessionConfig, then one native turn',
        read: 'v4',
        cwd: WORKSPACE,
        covers: ['converted v3 copy', 'native rows after the conversion'],
        copyOf: 'legacy-pi-v3.jsonl',
      },
      `${v3.file}.native-v4.jsonl`
    );

    // The copy was made, then the TUI kept writing to the original.
    const drifted = authorV3('legacy-pi-v3-drifted', false);
    await prepareSessionConfig(bare.hostIo, { file: drifted.file, cwd: WORKSPACE, mode: 'resume' });
    const cli = SessionManager.open(drifted.file);
    cli.appendMessage({
      role: 'user',
      content: 'v3: written after the copy was made',
      timestamp: Date.parse('2026-04-02T08:00:00.000Z'),
    });
    cli.appendMessage(
      assistantV3(
        [{ type: 'text', text: 'The copy never saw this.' }],
        'stop',
        Date.parse('2026-04-02T08:00:01.000Z')
      )
    );
    keepFile(
      {
        file: 'legacy-pi-v3-drifted.jsonl',
        generation: 'pi-v3',
        writer: 'pi-coding-agent 0.84.4 SessionManager, appended after the copy',
        read: 'legacy',
        cwd: WORKSPACE,
        covers: ['source changed after its native copy (session_import_source_changed)'],
      },
      drifted.file
    );
    keepFile(
      {
        file: 'legacy-pi-v3-drifted.jsonl.native-v4.jsonl',
        generation: 'native-v4',
        writer: 'prepareSessionConfig (copy of the source before it drifted)',
        read: 'v4',
        cwd: WORKSPACE,
        covers: ['stale sourceSha256'],
        copyOf: 'legacy-pi-v3-drifted.jsonl',
      },
      `${drifted.file}.native-v4.jsonl`
    );
  } finally {
    await bare.dispose();
  }
}

// ---------------------------------------------------------------------------
// damaged files, derived from the ones above
// ---------------------------------------------------------------------------

function damaged(basicBytes: Buffer): void {
  const text = basicBytes.toString('utf8');
  const lines = text.split('\n');
  lines.pop();
  const derived = (
    file: string,
    covers: string[],
    bytes: Buffer | string,
    read: ManifestEntry['read'] = 'v4'
  ) =>
    record(
      {
        file,
        generation: 'damaged',
        writer: 'derived from v4-basic.jsonl by the generator',
        read,
        sourcePath: join(SESSIONS, file),
        cwd: WORKSPACE,
        covers,
        derivedFrom: 'v4-basic.jsonl',
      },
      bytes
    );

  const last = lines.at(-1) as string;
  derived(
    'damaged-torn-tail.jsonl',
    ['torn tail: last row cut mid-write, no newline'],
    `${lines.slice(0, -1).join('\n')}\n${last.slice(0, Math.floor(last.length / 2))}`
  );

  const middle = [...lines];
  middle.splice(4, 0, '{"kind":"entry","type":"message","seq":');
  derived(
    'damaged-middle-row.jsonl',
    ['unparseable middle row (dropped, reported as skipped)'],
    `${middle.join('\n')}\n`
  );

  const gap = lines.map((line, index) => {
    if (index !== 5) return line;
    const row = JSON.parse(line) as { seq: number };
    return JSON.stringify({ ...row, seq: row.seq + 2 });
  });
  derived(
    'damaged-seq-gap.jsonl',
    ['seq jump no CLI row explains (refused)'],
    `${gap.join('\n')}\n`
  );

  const rows = lines.map(
    (line) => JSON.parse(line) as { seq?: number; kind?: string; id?: string }
  );
  const seq = Math.max(...rows.map((row) => (typeof row.seq === 'number' ? row.seq : 0)));
  const leaf = [...rows].reverse().find((row) => row.kind === 'entry')?.id ?? null;
  const time = Date.parse('2026-09-27T12:00:00.000Z');
  const records = [
    {
      kind: 'record',
      type: 'operation_started',
      id: 'op-compact-1',
      seq: seq + 1,
      lane: 'main',
      timestamp: time,
      sourceLeafId: leaf,
      intent: { kind: 'compaction', resultEntryId: 'unused-compaction' },
    },
    {
      kind: 'record',
      type: 'operation_finished',
      id: 'op-compact-1-end',
      seq: seq + 2,
      lane: 'main',
      timestamp: time + 1,
      runId: 'op-compact-1',
      outcome: 'declined',
    },
    {
      kind: 'record',
      type: 'operation_started',
      id: 'op-run-2',
      seq: seq + 3,
      lane: 'main',
      timestamp: time + 2,
      sourceLeafId: leaf,
      intent: { kind: 'run', originalPrompt: [], initialMessages: [] },
    },
    {
      kind: 'record',
      type: 'tool_started',
      id: 'rec-tool-2',
      seq: seq + 4,
      lane: 'main',
      timestamp: time + 3,
      runId: 'op-run-2',
      assistantEntryId: leaf,
      toolIndex: 0,
      toolCallId: 'call-never-finished',
      toolName: 'bash',
      effectiveArgs: { command: 'sleep 100' },
      resultEntryId: 'unused-result',
      replay: 'never',
    },
  ];
  derived(
    'damaged-unfinished-record.jsonl',
    ['pi SDK record rows', 'operation_started with no operation_finished (tolerateUnfinished)'],
    `${lines.join('\n')}\n${records.map((row) => JSON.stringify(row)).join('\n')}\n`
  );

  derived('damaged-empty.jsonl', ['zero-byte file'], '', 'bytes');

  const broken = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  const cut = broken.indexOf(Buffer.from('alpha'));
  derived(
    'damaged-invalid-utf8.jsonl',
    ['invalid UTF-8 in a middle row'],
    Buffer.concat([broken.subarray(0, cut), Buffer.from([0xc3, 0x28]), broken.subarray(cut)]),
    'bytes'
  );
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(OUT)) if (name.endsWith('.jsonl')) rmSync(join(OUT, name));
try {
  const basicBytes = await basic();
  await compaction();
  await branches();
  await stopAndInterject();
  await permissions();
  await subagent();
  await internalMessages();
  await crash();
  await cliRows();
  await imports();
  await legacy();
  damaged(basicBytes);
  manifest.sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(
    join(OUT, 'manifest.json'),
    `${JSON.stringify({ generatedBy: 'scripts/gen-legacy-pi-fixtures.ts', root: ROOT, files: manifest }, null, 2)}\n`
  );
  console.log(`wrote ${manifest.length} files to ${OUT}`);
} finally {
  if (!keep) rmSync(ROOT, { recursive: true, force: true });
}
