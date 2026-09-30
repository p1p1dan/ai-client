#!/usr/bin/env node

/**
 * fake-gateway.mjs — local fake Anthropic-Messages-style AI gateway for GUI point-checks.
 *
 * Maintained copy (dsh-rebase P1-2): the DSH probe drivers, the P0-4 kit and
 * scripts/packaged-dsh-host-smoke.mjs use this file. The copy under
 * docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/
 * is an archive and no longer changes.
 *
 * Mimics just enough of the Anthropic Messages streaming API (`api: anthropic-messages`
 * in ai-client's UserProvider config) to drive manual/CDP point-checks against a fake
 * custom AI service, without needing real credentials or a real model.
 *
 * SSE frame shapes are copied from scripts/run-f4-retry-probe.mjs:42-129 (successBody() /
 * startGateway() / the 503 error envelope), extended here with a tool_use frame sequence.
 *
 * Usage:
 *   node fake-gateway.mjs --port <port> --plan <plan> [--sleep <seconds>] [--state <path>] [--reset] [--model-id <id>]
 *
 * Options:
 *   --port <n>       Required. TCP port to listen on (127.0.0.1 only).
 *   --plan <name>    Required. One of: text | long-turn | retry-503 | retry-503-forever |
 *                    write-approval | archive-probe | ask-question | slow-write |
 *                    long-thinking | slow-fail | echo-key-error | dsh-p0-2
 *   --sleep <n>      Seconds used in the long-turn plan's `sleep <n> && echo done` bash
 *                    command, and in the archive-probe plan's 1st-request bash command.
 *                    Default: 90 (long-turn) — archive-probe callers should pass their own
 *                    value; see below.
 *   --state <path>   JSON file used to persist the request counter across restarts.
 *                    Default: /tmp/t032/fake-gateway.state.json
 *   --reset          Zero the request counter before starting (ignores any existing state file).
 *   --model-id <id>  Optional. Echoed back verbatim as `message.model` in every
 *                    `message_start` frame, regardless of what the caller's request body
 *                    sent as `model`. Lets a point-check log line up the fake gateway's
 *                    replies with a specific model name. Default: fake-sonnet.
 *   --chunks <n>     Only for the paced plans (slow-write / long-thinking). How many delta
 *                    frames the long field is cut into. Defaults: 40 (slow-write), 200
 *                    (long-thinking).
 *   --chunk-ms <n>   Only for the paced plans. Milliseconds between two delta frames.
 *                    Defaults: 300 (slow-write), 200 (long-thinking).
 *   --hold <n>       Only for slow-fail. Seconds to hold the connection open after the 200
 *                    response headers with zero body bytes. Default: 120.
 *   --write-path <p> Only for slow-write. The `path` argument of the streamed write call,
 *                    relative to the session cwd. Default: demo/out.html.
 *   --write-lines <n> Only for slow-write. How many lines the streamed file body spans.
 *                    Default: 60.
 *
 * Endpoints:
 *   POST *          Treated as POST /v1/messages regardless of actual path (path is ignored).
 *                   Body is expected to be an Anthropic Messages request:
 *                   { model, messages: [{ role, content }], ... }
 *   GET  /health    Returns { ok: true, plan, count } as JSON — count is the number of
 *                   POST requests served so far (persisted via --state).
 *
 * Plans:
 *   text               Always replies with a plain text block "fake gateway ok"
 *                       (stop_reason: end_turn).
 *   long-turn          1st request replies a tool_use block: name="bash",
 *                       input={"command":"sleep <N> && echo done"}. Any request whose body
 *                       contains a tool_result content block replies plain text
 *                       "turn finished" (stop_reason: end_turn).
 *   write-approval     1st request replies a tool_use block: name="write",
 *                       input={"path":"probe-write.txt","content":"hello from fake gateway"}
 *                       (path is relative to whatever cwd the caller resolves it against).
 *                       Any request with a tool_result replies plain text "turn finished".
 *   ask-question       (added by batch E1 for checklist item 25 / F7c) 1st request replies a
 *                       tool_use block: name="ask" with the exact input shape the runtime's
 *                       ask tool declares (src/runtime/plugins/tools/ask.ts ASK_PARAMETERS:
 *                       { questions: [{ question, header?, options: [{label, description?}] }] },
 *                       2-4 options per question). Any request with a tool_result replies
 *                       plain text "turn finished".
 *   retry-503          1st and 2nd requests reply HTTP 503 with an Anthropic-style error
 *                       envelope ({type:'error', error:{type:'overloaded_error', message}});
 *                       3rd+ requests succeed with plain text "fake gateway ok".
 *   retry-503-forever  Every request replies HTTP 503, with the error message containing the
 *                       literal marker FAKE_GATEWAY_OVERLOADED_MARKER so a log grep can tell
 *                       "gateway responded 503" apart from "no gateway reached".
 *   slow-write         (added by batch I point-check for T101) PACED plan — the frames go out
 *                       one at a time with real wall-clock gaps instead of in a single
 *                       `res.end()`, because T101 is about what the timeline shows WHILE a
 *                       tool call's arguments are still arriving.
 *                       1st request: a short text block ("下面开始编写文件：") is streamed and
 *                       closed, then a `tool_use` block (name="write") is opened and its
 *                       `{"path":…,"content":…}` JSON is dictated over --chunks
 *                       `input_json_delta` frames spaced --chunk-ms apart, then
 *                       `content_block_stop` + `message_delta` (stop_reason: tool_use).
 *                       `path` lands inside the FIRST chunk on purpose: the projector reads
 *                       pi's partial-JSON parse of the block, so a row can name its file
 *                       before a byte of the body exists.
 *                       Any request with a tool_result replies plain text "写入完成".
 *   long-thinking      (added by batch I point-check for T096 / T098) PACED plan.
 *                       1st request: a `thinking` block dictated over --chunks
 *                       `thinking_delta` frames spaced --chunk-ms apart (default 200 × 200ms
 *                       ≈ 40 s), with many newlines so the block overflows the viewport,
 *                       then a `signature_delta`, `content_block_stop`, and finally a short
 *                       text block + `message_delta` (stop_reason: end_turn).
 *                       Every later request repeats the same turn, so a second send in the
 *                       same session streams a second thought.
 *   echo-key-error     (added by dsh-rebase P1-5b, KEY-CANARY) Every request answers
 *                       HTTP 401 with an error message that repeats the key it received,
 *                       the way some providers do. The dsh-p0-2 plan has the same case
 *                       under the P1-ECHOKEY marker. What the client stores of that
 *                       message is what the canary scan checks.
 *   slow-fail          (added by batch I point-check for T093) Writes the 200 response
 *                       headers immediately and then sends ZERO body bytes for --hold
 *                       seconds (default 120) before closing. This is the shape decision 029
 *                       exists for: the connection is accepted, so a headers timeout never
 *                       fires, and only the idle/body timeout can cut it.
 *   archive-probe      Driven purely by request sequence number (not by whether the request
 *                       body contains a tool_result — that's still recorded in the log, just
 *                       not used to pick the response), so the turn sequence is deterministic
 *                       even if a caller's harness doesn't round-trip tool_result blocks:
 *                         1st request: tool_use name="bash",
 *                           input={"command":"sleep <N> && echo slept"} (N via --sleep,
 *                           default 45).
 *                         2nd request: tool_use name="write",
 *                           input={"path":"archive-probe.txt","content":"written after archive"}
 *                           (relative path, written under the caller's session cwd).
 *                         3rd request: tool_use name="read",
 *                           input={"path":"archive-probe.txt"}.
 *                         4th request: tool_use name="bash",
 *                           input={"command":"pwd && ls -la"}.
 *                         5th+ requests: plain text "archive probe finished"
 *                           (stop_reason: end_turn).
 *   dsh-p0-2           (added by dsh-rebase P0-2) CONTENT-KEYED plan for the DSH host probe
 *                       (src/dsh-host/tools/goal-probe.ts). Each request is decided from its own
 *                       messages, not from the sequence number: the latest user message
 *                       carrying a scenario marker (P0-GOAL-COMPLETE, P0-GOAL-BLOCKED,
 *                       P0-GOAL-PAUSE, P0-GOAL-ROUNDLIMIT, P0-JOBS, P0-OFFICE, P0-ENV,
 *                       P0-APPROVAL, for P0-3 P0-STREAM / P0-TOOL / P0-SLOWTOOL, and for P0-4
 *                       P0-FS / P0-RECALL with a JSON parameter object after the marker, and for
 *                       P0-6 P0-CRASH / P0-PACED / P0-SLEEPTOOL / P0-LOAD / P0-HIST, also with a
 *                       JSON parameter object, and for P1-3a P0-FDS) or a
 *                       DSH `<goal_round>` continuation prompt is the trigger; the number of
 *                       tool calls since the trigger is the step. Goal rounds read their
 *                       round number from the prompt's `Round: N/M` line, update_goal copies
 *                       the id/revision from the latest get_goal result, and a
 *                       `<goal_complete>` / `<goal_blocked>` wrap-up is answered with text.
 *                       Scripts are listed in `DSH_P0_2_SCRIPTS` below.
 *                       dsh-rebase P1-5b adds P1-ECHOKEY (HTTP 401 repeating the key it got)
 *                       and P1-ENVDUMP (one bash `env`) for the KEY-CANARY scan.
 *                       dsh-rebase P1-7e (decision 140) adds P1-GATE: HTTP 502 whose body
 *                       is a company gateway's stream-gate refusal
 *                       (`stream_gate_precommit` / `prebuffer_overflow`), which the
 *                       host must not retry (tools/loop-guard-smoke.ts, host A).
 *                       dsh-rebase P1-4e adds P1-FAIL (HTTP 500 for the whole turn) and
 *                       answers DSH's compaction instruction (`/compact`) with a short
 *                       fixed checkpoint, so the recorder (tools/bridge-record.ts) can
 *                       replay both deterministically.
 *                       dsh-rebase P1-4d1 adds three for the recorder's live-mapping
 *                       scenarios: P1-THINK (a thinking block, then text), P1-USAGE
 *                       (a tool step, then text billed with cache reads and writes)
 *                       and P1-JOBNOTICE (a background job that outlives the turn;
 *                       its completion notice wakes the agent and is answered). A
 *                       script also gets the text that reached the model since its
 *                       last reply, which is how P1-JOBNOTICE tells the wake-up.
 *                       dsh-rebase P1-6b adds the P1-PERM-* scripts for the permission
 *                       plugin's pre-work experiments (tools/perm-experiments.ts): a
 *                       subagent, a workflow and a PTC program that each end in one
 *                       bash call, a short-circuited bash call, glob + grep over a
 *                       workspace with secrets, and a bash call held at the gate.
 *                       P1-6b part 2 adds three for the gate itself
 *                       (tools/bridge-smoke.ts): P1-PERM-DENY reads `.env`
 *                       through bash (refused, no card), P1-PERM-SESSION runs
 *                       two `echo` calls (one card, answered for the session),
 *                       P1-PERM-PLAN writes then reads a file (plan mode: the
 *                       write is refused, the read runs).
 *                       P1-6c adds two for the recorder's perm-* scenarios
 *                       (tools/bridge-record.ts): P1-PERM-WRITES writes two
 *                       workspace files (one card each), P1-PERM-GRANTS runs
 *                       `echo` twice (a grant for the session covers the
 *                       second) and then `echo … && rm -f …` (rm was never
 *                       granted, so it is asked).
 *                       dsh-rebase P1-4c1 adds three for turn semantics
 *                       (tools/steer-experiments.ts, tools/bridge-record.ts `steer`
 *                       and `fail-retry`): P1-STEER (two bash steps, the first
 *                       sleeping 2 s, then an answer naming every `STEER-NOTE-<tag>`
 *                       the request carried), P1-STEER-ONE (one answer naming them)
 *                       and P1-FAILONCE (HTTP 500 until the request carries the
 *                       bridge's hidden retry continuation, then an answer). Scripts
 *                       get every user text of the request as a seventh argument.
 *                       dsh-rebase P1-4c2 adds three for attachments
 *                       (tools/attachment-experiments.ts, tools/bridge-record.ts
 *                       `image` and `file-attach`): P1-IMAGE (one answer counting
 *                       the image blocks of the request's user messages),
 *                       P1-FILEREAD (a `read` of the path the DSH file handle line
 *                       names, then an answer naming every `FILE-MARKER-<tag>` it
 *                       read) and P1-IMAGEREAD (a `read_image` of the normalized
 *                       copy an image handle line names). Scripts get the request's
 *                       messages as an eighth argument.
 *                       dsh-rebase P1-4d3 adds P1-QUESTION (tools/bridge-record.ts
 *                       `question`): one `ask_user_question` call, then an answer
 *                       quoting the tool result the model got back.
 *                       dsh-rebase P1-7b adds three for the recorder's `jobs-kill` and
 *                       `sub-cont`: P1-JOBKILL (a background ticker the window stops;
 *                       the kill's notice wakes the agent), P1-SUBCONT (a continuable
 *                       subagent in the background; its settlement wakes the agent,
 *                       which sends it one more message; the second settlement wakes
 *                       it again) and P1-SUBCHILD (the child: one paced answer, 1 s,
 *                       so the parent's own step is over before the child speaks).
 *                       dsh-rebase P1-15 adds four for one-shot completions (decision
 *                       125; the shared-host integration test's completion phase and
 *                       tools/bridge-smoke.ts): P1-COMPLETE-COMMIT (a commit message
 *                       in a ``` fence), P1-COMPLETE-BRANCH (a branch name in a
 *                       ```text fence), P1-COMPLETE-REVIEW (a review paced over six
 *                       text deltas, 100 ms apart) and P1-COMPLETE-SLOW (a review
 *                       paced over 60 deltas, 250 ms apart, for cancel and timeout).
 *                       dsh-rebase P1-13c adds `markerName` to the P0-FS parameter
 *                       object, so the encrypted-read smoke can point the first
 *                       read at a policy-encrypted extension. dsh-rebase P1-13d
 *                       adds `editInMarker` (default false): when true, the P0-FS
 *                       script also edits the marker file itself and re-reads it,
 *                       which is the encrypted-edit scenario. Both are additive —
 *                       a prompt without them gets the unchanged default steps.
 *                       Every dsh-p0-2 log line also says whether the request carried
 *                       the one-shot system prompt (`completionSystem: true`).
 *                       dsh-rebase P1-6d adds P1-S18 (tools/perm-pwsh-probe.ts): the
 *                       gate's S18 cases as `pwsh` calls, or their bash twins for a
 *                       Linux dry run — `P1-S18 {"case":"card|grants|deny|auto",
 *                       "shell":"pwsh|bash"}` (see `S18_STEPS`).
 *                       dsh-rebase P1-8 adds the P8-* scripts for the loop guard
 *                       (tools/loop-guard-smoke.ts, decisions 065 / 066), decided by
 *                       `decideP8` ahead of the scripts above: P8-REPEAT streams one reply
 *                       of N identical family calls (paced, and logs how far it got when
 *                       the client hung up), P8-VARIED N distinct `job_output` calls,
 *                       P8-FANOUT ten distinct `subagent` calls (children: P8-CHILD),
 *                       P8-LOOP one tool call per step forever, P8-WAKE background jobs
 *                       then the same loop, P8-SUBREPEAT a subagent whose own reply is a
 *                       P8-REPEAT, P8-VICTIM a stamped paced answer for the contention
 *                       regression (tools/contention-regression.ts). Every P8 step that
 *                       carries the loop guard's wrap-up instruction is answered with
 *                       text (or, with `wrapTool`, one more tool call, to see it refused).
 *
 * Every request (health checks excluded) appends one JSON line to /tmp/t032/fake-gateway.log
 * (or --log <path>) with: ISO timestamp, sequence number, HTTP status returned, the role of the
 * last message in the request body, a <=200 char snippet of that message's content, and whether
 * the body contained a tool_result content block. The dsh-p0-2 plan also logs its decision
 * (scenario, round, step, tool) and the tools the request offered (`tools`, a count, and
 * since dsh-rebase P1-10d `toolNames`: bridge-smoke checks the pilot plugin's tools are
 * offered only while it is enabled, with P0-OFFICE as its turn). Every line also says what identified the client: `auth`,
 * the key it received as `sha256:<first 8 hex>` (never the key itself: P1-5b's canary scan
 * reads these logs too), `userAgent`, `clientHeader` (X-Pilab-Client), the model the body
 * named, the path, and the reasoning fields the body carried.
 *
 * `--port 0` listens on an ephemeral port; the startup line prints the actual one.
 *
 * Examples:
 *   node fake-gateway.mjs --port 18080 --plan text
 *   node fake-gateway.mjs --port 18080 --plan long-turn --sleep 30
 *   node fake-gateway.mjs --port 18080 --plan retry-503 --reset
 *   node fake-gateway.mjs --port 18080 --plan retry-503-forever
 *   node fake-gateway.mjs --port 18080 --plan write-approval
 *   node fake-gateway.mjs --port 18080 --plan archive-probe --sleep 45
 *   node fake-gateway.mjs --port 18080 --plan text --model-id claude-sonnet-5
 *   node fake-gateway.mjs --port 18080 --plan slow-write --chunks 40 --chunk-ms 300
 *   node fake-gateway.mjs --port 18080 --plan long-thinking --chunks 200 --chunk-ms 200
 *   node fake-gateway.mjs --port 18080 --plan slow-fail --hold 120
 *   curl -s http://127.0.0.1:18080/health
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

let LOG_PATH = '/tmp/t032/fake-gateway.log';
const VALID_PLANS = [
  'text',
  'long-turn',
  'retry-503',
  'retry-503-forever',
  'write-approval',
  'archive-probe',
  'ask-question',
  'slow-write',
  'long-thinking',
  'slow-fail',
  'echo-key-error',
  'dsh-p0-2',
];

/** Per-plan pacing defaults, applied only when the caller did not say. */
const PACING_DEFAULTS = {
  'slow-write': { chunks: 40, chunkMs: 300 },
  'long-thinking': { chunks: 200, chunkMs: 200 },
};

