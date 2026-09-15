/**
 * P2-5/P2-6 — the same fixed suite against the SELF-OWNED runtime.
 *
 * Deliberately a sibling of `run.mjs` rather than a flag inside it: the two
 * backends are booted through different entry points (`bootstrapPiAgentSession`
 * on the installed pi-coding-agent SDK versus `createRuntime` on
 * `src/runtime/`), keep their own pinned copies of pi-ai / pi-agent-core, and
 * archive different session formats. One file with a backend switch would have
 * made every step read as "which half of this applies to me"; two files that
 * produce the SAME artifact shape can be diffed by `compare.mjs` and by a
 * reader.
 *
 * What is held identical to the baseline, on purpose:
 *   - `suite.mjs` — prompts, fixed files, tool arguments, assertions, model row
 *   - the fixed workspace path, which is part of the cached prefix
 *   - usage accounting: one provider call counted once, from `turn_end`, with
 *     compaction summary usage recorded separately (ARD D9)
 *
 * What CANNOT be held identical, and is therefore recorded rather than hidden:
 *   - pi protocol packages: 0.84.4 here, 0.84.3 in the legacy SDK (ARD D12)
 *   - the tool registry: six native tools plus `new_context`, not the SDK's set
 *   - compaction thresholds: this runtime derives reserve/keep-recent from the
 *     model window (`plugins/context/budget.ts`), so the baseline's explicit
 *     `reserveTokens=4096 / keepRecentTokens=1024` has no equivalent knob
 *   - the system prompt: assembled by `runtimePrompt`, not by the SDK
 *
 * Usage:
 *
 *   P20_BASELINE_API_KEY=<secret> node scripts/runtime-baseline/run-native.mjs \
 *     --base-url http://gateway:port --out docs/.../evidence/p2-5/NEW_RUN_ID
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createRuntime,
  RUNTIME_CONFIG_VERSION,
  resolveWorkerShell,
  standaloneHost,
} from '../../src/runtime/index.ts';
import { archiveSkeletonFailures, comparabilityReport, readArchive } from './archive.mjs';
import { assertToolCall, summarizeUsage } from './metrics.mjs';
import { suite } from './suite.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    out: { type: 'string' },
    work: { type: 'string', default: '/tmp/aiclient-p2-0-work' },
    case: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    [
      'P20_BASELINE_API_KEY=<secret> node scripts/runtime-baseline/run-native.mjs --base-url URL --out NEW_DIR [--case B01] [--work /tmp/aiclient-p2-0-work]',
      'node scripts/runtime-baseline/run-native.mjs --dry-run --out NEW_DIR   # no gateway, no key, no model call',
    ].join('\n')
  );
  process.exit(0);
}

/**
 * `--dry-run` — everything except the six scenarios (T028).
 *
 * A collection needs a gateway, a key and real model turns, so the plumbing
 * around it — argument parsing, the refusal to reuse a directory, the workspace
 * preparation, the manifest the comparison later depends on — was code nobody
 * could run on a development machine. This mode runs exactly that part, writes
 * the archive skeleton, checks it against the same comparability rules
 * `compare.mjs` uses, and stops before the first provider call.
 *
 * The archive it leaves behind is marked `dryRun: true` and its summary says
 * `validBaseline: false`, so neither the verifier nor the comparison can ever
 * mistake it for a measurement.
 */
const dryRun = values['dry-run'] === true;
assert(values.out, '--out is required');
assert(dryRun || values['base-url'], '--base-url is required unless --dry-run');
const apiKey = process.env.P20_BASELINE_API_KEY ?? (dryRun ? 'dry-run-no-key' : undefined);
assert(apiKey, 'Set P20_BASELINE_API_KEY; credentials are never CLI arguments or artifacts');
delete process.env.P20_BASELINE_API_KEY;
const out = resolve(values.out);
const work = resolve(values.work);
const cases = suite.cases.filter((item) => !values.case || item.id === values.case);
assert(cases.length, 'Unknown case');
assert(!existsSync(out), 'Output directory already exists; use a new run directory');
assert(!existsSync(work), 'Workspace is in use; do not share a writer or overwrite a previous run');

