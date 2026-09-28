/**
 * Bridge recording gate (dsh-rebase P1-4e skeleton, landed with P1-4a).
 *
 *   out-node-runtime/node src/dsh-host/tools/bridge-record.ts [--check | --update]
 *       [--only stream,tool] [--out-dir dir] [--raw dir] [--keep]
 *
 * Drives the product bridge through a real DSH host and the local fake gateway
 * (plan dsh-p0-2), exactly as Main's supervisor and WorkerSlot do (Node IPC,
 * one channel per session), one scenario per session, and records three golden
 * samples per scenario under src/shared/__tests__/fixtures/dsh/. Main's model
 * source is played too (P1-5): each host is configured with a plan whose one
 * route is the probes' `aiclient-gateway` / `fake-1`, so the samples keep
 * their route names, and gets its fake key per request.
 *
 *   stream.<scenario>.json  the RuntimeEvents the channel carried (the renderer's input)
 *   log.<scenario>.json     the session's DSH events at the end, read the way the bridge's
 *                           history cache reads them (`sessionQuery.observeSession`) —
 *                           the pure projection tests take these as input, and a DSH
 *                           upgrade that moves the vocabulary shows up here first
 *   rpc.<scenario>.json     worker.bootstrap (with `initialHistory` on a resume),
 *                           worker.history and worker.tree
 *
 * `--check` (the default) records and diffs against the samples, exiting 1 on
 * any difference; `--update` (or AICLIENT_UPDATE_FIXTURES=1) rewrites them —
 * only when closing out P1-4 or upgrading DSH, one scenario at a time with
 * `--only`, and a person reads the diff (a vanished field is a field the GUI
 * stops receiving). `--out-dir` writes the normalized recordings elsewhere
 * (repeat runs, to judge determinism); `--raw` also keeps them unnormalized.
 *
 * Scenarios (P1-4a; P1-4b..d add theirs):
 *   stream        one paced text answer
 *   tool          one bash call, then text
 *   fail          the only request of the turn fails upstream -> turn/end error
 *   stop-stream   Stop after five streamed deltas -> interrupted text, user_stop
 *   stop-tool     Stop while a bash call sleeps -> aborted tool result, user_stop
 *   compact       two turns, then `/compact` -> a "Context summary" row
 *   crash-resume  SIGKILL while a bash call sleeps; a new host resumes the stub and
 *                 its first page carries the interrupted-turn note and the
 *                 outcome-unknown tool row (decision 032)
 *   rewind        (P1-4b) two turns, `worker.rewind` to the second prompt, then a
 *                 turn that asks the model which markers it sees: only the first
 *                 turn's. `log` is the child session the stub names now, and
 *                 `log.retired` the session the rewind retired; the tree merges them
 *   fork          (P1-4b) two turns, `worker.fork` at the first answer for a minted
 *                 id, accepted; a second channel opens the child and asks which
 *                 markers it sees (only the first turn's), the source still sees
 *                 both. A second fork is discarded and leaves no stub. `log` is
 *                 the child's
 *
 * Normalized (plan P1-4 shard 05 §2): RuntimeEvent `seq` / `timestamp` dropped;
 * UUIDs renumbered `id-N` in first-seen order, one map per scenario shared by
 * its three samples (so the projection of `log` can be compared with `rpc`);
 * paths -> `<workspace>` / `<dsh-home>` / `<scratch>`; epoch milliseconds ->
 * `<ms>`; token counts -> 0; consecutive deltas of one block merged, in the
 * stream and in DSH's stored stream records, and stream timing (`dt`) dropped.
 * The system prompt, tool schemas and injected context bodies are replaced by
 * placeholders: they are DSH's text, not the bridge's, and carry dates. The
 * history's `settledAt` is dropped from `rpc`: whether it is present depends
 * on two events landing in the same millisecond (projection unit tests pin it).
 *
 * Needs `npm ci` in src/dsh-host and the bundled node (Node >= 24). One host is
 * alive at a time; the recorder refuses to start below 900 MB available.
 * Signals only ever go to a ChildProcess this script spawned. Every model
 * request goes to the fake gateway, and the probe hooks drop any non-loopback
 * connect.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeGatewayPlan, HostClient, isRecord, type Message } from './lib/hostClient.ts';
import { baseEnv, captureStderr, exitOf, type Sandbox, sandbox, sleep } from './lib/kit.ts';
import { installProbeBundle } from './lib/probe-bundle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const FIXTURE_DIR = join(repoRoot, 'src', 'shared', '__tests__', 'fixtures', 'dsh');
const MIN_AVAILABLE_MB = 900;

// ---- normalization -----------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** DSH command ids: a per-process random token and a counter (`cmd-babe6845-1`). */
const COMMAND_ID = /\bcmd-[0-9a-f]{8}-\d+\b/g;
/** Wall-clock milliseconds inside a string. */
const EPOCH_MS = /\b1\d{12}\b/g;

