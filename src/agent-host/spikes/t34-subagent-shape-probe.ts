/**
 * T-34 spike: what does the real subagent message stream look like, with and
 * without `forwardSubagentText` (SDK 0.3.218, default false)?
 *
 * Execution-plan §3 T-34 acceptance ① forbids designing the UI before the
 * real shapes are confirmed. The specific unknowns this probe pins down:
 *
 *   1. DEFAULT (A): which subagent events leak into the stream today —
 *      the known defect is that subagent tool_use/tool_result arrive and get
 *      rendered as the MAIN agent's tool rows. Confirm they carry a top-level
 *      `parent_tool_use_id` (the field the fix will key on).
 *   2. FORWARDED (B): with `forwardSubagentText: true`, what shapes carry the
 *      subagent's text/thinking (assistant messages with parent set?), do
 *      they interleave with main-agent events, and what extra top-level
 *      fields ride along (`subagent_type`, `task_description`, `uuid`).
 *   3. The Task tool_result's `tool_use_result` (SDKUserMessage) — sdk.d.ts
 *      says for Agent/Task it is the subagent's final report + run totals,
 *      "render from it instead of parsing the tool_result text".
 *   4. canUseTool during a subagent run: does the options bag carry an
 *      `agent_id`/subagent marker (the hook types suggest it mirrors
 *      can_use_tool routing) — decides the "from subagent" permission badge.
 *   5. Event-count delta A→B — acceptance ④'s baseline number.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/t34-subagent-shape-probe.ts
 *
 * Optional:
 *   AICLIENT_T34_TIMEOUT_MS=300000
 *   AICLIENT_T34_WORKDIR=<path>
 *   AICLIENT_T34_MODEL=<model id>
 *   AICLIENT_T34_DUMP_DIR=<dir>        # raw per-scenario NDJSON dumps
 *   AICLIENT_T34_SCENARIOS=A,B,C       # subset to run (default all)
 *   AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1
 *
 * FIRST-RUN RESULT (2026-08-05, CCH gateway, claude-opus-4-8, cometix 2.1.212):
 *   - The delegation tool is named `Agent`, NOT `Task`, on this CLI —
 *     toolCard.ts's 'Task' verb/arg tables never fire today (renders as the
 *     unknown-tool "Ran" fallback). Both names must be handled.
 *   - DEFAULT already forwards, with top-level `parent_tool_use_id` set: the
 *     subagent's prompt echo (user/text), its tool_use (assistant) and
 *     tool_result (user). Only subagent TEXT/THINKING need the flag.
 *   - `forwardSubagentText: true` adds assistant text messages with
 *     parent_tool_use_id + `subagent_type` + `task_description` top-level
 *     fields. No stream_event deltas for subagent content in either mode —
 *     subagent prose arrives message-at-a-time, not char-streamed.
 *   - Four `system/task_*` control events (parent unset, linked by
 *     `tool_use_id`): task_started {task_id, tool_use_id, description,
 *     subagent_type, task_type, prompt}, task_progress {usage totals,
 *     last_tool_name, description}, task_updated {patch}, task_notification
 *     {status, summary, output_file}.
 *   - The Agent tool_result user message carries structured `tool_use_result`
 *     {status, prompt, agentId, agentType, content, resolvedModel,
 *     totalDurationMs, totalTokens, totalToolUseCount, toolStats, usage}.
 *   - Event delta A→B on this run: 13 → 15 (subagent text messages only).
 *
 * PERMISSION RESULT (same day, scenarios C/D/E):
 *   - C: a subagent Bash `echo` ran WITHOUT canUseTool firing — that is the
 *     CLI's safe-command allowlist, not a subagent property (D proves it).
 *   - D (main-agent `touch`, control): canUseTool fired; the options bag has
 *     an `agentID` key whose value is undefined for main-agent calls.
 *   - E (subagent `touch`): canUseTool fired through the SAME bridge with
 *     `options.agentID` set (same id family as task_started.task_id /
 *     tool_use_result.agentId) — the "from subagent" permission badge has a
 *     concrete data handle; PermissionBridge just needs to pass it through.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { CLAUDE_AGENT_SDK_PIN_VERSION, COMETIX_PIN } from '../pin.ts';
import { TEST_AUTH_TOKEN, TEST_BASE_URL, testCredentialEnv } from './testCredentials.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(hostRoot, '..', '..');
const require = createRequire(import.meta.url);

const CWD = process.env.AICLIENT_T34_WORKDIR ?? repoRoot;
const TIMEOUT_MS = Number(process.env.AICLIENT_T34_TIMEOUT_MS ?? 300_000);
const FORCED_MODEL = process.env.AICLIENT_T34_MODEL ?? '';
const DUMP_DIR = process.env.AICLIENT_T34_DUMP_DIR ?? path.join(tmpdir(), 't34-subagent-probe');

/**
 * Forces exactly one Task subagent that must itself use a tool (Read) and
 * produce text — so the stream contains subagent tool_use, tool_result AND
 * prose to observe. package.json exists in the default CWD (repo root).
 */
