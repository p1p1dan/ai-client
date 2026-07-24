/**
 * C-10 spike: SDK options support probe — effort / permissionMode (esp. 'plan') /
 * model / thinking / maxThinkingTokens, against Cometix 2.1.212 + shared test gateway.
 *
 * Report-only, no runtime code changes. Bypasses the Host stdio protocol and calls
 * the Agent SDK `query()` directly with the same cliPath/executable resolution as
 * claudeRuntime.ts, so each probe varies exactly one option against the
 * claudeRuntime.ts `send()` baseline and inspects raw SDK messages:
 *   - `system`/`init` echoes back the effective model/permissionMode/capabilities
 *   - `result` carries usage/cost/duration/errors
 *   - `assistant` content blocks carry tool_use/thinking/text
 *
 * Usage (Node 24, from src/agent-host):
 *   node --experimental-strip-types spikes/c10-options-probe.ts
 *
 * Optional:
 *   AICLIENT_PROBE_ONLY=<comma ids or group names>   run a subset, e.g. "effort" or
 *                                                     "permissionMode-plan,model-illegal"
 *   AICLIENT_PROBE_TIMEOUT_MS=<ms>                    per-probe timeout (default 40000)
 *   AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1               use ~/.claude/settings.json instead
 *                                                      of the shared test gateway
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadClaudeSettingsEnv } from '../claudeSettings.ts';
import { resolveCometixCli } from '../cometix.ts';
import { testCredentialEnv } from './testCredentials.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname; // kept for parity with sibling spikes; not used directly here

const TIMEOUT_MS = Number(process.env.AICLIENT_PROBE_TIMEOUT_MS ?? 45000);
const ONLY = process.env.AICLIENT_PROBE_ONLY?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PLAIN_PROMPT = 'Reply with exactly: OK. Do not use tools.';
const WRITE_PROMPT =
  'Use the Write tool to create a file named "probe.txt" with the exact content OK. ' +
  'After the tool call succeeds (or is denied), reply with exactly: OK';

type SdkQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>> & { close?: () => void };

interface ProbeSpec {
  id: string;
  group: 'effort' | 'permissionMode' | 'model' | 'thinking';
  desc: string;
  prompt: string;
  options: Record<string, unknown>;
  /** Auto-allow every canUseTool call and record them. */
  wireCanUseTool?: boolean;
}

interface ProbeResult {
  id: string;
  group: string;
  desc: string;
  optionsSent: Record<string, unknown>;
  ok: boolean;
  threw: boolean;
  timedOut: boolean;
  /**
   * 'completed'           — a `result` event arrived (normal end of turn)
   * 'timeout-after-output' — assistant produced text/tool_use but the stream hung
   *                          before `result` and had to be aborted at TIMEOUT_MS
   *                          (matches the "gateway hang / dropped stream" behavior
   *                          claudeRuntime.ts already defends against — NOT
   *                          necessarily specific to the option under test)
   * 'timeout-no-output'   — aborted at TIMEOUT_MS with zero assistant output;
   *                          more likely option-specific (e.g. gateway stalls on
   *                          an unrecognized value)
   * 'error'               — threw before the timeout fired (fast rejection —
   *                          most useful signal for illegal-value probes)
   */
  outcome: 'completed' | 'timeout-after-output' | 'timeout-no-output' | 'error' | 'unknown';
  errorMessage?: string;
  elapsedMs: number;
  eventCount: number;
  eventTypes: string[];
  systemInit?: Record<string, unknown>;
  toolUses: Array<{ name: string; input: unknown }>;
  canUseToolCalls: Array<{ name: string; input: unknown }>;
  assistantTextPreview: string;
  thinkingPreview: string;
  resultRaw?: Record<string, unknown>;
}

function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const rest = { ...obj };
  delete rest[key];
  return rest;
}

function redact(options: Record<string, unknown>): Record<string, unknown> {
  return omit(omit(omit(options, 'env'), 'canUseTool'), 'abortController');
}