function isEpochMs(value: number): boolean {
  return Number.isInteger(value) && value >= 1_000_000_000_000 && value < 10_000_000_000_000;
}

/** Keys whose numbers are token counts. */
const USAGE_KEY = /^(usage|tokenUsage)$/;

/** The source kinds whose text the timeline shows; every other `user/message` body is injected context. */
const SHOWN_SOURCES = new Set(['user', 'compact-checkpoint', 'aiclient-retry']);

class Normalizer {
  private readonly ids = new Map<string, string>();
  private readonly paths: Array<[string, string]>;

  /** `paths`: absolute path -> placeholder; longer paths are replaced first. */
  constructor(paths: Record<string, string>) {
    this.paths = Object.entries(paths)
      .filter(([path]) => path.length > 0)
      .sort((a, b) => b[0].length - a[0].length);
  }

  string(value: string): string {
    let out = value;
    for (const [path, placeholder] of this.paths) out = out.split(path).join(placeholder);
    return out
      .replace(UUID, (uuid) => this.id(uuid.toLowerCase()))
      .replace(COMMAND_ID, (command) => `cmd-${this.id(command)}`)
      .replace(EPOCH_MS, '<ms>');
  }

  private id(key: string): string {
    let minted = this.ids.get(key);
    if (!minted) {
      minted = `id-${this.ids.size + 1}`;
      this.ids.set(key, minted);
    }
    return minted;
  }

  value(value: unknown, zeroNumbers = false): unknown {
    if (typeof value === 'number') {
      if (zeroNumbers) return 0;
      return isEpochMs(value) ? '<ms>' : value;
    }
    if (typeof value === 'string') return this.string(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item, zeroNumbers));
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.value(item, zeroNumbers || USAGE_KEY.test(key)),
        ])
      );
    }
    return value;
  }

  /** The RuntimeEvent stream, as the renderer depends on it. */
  stream(events: readonly Message[]): unknown[] {
    const merged: Message[] = [];
    for (const event of events) {
      const { seq: _seq, timestamp: _timestamp, ...rest } = event;
      const previous = merged.at(-1);
      const payload = (rest.payload ?? {}) as Message;
      if (
        (rest.type === 'message.delta' || rest.type === 'thinking.delta') &&
        previous?.type === rest.type &&
        previous.requestId === rest.requestId
      ) {
        const before = previous.payload as Message;
        if (before.messageId === payload.messageId && before.blockId === payload.blockId) {
          previous.payload = { ...before, text: `${String(before.text)}${String(payload.text)}` };
          continue;
        }
      }
      merged.push({ ...rest });
    }
    return merged.map((event) => this.value(event, event.type === 'usage.updated'));
  }

  /** One DSH log (observeSession) without its timing, prompt text and schemas. */
  log(observation: Message): unknown {
    const events = Array.isArray(observation.events) ? (observation.events as Message[]) : [];
    return {
      header: this.value(observation.header),
      inheritedEventCount: observation.inheritedEventCount,
      cursor: observation.cursor,
      events: events.map((event) => this.value(logEvent(event))),
    };
  }
}

