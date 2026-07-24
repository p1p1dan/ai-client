/**
 * C-03 spike: AskUserQuestion behavior under Agent SDK canUseTool.
 *
 * Probes whether "model asks the user" is natively supported, and how the
 * host should feed answers back (updatedInput vs tool_result vs other).
 *
 * Scenarios (each a fresh query() call, run sequentially):
 *   1. allow-updated — canUseTool returns {behavior:'allow', updatedInput}
 *      with `answers` injected (the hypothesized questionBridge mechanism).
 *   2. deny          — canUseTool returns {behavior:'deny', message}.
 *   3. allow-raw     — canUseTool allows with the input untouched (no answers)
 *      to observe what the CLI-side tool does without a collected answer.
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c03-question-probe.ts
 *   AICLIENT_C03_SCENARIOS=allow-updated node ... (comma list to subset)
 */

import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_AUTH_TOKEN, TEST_BASE_URL, testCredentialEnv } from './testCredentials.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(hostRoot, '..', '..');
const require = createRequire(import.meta.url);

const PROMPT =
  'Use the AskUserQuestion tool to ask me whether I prefer red or blue. ' +
  'You must ask before answering. Do not answer without asking. ' +
  'After the tool returns, reply with exactly one line: CHOSEN: <the color I picked>. ' +
  'If the question was declined or unanswered, reply with exactly: NO-ANSWER';

const SCENARIO_TIMEOUT_MS = Number(process.env.AICLIENT_C03_TIMEOUT_MS ?? 120000);
/** allow-raw may hang on a CLI-side interactive wait — cap it tighter. */
const ALLOW_RAW_TIMEOUT_MS = Number(process.env.AICLIENT_C03_RAW_TIMEOUT_MS ?? 60000);

type ScenarioName = 'allow-updated' | 'deny' | 'allow-raw';

interface CanUseToolCall {
  toolName: string;
  input: unknown;
  options: Record<string, unknown>;
  respondedWith: unknown;
}

interface ScenarioReport {
  scenario: ScenarioName;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  eventTypes: string[];
  unknownEventTypes: string[];
  canUseToolCalls: CanUseToolCall[];
  askUserQuestionSeen: boolean;
  toolUseBlocks: Array<{ name: string; id?: string; input: unknown }>;
  toolResults: Array<{ tool_use_id?: string; is_error?: boolean; content: unknown }>;
  assistantText: string;
  resultEvent?: unknown;
  error?: string;
}

const KNOWN_TYPES = new Set(['system', 'assistant', 'user', 'result', 'stream_event']);

async function resolveCometixCli(): Promise<string> {
  const pkgJson = require.resolve('@cometix/claude-code/package.json');
  const root = path.dirname(pkgJson);
  const candidates = [
    path.join(root, 'cli.js'),
    path.join(root, 'cli.mjs'),
    path.join(root, 'bin', 'cli.js'),
    path.join(root, 'dist', 'cli.js'),
  ];
  for (const c of candidates) {
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

async function loadQuery(): Promise<QueryFn> {
  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query?: QueryFn;
    default?: { query?: QueryFn };
  };
  const fn = sdk.query ?? sdk.default?.query;
  if (!fn) throw new Error('claude-agent-sdk has no query() export');
  return fn;
}

/** Redact nothing model-generated; strip only env-ish strings if they leak. */
function safeJson(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    if (!text) return value;
    return JSON.parse(
      text
        .replaceAll(TEST_AUTH_TOKEN, '<token>')
        .replaceAll(TEST_BASE_URL, '<base-url>')
    ) as unknown;
  } catch {
    return String(value);
  }
}

function buildAnswers(input: unknown): Record<string, string> {
  const answers: Record<string, string> = {};
  const questions = (input as { questions?: Array<{ question?: string; options?: Array<{ label?: string }> }> })
    ?.questions;
  if (!Array.isArray(questions)) return answers;
  for (const q of questions) {
    if (typeof q?.question !== 'string') continue;
    // Prefer an option containing "blue", else first option label, else literal.
    const labels = (q.options ?? []).map((o) => o?.label).filter((l): l is string => !!l);
    const blue = labels.find((l) => l.toLowerCase().includes('blue'));
    answers[q.question] = blue ?? labels[0] ?? 'blue';
  }
  return answers;
}