const TASK_PROMPT =
  'Use the Task tool exactly once: subagent_type "general-purpose", description ' +
  '"shape probe". The subagent prompt must be: \'Read the file package.json in the ' +
  'current working directory, then reply with the value of its "name" field and one ' +
  "short sentence describing the project.' After the Task tool returns, repeat the " +
  'name the subagent reported in one short sentence. Do not use any other tools yourself.';

/**
 * Scenario C: the subagent must run a Bash command — under permissionMode
 * 'default' that goes through canUseTool, so this pins down whether subagent
 * permission requests reach the host bridge and whether the options bag
 * carries any agent marker (the "from subagent" badge decision).
 */
const PERMISSION_PROMPT =
  'Use the Task tool exactly once: subagent_type "general-purpose", description ' +
  '"permission probe". The subagent prompt must be: \'Run the shell command ' +
  '`echo t34-permission-probe` using the Bash tool, then reply with the exact ' +
  "command output.' After the Task tool returns, repeat that output in one short " +
  'sentence. Do not use any other tools yourself.';

/**
 * Scenario C's `echo` never hit canUseTool — but echo may simply sit on the
 * CLI's safe-command allowlist. D/E isolate that variable with a WRITE-class
 * command (touch), which permissionMode 'default' must prompt for on the
 * main agent: D is the main-agent control, E the subagent probe. Equal
 * treatment (both prompt or neither) vs. asymmetry decides the T-34
 * interaction lane ("from subagent" permission badge: needed or moot).
 */
const MAIN_WRITE_PROMPT =
  'Run the shell command `touch /tmp/t34-main-perm-probe.txt` using the Bash tool, ' +
  'then state whether it succeeded in one short sentence. Do not use the Task tool.';

const SUB_WRITE_PROMPT =
  'Use the Task tool exactly once: subagent_type "general-purpose", description ' +
  '"write permission probe". The subagent prompt must be: \'Run the shell command ' +
  '`touch /tmp/t34-sub-perm-probe.txt` using the Bash tool, then reply stating ' +
  "whether it succeeded.' After the Task tool returns, repeat that in one short " +
  'sentence. Do not use any other tools yourself.';

/** cometix 2.1.212 names the delegation tool `Agent`; older CLIs said `Task`. */
const DELEGATION_TOOL_NAMES = new Set(['Task', 'Agent']);

async function resolveCometixCli(): Promise<string> {
  const pkgJson = require.resolve('@cometix/claude-code/package.json');
  const root = path.dirname(pkgJson);
  for (const c of [
    path.join(root, 'cli.js'),
    path.join(root, 'cli.mjs'),
    path.join(root, 'bin', 'cli.js'),
  ]) {
    try {
      await access(c);
      return c;
    } catch {
      // try next
    }
  }
  throw new Error(`Cometix cli.js not found under ${root}`);
}

type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown> & { close?: () => void };

async function loadQueryFn(): Promise<QueryFn> {
  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query?: QueryFn;
    default?: { query?: QueryFn };
  };
  const fn = sdk.query ?? sdk.default?.query;
  if (!fn) throw new Error('claude-agent-sdk has no query() export');
  return fn;
}