/** Stored stream records: runs of one block merged, timing gone, tokens zeroed later. */
function streamRecords(records: unknown): unknown {
  if (!Array.isArray(records)) return records;
  const out: Message[] = [];
  for (const raw of records) {
    if (!isRecord(raw)) continue;
    if (raw.type === 'chunk') {
      out.push({ type: 'chunk', time: raw.time, chunk: raw.chunk });
      continue;
    }
    const pieces = (raw.type === 'tool-call-chunks' ? raw.args : raw.texts) as unknown[];
    const text = Array.isArray(pieces) ? pieces.join('') : '';
    const previous = out.at(-1);
    if (
      previous &&
      previous.type === raw.type &&
      previous.index === raw.index &&
      previous.id === raw.id
    ) {
      const key = raw.type === 'tool-call-chunks' ? 'args' : 'texts';
      previous[key] = [`${String((previous[key] as string[])[0])}${text}`];
      continue;
    }
    const { dt: _dt, texts: _texts, args: _args, ...rest } = raw;
    out.push({
      ...rest,
      ...(raw.type === 'tool-call-chunks' ? { args: [text] } : { texts: [text] }),
    });
  }
  return out;
}

function placeholderContent(content: unknown, placeholder: string): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) =>
    isRecord(block) && block.type === 'text' ? { ...block, text: placeholder } : block
  );
}

function logEvent(event: Message): Message {
  const data = isRecord(event.data) ? event.data : undefined;
  if (!data) return event;
  switch (event.type) {
    case 'assistant/message':
    case 'assistant/attempt':
      return { ...event, data: { ...data, stream: streamRecords(data.stream) } };
    case 'system/message': {
      const message = data.message as Message | undefined;
      return {
        ...event,
        data: {
          ...data,
          message: { ...message, content: placeholderContent(message?.content, '<system-prompt>') },
        },
      };
    }
    case 'request/header': {
      const header = data.header as Message | undefined;
      const tools = Array.isArray(header?.tools)
        ? (header.tools as Message[]).map((tool) => tool?.name).sort()
        : header?.tools;
      return { ...event, data: { ...data, header: { ...header, tools } } };
    }
    case 'user/message': {
      const source = data.source as Message | undefined;
      const kind = String(source?.kind ?? '');
      if (SHOWN_SOURCES.has(kind) || source?.form === 'notice') return event;
      return {
        ...event,
        data: { ...data, content: placeholderContent(data.content, `<${kind}>`) },
      };
    }
    default:
      return event;
  }
}

// ---- comparison ----------------------------------------------------------------

/** Key-order-insensitive differences, as `path: expected -> actual`. */
function differences(expected: unknown, actual: unknown, path = '$', out: string[] = []): string[] {
  if (out.length >= 25) return out;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length && out.length < 25; index += 1) {
      if (index >= expected.length)
        out.push(`${path}[${index}]: (absent) -> ${brief(actual[index])}`);
      else if (index >= actual.length)
        out.push(`${path}[${index}]: ${brief(expected[index])} -> (absent)`);
      else differences(expected[index], actual[index], `${path}[${index}]`, out);
    }
    return out;
  }
  if (
    isRecord(expected) &&
    isRecord(actual) &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      if (out.length >= 25) break;
      if (!(key in actual)) out.push(`${path}.${key}: ${brief(expected[key])} -> (absent)`);
      else if (!(key in expected)) out.push(`${path}.${key}: (absent) -> ${brief(actual[key])}`);
      else differences(expected[key], actual[key], `${path}.${key}`, out);
    }
    return out;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    out.push(`${path}: ${brief(expected)} -> ${brief(actual)}`);
  }
  return out;
}

function brief(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

// ---- hosts and sessions -----------------------------------------------------------

interface Host {
  label: string;
  child: ChildProcess;
  client: HostClient;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

interface Session {
  host: Host;
  ch: string;
  logicalSessionId: string;
  dshSessionId: string;
  stubFile: string;
}

interface Recording {
  stream: Message[];
  observation: Message;
  /** Sessions the stub's lineage retired (P1-4b rewind), oldest first. */
  retired?: Message[];
  rpc: Message;
  /** Unnormalized facts for the report: delta counts and event totals. */
  facts: Message;
}

interface RecordContext {
  box: Sandbox;
  startHost(label: string): Promise<Host>;
  stopHost(host: Host): Promise<void>;
  kill(host: Host): Promise<void>;
  openSession(
    host: Host,
    name: string,
    sessionFile?: string
  ): Promise<{ session: Session; boot: Message }>;
  turn(
    session: Session,
    label: string,
    text: string,
    during?: (from: number) => Promise<void>
  ): Promise<Message[]>;
  history(session: Session): Promise<Message>;
  tree(session: Session): Promise<Message>;
  observe(session: Session): Promise<Message>;
  close(session: Session): Promise<void>;
}

function payloadOf(event: Message): Message {
  return (event.payload ?? {}) as Message;
}

/** Assistant text deltas (the user's echo is one `message.delta` too). */
function deltaCount(events: readonly Message[]): number {
  return events.filter(
    (event) =>
      event.type === 'message.delta' && !String(payloadOf(event).messageId).startsWith('dsh-user-')
  ).length;
}

/** `value` without any `key` in `keys`, however deep. */
function withoutKeys(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutKeys(item, keys));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !keys.has(key))
      .map(([key, item]) => [key, withoutKeys(item, keys)])
  );
}
const TIMING_KEYS: ReadonlySet<string> = new Set(['settledAt']);

