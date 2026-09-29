/**
 * Bridge recording gate (dsh-rebase P1-4e skeleton, landed with P1-4a).
 *
 *   out-node-runtime/node src/dsh-host/tools/bridge-record.ts [--check | --update]
 *       [--only stream,tool] [--out-dir dir] [--raw dir] [--artifacts dir] [--keep]
 *
 * Drives the product bridge through a real DSH host and the local fake gateway
 * (plan dsh-p0-2), exactly as Main's supervisor and WorkerSlot do (Node IPC,
 * one channel per session), one scenario per session, and records three golden
 * samples per scenario under src/shared/__tests__/fixtures/dsh/. Main's model
 * source is played too (P1-5): each host is configured with a plan whose one
 * route is the probes' `aiclient-gateway` / `fake-1`, so the samples keep
 * their route names, and gets its fake key per request. The route also serves
 * `fake-vision`, which declares image input; only `image` sends to it (P1-4c2).
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
 * `--artifacts` (P1-4e, CI) keeps what a failed gate needs, in any mode: the
 * normalized recordings (`recorded/`, the same files as the samples, so the
 * directory diffs against the fixtures), `summary.json`, and on failure
 * `differences.txt` and the hosts' stderr tails — the text the console prints
 * anyway. Never the unnormalized recordings (`--raw`), and no model key: the
 * hosts only ever get the fake gateway's.
 *
 * Scenarios (P1-4a; P1-4b..d add theirs):
 *   stream        one paced text answer
 *   tool          one bash call, then text
 *   fail          the only request of the turn fails upstream -> turn/end error
 *   stop-stream   Stop after five streamed deltas -> interrupted text, user_stop
 *   stop-tool     Stop while a bash call sleeps -> aborted tool result, user_stop
 *   compact       two turns, the menu (`worker.commands`), `worker.compact` with
 *                 instructions (refused) and without (DSH's `/compact` -> a
 *                 "Context summary" row, nothing live), then a `/goal` send: a
 *                 command with no model turn, echoed with its answer (P1-4d2)
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
 * Live-mapping scenarios (P1-4d1, decision 099):
 *   think         one answer with a reasoning block: thinking.started / completed
 *   usage         a tool step and an answer billed with cache reads and writes, then
 *                 a second turn: pending and settled usage, the context occupancy,
 *                 the running total across turns
 *   job-notice    a background job outlives its turn; its completion notice wakes
 *                 the agent into a turn nobody sent, headed by `origin: job`
 *
 * Turn-semantics scenarios (P1-4c1, decisions 093 and 095):
 *   steer         two tool steps; while the first command runs, `worker.interject`
 *                 hands the turn a message, which it takes in at the next step
 *                 boundary (echoed with its attempt id) and goes on; once idle,
 *                 a second `worker.interject` finds no turn (`turnActive: false`)
 *   fail-retry    the only request of the turn fails upstream; the failure card's
 *                 Continue (`mode: 'retry'`) follows up the hidden continuation and
 *                 the turn answers; a second Continue after that success is refused
 *                 (`WORKER_RETRY_UNAVAILABLE`)
 *
 * Attachment scenarios (P1-4c2, decisions 096 and 097), recorded last:
 *   image         a small PNG, sent to the image-capable `fake-vision`, reaches the
 *                 model as an image block (echo and history carry its chip); a PNG
 *                 wider than 8192 px is refused before any event
 *                 (`WORKER_ATTACHMENT_REJECTED`, in `rpc.rejected`)
 *   file-attach   a text attachment is a DSH file block; in the ask posture the
 *                 model reads the handle's path with `read` and no card comes up;
 *                 the history row carries the file's chip
 *
 * Background work scenarios (P1-7b, decisions 069 and 119), recorded last:
 *   jobs-kill     a background ticker; the jobs window reads its output
 *                 (`worker.job.read`, the tail, then what came after) and stops it
 *                 (`worker.job.kill`); the kill's completion notice wakes the agent
 *                 into a turn nobody sent. `rpc.jobs` keeps the reads' shape (the
 *                 tick count depends on the wall clock), the kill's outcome and the
 *                 `jobs` list `worker.panels` answers afterwards
 *   sub-cont      a continuable subagent in the background: its settlement wakes the
 *                 agent, which sends it one more message (`send_message`); the child
 *                 runs again on the same lane (`resumed`) and its second settlement
 *                 wakes the agent once more. The child runs beside its parent, so
 *                 `stream` keeps the parent's three turns without the lane, and
 *                 `rpc.lane` keeps the lane's `subagent.activity` in its own order
 *
 * Question scenario (P1-4d3, decisions 098 and 114), recorded after those:
 *   question      the model calls DSH's `ask_user_question` twice, one turn each:
 *                 the first card is answered (a single-select pick; two
 *                 multi-select picks, one label holding ", ", then Other text),
 *                 the second skipped; each turn's answer quotes the tool result
 *                 the model got. `rpc.respond` keeps both `worker.question.respond`
 *                 answers
 *
 * Permission scenarios (P1-6c; plan P1-6 shard 04 §5, E class). Each opens its
 * session in a workspace of its own (`<workspace>/<scenario>`), so what a turn
 * lists or searches does not depend on which scenarios ran before it; `rpc`
 * also carries the grant sidecar (decision 043) where the scenario has one:
 *   perm-card     S1   ask: two workspace writes, the first card allowed once,
 *                      the second denied (its file is never written)
 *   perm-grants   S2/3 ask: `echo` answered for the session; the next `echo`
 *                      asks nothing; `echo … && rm …` is asked (rm never was)
 *   perm-deny     S4   bypass: `cat .env` refused without a card
 *   perm-plan     S9   plan: the write refused without a card, the read runs
 *   perm-gear     S10/14 ask, a card up: a new mode is refused as busy, the
 *                      gear widened to auto answers the card and the call runs
 *   perm-stop     S13  ask, a card up: Stop takes it down as aborted
 *   perm-restart  S15  ask: `echo` answered for the session, the log flushed
 *                      (P1-4e), the host SIGKILLed, a new host reopens the stub
 *                      and asks nothing;
 *                      `worker.setPermissions` then forgets the grant, on disk
 *                      too, and the next `echo` is asked again
 *   perm-subagent S16  ask: a subagent's bash call is asked on the chat's card,
 *                      naming the delegate
 *   perm-search   S17  bypass: glob and grep results without `.env` and
 *                      `server.key`
 * S5–S8, S11 and S12 (gear rules, a parallel burst, a shortened deadline) are
 * the pure library's own suites; S18 (pwsh) is Windows CI's (P1-6d).
 *
 * Normalized (plan P1-4 shard 05 §2): RuntimeEvent `seq` / `timestamp` dropped;
 * UUIDs renumbered `id-N` in first-seen order, one map per scenario shared by
 * its three samples (so the projection of `log` can be compared with `rpc`);
 * paths -> `<workspace>` / `<dsh-home>` / `<scratch>`; epoch milliseconds ->
 * `<ms>`; token counts -> 0; consecutive deltas of one block merged, in the
 * stream and in DSH's stored stream records, and stream timing (`dt`) dropped;
 * a tool row's size updates while its arguments stream (P1-4d1) dropped, since
 * whether one exists depends on the wall clock between two deltas; a running
 * command's live tail (`tool.output`, P1-7b) dropped for the same reason — how
 * many there are depends on when the job's output was pumped (the bridge's
 * unit tests and bridge-smoke check them).
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
import { grantsSidecarFor } from '../bridge/stub.ts';
import {
  BYPASS_PERMISSIONS,
  FAKE_MODEL,
  FAKE_ROUTE,
  fakeGatewayPlan,
  HostClient,
  isRecord,
  type Message,
} from './lib/hostClient.ts';
import { baseEnv, captureStderr, exitOf, type Sandbox, sandbox, sleep } from './lib/kit.ts';
import { solidPng } from './lib/png.ts';
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
      // P1-4d1: a size update while a call's arguments stream exists only when
      // a window of wall clock passed between two deltas (plan P1-4 shard 05 §2).
      if (rest.type === 'tool.updated' && isRecord(payload.input) && '__streaming' in payload.input)
        continue;
      if (rest.type === 'tool.output') continue;
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
  /** `options.permissions` defaults to bypass; `options.cwd` to the run's workspace. */
  openSession(
    host: Host,
    name: string,
    sessionFile?: string,
    options?: { permissions?: Message; cwd?: string }
  ): Promise<{ session: Session; boot: Message }>;
  /** `extra` joins the `worker.send` payload (a model, attachments). */
  turn(
    session: Session,
    label: string,
    text: string,
    during?: (from: number) => Promise<void>,
    extra?: Message
  ): Promise<Message[]>;
  history(session: Session): Promise<Message>;
  tree(session: Session): Promise<Message>;
  observe(session: Session): Promise<Message>;
  close(session: Session): Promise<void>;
}