interface ContentStats {
  blockTypes: Record<string, number>;
  textLen: number;
  thinkingLen: number;
  textPreview: string;
  thinkingPreview: string;
  toolUses: Array<{ id: string; name: string; inputKeys: string[] }>;
  toolResults: Array<{ toolUseId: string; isError: boolean }>;
}

function newContentStats(): ContentStats {
  return {
    blockTypes: {},
    textLen: 0,
    thinkingLen: 0,
    textPreview: '',
    thinkingPreview: '',
    toolUses: [],
    toolResults: [],
  };
}

function foldContent(stats: ContentStats, content: unknown): void {
  if (typeof content === 'string') {
    stats.blockTypes.string = (stats.blockTypes.string ?? 0) + 1;
    stats.textLen += content.length;
    if (stats.textPreview.length < 200)
      stats.textPreview = (stats.textPreview + content).slice(0, 200);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as {
      type?: string;
      text?: unknown;
      thinking?: unknown;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      is_error?: boolean;
    };
    const t = String(p.type ?? 'unknown');
    stats.blockTypes[t] = (stats.blockTypes[t] ?? 0) + 1;
    if (t === 'text' && typeof p.text === 'string') {
      stats.textLen += p.text.length;
      if (stats.textPreview.length < 200)
        stats.textPreview = (stats.textPreview + p.text).slice(0, 200);
    }
    if (t === 'thinking') {
      const s =
        typeof p.thinking === 'string' ? p.thinking : typeof p.text === 'string' ? p.text : '';
      stats.thinkingLen += s.length;
      if (!stats.thinkingPreview) stats.thinkingPreview = s.slice(0, 200);
    }
    if (t === 'tool_use' && typeof p.id === 'string' && typeof p.name === 'string') {
      stats.toolUses.push({
        id: p.id,
        name: p.name,
        inputKeys: p.input && typeof p.input === 'object' ? Object.keys(p.input) : [],
      });
    }
    if (t === 'tool_result' && typeof p.tool_use_id === 'string') {
      stats.toolResults.push({ toolUseId: p.tool_use_id, isError: Boolean(p.is_error) });
    }
  }
}

interface ScenarioResult {
  label: string;
  forwardSubagentText: boolean;
  ok: boolean;
  threw: boolean;
  errorMessage?: string;
  msTotal: number;
  eventCount: number;
  /** `type/subtype` (+ `*` when top-level parent_tool_use_id is set), capped. */
  eventTagSeq: string[];
  byTag: Record<string, number>;
  /** Distinct top-level key sets seen per tag — catches unanticipated fields. */
  topLevelKeysByTag: Record<string, string[]>;
  distinctSessionIds: string[];
  /** Main-agent Task tool_use calls (the anchor subagent events must point at). */
  taskToolUses: Array<{
    id: string;
    subagentType: unknown;
    description: unknown;
    inputKeys: string[];
  }>;
  main: { assistant: ContentStats; user: ContentStats; models: string[] };
  sub: {
    assistant: ContentStats;
    user: ContentStats;
    models: string[];
    parentIds: string[];
    subagentTypes: string[];
    taskDescriptions: string[];
  };
  /** The Task tool_result's structured tool_use_result (user message). */
  taskToolUseResult: { keys: string[]; preview: string } | null;
  toolProgress: {
    count: number;
    withParent: number;
    samples: Array<Record<string, unknown>>;
  };
  streamEvents: { count: number; withParent: number; deltaTypes: string[] };
  canUseToolCalls: Array<{
    toolName: string;
    optionKeys: string[];
    agentMarkers: Record<string, unknown>;
  }>;
  isErrorResult: boolean;
  resultErrors: string[];
}