/** Everything a single-session scenario records once its turns are done. */
async function finish(
  context: RecordContext,
  session: Session,
  boots: Message[],
  turns: Message[][],
  extra: Message = {}
): Promise<Recording> {
  const history = await context.history(session);
  const tree = await context.tree(session);
  const observation = await context.observe(session);
  await context.close(session);
  return {
    stream: turns.flat(),
    observation,
    rpc: { bootstrap: boots, history, tree, ...extra },
    facts: {
      deltasPerTurn: turns.map(deltaCount),
      events: Array.isArray(observation.events) ? observation.events.length : 0,
    },
  };
}

type Scenario = (context: RecordContext, host: Host) => Promise<Recording>;

const SCENARIOS: Record<string, Scenario> = {
  async stream(context, host) {
    const { session, boot } = await context.openSession(host, 'stream');
    const turn = await context.turn(session, 'STREAM', 'P0-STREAM: stream a paragraph back to me.');
    return finish(context, session, [boot], [turn]);
  },
  async tool(context, host) {
    const { session, boot } = await context.openSession(host, 'tool');
    const turn = await context.turn(session, 'TOOL', 'P0-TOOL: list the workspace.');
    return finish(context, session, [boot], [turn]);
  },
  async fail(context, host) {
    const { session, boot } = await context.openSession(host, 'fail');
    const turn = await context.turn(session, 'FAIL', 'P1-FAIL: this request fails upstream.');
    return finish(context, session, [boot], [turn]);
  },
  async 'stop-stream'(context, host) {
    const { session, boot } = await context.openSession(host, 'stop-stream');
    const turn = await context.turn(
      session,
      'STOP-STREAM',
      'P0-PACED {"token":"stop-stream","chunks":30,"chunkMs":400} stream slowly; I will stop you.',
      async (from) => {
        // Five deltas in, 400 ms before the sixth: the cut lands between two frames.
        await session.host.client.until(
          session.ch,
          (events) => deltaCount(events.slice(from)) >= 5,
          60_000
        );
        await session.host.client.request(session.ch, 'worker.stop', {
          logicalSessionId: session.logicalSessionId,
          reason: 'user',
        });
      }
    );
    return finish(context, session, [boot], [turn]);
  },
  async 'stop-tool'(context, host) {
    const { session, boot } = await context.openSession(host, 'stop-tool');
    const turn = await context.turn(
      session,
      'STOP-TOOL',
      'P0-SLEEPTOOL {"token":"stop-tool","seconds":30} run a long command; I will stop you.',
      async (from) => {
        await waitForToolCall(session, from);
        // Past the command's first echo, well before its sleep ends.
        await sleep(2_000);
        await session.host.client.request(session.ch, 'worker.stop', {
          logicalSessionId: session.logicalSessionId,
          reason: 'user',
        });
      }
    );
    return finish(context, session, [boot], [turn]);
  },
  async compact(context, host) {
    const { session, boot } = await context.openSession(host, 'compact');
    const first = await context.turn(
      session,
      'STREAM',
      'P0-STREAM: stream a paragraph back to me.'
    );
    const second = await context.turn(session, 'TOOL', 'P0-TOOL: list the workspace.');
    const compacted = await host.client.probe(
      'compact',
      { sessionId: session.dshSessionId },
      120_000
    );
    return finish(context, session, [boot], [first, second], {
      compact: (compacted as Message).result,
    });
  },
  async 'crash-resume'(context, host) {
    const { session, boot } = await context.openSession(host, 'crash-resume');
    const before = await context.turn(
      session,
      'CRASH',
      // Short enough that the orphaned command ends on its own soon after the kill.
      'P0-SLEEPTOOL {"token":"crash-resume","seconds":10} run a long command.',
      async (from) => {
        await waitForToolCall(session, from);
        await sleep(2_000);
        await context.kill(host);
      }
    );
    const restarted = await context.startHost(`${host.label}-restarted`);
    const reopened = await context.openSession(restarted, 'crash-resume', session.stubFile);
    const recording = await finish(context, reopened.session, [boot, reopened.boot], [before, []]);
    // Main emits nothing on this channel for the dead host; the stream ends where the host died.
    await context.stopHost(restarted);
    return recording;
  },
  rewind: rewindScenario,
  fork: forkScenario,
};