async function runScenario(
  queryFn: QueryFn,
  cliPath: string,
  scenario: ScenarioName,
  timeoutMs: number
): Promise<ScenarioReport> {
  const report: ScenarioReport = {
    scenario,
    ok: false,
    timedOut: false,
    durationMs: 0,
    eventTypes: [],
    unknownEventTypes: [],
    canUseToolCalls: [],
    askUserQuestionSeen: false,
    toolUseBlocks: [],
    toolResults: [],
    assistantText: '',
  };
  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => {
    report.timedOut = true;
    abort.abort();
  }, timeoutMs);

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<unknown> => {
    const { signal: _signal, ...loggable } = options;
    let response: unknown;
    if (toolName === 'AskUserQuestion') {
      report.askUserQuestionSeen = true;
      if (scenario === 'allow-updated') {
        response = {
          behavior: 'allow',
          updatedInput: { ...input, answers: buildAnswers(input) },
        };
      } else if (scenario === 'deny') {
        response = { behavior: 'deny', message: 'User declined to answer the question.' };
      } else {
        response = { behavior: 'allow', updatedInput: input };
      }
    } else {
      // Non-question tools: allow untouched so the turn can proceed.
      response = { behavior: 'allow', updatedInput: input };
    }
    report.canUseToolCalls.push({
      toolName,
      input: safeJson(input),
      options: safeJson(loggable) as Record<string, unknown>,
      respondedWith: safeJson(response),
    });
    return response;
  };

  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...testCredentialEnv(repoRoot),
    ANTHROPIC_AUTH_TOKEN: TEST_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: TEST_BASE_URL,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'aiclient-c03-question-probe/0.0.1',
  };

  let stream: (AsyncIterable<unknown> & { close?: () => void }) | null = null;
  try {
    stream = queryFn({
      prompt: PROMPT,
      options: {
        cwd: repoRoot,
        pathToClaudeCodeExecutable: cliPath,
        executable: process.execPath,
        // Aligned with claudeRuntime.ts production options:
        tools: { type: 'preset', preset: 'claude_code' },
        settingSources: [],
        thinking: { type: 'disabled' },
        permissionMode: 'default',
        canUseTool,
        env: mergedEnv,
        abortController: abort,
      },
    });

    for await (const raw of stream) {
      if (abort.signal.aborted) break;
      const event = raw as {
        type?: string;
        message?: { content?: unknown };
        subtype?: string;
      };
      const type = String(event.type ?? typeof raw);
      report.eventTypes.push(event.subtype ? `${type}:${event.subtype}` : type);
      if (!KNOWN_TYPES.has(type)) report.unknownEventTypes.push(type);

      const content = event.message?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use') {
            report.toolUseBlocks.push({
              name: String(block.name ?? ''),
              id: typeof block.id === 'string' ? block.id : undefined,
              input: safeJson(block.input),
            });
          } else if (block.type === 'tool_result') {
            report.toolResults.push({
              tool_use_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
              is_error: block.is_error === true ? true : undefined,
              content: safeJson(block.content),
            });
          } else if (event.type === 'assistant' && block.type === 'text') {
            report.assistantText = (report.assistantText + String(block.text ?? '')).slice(0, 600);
          }
        }
      }
      if (event.type === 'result') {
        const { usage: _u, modelUsage: _m, ...rest } = raw as Record<string, unknown>;
        report.resultEvent = safeJson(rest);
      }
    }
    report.ok = !report.timedOut;
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    report.ok = false;
  } finally {
    clearTimeout(timer);
    report.durationMs = Date.now() - started;
    try {
      stream?.close?.();
    } catch {
      // ignore
    }
  }
  return report;
}

async function main(): Promise<void> {
  const requested = (process.env.AICLIENT_C03_SCENARIOS ?? 'allow-updated,deny,allow-raw')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ScenarioName =>
      ['allow-updated', 'deny', 'allow-raw'].includes(s)
    );

  const cliPath = await resolveCometixCli();
  const queryFn = await loadQuery();
  console.error(`[c03] cli=${cliPath}`);
  console.error(`[c03] scenarios=${requested.join(',')}`);

  const reports: ScenarioReport[] = [];
  for (const scenario of requested) {
    console.error(`[c03] running scenario: ${scenario}`);
    const timeout = scenario === 'allow-raw' ? ALLOW_RAW_TIMEOUT_MS : SCENARIO_TIMEOUT_MS;
    const report = await runScenario(queryFn, cliPath, scenario, timeout);
    console.error(
      `[c03] ${scenario}: ok=${report.ok} timedOut=${report.timedOut} ` +
        `askSeen=${report.askUserQuestionSeen} durationMs=${report.durationMs}`
    );
    reports.push(report);
  }

  const summary = {
    ok: reports.every((r) => r.ok || r.scenario === 'allow-raw'),
    reports,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.ok ? 0 : 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