function parseArgs(argv) {
  const args = {
    port: null,
    plan: null,
    sleep: 90,
    state: '/tmp/t032/fake-gateway.state.json',
    reset: false,
    modelId: 'fake-sonnet',
    chunks: null,
    chunkMs: null,
    hold: 120,
    writePath: 'demo/out.html',
    writeLines: 60,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--plan') args.plan = argv[++i];
    else if (a === '--sleep') args.sleep = Number(argv[++i]);
    else if (a === '--state') args.state = argv[++i];
    else if (a === '--reset') args.reset = true;
    else if (a === '--model-id') args.modelId = argv[++i];
    else if (a === '--chunks') args.chunks = Number(argv[++i]);
    else if (a === '--chunk-ms') args.chunkMs = Number(argv[++i]);
    else if (a === '--hold') args.hold = Number(argv[++i]);
    else if (a === '--write-path') args.writePath = argv[++i];
    else if (a === '--write-lines') args.writeLines = Number(argv[++i]);
    else if (a === '--log') args.log = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (args.port === null || Number.isNaN(args.port)) throw new Error('--port <n> is required');
  if (!args.plan) throw new Error('--plan <name> is required');
  if (!VALID_PLANS.includes(args.plan)) {
    throw new Error(`--plan must be one of: ${VALID_PLANS.join(', ')} (got "${args.plan}")`);
  }
  if (!Number.isFinite(args.sleep) || args.sleep <= 0)
    throw new Error('--sleep must be a positive number');
  if (!args.modelId) throw new Error('--model-id requires a value');
  const pacing = PACING_DEFAULTS[args.plan] ?? { chunks: 40, chunkMs: 300 };
  if (args.chunks === null) args.chunks = pacing.chunks;
  if (args.chunkMs === null) args.chunkMs = pacing.chunkMs;
  if (!Number.isInteger(args.chunks) || args.chunks <= 0)
    throw new Error('--chunks must be a positive integer');
  if (!Number.isFinite(args.chunkMs) || args.chunkMs < 0)
    throw new Error('--chunk-ms must be a non-negative number');
  if (!Number.isFinite(args.hold) || args.hold <= 0)
    throw new Error('--hold must be a positive number');
  if (!Number.isInteger(args.writeLines) || args.writeLines <= 0)
    throw new Error('--write-lines must be a positive integer');
  if (!args.writePath) throw new Error('--write-path requires a value');
  return args;
}

function loadState(statePath, reset) {
  if (!reset) {
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.count === 'number') return { count: parsed.count };
    } catch {
      // missing/corrupt state file -> start fresh
    }
  }
  return { count: 0 };
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function ensureLogDir() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
}