const hash = (value) => createHash('sha256').update(value).digest('hex');
const encode = (value) => `${JSON.stringify(value, null, 2).replaceAll(apiKey, '[REDACTED]')}\n`;
const save = (path, value) => writeFileSync(path, encode(value));

// pi-ai must come from the runtime subpackage's own `node_modules`, not from
// whatever the repo root happens to have installed: the version under test is
// the one `src/runtime/package.json` pins, and the manifest reports it. The
// package publishes an `import`-only exports map, so `require.resolve` cannot
// see it; the file path is read out of that map rather than guessed.
const runtimeModules = join(repo, 'src/runtime/node_modules');
const load = async (name, subpath = '.') => {
  const manifestPath = join(runtimeModules, name, 'package.json');
  const exported = JSON.parse(readFileSync(manifestPath, 'utf8')).exports;
  const entry =
    exported[subpath]?.import ??
    Object.entries(exported)
      .filter(([pattern]) => pattern.includes('*'))
      .map(([pattern, target]) => {
        const [prefix, suffix] = pattern.split('*');
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return undefined;
        return target.import.replace(
          '*',
          subpath.slice(prefix.length, subpath.length - suffix.length || undefined)
        );
      })
      .find(Boolean);
  assert(entry, `No import entry for ${name}${subpath === '.' ? '' : `/${subpath}`}`);
  return await import(pathToFileURL(join(runtimeModules, name, entry)).href);
};
const packageVersion = (name) =>
  JSON.parse(readFileSync(join(runtimeModules, name, 'package.json'), 'utf8')).version;

const PROVIDER_ID = 'p2-baseline';
const allUsage = [];
const results = [];
mkdirSync(out, { recursive: true });
mkdirSync(work, { mode: 0o700 });

/** Every runtime source file, so a later reader can tell what actually ran. */
const runtimeSources = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '__tests__', 'spikes', 'smoke'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|mjs)$/.test(entry.name)) runtimeSources.push(relative(repo, full));
  }
};
walk(join(repo, 'src/runtime'));

const manifest = {
  schemaVersion: 1,
  suiteVersion: suite.version,
  suiteSha256: hash(encode(suite)),
  backend: 'native',
  entry: 'createRuntime',
  startedAt: new Date().toISOString(),
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  gitStatus: execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' }),
  nodeVersion: process.version,
  dependencies: Object.fromEntries(
    ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', 'cordis'].map((name) => [
      name,
      packageVersion(name),
    ])
  ),
  baseUrl: values['base-url'] ?? 'dry-run://no-gateway',
  provider: PROVIDER_ID,
  /**
   * The runtime behaviour generation this collection was taken on, same value
   * every trace carries. `compare.mjs` refuses two archives from different
   * generations: a prompt, tool, compaction or permission change makes the two
   * runs different work rather than the same work measured twice (core-host-02).
   */
  configVersion: RUNTIME_CONFIG_VERSION,
  model: suite.model,
  settings: suite.settings,
  /**
   * Where this backend cannot honour a baseline setting. Stated as data, not
   * prose, because `compare.mjs` refuses to report a comparison whose
   * deviations were never declared.
   */
  settingDeviations: {
    'compaction.reserveTokens':
      'derived from the model window (COMPACTION_RESERVE_FLOOR_TOKENS); not configurable',
    'compaction.keepRecentTokens':
      'derived from the model window (COMPACTION_KEEP_RECENT_RATIO); not configurable',
    'compaction.enabled':
      'kept ON so B05 can force a real compaction; automatic compaction cannot trigger at this context size',
    'retry.enabled':
      'the native loop has its own provider retry; a retried request that never reaches turn_end contributes no usage row',
  },
  work,
  caseOrder: cases.map((item) => item.id),
  pricing: null,
  pricingNote: 'No trusted prices supplied; raw zero prices are placeholders.',
  cachePolicy:
    'Gateway default; no explicit warmup, no cold-cache guarantee; all first turns included',
  formula: 'sum(cacheRead) / (sum(input) + sum(cacheRead)); compaction usage separate',
  ...(dryRun ? { dryRun: true } : {}),
  files: {},
};
for (const name of [
  ...runtimeSources,
  'src/shared/piUsage.ts',
  'src/shared/piTurnRollup.ts',
  ...['run-native.mjs', 'suite.mjs', 'metrics.mjs'].map(
    (name) => `scripts/runtime-baseline/${name}`
  ),
]) {
  manifest.files[name] = hash(readFileSync(join(repo, name)));
}
save(join(out, 'manifest.json'), manifest);
save(join(out, 'suite.json'), suite);