function payloadOf(event: Message): Message {
  return (event.payload ?? {}) as Message;
}

/** Assistant text deltas (the user's echo, and a command send's, is one `message.delta` too). */
function deltaCount(events: readonly Message[]): number {
  return events.filter((event) => {
    const messageId = String(payloadOf(event).messageId);
    return (
      event.type === 'message.delta' &&
      !messageId.startsWith('dsh-user-') &&
      !messageId.startsWith('dsh-command-')
    );
  }).length;
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
    const { client } = session.host;
    const logicalSessionId = session.logicalSessionId;
    const first = await context.turn(
      session,
      'STREAM',
      'P0-STREAM: stream a paragraph back to me.'
    );
    const second = await context.turn(session, 'TOOL', 'P0-TOOL: list the workspace.');
    // P1-4d2 (decisions 099 rules 9-10, 113): the menu is DSH's commands and
    // skills; `/compact` is `worker.compact`, which refuses instructions
    // before anything runs and echoes nothing live.
    const commands = await client.request(session.ch, 'worker.commands', { logicalSessionId });
    const from = client.events(session.ch).length;
    const refused = answerOf(
      await client.call(session.ch, 'worker.compact', {
        logicalSessionId,
        instructions: 'keep the API decisions',
      })
    );
    const compacted = answerOf(
      await client.call(session.ch, 'worker.compact', { logicalSessionId }, 120_000)
    );
    const eventsAfter = client.events(session.ch).length - from;
    if (!compacted.ok) throw new Error(`compact: not compacted: ${JSON.stringify(compacted)}`);
    // A known command line is DSH's command, with no model turn: `/goal` alone shows its usage.
    const command = await context.turn(session, 'COMMAND', '/goal');
    return finish(context, session, [boot], [first, second, command], {
      commands,
      compact: { refused, compacted, eventsAfter },
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
  // P1-4d1 (decision 099): the live mapping's own scenarios.
  async think(context, host) {
    const { session, boot } = await context.openSession(host, 'think');
    const turn = await context.turn(session, 'THINK', 'P1-THINK: think it through, then answer.');
    return finish(context, session, [boot], [turn]);
  },
  async usage(context, host) {
    const { session, boot } = await context.openSession(host, 'usage');
    const first = await context.turn(session, 'USAGE', 'P1-USAGE: one tool step, then an answer.');
    // A second turn, so the running total spans turns.
    const second = await context.turn(session, 'USAGE-2', 'epsilon, no scenario.');
    return finish(context, session, [boot], [first, second]);
  },
  'job-notice': jobNoticeScenario,
  // P1-4c1 (decisions 093, 095): turn semantics.
  steer: steerScenario,
  'fail-retry': failRetryScenario,
  'perm-card': permCardScenario,
  'perm-grants': permGrantsScenario,
  'perm-deny': permDenyScenario,
  'perm-plan': permPlanScenario,
  'perm-gear': permGearScenario,
  'perm-stop': permStopScenario,
  'perm-restart': permRestartScenario,
  'perm-subagent': permSubagentScenario,
  'perm-search': permSearchScenario,
  // P1-4c2 (decisions 096, 097): attachments. Last, so the scenarios above
  // keep the host state they were recorded with.
  image: imageScenario,
  'file-attach': fileAttachScenario,
  // P1-4d3 (decisions 098, 114): DSH's ask_user_question on the card. After
  // the attachments, so every scenario above keeps its recorded host state.
  question: questionScenario,
  // P1-7b (decisions 069, 119): background work. Last, for the same reason.
  'jobs-kill': jobsKillScenario,
  'sub-cont': subContScenario,
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

/**
 * P1-4d1: a background job outlives the turn that started it; its completion
 * notice wakes the agent into a turn nobody sent, which the bridge heads with
 * an origin (decision 072 rule 3). The two turns are told apart by requestId:
 * the wake-up's is the bridge's own `dsh-turn-<session>-2`.
 */
async function jobNoticeScenario(context: RecordContext, host: Host): Promise<Recording> {
  const { session, boot } = await context.openSession(host, 'job-notice');
  const { client } = session.host;
  const from = client.events(session.ch).length;
  await context.turn(
    session,
    'JOBNOTICE',
    'P1-JOBNOTICE: start a background job, then wait for its notice.'
  );
  const wake = `dsh-turn-${session.dshSessionId}-2`;
  const woke = await client.until(
    session.ch,
    (events) =>
      events
        .slice(from)
        .some(
          (event) =>
            event.type === 'session.status' &&
            payloadOf(event).status === 'idle' &&
            event.requestId === wake
        ),
    60_000
  );
  if (!woke) throw new Error(`${session.logicalSessionId}: the job notice never woke the agent`);
  const events = client.events(session.ch).slice(from);
  return finish(
    context,
    session,
    [boot],
    [
      events.filter((event) => event.requestId === 'turn-JOBNOTICE'),
      events.filter((event) => event.requestId === wake),
    ]
  );
}

// ---- background work (P1-7b) -----------------------------------------------------------

/** Waits until the wake-up turn `requestId` of `session` went idle. */
async function wakeIdle(session: Session, from: number, requestId: string): Promise<void> {
  const woke = await session.host.client.until(
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
    90_000
  );
  if (!woke) throw new Error(`${session.logicalSessionId}: ${requestId} never went idle`);
}

/**
 * Decision 119: the jobs window's two calls on a live background job. The
 * ticker writes a line every 100 ms, so how much a read returns is the wall
 * clock's; what is recorded is its shape — the tail starts at the first byte
 * and a later read continues where it left — plus the kill's outcome, the
 * list `worker.panels` answers once the job settled, and the two turns.
 */
async function jobsKillScenario(context: RecordContext, host: Host): Promise<Recording> {
  const { session, boot } = await context.openSession(host, 'jobs-kill');
  const { client } = session.host;
  const logicalSessionId = session.logicalSessionId;
  const from = client.events(session.ch).length;
  await context.turn(session, 'JOBKILL', 'P1-JOBKILL: start a ticker in the background.');
  const events = () => client.events(session.ch).slice(from);
  const jobId = events()
    .filter((event) => event.type === 'session.projection' && payloadOf(event).key === 'jobs')
    .flatMap((event) => (payloadOf(event).view as Message[] | undefined) ?? [])
    .map((job) => String(job.id))
    .at(0);
  if (!jobId) throw new Error(`${logicalSessionId}: the jobs projection never listed the ticker`);
  await sleep(1_000);
  const first = await client.request(session.ch, 'worker.job.read', { logicalSessionId, jobId });
  await sleep(500);
  const later = await client.request(session.ch, 'worker.job.read', {
    logicalSessionId,
    jobId,
    from: first.next,
  });
  const kill = await client.request(session.ch, 'worker.job.kill', { logicalSessionId, jobId });
  const wake = `dsh-turn-${session.dshSessionId}-2`;
  await wakeIdle(session, from, wake);
  const panels = await client.request(session.ch, 'worker.panels', { logicalSessionId });
  const jobs = ((panels.projections as Message[] | undefined) ?? []).find(
    (entry) => entry.key === 'jobs'
  );
  const all = events();
  const recording = await finish(
    context,
    session,
    [boot],
    [
      all.filter((event) => event.requestId === 'turn-JOBKILL'),
      all.filter((event) => event.requestId === wake),
    ],
    {
      jobs: {
        first: {
          startsAtTheTop: first.from === 0 && String(first.text).startsWith('tick 1\n'),
          lossy: first.lossy,
        },
        later: {
          continues: later.from === first.next && Number(later.next) > Number(first.next),
          lossy: later.lossy,
        },
        kill,
        afterKill: ((jobs?.view as Message[] | undefined) ?? []).map((job) => ({
          id: job.id,
          kind: job.kind,
          status: job.status,
        })),
      },
    }
  );
  await context.stopHost(host);
  return recording;
}

/**
 * Decision 119: a continuable subagent on its lane across two runs. The child
 * works beside its parent, so where its activity falls among the parent's
 * events is the wall clock's: `stream` is the parent's three turns without
 * the lane, and `rpc.lane` the lane's own events, in order, without the
 * requestId of whichever parent turn happened to be current.
 */
async function subContScenario(context: RecordContext, host: Host): Promise<Recording> {
  const { session, boot } = await context.openSession(host, 'sub-cont');
  const { client } = session.host;
  const from = client.events(session.ch).length;
  await context.turn(session, 'SUBCONT', 'P1-SUBCONT: delegate to a continuable subagent.');
  const firstWake = `dsh-turn-${session.dshSessionId}-2`;
  const secondWake = `dsh-turn-${session.dshSessionId}-3`;
  await wakeIdle(session, from, firstWake);
  await wakeIdle(session, from, secondWake);
  const all = client.events(session.ch).slice(from);
  const parent = all.filter((event) => event.type !== 'subagent.activity');
  const lane = all
    .filter((event) => event.type === 'subagent.activity')
    .map((event) => ({ type: event.type, payload: event.payload }));
  const recording = await finish(
    context,
    session,
    [boot],
    [
      parent.filter((event) => event.requestId === 'turn-SUBCONT'),
      parent.filter((event) => event.requestId === firstWake),
      parent.filter((event) => event.requestId === secondWake),
    ],
    { lane }
  );
  await context.stopHost(host);
  return recording;
}

// ---- turn semantics (P1-4c1) ------------------------------------------------------

/**
 * Decision 093: Ctrl+Enter while the first of two commands runs. The message
 * waits in DSH's inbox and the turn takes it in at its next step boundary —
 * one turn, one requestId, the echo carrying the interjection's attempt id —
 * and the model's answer names it. Once idle, an interjection finds no turn.
 */
async function steerScenario(context: RecordContext, host: Host): Promise<Recording> {
  const { session, boot } = await context.openSession(host, 'steer');
  const { client } = session.host;
  const interject = (attemptId: string, text: string) =>
    client.call(session.ch, 'worker.interject', {
      logicalSessionId: session.logicalSessionId,
      attemptId,
      text,
    });
  const answers: Message = {};
  const turn = await context.turn(session, 'STEER', 'P1-STEER: two tool steps.', async (from) => {
    await waitForToolCall(session, from);
    // Inside the first command's two-second sleep.
    await sleep(500);
    answers.running = answerOf(
      await interject('interject-STEER', 'STEER-NOTE-A also report the step count.')
    );
  });
  const reply = replyOf(turn);
  if (!reply.includes('heard: STEER-NOTE-A')) {
    throw new Error(`steer: the model never saw the interjection: ${reply}`);
  }
  answers.idle = answerOf(await interject('interject-IDLE', 'STEER-NOTE-B nobody is running.'));
  return finish(context, session, [boot], [turn], { interject: answers });
}

/**
 * Decision 095: the turn fails upstream (no retry on the probes' route); the
 * failure card's Continue follows up the hidden continuation, which the
 * gateway answers. A second Continue, after that success, is refused before
 * anything goes out.
 */
async function failRetryScenario(context: RecordContext, host: Host): Promise<Recording> {
  const { session, boot } = await context.openSession(host, 'fail-retry');
  const { client } = session.host;
  const failed = await context.turn(session, 'FAILONCE', 'P1-FAILONCE: this request fails once.');
  const retry = (label: string) =>
    client.call(session.ch, 'worker.send', {
      logicalSessionId: session.logicalSessionId,
      requestId: `turn-${label}`,
      attemptId: `attempt-${label}`,
      text: '',
      mode: 'retry',
    });
  const from = client.events(session.ch).length;
  const accepted = answerOf(await retry('RETRY'));
  const idle = await client.until(
    session.ch,
    (events) =>
      events
        .slice(from)
        .some(
          (event) =>
            event.type === 'session.status' &&
            payloadOf(event).status === 'idle' &&
            event.requestId === 'turn-RETRY'
        ),
    120_000
  );
  if (!idle) throw new Error(`${session.logicalSessionId}: the retry never went idle`);
  const retried = client.events(session.ch).slice(from);
  if (!replyOf(retried).includes('recovered after the retry')) {
    throw new Error(`fail-retry: the retry did not recover: ${replyOf(retried)}`);
  }
  const refused = answerOf(await retry('RETRY-AGAIN'));
  return finish(context, session, [boot], [failed, retried], { retry: { accepted, refused } });
}

// ---- attachments (P1-4c2) ----------------------------------------------------------

/** The recorder's image-capable model (`input: ['text', 'image']`). */
const VISION_MODEL = 'fake-vision';

/**
 * Decision 096: a small PNG goes through DSH's admission and reaches the
 * model as an image block (the gateway counts them); the user echo and the
 * history carry its chip. A PNG wider than DSH's 8192 px is then refused
 * before anything goes out: `WORKER_ATTACHMENT_REJECTED` with DSH's code and
 * the file's name, and no event on the channel.
 */
async function imageScenario(context: RecordContext, host: Host): Promise<Recording> {
  const { session, boot } = await context.openSession(host, 'image');
  const { client } = session.host;
  const model = `${FAKE_ROUTE}/${VISION_MODEL}`;
  const png = (name: string, bytes: Buffer) => ({
    kind: 'image',
    mediaType: 'image/png',
    data: bytes.toString('base64'),
    name,
  });
  const turn = await context.turn(session, 'IMAGE', 'P1-IMAGE: what do you see?', undefined, {
    model,
    attachments: [png('dot.png', solidPng(2, 2))],
  });
  const reply = replyOf(turn);
  if (!reply.includes('saw 1 image block(s)')) {
    throw new Error(`image: the model did not get the image: ${reply}`);
  }
  const from = client.events(session.ch).length;
  const response = await client.call(session.ch, 'worker.send', {
    logicalSessionId: session.logicalSessionId,
    requestId: 'turn-IMAGE-WIDE',
    attemptId: 'attempt-IMAGE-WIDE',
    text: 'P1-IMAGE: and this one?',
    model,
    attachments: [png('wide.png', solidPng(8193, 1))],
  });
  // Anything the refusal might have let out would be on the channel by the time it answered.
  await sleep(300);
  if (response.ok) throw new Error('image: the wide PNG was not refused');
  const rejected = {
    ...answerOf(response),
    message: (response.error as Message | undefined)?.message,
    eventsAfter: client.events(session.ch).length - from,
  };
  return finish(context, session, [boot], [turn], { rejected });
}

/**
 * Decision 097: a text attachment is stored as a DSH file block; the model
 * gets one handle line and reads the saved read-only path with `read`, in the
 * ask posture without a card (the store is a trusted path; a card would be
 * denied and show here). The bubble keeps the user's own words; the history
 * row carries the file's chip.
 */
async function fileAttachScenario(context: RecordContext, host: Host): Promise<Recording> {
  const cwd = scenarioWorkspace(context.box, 'file-attach');
  const { session, boot } = await context.openSession(host, 'file-attach', undefined, {
    cwd,
    permissions: ASK_PERMISSIONS,
  });
  const turn = await context.turn(
    session,
    'FILE-ATTACH',
    'P1-FILEREAD: read the attached notes.',
    answering(session, 'FILE-ATTACH', () => 'deny'),
    {
      attachments: [
        {
          kind: 'text',
          mediaType: 'text/plain',
          data: 'FILE-MARKER-NOTES is on the first line.\nThe second line is plain.\n',
          name: 'notes.txt',
        },
      ],
    }
  );
  const reply = replyOf(turn);
  if (!reply.includes('read: FILE-MARKER-NOTES')) {
    throw new Error(`file-attach: the model did not read the file: ${reply}`);
  }
  return finish(context, session, [boot], [turn]);
}

// ---- permission scenarios (P1-6c) ---------------------------------------------------

/** Main's default posture: every gated call raises a card. */
const ASK_PERMISSIONS = Object.freeze({ mode: 'agent', gear: 'ask' } as const);

/**
 * The scenario's own workspace under the run's: its turns list, search and
 * write files, and must see the same tree whichever scenarios ran before.
 */
function scenarioWorkspace(box: Sandbox, name: string, files: Record<string, string> = {}): string {
  const dir = join(box.workspace, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

/** A `during` answering each card of turn `label` with `decide(card, index)`, until it idles. */
function answering(
  session: Session,
  label: string,
  decide: (card: Message, index: number) => string
): (from: number) => Promise<void> {
  const requestId = `turn-${label}`;
  return async (from) => {
    const { client } = session.host;
    const answered = new Set<unknown>();
    const idle = (events: Message[]) =>
      events
        .slice(from)
        .some(
          (event) =>
            event.type === 'session.status' &&
            payloadOf(event).status === 'idle' &&
            event.requestId === requestId
        );
    const waiting = (events: Message[]) =>
      events
        .slice(from)
        .filter(
          (event) =>
            event.type === 'permission.requested' && !answered.has(payloadOf(event).permissionId)
        );
    for (;;) {
      const woke = await client.until(
        session.ch,
        (events) => idle(events) || waiting(events).length > 0,
        120_000
      );
      for (const card of waiting(client.events(session.ch))) {
        const payload = payloadOf(card);
        const index = answered.size;
        answered.add(payload.permissionId);
        await client.request(session.ch, 'worker.permission.respond', {
          logicalSessionId: session.logicalSessionId,
          permissionId: payload.permissionId,
          decision: decide(payload, index),
        });
      }
      if (!woke || idle(client.events(session.ch))) return;
    }
  };
}

/** Resolves once turn `from` has its first card up. */
async function cardUp(session: Session, from: number): Promise<void> {
  const up = await session.host.client.until(
    session.ch,
    (events) => events.slice(from).some((event) => event.type === 'permission.requested'),
    60_000
  );
  if (!up) throw new Error(`${session.logicalSessionId}: no card came up`);
}

/** The session's grant sidecar as it stands (decision 043), or null when it has none. */
function grantsOf(session: Session): unknown {
  const file = grantsSidecarFor(session.stubFile);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null;
}

/** An RPC's answer without the request id, which counts every request of the host. */
function answerOf(response: Message): Message {
  if (response.ok) return { ok: true, result: response.result };
  const error = (response.error ?? {}) as Message;
  return { ok: false, code: error.code, retryable: error.retryable };
}

async function permCardScenario(context: RecordContext, host: Host): Promise<Recording> {
  const cwd = scenarioWorkspace(context.box, 'perm-card');
  const { session, boot } = await context.openSession(host, 'perm-card', undefined, {
    cwd,
    permissions: ASK_PERMISSIONS,
  });
  const turn = await context.turn(
    session,
    'PERM-CARD',
    'P1-PERM-WRITES: write two files.',
    answering(session, 'PERM-CARD', (_card, index) => (index === 0 ? 'allow' : 'deny'))
  );
  return finish(context, session, [boot], [turn], {
    files: {
      allowed: existsSync(join(cwd, 'perm-allowed.txt')),
      denied: existsSync(join(cwd, 'perm-denied.txt')),
    },
    grants: grantsOf(session),
  });
}

async function permGrantsScenario(context: RecordContext, host: Host): Promise<Recording> {
  const cwd = scenarioWorkspace(context.box, 'perm-grants');
  const { session, boot } = await context.openSession(host, 'perm-grants', undefined, {
    cwd,
    permissions: ASK_PERMISSIONS,
  });
  const turn = await context.turn(
    session,
    'PERM-GRANTS',
    'P1-PERM-GRANTS: echo three times.',
    answering(session, 'PERM-GRANTS', (_card, index) => (index === 0 ? 'allow_session' : 'deny'))
  );
  return finish(context, session, [boot], [turn], { grants: grantsOf(session) });
}

async function permDenyScenario(context: RecordContext, host: Host): Promise<Recording> {
  const cwd = scenarioWorkspace(context.box, 'perm-deny', { '.env': 'PERM_CANARY=perm-deny\n' });
  const { session, boot } = await context.openSession(host, 'perm-deny', undefined, { cwd });
  const turn = await context.turn(session, 'PERM-DENY', 'P1-PERM-DENY: print the env file.');
  return finish(context, session, [boot], [turn]);
}

async function permPlanScenario(context: RecordContext, host: Host): Promise<Recording> {
  const cwd = scenarioWorkspace(context.box, 'perm-plan', {
    'perm-plan-notes.txt': 'plan notes\n',
  });
  const { session, boot } = await context.openSession(host, 'perm-plan', undefined, {
    cwd,
    permissions: { mode: 'plan', gear: 'ask' },
  });
  const turn = await context.turn(session, 'PERM-PLAN', 'P1-PERM-PLAN: write, then read.');
  return finish(context, session, [boot], [turn], {
    written: existsSync(join(cwd, 'perm-plan.txt')),
  });
}

async function permGearScenario(context: RecordContext, host: Host): Promise<Recording> {
  const cwd = scenarioWorkspace(context.box, 'perm-gear');
  const { session, boot } = await context.openSession(host, 'perm-gear', undefined, {
    cwd,
    permissions: ASK_PERMISSIONS,
  });
  const changes: Message = {};
  const turn = await context.turn(
    session,
    'PERM-GEAR',
    'P1-PERM-HOLD: run one command.',
    async (from) => {
      await cardUp(session, from);
      const { client } = session.host;
      changes.mode = answerOf(
        await client.call(session.ch, 'worker.setPermissions', {
          logicalSessionId: session.logicalSessionId,
          permissions: { mode: 'plan', gear: 'ask' },
        })
      );
      changes.gear = answerOf(
        await client.call(session.ch, 'worker.setPermissionGear', {
          logicalSessionId: session.logicalSessionId,
          gear: 'auto',
        })
      );
    }
  );
  return finish(context, session, [boot], [turn], { changes });
}

async function permStopScenario(context: RecordContext, host: Host): Promise<Recording> {
  const cwd = scenarioWorkspace(context.box, 'perm-stop');
  const { session, boot } = await context.openSession(host, 'perm-stop', undefined, {
    cwd,
    permissions: ASK_PERMISSIONS,
  });
  const turn = await context.turn(
    session,
    'PERM-STOP',
    'P1-PERM-HOLD: run one command.',
    async (from) => {
      await cardUp(session, from);
      await session.host.client.request(session.ch, 'worker.stop', {
        logicalSessionId: session.logicalSessionId,
        reason: 'user',
      });
    }
  );
  return finish(context, session, [boot], [turn]);
}

async function permRestartScenario(context: RecordContext, host: Host): Promise<Recording> {
  const cwd = scenarioWorkspace(context.box, 'perm-restart');
  const options = { cwd, permissions: ASK_PERMISSIONS };
  const first = await context.openSession(host, 'perm-restart', undefined, options);
  const granted = await context.turn(
    first.session,
    'PERM-GRANT',
    'P1-PERM-SESSION: echo twice.',
    answering(first.session, 'PERM-GRANT', () => 'allow_session')
  );
  const grants: Message = { granted: grantsOf(first.session) };
  // The kill tests the grant sidecar across a crash, not DSH's write batching:
  // DSH buffers log writes for 200 ms and does not flush at turn boundaries, so
  // a kill right after `idle` used to lose turn 1's last reply, and whether it
  // did depended on the clock (decision 133). Flush through DSH's own entry
  // point first; crash-resume is the scenario that kills mid-turn on purpose.
  const flushed = await host.client.probe('flush', { sessionId: first.session.dshSessionId });
  if (flushed.participated !== true) {
    throw new Error(`perm-restart: the log flush reached no durability listener`);
  }
  await context.kill(host);
  const restarted = await context.startHost(`${host.label}-restarted`);
  const { session, boot } = await context.openSession(
    restarted,
    'perm-restart',
    first.session.stubFile,
    options
  );
  // Read back by the new host: nothing to ask.
  const covered = await context.turn(session, 'PERM-COVERED', 'P1-PERM-SESSION: echo twice.');
  const configure = answerOf(
    await restarted.client.call(session.ch, 'worker.setPermissions', {
      logicalSessionId: session.logicalSessionId,
      permissions: ASK_PERMISSIONS,
    })
  );
  grants.configured = grantsOf(session);
  const asked = await context.turn(
    session,
    'PERM-ASKED',
    'P1-PERM-SESSION: echo twice.',
    answering(session, 'PERM-ASKED', () => 'deny')
  );
  const recording = await finish(context, session, [first.boot, boot], [granted, covered, asked], {
    grants,
    configure,
  });
  await context.stopHost(restarted);
  return recording;
}

async function permSubagentScenario(context: RecordContext, host: Host): Promise<Recording> {
  const cwd = scenarioWorkspace(context.box, 'perm-subagent');
  const { session, boot } = await context.openSession(host, 'perm-subagent', undefined, {
    cwd,
    permissions: ASK_PERMISSIONS,
  });
  const turn = await context.turn(
    session,
    'PERM-SUB',
    'P1-PERM-SUB: delegate one command.',
    answering(session, 'PERM-SUB', () => 'allow')
  );
  return finish(context, session, [boot], [turn]);
}

async function permSearchScenario(context: RecordContext, host: Host): Promise<Recording> {
  const cwd = scenarioWorkspace(context.box, 'perm-search', {
    'notes.txt': 'PERM-SECRET in plain notes\n',
    '.env': 'PERM-SECRET=in the env file\n',
    'server.key': 'PERM-SECRET in a key file\n',
  });
  const { session, boot } = await context.openSession(host, 'perm-search', undefined, { cwd });
  const turn = await context.turn(
    session,
    'PERM-SEARCH',
    'P1-PERM-SEARCH: list and search the workspace.'
  );
  return finish(context, session, [boot], [turn]);
}

// ---- question scenario (P1-4d3) -------------------------------------------------------

/**
 * A `during` answering the first question card of the turn with `reply`, as the
 * renderer's store sends it (`worker.question.respond`); the answer is kept.
 */
function answeringQuestion(
  session: Session,
  label: string,
  reply: Message,
  replies: Message
): (from: number) => Promise<void> {
  return async (from) => {
    const { client } = session.host;
    const isCard = (event: Message) => event.type === 'question.requested';
    const up = await client.until(session.ch, (events) => events.slice(from).some(isCard), 60_000);
    if (!up) throw new Error(`${session.logicalSessionId} ${label}: no question card came up`);
    const card = payloadOf(client.events(session.ch).slice(from).find(isCard) as Message);
    replies[label] = answerOf(
      await client.call(session.ch, 'worker.question.respond', {
        logicalSessionId: session.logicalSessionId,
        questionId: card.questionId,
        ...reply,
      })
    );
  };
}

async function questionScenario(context: RecordContext, host: Host): Promise<Recording> {
  const { session, boot } = await context.openSession(host, 'question');
  const respond: Message = {};
  // The card's Continue: a single-select pick, and two multi-select picks (one
  // label holding ", ") with Other text after them, joined as the card joins them.
  const answered = await context.turn(
    session,
    'QUESTION-ANSWER',
    'P1-QUESTION: ask me before you start.',
    answeringQuestion(
      session,
      'answered',
      { answers: { scope: 'Renderer', checks: 'tsc, smoke, then record, also lint' } },
      respond
    )
  );
  // The card's Skip: every question answered with nothing selected.
  const skipped = await context.turn(
    session,
    'QUESTION-SKIP',
    'P1-QUESTION: ask me again.',
    answeringQuestion(session, 'skipped', { cancel: true }, respond)
  );
  return finish(context, session, [boot], [answered, skipped], { respond });
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

/**
 * Scenarios that manage hosts themselves (they kill the one they are given).
 * P1-7b's two run on a fresh host of their own and stop it: DSH mints job ids
 * from one counter per host process (`bash-N`), so on the shared host their
 * samples would depend on which scenarios ran before them.
 */
const OWN_HOST = new Set(['crash-resume', 'perm-restart', 'jobs-kill', 'sub-cont']);

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
    artifactsDir: value('--artifacts'),
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
  // `fake-1` as every probe has it, and (P1-4c2) an image-capable model for `image`.
  const plan = fakeGatewayPlan({
    routes: [
      {
        provider: FAKE_ROUTE,
        baseUrl: `http://127.0.0.1:${gateway.port}`,
        models: [
          { id: FAKE_MODEL, name: 'P0 fake model', contextWindow: 200_000, maxTokens: 8192 },
          {
            id: VISION_MODEL,
            name: 'P1-4c2 fake vision model',
            contextWindow: 200_000,
            maxTokens: 8192,
            input: ['text', 'image'],
          },
        ],
      },
    ],
  });
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
    async openSession(host, name, sessionFile, options = {}) {
      const ch = host.client.openChannel();
      const logicalSessionId = `rec-${name}`;
      const boot = await host.client.request(ch, 'worker.bootstrap', {
        logicalSessionId,
        cwd: options.cwd ?? box.workspace,
        ...(sessionFile ? { sessionFile } : {}),
        // P1-6b: the samples record the bridge, not the approval cards; the
        // perm-* scenarios choose their own posture (P1-6c).
        permissions: options.permissions ?? BYPASS_PERMISSIONS,
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
    async turn(session, label, text, during, extra = {}) {
      const { client } = session.host;
      const requestId = `turn-${label}`;
      const from = client.events(session.ch).length;
      await client.request(session.ch, 'worker.send', {
        logicalSessionId: session.logicalSessionId,
        requestId,
        attemptId: `attempt-${label}`,
        text,
        ...extra,
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
  const hostStderr: string[] = [];
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
        if (args.artifactsDir) writeJson(join(args.artifactsDir, 'recorded', file), sample);
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
      const tail = `--- ${host.label} stderr\n${host.stderr().slice(-2000)}\n`;
      hostStderr.push(tail);
      process.stderr.write(tail);
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
  if (args.artifactsDir) {
    writeJson(join(args.artifactsDir, 'summary.json'), {
      mode,
      scenarios: args.only,
      differences: failures.length,
      facts,
    });
    if (failures.length > 0) {
      writeFileSync(join(args.artifactsDir, 'differences.txt'), `${failures.join('\n\n')}\n`);
    }
    if (hostStderr.length > 0) {
      writeFileSync(join(args.artifactsDir, 'hosts-stderr.txt'), hostStderr.join('\n'));
    }
  }
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