function summarizeMessage(msg) {
  if (!msg) return '';
  let text = '';
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content
      .map((block) => {
        if (!block || typeof block !== 'object') return String(block);
        if (block.type === 'text') return block.text ?? '';
        if (block.type === 'tool_use') return `[tool_use:${block.name}]`;
        if (block.type === 'tool_result') {
          const c = block.content;
          if (typeof c === 'string') return `[tool_result:${c}]`;
          if (Array.isArray(c)) return `[tool_result:${c.map((x) => x?.text ?? '').join(' ')}]`;
          return '[tool_result]';
        }
        return JSON.stringify(block);
      })
      .join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function hasToolResult(messages) {
  return messages.some(
    (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_result')
  );
}

function logRequest(entry) {
  ensureLogDir();
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

// ---- dsh-p0-2: content-keyed scripts for the DSH host probe -----------------

const P0_MARKER =
  /P0-(GOAL-COMPLETE|GOAL-BLOCKED|GOAL-PAUSE|GOAL-ROUNDLIMIT|JOBS|OFFICE|ENV|FDS|APPROVAL|STREAM|SLOWTOOL|SLEEPTOOL|TOOL|FS|RECALL|CRASH|PACED|LOAD|HIST)/;
/** dsh-rebase P1-4e scenarios; scripted under `P1-<name>` in `DSH_P0_2_SCRIPTS`. */
const P1_MARKER =
  /P1-(FAILONCE|FAIL|GATE|ECHOKEY|ENVDUMP|THINK|USAGE|JOBNOTICE|JOBKILL|SUBCONT|SUBCHILD|STEER-ONE|STEER|IMAGEREAD|IMAGE|FILEREAD|QUESTION|COMPLETE-(?:COMMIT|BRANCH|REVIEW|SLOW)|PERM-(?:SUB|CHILD|WF|PTC|GUARD|SEARCH|HOLD|DENY|SESSION|PLAN|WRITES|GRANTS)|S18)/;

/** dsh-rebase P1-15: the system prompt of every one-shot completion (src/dsh-host/bridge/completions.ts). */
const COMPLETION_SYSTEM = /You are a tool-free completion service\./;

/** P1-15: whether the request's system prompt (Anthropic `system`, or a system message) is the one-shot one. */
function carriesCompletionSystem(parsed) {
  const system = parsed?.system;
  const texts = [];
  if (typeof system === 'string') texts.push(system);
  else if (Array.isArray(system)) for (const block of system) texts.push(String(block?.text ?? ''));
  for (const message of Array.isArray(parsed?.messages) ? parsed.messages : []) {
    if (message?.role === 'system' || message?.role === 'developer') texts.push(ownText(message));
  }
  return texts.some((text) => COMPLETION_SYSTEM.test(text));
}
/** dsh-rebase P1-8 loop guard scenarios, decided by `decideP8`. */
const P8_MARKER = /P8-(REPEAT|VARIED|FANOUT|CHILD|LOOP|WAKE|SUBREPEAT|VICTIM)/;

/** DSH's compaction request ends with this instruction (dsh-compaction-basic `COMPACTION_INSTRUCTION`). */
const COMPACTION_INSTRUCTION = /You are now acting as a compaction engine/;
/** Short on purpose: DSH rejects a checkpoint that does not shrink what it replaces. */
const COMPACTION_SUMMARY = [
  '## Primary Request and Intent',
  '- P1-COMPACT: stream a paragraph, then list the workspace.',
  '',
  '## Current Work',
  '- (none)',
].join('\n');

/** Text of a message's own text blocks (tool results excluded). */
function ownText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

function toolResultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => x?.text ?? '').join('\n');
  return '';
}

/** The latest get_goal result, parsed to the ref update_goal needs. */
function goalRefFrom(calls) {
  const read = [...calls].reverse().find((c) => c.name === 'get_goal' && c.result !== undefined);
  if (!read) return { goal_id: 'missing-get-goal', revision: 1 };
  try {
    const parsed = JSON.parse(read.result.slice(read.result.indexOf('{')));
    return { goal_id: parsed.goal.id, revision: parsed.goal.revision };
  } catch {
    return { goal_id: 'unparsable-get-goal', revision: 1 };
  }
}

/**
 * dsh-rebase P1-4c1: the hidden retry continuation the bridge follows up after a
 * failed turn (decision 028, `DSH_RETRY_CONTINUATION_TEXT` of
 * src/shared/dshHistory/types.ts).
 */
const RETRY_CONTINUATION = /The previous model request failed\. Continue from where it stopped\./;

/** P1-4c1: the steering notes (`STEER-NOTE-<tag>`) in `text`, in order, or `-`. */
function steerNotes(text) {
  const notes = [...new Set(String(text ?? '').match(/STEER-NOTE-[A-Z0-9]+/g) ?? [])];
  return notes.length > 0 ? notes.join(',') : '-';
}

/**
 * dsh-rebase P1-4c2: the read-only path a DSH file handle line names
 * (dsh-llm `fileHandleText`; the path is JSON-quoted).
 */
const FILE_HANDLE_PATH = /verbatim read-only copy saved at ("(?:[^"\\]|\\.)*")/;
/** P1-4c2: the normalized copy an image handle line names (dsh-llm `requestImageHandleText`). */
const IMAGE_HANDLE_PATH =
  /Normalized copy \(read-only; may be resized or re-encoded\): ("(?:[^"\\]|\\.)*")/;

/** P1-4c2: the first path `pattern` finds in `text`, unquoted, or undefined. */
function handlePath(text, pattern) {
  const quoted = String(text ?? '').match(pattern)?.[1];
  if (!quoted) return undefined;
  try {
    return JSON.parse(quoted);
  } catch {
    return undefined;
  }
}

/** P1-4c2: image content blocks in the request's user messages (Anthropic `image`). */
function imageBlocks(messages) {
  let count = 0;
  for (const message of messages ?? []) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) if (block?.type === 'image') count += 1;
  }
  return count;
}

/** P1-4c2: the file markers (`FILE-MARKER-<tag>`) in `text`, in order, or `-`. */
function fileMarkers(text) {
  const markers = [...new Set(String(text ?? '').match(/FILE-MARKER-[A-Z0-9]+/g) ?? [])];
  return markers.length > 0 ? markers.join(',') : '-';
}

const tool = (name, input) => ({ kind: 'tool_use', status: 200, name, input });
const say = (text) => ({ kind: 'text', status: 200, text });

// dsh-rebase P0-4: the prompt carries a JSON object after the marker, e.g.
// `P0-FS {"tag":"on","dir":"D:\\enc\\ws-on","marker":"...","token":"...","shell":"pwsh"}`.
function p04Params(triggerText) {
  try {
    return JSON.parse(triggerText.slice(triggerText.indexOf('{')));
  } catch {
    // P0-6 prompts carry prose after the object; take the balanced object alone.
    try {
      const object = firstJsonObject(triggerText);
      if (object) return JSON.parse(object);
    } catch {
      // Fall through to the placeholder parameters.
    }
    return { tag: 'bad-params', dir: '.', marker: 'missing', token: 'missing', shell: 'bash' };
  }
}

/** The first balanced `{...}` in `text` (string-aware), or null. */
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
/**
 * dsh-rebase P1-6d: S18's shell steps (plan P1-6 shard 04 §5: pwsh's S1, S3,
 * S4 and S7), each with its bash twin for the Linux dry run. Relative paths:
 * the call runs in the session's own workspace.
 *   card    S1  ask: two writes; the probe allows the first card, denies the second
 *   grants  S3  ask: `Write-Output` answered for the session; `echo` (its alias)
 *               asks nothing; `echo …; Remove-Item …` asks (never granted)
 *   deny    S4  bypass: the env file and a private key, refused without a card
 *   auto    S7  auto: a variable the analysis cannot read asks (`askReason`),
 *               the plain word does not
 */
const S18_STEPS = {
  card: {
    pwsh: [
      ["Set-Content -LiteralPath 's18-allowed.txt' -Value 'first'", 'Write the first file'],
      ["Set-Content -LiteralPath 's18-denied.txt' -Value 'second'", 'Write the second file'],
    ],
    bash: [
      ['printf first > s18-allowed.txt', 'Write the first file'],
      ['printf second > s18-denied.txt', 'Write the second file'],
    ],
  },
  grants: {
    pwsh: [
      ['Write-Output s18-a', 'First echo'],
      ['echo s18-b', 'Second echo, by its alias'],
      [
        "echo s18-c; Remove-Item -LiteralPath 's18-missing.txt' -ErrorAction SilentlyContinue",
        'Echo, then remove a file',
      ],
    ],
    bash: [
      ['echo s18-a', 'First echo'],
      ['echo s18-b', 'Second echo'],
      ['echo s18-c && rm -f s18-missing.txt', 'Echo, then remove a file'],
    ],
  },
  deny: {
    pwsh: [
      ['Get-Content -LiteralPath .env', 'Print the env file'],
      ['Get-Content ~\\.ssh\\id_rsa', 'Print a private key'],
    ],
    bash: [
      ['cat .env', 'Print the env file'],
      ['cat ~/.ssh/id_rsa', 'Print a private key'],
    ],
  },
  auto: {
    pwsh: [
      ['Write-Output $S18X > s18-var.txt', 'Write a variable'],
      ['Write-Output s18 > s18-plain.txt', 'Write a word'],
    ],
    bash: [
      ['echo $S18X > s18-var.txt', 'Write a variable'],
      ['echo s18 > s18-plain.txt', 'Write a word'],
    ],
  },
};
const p04Join = (dir, name) => `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;
const pwshQuote = (text) => `'${text.replace(/'/g, "''")}'`;
const bashQuote = (text) => `'${text.replace(/'/g, "'\\''")}'`;

/** The P0-4 shell steps for either `pwsh` (Windows) or `bash` (Linux dry run). */
function p04ShellSteps(p, f) {
  const shellWritten = f(`shell-written-${p.token}.txt`);
  const line = `${p.marker} SHELL-${p.token}`;
  if (p.shell === 'pwsh') {
    return [
      tool('pwsh', {
        command: `Get-Content -Raw -LiteralPath ${pwshQuote(f('marker.txt'))}`,
        description: 'Read the marker file',
      }),
      tool('pwsh', {
        command: `Set-Content -LiteralPath ${pwshQuote(shellWritten)} -Value ${pwshQuote(line)} -Encoding ASCII`,
        description: 'Write a file from the shell',
      }),
      tool('pwsh', {
        command: `1..4000 | ForEach-Object { "spill-line $_ ${p.token}" }`,
        description: 'Print a large output',
      }),
    ];
  }
  return [
    tool('bash', {
      command: `cat ${bashQuote(f('marker.txt'))}`,
      description: 'Read the marker file',
    }),
    tool('bash', {
      command: `printf '%s\\n' ${bashQuote(line)} > ${bashQuote(shellWritten)}`,
      description: 'Write a file from the shell',
    }),
    tool('bash', {
      command: `for i in $(seq 1 4000); do echo "spill-line $i ${p.token}"; done`,
      description: 'Print a large output',
    }),
  ];
}

/**
 * One script per scenario: (round, step, calls) -> decision. Round 0 is the
 * human turn; goal rounds are 1-based as the round driver numbers them.
 */