/** The id of the first tree node whose preview contains `text`, and the node after it. */
function nodeAfter(tree: Message, text: string): { node: string; next?: string } {
  const nodes = ((tree.snapshot as Message | undefined)?.nodes ?? []) as Message[];
  const index = nodes.findIndex((node) => String(node.preview ?? '').includes(text));
  if (index < 0) throw new Error(`no tree node previews ${text}`);
  return {
    node: String(nodes[index]?.id),
    ...(nodes[index + 1] ? { next: String(nodes[index + 1]?.id) } : {}),
  };
}

/** The last assistant text of a turn's events. */
function replyOf(events: readonly Message[]): string {
  const assistant = new Set(
    events
      .filter((event) => event.type === 'message.started' && payloadOf(event).role === 'assistant')
      .map((event) => payloadOf(event).messageId)
  );
  return events
    .filter((event) => event.type === 'message.delta' && assistant.has(payloadOf(event).messageId))
    .map((event) => String(payloadOf(event).text))
    .join('');
}

/** What a rewind or fork answered, without the pages the scenario records anyway. */
function idsOf(result: Message): Message {
  const { history, tree, ...rest } = result;
  const page = (history as Message | undefined)?.page as Message | undefined;
  const nodes = ((tree as Message | undefined)?.snapshot as Message | undefined)?.nodes;
  return {
    ...rest,
    historyIds: ((page?.messages ?? []) as Message[]).map((message) => message.id),
    ...(Array.isArray(nodes)
      ? {
          treeNodes: (nodes as Message[]).map(
            (node) => `${String(node.id)}${node.active ? '' : ' (retired)'}${node.leaf ? ' *' : ''}`
          ),
        }
      : {}),
  };
}

/** The DSH session a stub names now. */
function stubTarget(stubFile: string): string {
  return String((JSON.parse(readFileSync(stubFile, 'utf8')) as Message).dshSessionId);
}

const REWIND_RECALL =
  'P0-RECALL {"markers":["REWIND-KEEP-1","REWIND-DROP-2"]} which markers do you see?';
const FORK_RECALL =
  'P0-RECALL {"markers":["FORK-BASE-1","FORK-AFTER-2"]} which markers do you see?';

async function rewindScenario(context: RecordContext, host: Host): Promise<Recording> {
  const { session, boot } = await context.openSession(host, 'rewind');
  const first = await context.turn(session, 'KEEP', 'alpha REWIND-KEEP-1, no scenario.');
  const second = await context.turn(session, 'DROP', 'beta REWIND-DROP-2, no scenario.');
  const target = nodeAfter(await context.tree(session), 'REWIND-DROP-2').node;
  const retiredId = session.dshSessionId;
  const rewound = await host.client.request(session.ch, 'worker.rewind', {
    logicalSessionId: session.logicalSessionId,
    targetEntryId: target,
    confirmed: true,
  });
  session.dshSessionId = stubTarget(session.stubFile);
  const recall = await context.turn(session, 'RECALL', REWIND_RECALL);
  const reply = replyOf(recall);
  if (!reply.includes('present=REWIND-KEEP-1 missing=REWIND-DROP-2')) {
    throw new Error(`rewind: the model saw what the rewind dropped: ${reply}`);
  }
  const retired = await host.client.probe('observe', { sessionId: retiredId }, 60_000);
  const recording = await finish(context, session, [boot], [first, second, recall], {
    rewind: idsOf(rewound),
  });
  return { ...recording, retired: [retired] };
}