async function runScenario(opts: {
  label: string;
  prompt: string;
  forwardSubagentText: boolean;
  /** D control runs WITHOUT delegation on purpose — relax the ok gate. */
  expectsDelegation?: boolean;
  queryFn: QueryFn;
  cliPath: string;
  env: NodeJS.ProcessEnv;
}): Promise<ScenarioResult> {
  const started = performance.now();
  const r: ScenarioResult = {
    label: opts.label,
    forwardSubagentText: opts.forwardSubagentText,
    ok: false,
    threw: false,
    msTotal: 0,
    eventCount: 0,
    eventTagSeq: [],
    byTag: {},
    topLevelKeysByTag: {},
    distinctSessionIds: [],
    taskToolUses: [],
    main: { assistant: newContentStats(), user: newContentStats(), models: [] },
    sub: {
      assistant: newContentStats(),
      user: newContentStats(),
      models: [],
      parentIds: [],
      subagentTypes: [],
      taskDescriptions: [],
    },
    taskToolUseResult: null,
    toolProgress: { count: 0, withParent: 0, samples: [] },
    streamEvents: { count: 0, withParent: 0, deltaTypes: [] },
    canUseToolCalls: [],
    isErrorResult: false,
    resultErrors: [],
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const rawLines: string[] = [];
  const pushDistinct = (arr: string[], v: string) => {
    if (!arr.includes(v)) arr.push(v);
  };

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> => {
    const agentMarkers: Record<string, unknown> = {};
    for (const key of Object.keys(options)) {
      if (/agent|task|parent/i.test(key)) agentMarkers[key] = options[key];
    }
    r.canUseToolCalls.push({ toolName, optionKeys: Object.keys(options).sort(), agentMarkers });
    return { behavior: 'allow', updatedInput: input };
  };

  // Mirror claudeRuntime.ts's production option set exactly except the field
  // under test, so results transfer.
  const options: Record<string, unknown> = {
    cwd: CWD,
    pathToClaudeCodeExecutable: opts.cliPath,
    executable: process.execPath,
    tools: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    thinking: { type: 'adaptive', display: 'summarized' },
    permissionMode: 'default',
    canUseTool,
    env: opts.env,
    abortController: abort,
    stderr: (line: string) => console.error(`[t34:${opts.label}] cli-stderr:`, line.slice(0, 300)),
    ...(opts.forwardSubagentText ? { forwardSubagentText: true } : {}),
    ...(FORCED_MODEL ? { model: FORCED_MODEL } : {}),
  };

  let stream: (AsyncIterable<unknown> & { close?: () => void }) | null = null;
  try {
    stream = opts.queryFn({ prompt: opts.prompt, options });
    for await (const event of stream) {
      if (abort.signal.aborted) break;
      r.eventCount += 1;
      rawLines.push(JSON.stringify(event));
      const e = event as {
        type?: string;
        subtype?: string;
        session_id?: string;
        parent_tool_use_id?: string | null;
        subagent_type?: string;
        task_description?: string;
        message?: { content?: unknown; model?: string };
        tool_use_result?: unknown;
        event?: { type?: string; delta?: { type?: string } };
        is_error?: boolean;
        errors?: string[];
      };
      const type = String(e.type ?? typeof event);
      const parent = typeof e.parent_tool_use_id === 'string' ? e.parent_tool_use_id : null;
      const tag = (e.subtype ? `${type}/${e.subtype}` : type) + (parent ? '*' : '');
      r.byTag[tag] = (r.byTag[tag] ?? 0) + 1;
      if (r.eventTagSeq.length < 120) r.eventTagSeq.push(tag);
      const keySet = Object.keys(event as object)
        .sort()
        .join(',');
      if (!r.topLevelKeysByTag[tag]) r.topLevelKeysByTag[tag] = [];
      pushDistinct(r.topLevelKeysByTag[tag], keySet);
      if (typeof e.session_id === 'string') pushDistinct(r.distinctSessionIds, e.session_id);

      if (type === 'assistant') {
        const bucket = parent ? r.sub : r.main;
        foldContent(bucket.assistant, e.message?.content);
        if (typeof e.message?.model === 'string') pushDistinct(bucket.models, e.message.model);
        if (parent) {
          pushDistinct(r.sub.parentIds, parent);
          if (typeof e.subagent_type === 'string')
            pushDistinct(r.sub.subagentTypes, e.subagent_type);
          if (typeof e.task_description === 'string')
            pushDistinct(r.sub.taskDescriptions, e.task_description);
        } else {
          for (const tool of r.main.assistant.toolUses) {
            if (
              DELEGATION_TOOL_NAMES.has(tool.name) &&
              !r.taskToolUses.some((t) => t.id === tool.id)
            ) {
              // Re-read the raw input for the two fields the UI will key on.
              const rawInput = (
                (e.message?.content as Array<{ id?: string; input?: Record<string, unknown> }>) ??
                []
              ).find((b) => b?.id === tool.id)?.input;
              r.taskToolUses.push({
                id: tool.id,
                subagentType: rawInput?.subagent_type,
                description: rawInput?.description,
                inputKeys: tool.inputKeys,
              });
            }
          }
        }
      }

      if (type === 'user') {
        const bucket = parent ? r.sub : r.main;
        foldContent(bucket.user, e.message?.content);
        if (parent) {
          pushDistinct(r.sub.parentIds, parent);
          if (typeof e.subagent_type === 'string')
            pushDistinct(r.sub.subagentTypes, e.subagent_type);
          if (typeof e.task_description === 'string')
            pushDistinct(r.sub.taskDescriptions, e.task_description);
        } else if (
          e.tool_use_result != null &&
          r.taskToolUses.length > 0 &&
          bucket.user.toolResults.some((tr) => r.taskToolUses.some((t) => t.id === tr.toolUseId))
        ) {
          const obj = e.tool_use_result;
          r.taskToolUseResult = {
            keys: obj && typeof obj === 'object' ? Object.keys(obj).sort() : [typeof obj],
            preview: JSON.stringify(obj).slice(0, 600),
          };
        }
      }

      if (type === 'tool_progress') {
        r.toolProgress.count += 1;
        if (parent) r.toolProgress.withParent += 1;
        if (r.toolProgress.samples.length < 6) {
          const {
            tool_use_id,
            tool_name,
            elapsed_time_seconds,
            heartbeat,
            task_id,
            subagent_type,
          } = event as Record<string, unknown>;
          r.toolProgress.samples.push({
            tool_use_id,
            tool_name,
            parent_tool_use_id: parent,
            elapsed_time_seconds,
            heartbeat,
            task_id,
            subagent_type,
          });
        }
      }

      if (type === 'stream_event') {
        r.streamEvents.count += 1;
        if (parent) r.streamEvents.withParent += 1;
        const deltaType = String(e.event?.delta?.type ?? e.event?.type ?? '');
        if (deltaType && r.streamEvents.deltaTypes.length < 20)
          pushDistinct(r.streamEvents.deltaTypes, deltaType);
      }

      if (type === 'result') {
        r.isErrorResult = Boolean(e.is_error);
        if (Array.isArray(e.errors)) r.resultErrors = e.errors.map(String);
      }
    }
    r.ok =
      !r.isErrorResult &&
      r.main.assistant.textLen > 0 &&
      ((opts.expectsDelegation ?? true) ? r.taskToolUses.length > 0 : true);
  } catch (err) {
    r.threw = true;
    r.errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    r.msTotal = Math.round(performance.now() - started);
    try {
      stream?.close?.();
    } catch {
      // ignore
    }
  }

  try {
    await mkdir(DUMP_DIR, { recursive: true });
    await writeFile(path.join(DUMP_DIR, `${opts.label}.jsonl`), `${rawLines.join('\n')}\n`);
  } catch (err) {
    console.error(`[t34] dump write failed for ${opts.label}:`, err);
  }
  return r;
}

async function main(): Promise<void> {
  const cliPath = await resolveCometixCli();
  const queryFn = await loadQueryFn();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...testCredentialEnv(CWD),
    ANTHROPIC_AUTH_TOKEN: TEST_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: TEST_BASE_URL,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'aiclient-t34-subagent-probe/0.0.1',
  };

  console.error(`[t34] node=${process.version}`);
  console.error(`[t34] cometix=${COMETIX_PIN.version} sdk=${CLAUDE_AGENT_SDK_PIN_VERSION}`);
  console.error(`[t34] cliPath=${cliPath}`);
  console.error(`[t34] cwd=${CWD} dumpDir=${DUMP_DIR}`);
  console.error(`[t34] baseUrl=${TEST_BASE_URL} timeoutMs=${TIMEOUT_MS}`);

  const selected = (process.env.AICLIENT_T34_SCENARIOS ?? 'A,B,C')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const specs = [
    { key: 'A', label: 'A_default', prompt: TASK_PROMPT, forwardSubagentText: false },
    { key: 'B', label: 'B_forwarded', prompt: TASK_PROMPT, forwardSubagentText: true },
    { key: 'C', label: 'C_permission', prompt: PERMISSION_PROMPT, forwardSubagentText: true },
    {
      key: 'D',
      label: 'D_main_write_control',
      prompt: MAIN_WRITE_PROMPT,
      forwardSubagentText: true,
      expectsDelegation: false,
    },
    { key: 'E', label: 'E_sub_write', prompt: SUB_WRITE_PROMPT, forwardSubagentText: true },
  ].filter((s) => selected.includes(s.key));

  const results: ScenarioResult[] = [];
  for (const spec of specs) {
    console.error(`[t34] ${spec.label}: forwardSubagentText=${spec.forwardSubagentText}…`);
    const r = await runScenario({ ...spec, queryFn, cliPath, env });
    console.error(
      `[t34] ${spec.label} ok=${r.ok} events=${r.eventCount} taskCalls=${r.taskToolUses.length} ` +
        `subToolUses=${r.sub.assistant.toolUses.length} subTextLen=${r.sub.assistant.textLen} ` +
        `canUseTool=${r.canUseToolCalls.length} ms=${r.msTotal}`
    );
    results.push(r);
  }

  const byLabel = new Map(results.map((r) => [r.label, r]));
  const a = byLabel.get('A_default');
  const b = byLabel.get('B_forwarded');
  const c = byLabel.get('C_permission');
  const taskIds = (r: ScenarioResult) => r.taskToolUses.map((t) => t.id);
  const verdict = {
    /** Every selected scenario produced a real delegation run with a final answer. */
    allRunsHealthy: results.length > 0 && results.every((r) => r.ok),
    /** A: the known defect's mechanism — subagent tool traffic present by default… */
    defaultLeaksSubagentToolUse: a
      ? a.sub.assistant.toolUses.length > 0 || a.sub.user.toolResults.length > 0
      : null,
    /** …and it is distinguishable (parent_tool_use_id set) — the fix has a key. */
    subagentTrafficKeyed: results.some((r) => r.sub.parentIds.length > 0),
    /** B: text/thinking actually arrive once forwarded. */
    forwardGivesSubagentText: b ? b.sub.assistant.textLen > 0 : null,
    forwardGivesSubagentThinking: b ? b.sub.assistant.thinkingLen > 0 : null,
    /** Subagent events point at the main agent's Task/Agent tool_use id. */
    parentMatchesTaskToolUse: results
      .filter((r) => r.sub.parentIds.length > 0)
      .every((r) => r.sub.parentIds.every((id) => taskIds(r).includes(id))),
    /** Structured Task result exists — the display can render from it. */
    taskToolUseResultPresent: results.some((r) => r.taskToolUseResult),
    /** C: subagent tool permissions reach canUseTool at all. */
    subagentToolHitsCanUseTool: c ? c.canUseToolCalls.length > 0 : null,
    /** canUseTool exposes a subagent marker for the permission badge. */
    canUseToolCarriesAgentMarker: results.some((r) =>
      r.canUseToolCalls.some((call) => Object.keys(call.agentMarkers).length > 0)
    ),
    /** Acceptance ④ baseline: events per scenario. */
    eventCounts: Object.fromEntries(results.map((r) => [r.label, r.eventCount])),
  };

  const out = {
    probe: 't34-subagent-shape',
    baseUrl: TEST_BASE_URL,
    cometixVersion: COMETIX_PIN.version,
    sdkVersion: CLAUDE_AGENT_SDK_PIN_VERSION,
    modelRequested: FORCED_MODEL || '<gateway default>',
    dumpDir: DUMP_DIR,
    verdict,
    scenarios: Object.fromEntries(results.map((r) => [r.label, r])),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = verdict.allRunsHealthy ? 0 : 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