const DSH_P0_2_SCRIPTS = {
  'GOAL-COMPLETE'(round, step, calls) {
    if (round === 0) {
      if (step === 0) {
        return tool('create_goal', {
          objective: 'P0-GOAL-COMPLETE: write progress.txt in the workspace, then verify it',
          max_goal_rounds: 4,
        });
      }
      return say('Goal created; automatic rounds will do the work.');
    }
    if (round === 1) {
      if (step === 0) {
        return tool('todo_write', {
          todos: [
            { content: 'Write progress.txt', status: 'in_progress' },
            { content: 'Verify progress.txt', status: 'pending' },
          ],
        });
      }
      if (step === 1) {
        return tool('bash', {
          command: 'echo round-1 > progress.txt && cat progress.txt',
          description: 'Write progress file',
        });
      }
      return say('Round 1: wrote progress.txt; verification remains for the next round.');
    }
    if (round === 2) {
      if (step === 0) {
        return tool('bash', { command: 'cat progress.txt', description: 'Verify progress file' });
      }
      if (step === 1) {
        return tool('todo_write', {
          todos: [
            { content: 'Write progress.txt', status: 'completed' },
            { content: 'Verify progress.txt', status: 'completed' },
          ],
        });
      }
      if (step === 2) return tool('get_goal', {});
      if (step === 3) return tool('update_goal', { ...goalRefFrom(calls), action: 'complete' });
      return say('Objective achieved: progress.txt verified.');
    }
    return say(`unexpected round ${round}`);
  },
  'GOAL-BLOCKED'(round, step, calls) {
    if (round === 0) {
      if (step === 0) {
        return tool('create_goal', {
          objective: 'P0-GOAL-BLOCKED: load /nonexistent/p0-config.json and apply it',
          max_goal_rounds: 6,
        });
      }
      return say('Goal created.');
    }
    if (step === 0) {
      return tool('bash', {
        command: 'cat /nonexistent/p0-config.json',
        description: 'Read the config',
      });
    }
    if (step === 1) return tool('get_goal', {});
    if (step === 2) {
      return tool('update_goal', {
        ...goalRefFrom(calls),
        action: 'blocked',
        blocked_reason: `Config /nonexistent/p0-config.json is still missing (round ${round}).`,
      });
    }
    const update = calls.find((c) => c.name === 'update_goal');
    return say(
      update?.isError
        ? `Round ${round}: still blocked, the blocker was not accepted yet.`
        : 'Blocked: the config file does not exist.'
    );
  },
  'GOAL-PAUSE'(round, step, calls) {
    if (round === 1) {
      if (step === 0) {
        return tool('bash', {
          command: 'sleep 8; echo slow-check-done',
          description: 'Slow check',
        });
      }
      return say('Slow check finished.');
    }
    if (round >= 2) {
      if (step === 0) return tool('get_goal', {});
      if (step === 1) return tool('update_goal', { ...goalRefFrom(calls), action: 'complete' });
      return say('Resumed and finished.');
    }
    return say('P0-GOAL-PAUSE has no human-turn script.');
  },
  'GOAL-ROUNDLIMIT'(round, step) {
    if (round === 0) {
      if (step === 0) {
        return tool('create_goal', {
          objective: 'P0-GOAL-ROUNDLIMIT: keep polishing without ever finishing',
          max_goal_rounds: 2,
        });
      }
      return say('Goal created.');
    }
    return say(`Still polishing (round ${round}); work remains.`);
  },
  JOBS(_round, step, calls) {
    if (step === 0) {
      return tool('bash', {
        command: 'for i in 1 2 3; do echo tick-$i; sleep 1; done',
        description: 'Background ticker',
        run_in_background: true,
      });
    }
    // DSH answers "started background job <id> ...".
    const started = calls[0]?.result ?? '';
    const jobId = (started.match(/background job ([\w.:-]+)/) ?? [])[1] ?? 'unknown-job';
    if (step === 1) return tool('job_list', {});
    if (step === 2) return tool('job_output', { job_id: jobId, wait: true, timeout_ms: 15000 });
    return say('Background job collected.');
  },
  // dsh-rebase P0-3: GUI bridge cases.
  STREAM() {
    return {
      kind: 'paced-text',
      status: 200,
      text:
        'DSH 引擎经 aiclient-bridge 流式回复：这段文字分成二十小块，每块间隔约一百五十毫秒送出，' +
        '用来确认渲染层看到的是逐块增长的正文，而不是一次性出现的整段。',
      chunks: 20,
      chunkMs: 150,
    };
  },
  TOOL(_round, step) {
    if (step === 0) {
      return tool('bash', {
        command: 'echo "bridge tool row ok"; pwd; ls -a',
        description: 'List the workspace',
      });
    }
    return say('Tool row finished: the workspace listing is above.');
  },
  SLOWTOOL(_round, step) {
    if (step === 0) {
      return tool('bash', {
        command: 'echo slow tool started; sleep 5; echo slow tool done',
        description: 'Run a slow command',
      });
    }
    return say('The slow command finished.');
  },
  APPROVAL(_round, step, _calls, triggerText) {
    // The prompt names a path outside the session workspace: `path=<abs path>`.
    const target = (triggerText.match(/path=(\S+)/) ?? [])[1] ?? 'outside-approval.txt';
    // First a plain write (the file sandbox denies it), then the same write
    // asking for escalation, which DSH routes through `approval/request`.
    if (step === 0) {
      return tool('write', { file_path: target, content: 'written after approval\n' });
    }
    if (step === 1) {
      return tool('write', {
        file_path: target,
        content: 'written after approval\n',
        sandbox_permissions: 'danger-full-access',
        justification: 'The P0 probe needs one file outside the workspace.',
      });
    }
    return say('Write outside the workspace attempted.');
  },
  OFFICE(_round, step) {
    if (step === 0) {
      return tool('word_create', {
        path: 'p0-report.docx',
        title: 'P0-2 report',
        paragraphs: ['Written by dsh-office-tools through the fake gateway.'],
        bullets: ['goal', 'todo', 'jobs'],
      });
    }
    if (step === 1) return tool('word_read', { path: 'p0-report.docx' });
    return say('Office document created and read back.');
  },
  ENV(_round, step) {
    if (step === 0) {
      return tool('bash', {
        // Values of the canaries only; every other variable is listed by name.
        command:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
          'echo "ws=${P0_WS_CANARY:-unset} hostcwd=${P0_HOSTCWD_CANARY:-unset} dshhome=${P0_DSHHOME_CANARY:-unset} gatewaykey=${AICLIENT_DSH_GATEWAY_KEY:+present}"; echo "names: $(env | cut -d= -f1 | sort | tr "\\n" " ")"',
        description: 'Print env canaries',
      });
    }
    return say('Env canaries printed.');
  },
  // dsh-rebase P1-3a (decision 034's precondition): which descriptors and IPC
  // variables a tool process inherits from the host. Linux /proc only.
  // Step 0 runs in the sandbox, step 1 escalates out of it (an approval).
  FDS(_round, step) {
    const command =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
      'echo "pid=$$ ppid=$PPID channel_fd=${NODE_CHANNEL_FD:-unset} channel_mode=${NODE_CHANNEL_SERIALIZATION_MODE:-unset}"; for fd in /proc/$$/fd/*; do echo "fd ${fd##*/} -> $(readlink "$fd")"; done';
    if (step === 0) {
      return tool('bash', { command, description: 'List inherited file descriptors' });
    }
    if (step === 1) {
      return tool('bash', {
        command,
        description: 'List them again outside the sandbox',
        sandbox_permissions: 'danger-full-access',
        justification:
          'The P1-3a probe compares what a tool inherits inside and outside the sandbox.',
      });
    }
    return say('Inherited file descriptors listed.');
  },
  // dsh-rebase P0-4: file tools and the shell against an encrypted workspace.
  // P1-13c: `markerName` (default `marker.txt`) lets the encrypted-read smoke
  // point the first read at a policy-encrypted extension.
  // P1-13d: `refuseName` (optional) inserts a read of a marker file the
  // fallback cannot decrypt — the still-ciphertext refusal — and
  // `editInMarker` (default false) inserts a literal edit against the marker
  // file itself plus a re-read. Both are additive: a prompt without them gets
  // exactly the steps and judgement it had before (decision 135).
  FS(_round, step, _calls, triggerText) {
    const p = p04Params(triggerText);
    const f = (name) => p04Join(p.dir, name);
    const written = f(`dsh-written-${p.token}.txt`);
    const markerFile = f(p.markerName ?? 'marker.txt');
    const steps = [
      ...(p.refuseName === undefined ? [] : [tool('read', { file_path: f(p.refuseName) })]),
      tool('read', { file_path: markerFile }),
      ...(p.editInMarker === true
        ? [
            tool('edit', {
              file_path: markerFile,
              old_string: p.marker,
              new_string: `${p.marker} ENC-EDITED-${p.token}`,
            }),
            tool('read', { file_path: markerFile }),
          ]
        : []),
      tool('read', { file_path: f('edit-target.txt') }),
      tool('edit', {
        file_path: f('edit-target.txt'),
        old_string: p.marker,
        new_string: `${p.marker} EDITED-${p.token}`,
      }),
      tool('read', { file_path: f('edit-target.txt') }),
      tool('write', { file_path: written, content: `${p.marker} WRITTEN-${p.token}\n` }),
      tool('read', { file_path: written }),
      tool('grep', { pattern: p.marker, path: p.dir }),
      tool('glob', { pattern: '*.txt', path: p.dir }),
      ...p04ShellSteps(p, f),
      tool('read', { file_path: f(`shell-written-${p.token}.txt`) }),
    ];
    const decision = step < steps.length ? steps[step] : say(`P0-FS ${p.tag} finished.`);
    return { ...decision, tag: p.tag };
  },
  // dsh-rebase P0-4: after a resume, does the model request still carry the
  // marker the earlier turn read from the encrypted file?
  RECALL(_round, _step, _calls, triggerText, history) {
    const p = p04Params(triggerText);
    // P0-6: `markers` checks several strings at once and names each outcome.
    if (Array.isArray(p.markers)) {
      const present = p.markers.filter((m) => history.includes(m));
      const missing = p.markers.filter((m) => !history.includes(m));
      const tag = `present=${present.join(',') || '-'} missing=${missing.join(',') || '-'}`;
      return { ...say(`P0-RECALL ${tag}`), tag };
    }
    const present = history.includes(p.marker);
    return {
      ...say(`P0-RECALL ${present ? 'present' : 'missing'}`),
      tag: present ? 'present' : 'missing',
    };
  },
  // dsh-rebase P1-15 (decision 125): one-shot completions. The commit message
  // and the branch name come fenced, as models often answer, so the app's own
  // fence stripping is on the path; the reviews are paced text.
  'P1-COMPLETE-COMMIT'() {
    return say('```\nfeat(p1-15): generate commit messages on the DSH host\n```');
  },
  'P1-COMPLETE-BRANCH'() {
    return say('```text\nfeat/p1-15-one-shot\n```');
  },
  'P1-COMPLETE-REVIEW'() {
    return {
      kind: 'paced-text',
      status: 200,
      text: 'Review of the P1-COMPLETE diff: no issues found. The change is small and tested.',
      chunks: 6,
      chunkMs: 100,
    };
  },
  'P1-COMPLETE-SLOW'() {
    return {
      kind: 'paced-text',
      status: 200,
      text: 'A slow review that keeps going, one small piece at a time, until someone stops it. '.repeat(
        3
      ),
      chunks: 60,
      chunkMs: 250,
    };
  },
  // dsh-rebase P1-5b (KEY-CANARY): the upstream rejects the key and repeats it.
  'P1-ECHOKEY'() {
    return { kind: 'echo-key', status: 401 };
  },
  // dsh-rebase P1-5b (KEY-CANARY): a tool prints its whole environment, which the
  // canary scan reads; then one more request, so the key is asked for twice.
  'P1-ENVDUMP'(_round, step) {
    if (step === 0) {
      return tool('bash', { command: 'env', description: 'Print the tool environment' });
    }
    return say('Environment printed.');
  },
  // dsh-rebase P1-4e: every request of the turn fails upstream (no retry in this route).
  // dsh-rebase P1-4d1 (tools/bridge-record.ts `think`): a reasoning block, then the answer.
  'P1-THINK'() {
    return {
      ...say('Thought it through: the answer is 42.'),
      thinking: 'First the question, then the arithmetic.\nSix times seven is forty-two.',
    };
  },
  // P1-4d1 (`usage`): a tool step and an answer, both billed with cache reads
  // and writes, so every usage field has a value to carry.
  'P1-USAGE'(_round, step) {
    if (step === 0) {
      return tool('bash', { command: 'echo usage-probe', description: 'Print a marker' });
    }
    return {
      ...say('Usage recorded for both steps.'),
      usage: { input_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 },
    };
  },
  // P1-4d1 (`job-notice`): a background job that ends after the turn does; its
  // completion notice wakes the agent into a turn nobody sent.
  'P1-JOBNOTICE'(_round, step, _calls, _triggerText, _history, recent) {
    if (/background job \S+ .*finished/.test(recent ?? '')) {
      return say('The background job reported back: done.');
    }
    if (step === 0) {
      return tool('bash', {
        command: 'sleep 3; echo job-notice-done',
        description: 'Background sleeper',
        run_in_background: true,
      });
    }
    return say('Started a background job; its notice will wake me.');
  },
  'P1-FAIL'() {
    return {
      kind: 'error',
      status: 500,
      message: 'P1-FAIL: the fake upstream failed this request',
    };
  },
  // dsh-rebase P1-7e (decision 140): a company gateway's stream gate refuses
  // the reply before the model's first byte, as a 5xx with its own body.
  'P1-GATE'() {
    return {
      kind: 'raw-error',
      status: 502,
      body: JSON.stringify({
        error: {
          type: 'stream_gate_precommit',
          reason: 'prebuffer_overflow',
          family: 'anthropic',
          message: 'P1-GATE: the fake gateway gated this reply',
        },
      }),
    };
  },
  // dsh-rebase P1-7b (tools/bridge-record.ts `jobs-kill`): a background ticker
  // that would run a minute; the jobs window stops it, and the kill's
  // completion notice wakes the agent into a turn nobody sent.
  'P1-JOBKILL'(_round, step, _calls, _triggerText, _history, recent) {
    if (/background job \S+ .*finished/.test(recent ?? '')) {
      return say('P1-JOBKILL: the ticker was stopped.');
    }
    if (step === 0) {
      return tool('bash', {
        command: 'for i in $(seq 1 600); do echo tick $i; sleep 0.1; done',
        description: 'Background ticker',
        run_in_background: true,
      });
    }
    return say('P1-JOBKILL: started the ticker.');
  },
  // P1-7b (`sub-cont`): a continuable subagent in the background. Its first
  // settlement wakes the agent, which sends it one more message
  // (`send_message`); the second settlement wakes it again. No reply here or
  // in the child's carries a marker, so a notice quoting one decides nothing.
  'P1-SUBCONT'(_round, step, calls, _triggerText, _history, recent, userTexts) {
    const settled = (userTexts ?? '').match(/Background subagent \S+ finished/g)?.length ?? 0;
    const woke = /Background subagent \S+ finished/.test(recent ?? '');
    if (woke && settled >= 2) return say('Both runs of the subagent reported back.');
    if (woke && step === 1) {
      const child = /started subagent (\S+)/.exec(String(calls[0]?.result ?? ''))?.[1];
      if (!child) return say('No subagent id to continue.');
      return tool('send_message', { agent_id: child, message: 'Please report once more.' });
    }
    if (step === 0) {
      return tool('subagent', {
        description: 'Continuable probe',
        prompt: 'P1-SUBCHILD: answer in one line.',
      });
    }
    if (step === 1) return say('Delegated; the subagent reports back when it is done.');
    return say('Sent the subagent one more message.');
  },
  'P1-SUBCHILD'() {
    return {
      kind: 'paced-text',
      status: 200,
      text: 'Child done: the probe ran.',
      chunks: 10,
      chunkMs: 100,
      tag: 'subchild',
    };
  },
  // dsh-rebase P1-4c1 (decision 095, tools/bridge-record.ts `fail-retry`): the
  // first request fails upstream; once the bridge's hidden retry continuation
  // (decision 028) reached the model, the turn answers.
  'P1-FAILONCE'(_round, _step, _calls, _triggerText, _history, _recent, userTexts) {
    if (RETRY_CONTINUATION.test(userTexts ?? '')) {
      return say('P1-FAILONCE recovered after the retry.');
    }
    return {
      kind: 'error',
      status: 500,
      message: 'P1-FAILONCE: the fake upstream failed this request once',
    };
  },
  // dsh-rebase P1-4c1 (decision 093; tools/steer-experiments.ts, tools/bridge-record.ts
  // `steer`): two tool steps, then an answer naming every steering note the model
  // was sent (`STEER-NOTE-<tag>` anywhere in a user message of the request).
  // The first command sleeps, so a driver can steer while it runs.
  'P1-STEER'(_round, step, _calls, _triggerText, _history, _recent, userTexts) {
    if (step === 0) {
      return tool('bash', {
        command: 'sleep 2; echo steer-step-1',
        description: 'First step',
      });
    }
    if (step === 1) {
      return tool('bash', { command: 'echo steer-step-2', description: 'Second step' });
    }
    return say(`P1-STEER finished; heard: ${steerNotes(userTexts)}.`);
  },
  // P1-4c1: one text step naming the steering notes it was sent; answered
  // again when a note is steered in after it.
  'P1-STEER-ONE'(_round, _step, _calls, _triggerText, _history, _recent, userTexts) {
    return say(`P1-STEER-ONE heard: ${steerNotes(userTexts)}.`);
  },
  // dsh-rebase P1-4c2 (decision 096; tools/bridge-record.ts `image`,
  // tools/attachment-experiments.ts): one answer counting the image blocks the
  // request carried in user messages. Scripts get the request's messages as an
  // eighth argument.
  'P1-IMAGE'(_round, _step, _calls, _triggerText, _history, _recent, _userTexts, messages) {
    return say(`P1-IMAGE saw ${imageBlocks(messages)} image block(s).`);
  },
  // P1-4c2 (decision 097; `file-attach`): read the attached file through the
  // path its DSH handle line names, then answer with the file markers read.
  'P1-FILEREAD'(_round, step, calls, _triggerText, _history, _recent, userTexts) {
    if (step === 0) {
      const path = handlePath(userTexts, FILE_HANDLE_PATH);
      if (!path) return say('P1-FILEREAD found no file handle.');
      return tool('read', { file_path: path });
    }
    const read = calls[0];
    return say(
      read?.isError
        ? `P1-FILEREAD could not read it: ${String(read.result ?? '').slice(0, 160)}`
        : `P1-FILEREAD read: ${fileMarkers(read?.result)}.`
    );
  },
  // P1-4c2 (tools/attachment-experiments.ts): read_image on the normalized copy
  // an image handle line names, then answer with the image block count.
  'P1-IMAGEREAD'(_round, step, calls, _triggerText, _history, _recent, userTexts, messages) {
    if (step === 0) {
      const path = handlePath(userTexts, IMAGE_HANDLE_PATH);
      if (!path) return say(`P1-IMAGEREAD found no image path; ${imageBlocks(messages)} block(s).`);
      return tool('read_image', { file_path: path });
    }
    const read = calls[0];
    const seen = `${imageBlocks(messages)} image block(s)`;
    return say(
      read?.isError
        ? `P1-IMAGEREAD could not read it (${seen}): ${String(read.result ?? '').slice(0, 160)}`
        : `P1-IMAGEREAD read it; ${seen}.`
    );
  },
  // dsh-rebase P1-4d3 (decisions 098, 114): one ask_user_question with a
  // single-select and a multi-select question (a label holding ", "), then an
  // answer quoting what the tool returned (tools/bridge-record.ts `question`).
  'P1-QUESTION'(_round, step, calls) {
    if (step === 0) {
      return tool('ask_user_question', {
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            question: 'Which part should change first?',
            options: [
              { label: 'Bridge (Recommended)', description: 'The worker side of the card.' },
              { label: 'Renderer', description: 'The card itself.' },
            ],
          },
          {
            id: 'checks',
            header: 'Checks',
            question: 'Which checks should run afterwards?',
            multi_select: true,
            options: [{ label: 'tsc' }, { label: 'smoke, then record' }, { label: 'vitest' }],
          },
        ],
      });
    }
    const asked = calls[0];
    return say(
      asked?.isError
        ? `P1-QUESTION failed: ${String(asked.result ?? '').slice(0, 300)}`
        : `P1-QUESTION got ${String(asked?.result ?? '(nothing)').slice(0, 400)}`
    );
  },
  // dsh-rebase P1-6b: permission plugin experiments (tools/perm-experiments.ts).
  'P1-PERM-SUB'(_round, step) {
    if (step === 0) {
      return tool('subagent', {
        description: 'Permission probe child',
        prompt: 'P1-PERM-CHILD: run one bash call, then answer.',
        run_in_background: false,
      });
    }
    return say('P1-PERM-SUB finished.');
  },
  'P1-PERM-CHILD'(_round, step) {
    if (step === 0) {
      return tool('bash', { command: 'echo perm-child-call', description: 'Echo from the child' });
    }
    return say('P1-PERM-CHILD finished.');
  },
  'P1-PERM-WF'(_round, step) {
    if (step === 0) {
      return tool('workflow', {
        script:
          'const r = await agent("P1-PERM-CHILD: run one bash call, then answer."); return r;',
        meta: { name: 'perm-wf', description: 'Permission probe workflow' },
      });
    }
    return say('P1-PERM-WF finished.');
  },
  'P1-PERM-PTC'(_round, step) {
    if (step === 0) {
      return tool('run_code', {
        code: "const r = await tools.bash({ command: 'echo perm-ptc-sub', description: 'Echo from PTC' }); return r;",
        description: 'Run one bash call from a program',
      });
    }
    return say('P1-PERM-PTC finished.');
  },
  'P1-PERM-GUARD'(_round, step) {
    if (step === 0) {
      return tool('bash', {
        command: 'echo P1-PERM-SHORTCIRCUIT',
        description: 'Short-circuit probe',
      });
    }
    return say('P1-PERM-GUARD finished.');
  },
  'P1-PERM-SEARCH'(_round, step) {
    if (step === 0) return tool('glob', { pattern: '**/*' });
    if (step === 1) return tool('grep', { pattern: 'PERM-SECRET' });
    return say('P1-PERM-SEARCH finished.');
  },
  // dsh-rebase P1-6b part 2: the gate for real (tools/bridge-smoke.ts).
  'P1-PERM-DENY'(_round, step) {
    if (step === 0) {
      return tool('bash', { command: 'cat .env', description: 'Print the env file' });
    }
    return say('P1-PERM-DENY finished.');
  },
  'P1-PERM-SESSION'(_round, step) {
    if (step === 0) {
      return tool('bash', { command: 'echo perm-session-first', description: 'First echo' });
    }
    if (step === 1) {
      return tool('bash', { command: 'echo perm-session-second', description: 'Second echo' });
    }
    return say('P1-PERM-SESSION finished.');
  },
  'P1-PERM-PLAN'(_round, step) {
    if (step === 0) {
      return tool('write', { file_path: 'perm-plan.txt', content: 'written in plan mode\n' });
    }
    if (step === 1) return tool('read', { file_path: 'perm-plan-notes.txt' });
    return say('P1-PERM-PLAN finished.');
  },
  'P1-PERM-HOLD'(_round, step) {
    if (step === 0) {
      return tool('bash', { command: 'echo P1-PERM-HOLD', description: 'Held at the gate' });
    }
    return say('P1-PERM-HOLD finished.');
  },
  // dsh-rebase P1-6c: the recorder's perm-* scenarios (tools/bridge-record.ts).
  'P1-PERM-WRITES'(_round, step) {
    if (step === 0) {
      return tool('write', { file_path: 'perm-allowed.txt', content: 'first write\n' });
    }
    if (step === 1) {
      return tool('write', { file_path: 'perm-denied.txt', content: 'second write\n' });
    }
    return say('P1-PERM-WRITES finished.');
  },
  'P1-PERM-GRANTS'(_round, step) {
    if (step === 0) {
      return tool('bash', { command: 'echo perm-grant-a', description: 'First echo' });
    }
    if (step === 1) {
      return tool('bash', { command: 'echo perm-grant-b', description: 'Second echo' });
    }
    if (step === 2) {
      return tool('bash', {
        command: 'echo perm-grant-c && rm -f perm-grant-missing.txt',
        description: 'Echo, then remove a file',
      });
    }
    return say('P1-PERM-GRANTS finished.');
  },
  // dsh-rebase P1-6d: S18, the gate's pwsh scenarios (tools/perm-pwsh-probe.ts),
  // `P1-S18 {"case":"card","shell":"pwsh"}`; `"shell":"bash"` is the Linux dry run.
  'P1-S18'(_round, step, _calls, triggerText) {
    const p = p04Params(triggerText);
    const shell = p.shell === 'pwsh' ? 'pwsh' : 'bash';
    const steps = S18_STEPS[p.case]?.[shell] ?? [];
    if (step < steps.length) {
      const [command, description] = steps[step];
      return { ...tool(shell, { command, description }), tag: String(p.case) };
    }
    return { ...say(`P1-S18 ${p.case} finished.`), tag: String(p.case) };
  },
  // dsh-rebase P0-6: one ordinary turn with one tool call, before the host is killed.
  CRASH(_round, step, _calls, triggerText) {
    const p = p04Params(triggerText);
    if (step === 0) {
      return {
        ...tool('bash', {
          command: `echo "crash-probe ${p.token}"; ls -a`,
          description: 'Echo the probe token',
        }),
        tag: p.token,
      };
    }
    return { ...say(`P0-CRASH ${p.token} finished; the listing is above.`), tag: p.token };
  },
  // P0-6: a long paced answer, so the host can be killed while it streams.
  PACED(_round, _step, _calls, triggerText) {
    const p = p04Params(triggerText);
    const chunks = p.chunks ?? 40;
    const pieces = [];
    for (let i = 1; i <= chunks; i += 1) {
      pieces.push(i === 1 ? `STREAMED-${p.token} ` : `〔${i}〕流式正文片段。`);
    }
    return {
      kind: 'paced-text',
      status: 200,
      text: pieces.join(''),
      chunks,
      chunkMs: p.chunkMs ?? 150,
      tag: p.token,
    };
  },
  // P0-6: a bash call still running when the host is killed.
  SLEEPTOOL(_round, step, _calls, triggerText) {
    const p = p04Params(triggerText);
    if (step === 0) {
      return {
        ...tool('bash', {
          command: `echo "sleep-tool ${p.token} started"; sleep ${p.seconds ?? 30}; echo "sleep-tool done"`,
          description: 'Run a long command',
        }),
        tag: p.token,
      };
    }
    return { ...say(`P0-SLEEPTOOL ${p.token} finished.`), tag: p.token };
  },
  // P0-6: concurrency load. Every text delta carries its send time (see
  // `stampedFrames`); steps 0-2 end in a bash / read / bash call, step 3 is
  // a longer closing answer.
  LOAD(_round, step, _calls, triggerText) {
    const p = p04Params(triggerText);
    const chunks = p.chunks ?? 40;
    const chunkMs = p.chunkMs ?? 30;
    const tools = [
      tool('bash', {
        command: 'ls -la; wc -c *.txt; cat module-*.ts',
        description: 'List the workspace and print the sources',
      }),
      tool('read', { file_path: p.file }),
      tool('bash', {
        command: "seq 1 20000 | awk '{s+=$1} END {print s}'; grep -c line data.txt",
        description: 'Sum and count',
      }),
    ];
    const toolUse = step < tools.length ? tools[step] : undefined;
    return {
      kind: 'stamped',
      status: 200,
      chunks: toolUse ? chunks : chunks * 2,
      chunkMs,
      ...(toolUse ? { toolName: toolUse.name, toolInput: toolUse.input } : {}),
      tag: `s${p.session}`,
    };
  },
  // P0-6: history builder. One read (every tenth turn a bash) of a workspace
  // file, then about 1 KB of prose. `native: true` drives our own worker.
  HIST(_round, step, _calls, triggerText) {
    const p = p04Params(triggerText);
    if (step === 0) {
      if (p.i % 10 === 0) {
        return tool('bash', {
          command: `head -c 3000 ${bashQuote(p.file)}; echo; echo "[turn ${p.i}]"`,
          description: 'Peek at a source file',
        });
      }
      // Our native runtime's read tool names its argument `path`.
      return tool('read', p.native ? { path: p.file } : { file_path: p.file });
    }
    return say(histProse(p.i, p.token));
  },
};