if (dryRun) {
  save(join(out, 'summary.json'), {
    schemaVersion: 1,
    validBaseline: false,
    dryRun: true,
    backend: 'native',
    suiteVersion: suite.version,
    completedAt: new Date().toISOString(),
    results: [],
    pricing: null,
    usage: null,
    compactionUsage: null,
    note: 'Dry run: plumbing only, no gateway and no model calls. Not a measurement.',
  });
  const skeleton = readArchive(out);
  const shape = archiveSkeletonFailures(skeleton);
  assert.deepEqual(shape, [], `Archive skeleton is incomplete: ${shape.join('; ')}`);
  // The other half of the same claim: this directory must be UNUSABLE as a
  // comparison side. If compare.mjs ever accepted it, a dry run would look like
  // a result.
  const { failures } = comparabilityReport(skeleton, skeleton);
  assert(failures.length > 0, 'compare.mjs would accept a dry-run archive as a measurement');
  rmSync(work, { recursive: true, force: true });
  console.log(
    [
      `[dry-run] archive skeleton written to ${out}`,
      `[dry-run] suite ${suite.version} · ${cases.length} case(s): ${cases.map((item) => item.id).join(', ')}`,
      `[dry-run] generation ${RUNTIME_CONFIG_VERSION} · model ${suite.model.id} · work ${work} (prepared, then removed)`,
      `[dry-run] manifest hashes ${Object.keys(manifest.files).length} source files`,
      `[dry-run] refused as a comparison side, as it must be: ${failures[0]}`,
      '[dry-run] stopped before the first provider call; no gateway was contacted',
    ].join('\n')
  );
  process.exit(0);
}

const { createProvider } = await load('@earendil-works/pi-ai');
const { anthropicMessagesApi } = await load(
  '@earendil-works/pi-ai',
  './api/anthropic-messages.lazy'
);