async function runProbe(queryFn: SdkQueryFn, spec: ProbeSpec): Promise<ProbeResult> {
  const result: ProbeResult = {
    id: spec.id,
    group: spec.group,
    desc: spec.desc,
    optionsSent: redact(spec.options),
    ok: false,
    threw: false,
    timedOut: false,
    outcome: 'unknown',
    elapsedMs: 0,
    eventCount: 0,
    eventTypes: [],
    toolUses: [],
    canUseToolCalls: [],
    assistantTextPreview: '',
    thinkingPreview: '',
  };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const started = Date.now();

  const options: Record<string, unknown> = { ...spec.options, abortController: abort };
  if (spec.wireCanUseTool) {
    options.canUseTool = (toolName: string, input: Record<string, unknown>) => {
      result.canUseToolCalls.push({ name: toolName, input });
      return Promise.resolve({ behavior: 'allow' as const, updatedInput: input });
    };
  }

  try {
    const stream = queryFn({ prompt: spec.prompt, options });
    for await (const event of stream) {
      if (abort.signal.aborted) break;
      result.eventCount += 1;
      const type = String((event as { type?: string }).type ?? '');
      if (result.eventTypes.length < 40) result.eventTypes.push(type);

      if (type === 'system' && (event as { subtype?: string }).subtype === 'init') {
        const e = event as Record<string, unknown>;
        result.systemInit = {
          ...e,
          // Trim noisy long lists to counts; full names rarely matter for this probe.
          tools: Array.isArray(e.tools) ? (e.tools as unknown[]).length : e.tools,
          slash_commands: Array.isArray(e.slash_commands)
            ? (e.slash_commands as unknown[]).length
            : e.slash_commands,
          skills: Array.isArray(e.skills) ? (e.skills as unknown[]).length : e.skills,
        };
      }

      if (type === 'assistant') {
        const content = (event as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            const p = part as {
              type?: string;
              text?: string;
              thinking?: string;
              name?: string;
              input?: unknown;
            };
            if (p.type === 'text' && p.text) {
              result.assistantTextPreview = (result.assistantTextPreview + p.text).slice(0, 300);
            }
            if (p.type === 'thinking' && p.thinking) {
              result.thinkingPreview = (result.thinkingPreview + p.thinking).slice(0, 300);
            }
            if (p.type === 'tool_use' && p.name) {
              result.toolUses.push({ name: p.name, input: p.input });
            }
          }
        }
      }

      if (type === 'result') {
        const e = event as Record<string, unknown>;
        result.resultRaw = {
          subtype: e.subtype,
          is_error: e.is_error,
          duration_ms: e.duration_ms,
          duration_api_ms: e.duration_api_ms,
          num_turns: e.num_turns,
          total_cost_usd: e.total_cost_usd,
          usage: e.usage,
          errors: e.errors,
          permission_denials: e.permission_denials,
        };
      }
    }
    if (result.resultRaw) {
      result.outcome = 'completed';
      result.ok = true;
    } else if (abort.signal.aborted) {
      result.timedOut = true;
      result.outcome =
        result.assistantTextPreview || result.toolUses.length > 0
          ? 'timeout-after-output'
          : 'timeout-no-output';
      result.errorMessage = `timed out after ${TIMEOUT_MS}ms (partial: ${result.eventCount} events)`;
    }
  } catch (err) {
    result.threw = true;
    result.timedOut = abort.signal.aborted;
    result.outcome = result.timedOut
      ? result.assistantTextPreview || result.toolUses.length > 0
        ? 'timeout-after-output'
        : 'timeout-no-output'
      : 'error';
    result.errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    result.elapsedMs = Date.now() - started;
  }
  return result;
}