/** P0-6: about 1 KB of deterministic mixed-language prose for one HIST turn. */
function histProse(i, token) {
  const lines = [
    `第 ${i} 轮小结（${token}）：这个文件主要定义了一组数据结构和几个纯函数，`,
    '入口函数先校验参数，再按配置决定走缓存还是直接计算；错误路径统一抛出带错误码的异常。',
    'The module keeps its state in a single map keyed by session id, and every mutation goes',
    'through one serialized queue, so concurrent callers observe a consistent order of updates.',
    '需要注意的地方：超时参数为 0 时表示关闭，而不是立即超时；日志里的路径已经做过脱敏处理。',
    'Next steps: add a regression test for the empty-input case, and document the retry budget',
    `and the back-off schedule in the README before the next release (turn ${i}).`,
  ];
  return lines.join('\n');
}

/** dsh-p0-2: decide from the request's own messages. */
function decideDshP02(parsed) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const lastText = ownText(messages[messages.length - 1]);
  if (/<goal_(complete|blocked)>/.test(lastText)) {
    return { ...say('Wrapping up the goal for the user.'), label: 'wrap-up' };
  }
  if (COMPACTION_INSTRUCTION.test(lastText)) {
    return { ...say(COMPACTION_SUMMARY), label: 'compaction' };
  }
  const p8 = decideP8(messages);
  if (p8) return p8;
  let trigger = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue;
    const text = ownText(messages[i]);
    if (/<goal_round>/.test(text) || P0_MARKER.test(text) || P1_MARKER.test(text)) {
      trigger = i;
      break;
    }
  }
  if (trigger < 0) return { ...say('fake gateway: no P0 scenario marker'), label: 'no-marker' };
  const triggerText = ownText(messages[trigger]);
  const p1 = triggerText.match(P1_MARKER)?.[1];
  const scenario = triggerText.match(P0_MARKER)?.[1] ?? (p1 ? `P1-${p1}` : undefined);
  const roundMatch = triggerText.match(/<goal_round>[\s\S]*?Round: (\d+)\//);
  const round = roundMatch ? Number(roundMatch[1]) : 0;
  const calls = [];
  for (const message of messages.slice(trigger + 1)) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (message.role === 'assistant' && block?.type === 'tool_use') {
        calls.push({ id: block.id, name: block.name, input: block.input });
      }
      if (message.role === 'user' && block?.type === 'tool_result') {
        const call = calls.find((c) => c.id === block.tool_use_id);
        if (call) {
          call.result = toolResultText(block);
          call.isError = block.is_error === true;
        }
      }
    }
  }
  const script = DSH_P0_2_SCRIPTS[scenario];
  if (!script) return { ...say(`fake gateway: no script for ${scenario}`), label: 'no-script' };
  const history = messages
    .slice(0, trigger)
    .map((message) =>
      Array.isArray(message?.content)
        ? message.content
            .map((block) =>
              block?.type === 'tool_result' ? toolResultText(block) : (block?.text ?? '')
            )
            .join('\n')
        : String(message?.content ?? '')
    )
    .join('\n');
  // P1-4d1: what reached the model since its last reply (a wake-up's notice).
  const lastReply = messages.findLastIndex((message) => message?.role === 'assistant');
  const recent = messages
    .slice(lastReply + 1)
    .map((message) => ownText(message))
    .join('\n');
  // P1-4c1: every user text of the request (tool results excluded), for scripts
  // that report what reached the model wherever it landed (steering, a retry).
  const userTexts = messages
    .filter((message) => message?.role === 'user')
    .map((message) => ownText(message))
    .join('\n');
  const decision = script(
    round,
    calls.length,
    calls,
    triggerText,
    history,
    recent,
    userTexts,
    messages
  );
  const tag = decision.tag ? `:${decision.tag}` : '';
  return {
    ...decision,
    label: `${scenario}${tag} r${round} s${calls.length}`,
    // P0-4 reads every tool result back out of the log, as the model saw it.
    ...(scenario === 'FS'
      ? {
          calls: calls.map((c) => ({
            name: c.name,
            input: c.input,
            isError: c.isError,
            result: c.result === undefined ? undefined : c.result.slice(0, 1500),
          })),
        }
      : {}),
    // P0-6 reads what a resumed session sends the model: the shape of the
    // history before the trigger, and its tail as text.
    ...(scenario === 'RECALL'
      ? {
          probe: {
            messagesBeforeTrigger: trigger,
            requestBytes: JSON.stringify(parsed).length,
            roleTail: messages
              .slice(Math.max(0, trigger - 8), trigger)
              .map((m) =>
                [
                  m?.role,
                  ...(Array.isArray(m?.content)
                    ? m.content.map((b) =>
                        b?.type === 'tool_result'
                          ? `tool_result${b.is_error ? '!' : ''}:${toolResultText(b).slice(0, 80)}`
                          : b?.type === 'tool_use'
                            ? `tool_use:${b.name}`
                            : `${b?.type}:${String(b?.text ?? '').slice(0, 80)}`
                      )
                    : [String(m?.content ?? '').slice(0, 80)]),
                ].join(' | ')
              ),
          },
        }
      : {}),
  };
}