async function forkScenario(context: RecordContext, host: Host): Promise<Recording> {
  const { session: source, boot: sourceBoot } = await context.openSession(host, 'fork');
  const first = await context.turn(source, 'BASE', 'gamma FORK-BASE-1, no scenario.');
  const second = await context.turn(source, 'AFTER', 'delta FORK-AFTER-2, no scenario.');
  const answer = nodeAfter(await context.tree(source), 'FORK-BASE-1').next;
  if (!answer) throw new Error('fork: no answer after the first prompt');
  const forked = await host.client.request(source.ch, 'worker.fork', {
    logicalSessionId: source.logicalSessionId,
    entryId: answer,
    targetLogicalSessionId: 'rec-fork-child',
  });
  const childStub = String(forked.sessionFile);
  const accept = await host.client.request(source.ch, 'worker.fork.accept', {
    logicalSessionId: source.logicalSessionId,
    sessionFile: childStub,
  });
  // The child's lock went with the source's handle: another channel resumes it at once.
  const { session: child, boot: childBoot } = await context.openSession(
    host,
    'fork-child',
    childStub
  );
  const childRecall = await context.turn(child, 'CHILD-RECALL', FORK_RECALL);
  const sourceRecall = await context.turn(source, 'SOURCE-RECALL', FORK_RECALL);
  const childReply = replyOf(childRecall);
  const sourceReply = replyOf(sourceRecall);
  if (!childReply.includes('present=FORK-BASE-1 missing=FORK-AFTER-2')) {
    throw new Error(`fork: the child saw past the fork point: ${childReply}`);
  }
  if (!sourceReply.includes('present=FORK-BASE-1,FORK-AFTER-2 missing=-')) {
    throw new Error(`fork: the source lost its own history: ${sourceReply}`);
  }
  // A fork Main does not adopt: its stub and marker go.
  const dropped = await host.client.request(source.ch, 'worker.fork', {
    logicalSessionId: source.logicalSessionId,
    entryId: answer,
    targetLogicalSessionId: 'rec-fork-dropped',
  });
  const discard = await host.client.request(source.ch, 'worker.fork.discard', {
    logicalSessionId: source.logicalSessionId,
    sessionFile: String(dropped.sessionFile),
  });
  const droppedLeft = [String(dropped.sessionFile), `${String(dropped.sessionFile)}.staged`].filter(
    (file) => existsSync(file)
  );
  await context.close(source);
  return finish(context, child, [], [first, second, childRecall, sourceRecall], {
    sourceBootstrap: sourceBoot,
    childBootstrap: childBoot,
    fork: idsOf(forked),
    accept,
    stagedMarkerLeft: existsSync(`${childStub}.staged`),
    discard: { ...discard, filesLeft: droppedLeft },
  });
}

/** The durable `tool/call` has been appended: the call is dispatched. */
async function waitForToolCall(session: Session, from: number): Promise<void> {
  const found = await session.host.client.until(
    session.ch,
    (events) => events.slice(from).some((event) => event.type === 'tool.updated'),
    60_000
  );
  if (!found) throw new Error(`${session.logicalSessionId}: the tool call never started`);
}

/** Scenarios that manage hosts themselves (they kill the one they are given). */
const OWN_HOST = new Set(['crash-resume']);

// ---- main ------------------------------------------------------------------------