async function runCase(testCase) {
  const caseOut = join(out, testCase.id);
  const cwd = join(work, testCase.id);
  const agentDir = join(work, `${testCase.id}-agent`);
  const sessionFile = join(caseOut, 'sessions', `${testCase.id}.jsonl`);
  mkdirSync(caseOut);
  mkdirSync(join(caseOut, 'sessions'), { recursive: true });
  mkdirSync(cwd);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(cwd, 'AGENTS.md'),
    'This is an isolated fixed benchmark. Follow the requested tool calls exactly. Keep answers short. Do not read outside this workspace or call extra tools.\n'
  );
  for (const [file, content] of Object.entries(testCase.files))
    writeFileSync(join(cwd, file), content);
  cpSync(cwd, join(caseOut, 'initial-workspace'), { recursive: true });

  let currentStep;
  let stepIndex = -1;
  let toolIndex = 0;
  let handle;
  const records = [];
  const violations = [];
  const counts = { turn: 0, compaction: 0 };
  const assertions = [];
  const trace = (event) =>
    appendFileSync(
      join(caseOut, 'trace.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), stepIndex, ...event }).replaceAll(
        apiKey,
        '[REDACTED]'
      )}\n`
    );
  const recordUsage = (source, usage) => {
    const row = {
      caseId: testCase.id,
      source,
      ordinal: ++counts[source],
      stepIndex,
      at: new Date().toISOString(),
      usage,
    };
    records.push(row);
    allUsage.push(row);
    appendFileSync(join(caseOut, 'usage.jsonl'), `${JSON.stringify(row)}\n`);
  };

  // The legacy harness archived request bodies through the SDK's
  // `before_provider_request` hook. This runtime has no such hook, so the
  // equivalent evidence is captured one layer lower: pi-ai hands the adapter
  // the exact `Context` it is about to serialize.
  const base = anthropicMessagesApi();
  const recordRequest = (kind, model, context) =>
    trace({
      type: 'provider_request',
      payload: {
        kind,
        model: model.id,
        provider: model.provider,
        systemPromptSha256: hash(context.systemPrompt ?? ''),
        systemPromptBytes: Buffer.byteLength(context.systemPrompt ?? ''),
        toolNames: (context.tools ?? []).map((tool) => tool.name),
        messageCount: context.messages.length,
        context,
      },
    });
  const api = {
    stream: (model, context, options) => {
      recordRequest('stream', model, context);
      return base.stream(model, context, options);
    },
    streamSimple: (model, context, options) => {
      recordRequest('streamSimple', model, context);
      return base.streamSimple(model, context, options);
    },
    ...(base.fetchDeferred ? { fetchDeferred: base.fetchDeferred.bind(base) } : {}),
    ...(base.cancelDeferred ? { cancelDeferred: base.cancelDeferred.bind(base) } : {}),
  };
  const provider = createProvider({
    id: PROVIDER_ID,
    name: PROVIDER_ID,
    baseUrl: values['base-url'],
    auth: {
      apiKey: {
        name: `${PROVIDER_ID} API key`,
        resolve: async () => ({ auth: { apiKey } }),
      },
    },
    models: [
      {
        ...suite.model,
        name: suite.model.id,
        provider: PROVIDER_ID,
        baseUrl: values['base-url'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    api,
  });

  const onEvent = (event) => {
    if (
      [
        'turn_end',
        'tool_execution_start',
        'tool_execution_end',
        'compaction_start',
        'compaction_end',
      ].includes(event.type)
    )
      trace({ type: 'sdk_event', event });
    if (event.type === 'tool_execution_start') {
      try {
        assertToolCall(
          { toolName: event.toolName, input: event.args },
          currentStep?.tools?.[toolIndex],
          cwd
        );
        toolIndex++;
      } catch (error) {
        violations.push(error.message);
      }
    }
    if (event.type === 'turn_end' && event.message.role === 'assistant') {
      recordUsage('turn', event.message.usage);
      if (['error', 'aborted', 'length'].includes(event.message.stopReason))
        violations.push(`Provider stop: ${event.message.stopReason}`);
    }
    if (event.type === 'tool_execution_end' && event.isError)
      violations.push(`Tool failed: ${event.toolName}`);
  };

  const createHandle = async (mode) => {
    handle = await createRuntime({
      // The real process environment, not an empty one: `commandEnvironment`
      // derives the shell's PATH from `childEnv`, so an empty host makes every
      // `bash` step fail with "command not found" — which is a property of the
      // harness, not of the runtime. The test key was deleted from this
      // environment at startup, so nothing secret rides along.
      host: standaloneHost(process.env),
      providers: [provider],
      agentDir,
      traceDir: join(caseOut, 'runtime-trace'),
      tools: { cwd, shellPath: resolveWorkerShell(process.env), recordFileChanges: false },
      permissions: {
        mode: 'agent',
        gear: 'ask',
        projectTrusted: false,
        approve: async (request) => {
          trace({ type: 'permission', payload: { tool: request.toolName, mode: 'approve' } });
          const expected = currentStep?.tools?.length > 0;
          if (!expected) violations.push(`Unexpected approval request: ${request.toolName}`);
          return expected ? 'allow-once' : 'deny';
        },
      },
      context: { enabled: true },
      session: { file: sessionFile, cwd, mode },
      loop: { singleTurn: false, defaultThinkingLevel: 'off' },
    });
    const tools = handle.ctx.runtimeTools.list();
    for (const step of testCase.steps) {
      for (const expected of step.tools ?? []) {
        const tool = tools.find((item) => item.name === expected.name);
        assert(tool, `Missing tool ${expected.name}`);
        for (const key of Object.keys(expected.args)) {
          assert(
            key in tool.parameters.properties,
            `Suite parameter absent from runtime tool: ${expected.name}.${key}`
          );
        }
      }
    }
    trace({
      type: 'bootstrap',
      sessionId: handle.session.metadata().id,
      sessionFile: handle.session.file,
      mode,
      systemPrompt: (await handle.prompt.compose()).text,
      tools: tools.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
      versionStamp: handle.trace.runs.at(-1)?.version_stamp ?? null,
    });
  };

  const started = Date.now();
  let timer;
  try {
    await createHandle('create');
    for (const step of testCase.steps) {
      stepIndex++;
      currentStep = step;
      toolIndex = 0;
      trace({ type: 'step_start', step });
      console.log(`${testCase.id} ${stepIndex + 1}/${testCase.steps.length} ${step.action}`);
      const operation = async () => {
        if (step.action === 'prompt') {
          const before = counts.turn;
          const result = await handle.run({ prompt: step.text, thinkingLevel: 'off', onEvent });
          assert(counts.turn > before, 'Missing turn_end usage');
          assert.equal(toolIndex, step.tools.length, 'Expected tool was not called');
          assert(result.success, `Run failed: ${result.error?.message ?? 'unknown'}`);
          for (const marker of step.contains)
            assert(result.text.includes(marker), `Missing response marker ${marker}`);
          assert.equal(result.stopReason, 'stop', 'Final response did not finish normally');
        } else if (step.action === 'compact') {
          // What `/compact` does in the product (`worker/nativeWorkerRuntime.ts`):
          // force the boundary now instead of recording an intent for the next
          // turn, restoring the persisted checkpoint identity first.
          await handle.session.flush();
          const snapshot = handle.session.snapshot();
          const resolved = handle.model.resolve({ provider: PROVIDER_ID, id: suite.model.id });
          handle.context.beginRun(snapshot);
          const prepared = await handle.context.prepareTurn({
            messages: snapshot.messages,
            model: resolved.model,
            models: resolved.models,
            retention: 'completed_turn',
            force: true,
            instructions: step.instructions,
          });
          assert(prepared.compaction, `Compaction did not run: ${prepared.skipped?.message ?? ''}`);
          assert(prepared.compaction.summaryBytes > 0, 'Empty compaction summary');
          if (prepared.compaction.usage) recordUsage('compaction', prepared.compaction.usage);
          trace({ type: 'compaction_result', payload: prepared.compaction });
          await handle.session.flush();
          assert(
            handle.session.snapshot().entries.some((entry) => entry.type === 'compaction'),
            'No durable compaction entry'
          );
        } else {
          const previous = handle.session.metadata();
          const messages = hash(JSON.stringify(handle.session.snapshot().messages));
          const calls = counts.turn;
          await handle.dispose();
          await createHandle('resume');
          const current = handle.session.metadata();
          assert.equal(current.id, previous.id);
          assert.equal(current.file, previous.file);
          assert.equal(hash(JSON.stringify(handle.session.snapshot().messages)), messages);
          assert.equal(counts.turn, calls, 'Resume replayed usage');
          trace({
            type: 'resume_verified',
            id: current.id,
            sessionFile: current.file,
            messagesSha256: messages,
            calls,
          });
        }
      };
      await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Step timeout after 180s')), 180000);
        }),
      ]);
      clearTimeout(timer);
      assert.deepEqual(violations, []);
      assertions.push({ stepIndex, action: step.action, passed: true });
      trace({ type: 'step_passed' });
    }
    for (const [name, original] of Object.entries(testCase.files)) {
      assert.equal(
        readFileSync(join(cwd, name), 'utf8'),
        testCase.finalFiles?.[name] ?? original,
        `Unexpected final file ${name}`
      );
    }
    assert.deepEqual(
      readdirSync(cwd).sort(),
      ['AGENTS.md', ...Object.keys(testCase.files)].sort(),
      'Unexpected workspace files'
    );
    if (testCase.id === 'B04') {
      const events = readFileSync(join(caseOut, 'trace.jsonl'), 'utf8');
      assert(/truncated; next line=/.test(events), 'Missing large-file truncation evidence');
    }
    const usage = summarizeUsage(records);
    assert(usage.calls > 0 && usage.cacheHitRate !== null);
    const result = {
      caseId: testCase.id,
      name: testCase.name,
      passed: true,
      latencyMs: Date.now() - started,
      assertions,
      usage,
      compactionUsage: summarizeUsage(records, 'compaction'),
      toolCalls: testCase.steps.reduce((n, step) => n + (step.tools?.length ?? 0), 0),
    };
    save(join(caseOut, 'result.json'), result);
    return result;
  } catch (error) {
    const result = {
      caseId: testCase.id,
      name: testCase.name,
      passed: false,
      latencyMs: Date.now() - started,
      assertions,
      error: error.message.replaceAll(apiKey, '[REDACTED]'),
      violations,
    };
    save(join(caseOut, 'result.json'), result);
    return result;
  } finally {
    clearTimeout(timer);
    if (handle) await handle.dispose().catch(() => {});
    if (existsSync(cwd)) cpSync(cwd, join(caseOut, 'final-workspace'), { recursive: true });
  }
}

try {
  for (const testCase of cases) {
    const result = await runCase(testCase);
    results.push(result);
    console.log(JSON.stringify(result));
    if (!result.passed) break;
  }
} finally {
  const complete =
    results.length === suite.cases.length && results.every((result) => result.passed);
  const summary = {
    schemaVersion: 1,
    validBaseline: complete,
    backend: 'native',
    suiteVersion: suite.version,
    completedAt: new Date().toISOString(),
    results,
    pricing: null,
    usage: complete ? summarizeUsage(allUsage) : null,
    compactionUsage: complete ? summarizeUsage(allUsage, 'compaction') : null,
  };
  save(join(out, 'summary.json'), summary);
  const percent = (value) => (value === null ? '不可测' : `${(value * 100).toFixed(2)}%`);
  writeFileSync(
    join(out, 'report.md'),
    `# P2-5 自有 runtime 采集\n\n有效完整结果：${complete ? '是' : '否'}。模型：${suite.model.id}。费用：未知。\n\n| 场景 | 成功 | 模型调用 | input | cacheRead | cacheWrite | 命中率 |\n|---|---|---|---|---|---|---|\n` +
      results
        .map(
          (item) =>
            `| ${item.caseId} ${item.name} | ${item.passed} | ${item.usage?.calls ?? '—'} | ${item.usage?.input ?? '—'} | ${item.usage?.cacheRead ?? '—'} | ${item.usage?.cacheWrite ?? '—'} | ${percent(item.usage?.cacheHitRate ?? null)} |`
        )
        .join('\n') +
      `\n\n整体 token 加权命中率：${percent(summary.usage?.cacheHitRate ?? null)}。压缩摘要 usage 独立保存在 summary.json；不计入 D9 门禁分母。\n`
  );
  rmSync(work, { recursive: true, force: true });
  if (!complete) process.exitCode = 1;
}