/**
 * P0-6 — a paced text block whose every delta carries its own send time
 * (`‹t<microseconds of CLOCK_MONOTONIC>›`, the clock process.hrtime reads in
 * every process on the machine), optionally followed by one tool_use block.
 * Frame data may be a function; `sendPaced` evaluates it at write time.
 */
function stampedFrames(model, { chunks, chunkMs, toolName, toolInput }) {
  const prose = '流式输出按接近真实的速率逐块送达，The host relays each piece to the bridge. ';
  const piece = (i) =>
    prose.slice((i * 5) % (prose.length - 5), ((i * 5) % (prose.length - 5)) + 5);
  const frames = [
    messageStartFrame(model),
    [
      0,
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
  ];
  for (let i = 0; i < chunks; i += 1) {
    frames.push([
      i === 0 ? 0 : chunkMs,
      'content_block_delta',
      () => ({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: `${piece(i)}‹t${process.hrtime.bigint() / 1000n}›`,
        },
      }),
    ]);
  }
  frames.push([chunkMs, 'content_block_stop', { type: 'content_block_stop', index: 0 }]);
  if (toolName) {
    const toolId = `toolu_${crypto.randomUUID()}`;
    frames.push([
      0,
      'content_block_start',
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
      },
    ]);
    for (const partial_json of chunkString(JSON.stringify(toolInput), 3)) {
      frames.push([
        chunkMs,
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json },
        },
      ]);
    }
    frames.push([0, 'content_block_stop', { type: 'content_block_stop', index: 1 }]);
  }
  frames.push(
    [
      0,
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: toolName ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: chunks * 2 },
      },
    ],
    [0, 'message_stop', { type: 'message_stop' }]
  );
  return frames;
}