function availableMb(): number {
  try {
    const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
    return match ? Number(match[1]) / 1024 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function parseArgs(argv: string[]) {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const only = value('--only')
    ?.split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of only ?? []) {
    if (!(name in SCENARIOS))
      throw new Error(`unknown scenario ${name}: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  return {
    update: argv.includes('--update') || process.env.AICLIENT_UPDATE_FIXTURES === '1',
    only: only ?? Object.keys(SCENARIOS),
    outDir: value('--out-dir'),
    rawDir: value('--raw'),
    keep: argv.includes('--keep'),
  };
}

async function startGateway(root: string, nodeBin: string) {
  const child = spawn(
    nodeBin,
    [gatewayEntry, '--port', '0', '--plan', 'dsh-p0-2', '--reset'].concat([
      '--state',
      join(root, 'gateway.state.json'),
      '--log',
      join(root, 'gateway.jsonl'),
      '--model-id',
      'fake-1',
    ]),
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const port = await new Promise<number>((done, fail) => {
    let text = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) done(Number(match[1]));
    });
    setTimeout(() => fail(new Error('fake gateway did not start')), 15_000);
  });
  return { child, port };
}

/** One JSON primitive as `JSON.stringify` prints it (strings never hold a raw newline). */
const JSON_PRIMITIVE = String.raw`(?:"(?:[^"\\\n]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)`;
const PRIMITIVE_ARRAY = new RegExp(
  String.raw`\[\n\s*(${JSON_PRIMITIVE}(?:,\n\s*${JSON_PRIMITIVE})*)\n\s*\]`,
  'g'
);

/** Columns as a formatter counts them: East Asian wide and fullwidth characters take two. */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * Biome's JSON layout, which lint-staged rewrites fixtures with: an array of
 * primitives that fits in 100 columns goes on one line; objects stay expanded.
 */
function formatJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return `${text.replace(PRIMITIVE_ARRAY, (match, body: string, offset: number) => {
    const collapsed = `[${body.split(/,\n\s*/).join(', ')}]`;
    const column = offset - (text.lastIndexOf('\n', offset) + 1);
    const comma = text[offset + match.length] === ',' ? 1 : 0;
    return column + displayWidth(collapsed) + comma <= 100 ? collapsed : match;
  })}\n`;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatJson(value));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
  const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;
  const available = availableMb();
  if (available < MIN_AVAILABLE_MB) {
    process.stderr.write(
      `[record] only ${Math.round(available)} MB available (< ${MIN_AVAILABLE_MB}); not starting a host\n`
    );
    return 2;
  }
  // Fixed length: the workspace path reaches tool output, and so DSH's token estimates.
  const scratchRoot = join('/var/tmp', `aiclient-dsh-record-${randomBytes(6).toString('hex')}`);
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const box = sandbox(scratchRoot, 'run');
  const hostCwd = join(box.root, 'host-cwd');
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  installProbeBundle(box.dshHome);
  const gateway = await startGateway(box.root, nodeBin);
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    // The probe bundle's auto-approving row would answer the bridge's approvals.
    AICLIENT_DSH_PROBE_ROW: '0',
  };
  const plan = fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gateway.port}` });
  const live: Host[] = [];
  const context: RecordContext = {
    box,
    async startHost(label) {
      const child = spawn(nodeBin, ['--expose-internals', '--import', hooksEntry, hostEntry], {
        cwd: hostCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const host: Host = {
        label,
        child,
        client: new HostClient(child, { requestPrefix: `record-${label}` }),
        stderr: captureStderr(child),
        exited: exitOf(child),
      };
      host.client.configure(plan, 'p1-4-fake-key');
      live.push(host);
      const ready = await host.client.control(
        (message) => message.type === 'ready' || message.type === 'fatal',
        180_000
      );
      if (ready?.type !== 'ready') {
        throw new Error(
          `${label}: no ready (${JSON.stringify(ready)}) ${host.stderr().slice(-800)}`
        );
      }
      return host;
    },
    async stopHost(host) {
      if (host.child.exitCode !== null || host.child.signalCode !== null) return;
      host.client.send({ type: 'shutdown' });
      await Promise.race([host.exited, sleep(20_000)]);
      if (host.child.exitCode === null && host.child.signalCode === null)
        host.child.kill('SIGKILL');
      await host.exited;
    },
    async kill(host) {
      if (host.child.exitCode === null && host.child.signalCode === null)
        host.child.kill('SIGKILL');
      await host.exited;
    },
    async openSession(host, name, sessionFile) {
      const ch = host.client.openChannel();
      const logicalSessionId = `rec-${name}`;
      const boot = await host.client.request(ch, 'worker.bootstrap', {
        logicalSessionId,
        cwd: box.workspace,
        ...(sessionFile ? { sessionFile } : {}),
      });
      return {
        session: {
          host,
          ch,
          logicalSessionId,
          dshSessionId: String(boot.piSessionId),
          stubFile: String(boot.sessionFile),
        },
        boot,
      };
    },
    async turn(session, label, text, during) {
      const { client } = session.host;
      const requestId = `turn-${label}`;
      const from = client.events(session.ch).length;
      await client.request(session.ch, 'worker.send', {
        logicalSessionId: session.logicalSessionId,
        requestId,
        attemptId: `attempt-${label}`,
        text,
      });
      await during?.(from);
      if (session.host.child.exitCode === null && session.host.child.signalCode === null) {
        const idle = await client.until(
          session.ch,
          (events) =>
            events
              .slice(from)
              .some(
                (event) =>
                  event.type === 'session.status' &&
                  payloadOf(event).status === 'idle' &&
                  event.requestId === requestId
              ),
          120_000
        );
        if (!idle) throw new Error(`${session.logicalSessionId} ${label}: never went idle`);
      }
      return client.events(session.ch).slice(from);
    },
    history(session) {
      return session.host.client.request(session.ch, 'worker.history', {
        logicalSessionId: session.logicalSessionId,
      });
    },
    tree(session) {
      return session.host.client.request(session.ch, 'worker.tree', {
        logicalSessionId: session.logicalSessionId,
      });
    },
    observe(session) {
      return session.host.client.probe('observe', { sessionId: session.dshSessionId }, 60_000);
    },
    async close(session) {
      await session.host.client.request(session.ch, 'worker.dispose', { reason: 'slot-dispose' });
    },
  };

  const failures: string[] = [];
  const facts: Record<string, Message> = {};
  let shared: Host | undefined;
  try {
    for (const name of args.only) {
      const scenario = SCENARIOS[name];
      if (!scenario) continue;
      if (OWN_HOST.has(name) && shared) {
        await context.stopHost(shared);
        shared = undefined;
      }
      const host = shared ?? (await context.startHost(OWN_HOST.has(name) ? name : 'shared'));
      if (!OWN_HOST.has(name)) shared = host;
      process.stderr.write(`[record] ${name}\n`);
      const recording = await scenario(context, host);
      facts[name] = recording.facts;
      const normalizer = new Normalizer({
        [box.workspace]: '<workspace>',
        [box.dshHome]: '<dsh-home>',
        [scratchRoot]: '<scratch>',
      });
      // One id map: the log first, so the projection of `log` meets `rpc` on the same ids.
      const log = normalizer.log(recording.observation) as Message;
      if (recording.retired) {
        log.retired = recording.retired.map((observation) => normalizer.log(observation));
      }
      const samples = {
        log,
        rpc: normalizer.value(withoutKeys(recording.rpc, TIMING_KEYS)),
        stream: normalizer.stream(recording.stream),
      };
      if (args.rawDir) {
        writeJson(join(args.rawDir, `${name}.raw.json`), {
          stream: recording.stream,
          observation: recording.observation,
          rpc: recording.rpc,
        });
      }
      for (const [kind, sample] of Object.entries(samples)) {
        const file = `${kind}.${name}.json`;
        if (args.outDir) {
          writeJson(join(args.outDir, file), sample);
        } else if (args.update) {
          writeJson(join(FIXTURE_DIR, file), sample);
        } else {
          const expectedFile = join(FIXTURE_DIR, file);
          if (!existsSync(expectedFile)) {
            failures.push(`${file}: no golden sample (record it with --update --only ${name})`);
            continue;
          }
          const diff = differences(JSON.parse(readFileSync(expectedFile, 'utf8')), sample);
          if (diff.length > 0) failures.push(`${file}:\n    ${diff.join('\n    ')}`);
        }
      }
    }
  } catch (error) {
    failures.push(
      `recording failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
    );
    for (const host of live) {
      process.stderr.write(`--- ${host.label} stderr\n${host.stderr().slice(-2000)}\n`);
    }
  } finally {
    for (const host of live) {
      if (host.child.exitCode === null && host.child.signalCode === null)
        await context.stopHost(host);
    }
    gateway.child.kill('SIGTERM');
    if (!args.keep) rmSync(scratchRoot, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ scenarios: args.only, facts }, null, 2)}\n`);
  const mode = args.outDir ? `written to ${args.outDir}` : args.update ? 'updated' : 'checked';
  if (failures.length > 0) {
    process.stderr.write(
      `[record] ${failures.length} difference(s):\n  ${failures.join('\n  ')}\n`
    );
    return 1;
  }
  process.stderr.write(`[record] ${args.only.length} scenario(s) ${mode}\n`);
  return 0;
}

process.exitCode = await main();