async function main(): Promise<void> {
  const cometix = await resolveCometixCli();
  const scratchWorkdir = mkdtempSync(path.join(tmpdir(), 'aiclient-c10-probe-'));

  const credEnv = testCredentialEnv(scratchWorkdir);
  for (const [k, v] of Object.entries(credEnv)) process.env[k] = v;
  const loaded = await loadClaudeSettingsEnv();
  const mergedEnv: NodeJS.ProcessEnv = {
    ...loaded.env,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'aiclient-c10-probe/0.0.1',
  };

  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query?: SdkQueryFn;
    default?: { query?: SdkQueryFn };
  };
  const queryFn = sdk.query ?? sdk.default?.query;
  if (!queryFn) throw new Error('claude-agent-sdk has no query() export');

  // Mirrors claudeRuntime.ts send() options exactly; each probe overrides only the
  // field(s) under test. Call fresh per-probe (options object is mutated by callers).
  const baseline = (): Record<string, unknown> => ({
    cwd: scratchWorkdir,
    pathToClaudeCodeExecutable: cometix.cliPath,
    executable: process.execPath,
    tools: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    thinking: { type: 'disabled' },
    permissionMode: 'default',
    env: mergedEnv,
  });

  const specs: ProbeSpec[] = [
    // --- effort: each named tier under the current runtime baseline (thinking disabled) ---
    {
      id: 'effort-low',
      group: 'effort',
      desc: "effort='low', thinking disabled (matches claudeRuntime.ts baseline)",
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), effort: 'low' },
    },
    {
      id: 'effort-medium',
      group: 'effort',
      desc: "effort='medium', thinking disabled (baseline)",
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), effort: 'medium' },
    },
    {
      id: 'effort-high',
      group: 'effort',
      desc: "effort='high', thinking disabled (baseline)",
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), effort: 'high' },
    },
    {
      id: 'effort-xhigh',
      group: 'effort',
      desc: "effort='xhigh', thinking disabled (baseline)",
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), effort: 'xhigh' },
    },
    {
      id: 'effort-max',
      group: 'effort',
      desc: "effort='max', thinking disabled (baseline)",
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), effort: 'max' },
    },
    // --- effort contrast: thinking omitted (SDK default / adaptive) instead of forced-disabled ---
    {
      id: 'effort-low-thinkingdefault',
      group: 'effort',
      desc: "effort='low', thinking OMITTED (SDK default, not the runtime's forced-disabled)",
      prompt: PLAIN_PROMPT,
      options: { ...omit(baseline(), 'thinking'), effort: 'low' },
    },
    {
      id: 'effort-xhigh-thinkingdefault',
      group: 'effort',
      desc: "effort='xhigh', thinking OMITTED (SDK default, not the runtime's forced-disabled)",
      prompt: PLAIN_PROMPT,
      options: { ...omit(baseline(), 'thinking'), effort: 'xhigh' },
    },
    // --- effort illegal-value contrast ---
    {
      id: 'effort-illegal-string',
      group: 'effort',
      desc: "effort='ultra' (not in EffortLevel enum)",
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), effort: 'ultra' },
    },
    {
      id: 'effort-illegal-number',
      group: 'effort',
      desc: 'effort=5 (wrong type at top-level Options — AgentDefinition.effort allows a number, top-level does not)',
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), effort: 5 },
    },

    // --- permissionMode: full enum, with a Write-tool-shaped prompt so canUseTool /
    // ExitPlanMode / auto-deny behavior is observable, not just the init echo. ---
    {
      id: 'permissionMode-plan',
      group: 'permissionMode',
      desc: "permissionMode='plan' + Write-tool prompt (key probe for T-09 Plan control)",
      prompt: WRITE_PROMPT,
      options: { ...baseline(), permissionMode: 'plan' },
      wireCanUseTool: true,
    },
    {
      id: 'permissionMode-acceptEdits',
      group: 'permissionMode',
      desc: "permissionMode='acceptEdits' + Write-tool prompt",
      prompt: WRITE_PROMPT,
      options: { ...baseline(), permissionMode: 'acceptEdits' },
      wireCanUseTool: true,
    },
    {
      id: 'permissionMode-dontAsk',
      group: 'permissionMode',
      desc: "permissionMode='dontAsk' + Write-tool prompt",
      prompt: WRITE_PROMPT,
      options: { ...baseline(), permissionMode: 'dontAsk' },
      wireCanUseTool: true,
    },
    {
      id: 'permissionMode-auto',
      group: 'permissionMode',
      desc: "permissionMode='auto' + Write-tool prompt",
      prompt: WRITE_PROMPT,
      options: { ...baseline(), permissionMode: 'auto' },
      wireCanUseTool: true,
    },
    {
      id: 'permissionMode-bypass-noflag',
      group: 'permissionMode',
      desc: "permissionMode='bypassPermissions' WITHOUT allowDangerouslySkipPermissions (docs say this is required)",
      prompt: WRITE_PROMPT,
      options: { ...baseline(), permissionMode: 'bypassPermissions' },
      wireCanUseTool: true,
    },
    {
      id: 'permissionMode-bypass-flag',
      group: 'permissionMode',
      desc: "permissionMode='bypassPermissions' WITH allowDangerouslySkipPermissions=true",
      prompt: WRITE_PROMPT,
      options: { ...baseline(), permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true },
      wireCanUseTool: true,
    },
    {
      id: 'permissionMode-illegal',
      group: 'permissionMode',
      desc: "permissionMode='yolo' (not in PermissionMode enum)",
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), permissionMode: 'yolo' },
    },

    // --- model ---
    {
      id: 'model-illegal',
      group: 'model',
      desc: "model='claude-does-not-exist-9000' (support for a *valid* model string is already exercised via session.model plumbing elsewhere; this only probes the error contour for an invalid one)",
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), model: 'claude-does-not-exist-9000' },
    },

    // --- thinking / maxThinkingTokens ---
    {
      id: 'thinking-maxThinkingTokens',
      group: 'thinking',
      desc: 'maxThinkingTokens=1024, thinking OMITTED (deprecated field, no longer forced-disabled)',
      prompt: PLAIN_PROMPT,
      options: { ...omit(baseline(), 'thinking'), maxThinkingTokens: 1024 },
    },
    {
      id: 'thinking-adaptive',
      group: 'thinking',
      desc: "thinking={type:'adaptive'} (explicit, vs. baseline's forced disabled)",
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), thinking: { type: 'adaptive' } },
    },
    {
      id: 'thinking-enabled-budget',
      group: 'thinking',
      desc: "thinking={type:'enabled', budgetTokens:1024}",
      prompt: PLAIN_PROMPT,
      options: { ...baseline(), thinking: { type: 'enabled', budgetTokens: 1024 } },
    },
  ];

  const filtered = ONLY?.length
    ? specs.filter((s) => ONLY.includes(s.id) || ONLY.includes(s.group))
    : specs;

  const results: ProbeResult[] = [];
  for (const spec of filtered) {
    process.stderr.write(`[c10-probe] running ${spec.id} …\n`);
    let r = await runProbe(queryFn, spec);
    // The shared test gateway is under concurrent load from sibling spikes; a probe
    // that never even reached `system/init` (no signal at all, not even a hang after
    // output) is inconclusive rather than a real finding — retry once before recording.
    if (!r.systemInit && r.outcome === 'timeout-no-output') {
      process.stderr.write(`[c10-probe] ${spec.id} inconclusive (no system/init) — retrying once…\n`);
      r = await runProbe(queryFn, spec);
    }
    results.push(r);
    process.stderr.write(
      `[c10-probe] ${spec.id} done outcome=${r.outcome} threw=${r.threw} elapsed=${r.elapsedMs}ms events=${r.eventCount}\n`
    );
  }

  console.log(
    JSON.stringify(
      {
        cometixVersion: cometix.version,
        cliPath: cometix.cliPath,
        scratchWorkdir,
        probeCount: results.length,
        results,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