/** Decide what this request's response should look like, given the active plan. */
function decide(plan, seq, toolResultPresent, sleepSeconds, opts = {}) {
  switch (plan) {
    case 'slow-write':
      if (toolResultPresent) return { kind: 'text', status: 200, text: '写入完成' };
      return { kind: 'paced', status: 200, flavour: 'slow-write' };
    case 'long-thinking':
      return { kind: 'paced', status: 200, flavour: 'long-thinking' };
    case 'slow-fail':
      return { kind: 'hang', status: 200, holdMs: Math.round((opts.hold ?? 120) * 1000) };
    case 'text':
      return { kind: 'text', status: 200, text: 'fake gateway ok' };
    case 'long-turn':
      if (toolResultPresent) return { kind: 'text', status: 200, text: 'turn finished' };
      return {
        kind: 'tool_use',
        status: 200,
        name: 'bash',
        input: { command: `sleep ${sleepSeconds} && echo done` },
      };
    case 'write-approval':
      if (toolResultPresent) return { kind: 'text', status: 200, text: 'turn finished' };
      return {
        kind: 'tool_use',
        status: 200,
        name: 'write',
        input: { path: 'probe-write.txt', content: 'hello from fake gateway' },
      };
    case 'ask-question':
      if (toolResultPresent) return { kind: 'text', status: 200, text: 'turn finished' };
      return {
        kind: 'tool_use',
        status: 200,
        name: 'ask',
        input: {
          questions: [
            {
              header: '\u70b9\u9a8c\u987a\u5e8f',
              question:
                '\u8fd9\u6b21\u89c6\u89c9\u70b9\u9a8c\u5148\u91cf\u54ea\u4e00\u5f20\u5361\uff1f',
              options: [
                {
                  label: '\u5148\u91cf\u6743\u9650\u5361',
                  description: '\u5199\u6587\u4ef6\u5ba1\u6279\u90a3\u4e00\u5f20',
                },
                {
                  label: '\u5148\u91cf\u95ee\u7b54\u5361',
                  description: '\u5c31\u662f\u73b0\u5728\u8fd9\u4e00\u5f20',
                },
                {
                  label: '\u4e24\u5f20\u4e00\u8d77\u91cf',
                  description: '\u540c\u4e00\u56de\u5408\u5185\u5148\u540e\u89e6\u53d1',
                },
              ],
            },
          ],
        },
      };
    case 'retry-503':
      if (seq <= 2) return { kind: 'error', status: 503, message: `fake overloaded #${seq}` };
      return { kind: 'text', status: 200, text: 'fake gateway ok' };
    case 'retry-503-forever':
      return {
        kind: 'error',
        status: 503,
        message: `FAKE_GATEWAY_OVERLOADED_MARKER fake overloaded #${seq}`,
      };
    case 'archive-probe':
      // Driven by request sequence number only — deliberately ignores toolResultPresent
      // so the turn sequence stays deterministic even if a caller's harness doesn't
      // round-trip tool_result blocks correctly.
      if (seq === 1) {
        return {
          kind: 'tool_use',
          status: 200,
          name: 'bash',
          input: { command: `sleep ${sleepSeconds} && echo slept` },
        };
      }
      if (seq === 2) {
        return {
          kind: 'tool_use',
          status: 200,
          name: 'write',
          input: { path: 'archive-probe.txt', content: 'written after archive' },
        };
      }
      if (seq === 3) {
        return {
          kind: 'tool_use',
          status: 200,
          name: 'read',
          input: { path: 'archive-probe.txt' },
        };
      }
      if (seq === 4) {
        return {
          kind: 'tool_use',
          status: 200,
          name: 'bash',
          input: { command: 'pwd && ls -la' },
        };
      }
      return { kind: 'text', status: 200, text: 'archive probe finished' };
    default:
      throw new Error(`Unknown plan: ${plan}`);
  }
}

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeSSE(res, frames) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.end(frames.map(([event, data]) => sseFrame(event, data)).join(''));
}

/**
 * One text reply. `usage` (dsh-rebase P1-4d1) replaces the default prompt-side
 * counts of `message_start`, e.g. to report cache reads and writes.
 * `thinking`, when given, is streamed first as its own block (P1-4d1 `think`).
 */
function sendTextTurn(res, model, text, { usage, thinking } = {}) {
  const thought =
    typeof thinking === 'string'
      ? [
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '' },
            },
          ],
          ...splitInto(thinking, 3).map((piece) => [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: piece },
            },
          ]),
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'fake-signature' },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ]
      : [];
  const at = thought.length > 0 ? 1 : 0;
  const frames = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0, ...usage },
        },
      },
    ],
    ...thought,
    [
      'content_block_start',
      { type: 'content_block_start', index: at, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: at, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: at }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 9 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  writeSSE(res, frames);
}

/** Split a JSON string into a handful of partial_json chunks so the delta sequence is realistic. */
function chunkString(s, chunkCount) {
  if (s.length === 0) return [''];
  const size = Math.max(1, Math.ceil(s.length / chunkCount));
  const chunks = [];
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
  return chunks;
}

function sendToolUseTurn(res, model, { name, input }) {
  const toolId = `toolu_${crypto.randomUUID()}`;
  const inputJson = JSON.stringify(input);
  const chunks = chunkString(inputJson, 3);
  const frames = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 18, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: toolId, name, input: {} },
      },
    ],
    ...chunks.map((partial_json) => [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } },
    ]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 24 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  writeSSE(res, frames);
}

// --- paced plans (batch I point-check) --------------------------------------
//
// Everything above writes one `res.end()` with the whole turn in it, which is
// enough when a point-check only cares about the settled result. T101 / T096 /
// T098 are about the SHAPE OF THE WAIT, so the three plans below hand back a
// list of `[delayMs, event, data]` triples that `sendPaced` walks with real
// timers. `delayMs` is the gap BEFORE that frame.

/** The `message_start` frame every turn opens with. */
function messageStartFrame(model, inputTokens = 24) {
  return [
    0,
    'message_start',
    {
      type: 'message_start',
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    },
  ];
}

/** Cut a string into exactly `count` pieces (the last one absorbs the remainder). */
function splitInto(text, count) {
  if (count <= 1) return [text];
  const size = Math.ceil(text.length / count);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  // A short string can yield fewer pieces than asked; that is fine and honest.
  return out.length > 0 ? out : [''];
}

/**
 * A multi-line file body big enough that "已收到 N 行" visibly climbs.
 *
 * Deliberately plain HTML: the point-check wants a `write` whose diff preview
 * is readable in a screenshot, not a torture test for the differ.
 */
function buildWriteBody(lines) {
  const rows = [
    '<!doctype html>',
    '<html lang="zh">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <title>T101 slow write</title>',
    '  </head>',
    '  <body>',
  ];
  for (let i = 1; rows.length < lines - 2; i += 1) {
    rows.push(`    <p data-row="${i}">第 ${i} 行：工具行应当在参数还没流完时就出现。</p>`);
  }
  rows.push('  </body>');
  rows.push('</html>');
  return `${rows.join('\n')}\n`;
}

/**
 * T101 — a text block, then a `write` call whose arguments are dictated slowly.
 *
 * The preamble reproduces the field report's screenshot ("下面开始编写文件：" and
 * then nothing for minutes), so the point-check is looking at the same moment
 * the user was.
 */
function buildSlowWriteFrames(model, { chunks, chunkMs, writePath, writeLines }) {
  const toolId = `toolu_${crypto.randomUUID()}`;
  const inputJson = JSON.stringify({ path: writePath, content: buildWriteBody(writeLines) });
  const pieces = splitInto(inputJson, chunks);
  return [
    messageStartFrame(model),
    [
      0,
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      200,
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '下面开始编写文件：' },
      },
    ],
    [200, 'content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      300,
      'content_block_start',
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: toolId, name: 'write', input: {} },
      },
    ],
    ...pieces.map((partial_json, i) => [
      i === 0 ? 0 : chunkMs,
      'content_block_delta',
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } },
    ]),
    [chunkMs, 'content_block_stop', { type: 'content_block_stop', index: 1 }],
    [
      0,
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 1200 },
      },
    ],
    [0, 'message_stop', { type: 'message_stop' }],
  ];
}

/** A long, many-lined thought so the block overflows the transcript viewport. */
function buildThinkingText(chunks) {
  const out = [];
  for (let i = 1; i <= chunks; i += 1) {
    out.push(`第 ${i} 步推理：先确认这一段思考正文足够长，好让折叠头有机会吸顶。\n`);
  }
  return out.join('');
}

/** T096 / T098 — one `thinking` block dictated slowly, then a short answer. */
function buildLongThinkingFrames(model, { chunks, chunkMs }) {
  const thinkingText = buildThinkingText(chunks);
  const pieces = splitInto(thinkingText, chunks);
  return [
    messageStartFrame(model),
    [
      0,
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    ],
    ...pieces.map((thinking, i) => [
      i === 0 ? 0 : chunkMs,
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    ]),
    [
      chunkMs,
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'fake-signature' },
      },
    ],
    [0, 'content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      200,
      'content_block_start',
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ],
    [
      200,
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: '想完了：折叠头该吸顶，收起后该回到这一块的自然位置。' },
      },
    ],
    [0, 'content_block_stop', { type: 'content_block_stop', index: 1 }],
    [
      0,
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 900 },
      },
    ],
    [0, 'message_stop', { type: 'message_stop' }],
  ];
}

/**
 * Walk a paced frame list with real timers, and stop the moment the client
 * hangs up — a Stop button or an idle timeout closes the socket, and a server
 * that kept firing timers into a dead response would keep the process alive
 * long after the point-check moved on.
 */
/** dsh-rebase P0-3 — one text block dictated in `chunks` deltas `chunkMs` apart. */
function buildPacedTextFrames(model, text, chunks, chunkMs) {
  const pieces = splitInto(text, chunks);
  return [
    messageStartFrame(model),
    [
      0,
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    ...pieces.map((piece, i) => [
      i === 0 ? 0 : chunkMs,
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
    ]),
    [chunkMs, 'content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      0,
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 120 },
      },
    ],
    [0, 'message_stop', { type: 'message_stop' }],
  ];
}

function sendPaced(res, frames) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let aborted = false;
  res.on('close', () => {
    aborted = true;
  });
  let index = 0;
  const step = () => {
    if (aborted) return;
    if (index >= frames.length) {
      res.end();
      return;
    }
    const [delayMs, event, data] = frames[index++];
    setTimeout(() => {
      if (aborted) return;
      // P0-6 stamped frames compute their payload at write time.
      res.write(sseFrame(event, typeof data === 'function' ? data() : data));
      step();
    }, delayMs);
  };
  step();
}

/**
 * T093 — accept the request, answer with 200 headers, then say nothing.
 *
 * No body bytes at all, so a headers timeout can never fire and only the idle
 * (body) timeout decision 029 adds can end this.
 */
function sendHang(res, holdMs) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const timer = setTimeout(() => res.end(), holdMs);
  res.on('close', () => clearTimeout(timer));
}

function sendError(res, status, message, type = 'overloaded_error') {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

/** The key a request carried: `x-api-key`, or a bearer token. */
function receivedKey(req) {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey) return apiKey;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth) return auth.replace(/^bearer\s+/i, '');
  return null;
}

/** A key as the log shows it: a digest prefix, never the value. */
function keyDigest(key) {
  return key === null
    ? null
    : `sha256:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

/** What a request's body asked for in reasoning, whatever the wire protocol. */
function reasoningOf(parsed) {
  const out = {};
  if (parsed?.thinking !== undefined) out.thinking = parsed.thinking;
  if (parsed?.reasoning_effort !== undefined) out.reasoning_effort = parsed.reasoning_effort;
  if (parsed?.reasoning !== undefined) out.reasoning = parsed.reasoning;
  if (parsed?.output_config !== undefined) out.output_config = parsed.output_config;
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---- dsh-rebase P1-8: loop guard scenarios ---------------------------------------

/** The loop guard's wrap-up instruction (src/dsh-host/loopGuard/constants.ts). */
const CEILING_INSTRUCTION = /this app's ceiling for one run/;

/**
 * P1-8: decide a P8 request, or undefined when the latest scenario marker is
 * not a P8 one. The step is the number of tool calls since the trigger; a
 * wrap-up is any P8 request carrying the loop guard's instruction after it.
 */
function decideP8(messages) {
  let trigger = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue;
    const text = ownText(messages[i]);
    if (P8_MARKER.test(text)) {
      trigger = i;
      break;
    }
    if (/<goal_round>/.test(text) || P0_MARKER.test(text) || P1_MARKER.test(text)) return undefined;
  }
  if (trigger < 0) return undefined;
  const triggerText = ownText(messages[trigger]);
  const scenario = triggerText.match(P8_MARKER)[1];
  const p = firstJsonObject(triggerText) ? p04Params(triggerText) : {};
  let calls = 0;
  let wrapUp = false;
  for (const message of messages.slice(trigger + 1)) {
    if (!Array.isArray(message?.content)) {
      if (message?.role === 'user' && CEILING_INSTRUCTION.test(String(message?.content ?? '')))
        wrapUp = true;
      continue;
    }
    for (const block of message.content) {
      if (message.role === 'assistant' && block?.type === 'tool_use') calls += 1;
      if (message.role === 'user' && block?.type === 'text') {
        if (CEILING_INSTRUCTION.test(block.text ?? '')) wrapUp = true;
      }
    }
  }
  const label = (tail) => `P8-${scenario}${p.tag ? `:${p.tag}` : ''} s${calls}${tail ?? ''}`;
  if (wrapUp) {
    if (p.wrapTool) {
      return {
        ...tool('bash', {
          command: 'echo P8-WRAP-TOOL-RAN > p8-wrap-tool.txt',
          description: 'A call the wrap-up must refuse',
          sandbox_permissions: 'danger-full-access',
          justification: 'The P1-8 probe checks the wrap-up refuses this before any approval.',
        }),
        label: label(' wrap-up tool'),
      };
    }
    return { ...say(`P8-${scenario} wrap-up summary (${calls} calls).`), label: label(' wrap-up') };
  }
  const burst = (list, text) => ({
    kind: 'burst',
    status: 200,
    calls: list,
    text,
    chunkMs: p.chunkMs ?? 15,
    label: label(),
  });
  switch (scenario) {
    case 'REPEAT': {
      if (calls > 0) return { ...say('P8-REPEAT finished.'), label: label() };
      const count = p.count ?? 200;
      const call = { name: p.tool ?? 'job_list', input: p.args ?? {} };
      return burst(
        Array.from({ length: count }, () => call),
        'Checking the background work.'
      );
    }
    case 'VARIED': {
      if (calls > 0) return { ...say('P8-VARIED finished.'), label: label() };
      const count = p.count ?? 40;
      return burst(
        Array.from({ length: count }, (_, i) => ({
          name: 'job_output',
          input: { job_id: `p8-job-${i}` },
        })),
        'Reading every job.'
      );
    }
    case 'FANOUT': {
      if (calls > 0) return { ...say('P8-FANOUT finished.'), label: label() };
      const count = p.count ?? 10;
      return burst(
        Array.from({ length: count }, (_, i) => ({
          name: 'subagent',
          input: {
            description: `Fan-out ${i}`,
            prompt: `P8-CHILD ${i}: answer in one line.`,
            run_in_background: false,
          },
        })),
        'Fanning out.'
      );
    }
    case 'CHILD':
      return { ...say(`P8-CHILD done (${triggerText.slice(0, 40)}).`), label: label() };
    // tools/contention-regression.ts: a paced answer whose every delta carries
    // its send time, so the receiver can tell this process's own stalls apart.
    case 'VICTIM':
      return {
        kind: 'stamped',
        status: 200,
        chunks: p.chunks ?? 60,
        chunkMs: p.chunkMs ?? 150,
        label: label(),
      };
    case 'SUBREPEAT': {
      if (calls > 0) return { ...say('P8-SUBREPEAT finished.'), label: label() };
      // `child: 'LOOP'` gives the child an endless tool loop instead (its step ceiling).
      const prompt =
        p.child === 'LOOP'
          ? `P8-LOOP ${JSON.stringify({ tag: 'child-loop' })} keep reading.`
          : `P8-REPEAT ${JSON.stringify({ tag: 'child', count: p.count ?? 60 })} list the jobs.`;
      return {
        ...tool('subagent', { description: 'Looping child', prompt, run_in_background: false }),
        label: label(),
      };
    }
    case 'WAKE':
    case 'LOOP':
      // WAKE starts its background jobs first, then loops like LOOP.
      if (scenario === 'WAKE' && calls === 0) {
        const jobs = p.jobs ?? 2;
        return burst(
          Array.from({ length: jobs }, (_, i) => ({
            name: 'bash',
            input: {
              command: `sleep ${(p.seconds ?? 3) + i}; echo p8-wake-${i}`,
              description: `Background job ${i}`,
              run_in_background: true,
            },
          })),
          'Starting background jobs.'
        );
      }
      // `max` ends the loop by itself (the guard switched off must not hang a probe).
      if (p.max !== undefined && calls >= p.max) {
        return { ...say(`P8-${scenario} done after ${calls} calls.`), label: label() };
      }
      if (p.tool === 'bash') {
        return {
          ...tool('bash', { command: `echo p8-loop-${calls}`, description: 'Loop step' }),
          label: label(),
        };
      }
      return { ...tool('read', { file_path: p.file ?? 'p8-loop.txt' }), label: label() };
    default:
      return { ...say(`fake gateway: no P8 script for ${scenario}`), label: label() };
  }
}

/**
 * P1-8: one reply of a text block and `calls` tool_use blocks, paced `chunkMs`
 * apart, stop_reason tool_use. When the client hangs up first, one log line
 * says how many tool blocks it had been sent (the loop guard's upstream
 * cancel, experiment E2).
 */
function sendBurst(res, model, decision, seq) {
  const frames = [messageStartFrame(model)];
  let index = 0;
  if (decision.text) {
    frames.push(
      [
        0,
        'content_block_start',
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      ],
      [
        0,
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: decision.text } },
      ],
      [0, 'content_block_stop', { type: 'content_block_stop', index }]
    );
    index += 1;
  }
  const toolStops = new Set();
  for (const call of decision.calls) {
    frames.push(
      [
        decision.chunkMs,
        'content_block_start',
        {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: `toolu_${crypto.randomUUID()}`,
            name: call.name,
            input: {},
          },
        },
      ],
      [
        0,
        'content_block_delta',
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
        },
      ]
    );
    toolStops.add(frames.length);
    frames.push([0, 'content_block_stop', { type: 'content_block_stop', index }]);
    index += 1;
  }
  frames.push(
    [
      0,
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 20 * decision.calls.length },
      },
    ],
    [0, 'message_stop', { type: 'message_stop' }]
  );
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let written = 0;
  let toolBlocksSent = 0;
  let lastToolStopAt = 0;
  let finished = false;
  const startedAt = Date.now();
  res.on('close', () => {
    if (finished) return;
    finished = true;
    logRequest({
      seq,
      event: 'client-closed',
      framesWritten: written,
      framesTotal: frames.length,
      toolBlocksSent,
      toolBlocksTotal: decision.calls.length,
      msAfterLastToolBlock: lastToolStopAt ? Date.now() - lastToolStopAt : null,
      msSinceStart: Date.now() - startedAt,
    });
  });
  const step = () => {
    if (finished) return;
    if (written >= frames.length) {
      finished = true;
      logRequest({ seq, event: 'burst-completed', toolBlocksSent, framesWritten: written });
      res.end();
      return;
    }
    const [delayMs, event, data] = frames[written];
    setTimeout(() => {
      if (finished) return;
      res.write(sseFrame(event, data));
      if (toolStops.has(written)) {
        toolBlocksSent += 1;
        lastToolStopAt = Date.now();
      }
      written += 1;
      step();
    }, delayMs);
  };
  step();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.log) LOG_PATH = args.log;
  const state = loadState(args.state, args.reset);
  saveState(args.state, state); // materialize the state file even on first run / --reset

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, plan: args.plan, count: state.count }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'not found',
          hint: 'this fake gateway only serves POST (as /v1/messages) and GET /health',
        })
      );
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      state.count += 1;
      const seq = state.count;

      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        parsed = {};
      }
      // Echo back --model-id regardless of what the request body sent as `model`, so a
      // point-check log can line up the fake gateway's replies with a specific model name.
      const model = args.modelId;
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const lastMessage = messages[messages.length - 1];
      const toolResultPresent = hasToolResult(messages);
      const summary = summarizeMessage(lastMessage);

      const decision =
        args.plan === 'dsh-p0-2'
          ? decideDshP02(parsed)
          : args.plan === 'echo-key-error'
            ? { kind: 'echo-key', status: 401 }
            : decide(args.plan, seq, toolResultPresent, args.sleep, { hold: args.hold });
      const key = receivedKey(req);

      logRequest({
        seq,
        status: decision.status,
        role: lastMessage?.role ?? null,
        contentSummary: summary,
        hasToolResult: toolResultPresent,
        plan: args.plan,
        auth: keyDigest(key),
        userAgent: req.headers['user-agent'] ?? null,
        clientHeader: req.headers['x-pilab-client'] ?? null,
        model: typeof parsed?.model === 'string' ? parsed.model : null,
        path: req.url,
        reasoning: reasoningOf(parsed),
        ...(args.plan === 'dsh-p0-2'
          ? {
              decision: decision.label,
              tool:
                decision.kind === 'tool_use'
                  ? decision.name
                  : decision.kind === 'stamped'
                    ? decision.toolName
                    : decision.kind === 'burst'
                      ? `${decision.calls.length}x ${[...new Set(decision.calls.map((c) => c.name))].join('+')}`
                      : undefined,
              tools: Array.isArray(parsed?.tools) ? parsed.tools.length : undefined,
              // P1-10d: which tools the model was offered (a plugin's are there only when enabled).
              toolNames: Array.isArray(parsed?.tools)
                ? parsed.tools.map((item) => item?.name)
                : undefined,
              calls: decision.calls,
              // P0-6: request size and what a resumed session sent.
              bodyChars: body.length,
              probe: decision.probe,
              // P1-15: a one-shot completion's system prompt (absent otherwise).
              completionSystem: carriesCompletionSystem(parsed) || undefined,
            }
          : {}),
      });
      saveState(args.state, state);

      if (decision.kind === 'error') {
        sendError(res, decision.status, decision.message);
      } else if (decision.kind === 'raw-error') {
        res.writeHead(decision.status, { 'content-type': 'application/json' });
        res.end(decision.body);
      } else if (decision.kind === 'echo-key') {
        sendError(
          res,
          decision.status,
          `P1-ECHOKEY: invalid x-api-key ${key ?? '(none)'} for this fake upstream`,
          'authentication_error'
        );
      } else if (decision.kind === 'text') {
        sendTextTurn(res, model, decision.text, {
          usage: decision.usage,
          thinking: decision.thinking,
        });
      } else if (decision.kind === 'tool_use') {
        sendToolUseTurn(res, model, { name: decision.name, input: decision.input });
      } else if (decision.kind === 'hang') {
        sendHang(res, decision.holdMs);
      } else if (decision.kind === 'paced-text') {
        sendPaced(
          res,
          buildPacedTextFrames(model, decision.text, decision.chunks, decision.chunkMs)
        );
      } else if (decision.kind === 'stamped') {
        sendPaced(res, stampedFrames(model, decision));
      } else if (decision.kind === 'burst') {
        sendBurst(res, model, decision, seq);
      } else if (decision.kind === 'paced') {
        const frames =
          decision.flavour === 'slow-write'
            ? buildSlowWriteFrames(model, {
                chunks: args.chunks,
                chunkMs: args.chunkMs,
                writePath: args.writePath,
                writeLines: args.writeLines,
              })
            : buildLongThinkingFrames(model, { chunks: args.chunks, chunkMs: args.chunkMs });
        sendPaced(res, frames);
      }
    });
  });

  server.listen(args.port, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[fake-gateway] listening on http://127.0.0.1:${server.address().port} plan=${args.plan} sleep=${args.sleep} state=${args.state} model=${args.modelId} pid=${process.pid}`
    );
  });

  const shutdown = () => {
    saveState(args.state, state);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
