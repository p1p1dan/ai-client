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
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveBundledFeaturePlugins } from '../../src/agent-host/bundledFeaturePlugins.ts';
import { createPortableExtensionUiBridge } from '../../src/agent-host/extensionUiBridge.ts';
import { decidePermissionPlugin } from '../../src/agent-host/permissionPlugin.ts';
import { bootstrapPiAgentSession } from '../../src/agent-host/piAgentSessionBootstrap.ts';
import { assertToolCall, summarizeUsage } from './metrics.mjs';
import { suite } from './suite.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: {
    'sdk-host': { type: 'string', default: join(repo, 'src/agent-host') },
    'base-url': { type: 'string' },
    out: { type: 'string' },
    work: { type: 'string', default: '/tmp/aiclient-p2-0-work' },
    case: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'P20_BASELINE_API_KEY=<secret> node scripts/runtime-baseline/run.mjs --base-url URL --out NEW_DIR [--sdk-host src/agent-host] [--case B01] [--work /tmp/aiclient-p2-0-work]'
  );
  process.exit(0);
}
assert(values.out && values['base-url'], '--out and --base-url are required');
const apiKey = process.env.P20_BASELINE_API_KEY;
assert(apiKey, 'Set P20_BASELINE_API_KEY; credentials are never CLI arguments or artifacts');
delete process.env.P20_BASELINE_API_KEY;
const sdkHost = resolve(values['sdk-host']);
const out = resolve(values.out);
const work = resolve(values.work);
const cases = suite.cases.filter((item) => !values.case || item.id === values.case);
assert(cases.length, 'Unknown case');
assert(!existsSync(out), 'Output directory already exists; use a new run directory');
assert(!existsSync(work), 'Workspace is in use; do not share a writer or overwrite a previous run');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const encode = (value) => `${JSON.stringify(value, null, 2).replaceAll(apiKey, '[REDACTED]')}\n`;
const save = (path, value) => writeFileSync(path, encode(value));
const sdkRoot = join(sdkHost, 'node_modules/@earendil-works/pi-coding-agent');
const sdkEntry = join(sdkRoot, 'dist/index.js');
const packageVersion = (name) => {
  const folder = createRequire(sdkEntry)
    .resolve.paths(name)
    .map((base) => join(base, name))
    .find((candidate) => existsSync(join(candidate, 'package.json')));
  assert(folder, `Missing installed package ${name}`);
  return JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).version;
};
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const allUsage = [];
const results = [];
mkdirSync(out, { recursive: true });
mkdirSync(work, { mode: 0o700 });
process.env.PI_CODING_AGENT_DIR = join(work, 'bootstrap-agent');
const manifest = {
  schemaVersion: 1,
  suiteVersion: suite.version,
  suiteSha256: hash(encode(suite)),
  backend: 'legacy',
  entry: 'bootstrapPiAgentSession',
  startedAt: new Date().toISOString(),
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  gitStatus: execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' }),
  nodeVersion: process.version,
  sdkHost,
  dependencies: Object.fromEntries(
    [
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
    ].map((name) => [name, packageVersion(name)])
  ),
  baseUrl: values['base-url'],
  provider: 'p2-baseline',
  model: suite.model,
  settings: suite.settings,
  work,
  caseOrder: cases.map((item) => item.id),
  pricing: null,
  pricingNote: 'No trusted prices supplied; raw SDK zero prices are placeholders.',
  cachePolicy: 'SDK default; no explicit warmup, no cold-cache guarantee; all first turns included',
  formula: 'sum(cacheRead) / (sum(input) + sum(cacheRead)); compaction usage separate',
  files: {},
};
for (const name of [
  ...readdirSync(join(repo, 'src/agent-host'))
    .filter((name) => /\.(ts|mjs)$/.test(name))
    .map((name) => `src/agent-host/${name}`),
  'src/shared/piUsage.ts',
  'src/shared/piTurnRollup.ts',
  ...['run.mjs', 'suite.mjs', 'metrics.mjs'].map((name) => `scripts/runtime-baseline/${name}`),
]) {
  manifest.files[name] = hash(readFileSync(join(repo, name)));
}
save(join(out, 'manifest.json'), manifest);
save(join(out, 'suite.json'), suite);

async function runCase(sdk, AuthStorage, testCase) {
  const caseOut = join(out, testCase.id);
  const cwd = join(work, testCase.id);
  const agentDir = join(work, `${testCase.id}-agent`);
  mkdirSync(caseOut);
  mkdirSync(cwd);
  mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
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
  let bridge;
  let unsubscribe;
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
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    modelsStorePath: join(agentDir, 'models-store.json'),
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('p2-baseline', {
    baseUrl: values['base-url'],
    api: suite.model.api,
    models: [
      {
        ...suite.model,
        name: suite.model.id,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey('p2-baseline', apiKey);
  const createRuntime = async (sessionFile) => {
    bridge = createPortableExtensionUiBridge({
      onRequest(request) {
        trace({ type: 'extension_ui', request });
        if (['select', 'confirm', 'input', 'editor'].includes(request.method)) {
          const approved =
            request.method === 'select' &&
            request.args.options.includes('Yes') &&
            currentStep?.tools?.length > 0;
          if (!approved) violations.push('Unexpected extension dialog');
          queueMicrotask(() =>
            bridge.respond({
              runtimeId: request.runtimeId,
              uiRequestId: request.uiRequestId,
              ok: approved,
              value: approved ? 'Yes' : undefined,
            })
          );
        }
      },
    });
    const facade = {
      ...sdk,
      getAgentDir: () => agentDir,
      SettingsManager: {
        create: () => sdk.SettingsManager.inMemory(suite.settings, { projectTrusted: false }),
      },
      SessionManager: {
        create: (sessionCwd) => sdk.SessionManager.create(sessionCwd, join(caseOut, 'sessions')),
        open: (file) => sdk.SessionManager.open(file),
      },
      createAgentSessionServices: (options) =>
        sdk.createAgentSessionServices({
          ...options,
          modelRuntime,
          resourceLoaderOptions: {
            ...options.resourceLoaderOptions,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
          },
        }),
    };
    const boot = await bootstrapPiAgentSession({
      sdk: facade,
      cwd,
      projectTrusted: false,
      extensionUi: bridge,
      sessionFile,
      model: `p2-baseline/${suite.model.id}`,
      effort: 'off',
      decidePermissionGate: (packages) => decidePermissionPlugin(packages, sdkHost),
      resolveFeaturePlugins: (packages, _base, options) =>
        resolveBundledFeaturePlugins(packages, sdkHost, options),
      onPermissionActivity: (payload) => trace({ type: 'permission', payload }),
      log: (...args) => trace({ type: 'log', args }),
      additionalExtensionFactories: [
        {
          name: 'p2-baseline-observer',
          hidden: true,
          factory(pi) {
            pi.on('before_provider_request', (event) => {
              trace({ type: 'provider_request', payload: event.payload });
            });
            pi.on('after_provider_response', (event) => {
              trace({ type: 'provider_response', status: event.status });
            });
            pi.on('tool_call', (event) => {
              try {
                assertToolCall(event, currentStep?.tools?.[toolIndex], cwd);
                toolIndex++;
              } catch (error) {
                violations.push(error.message);
                queueMicrotask(() => {
                  void handle.session.abort();
                });
                return { block: true, reason: error.message };
              }
            });
          },
        },
      ],
    });
    handle = boot.handle;
    for (const step of testCase.steps) {
      for (const expected of step.tools ?? []) {
        const tool = handle.session.getAllTools().find((item) => item.name === expected.name);
        assert(tool, `Missing tool ${expected.name}`);
        for (const key of Object.keys(expected.args)) {
          assert(
            key in tool.parameters.properties,
            `Suite parameter absent from SDK: ${expected.name}.${key}`
          );
        }
      }
    }
    trace({
      type: 'bootstrap',
      sessionId: handle.session.sessionId,
      sessionFile: handle.session.sessionFile,
      extensions: boot.extensions,
      systemPrompt: handle.session.systemPrompt,
      tools: handle.session.getAllTools(),
    });
    unsubscribe = handle.session.subscribe((event) => {
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
      if (event.type === 'turn_end') {
        recordUsage('turn', event.message.usage);
        if (['error', 'aborted', 'length'].includes(event.message.stopReason))
          violations.push(`Provider stop: ${event.message.stopReason}`);
      }
      if (event.type === 'tool_execution_end' && event.isError)
        violations.push(`Tool failed: ${event.toolName}`);
    });
  };
  const started = Date.now();
  let timer;
  try {
    await createRuntime();
    for (const step of testCase.steps) {
      stepIndex++;
      currentStep = step;
      toolIndex = 0;
      trace({ type: 'step_start', step });
      console.log(`${testCase.id} ${stepIndex + 1}/${testCase.steps.length} ${step.action}`);
      const operation = async () => {
        if (step.action === 'prompt') {
          const before = counts.turn;
          await handle.session.prompt(step.text);
          assert(counts.turn > before, 'Missing turn_end usage');
          assert.equal(toolIndex, step.tools.length, 'Expected tool was not called');
          const last = handle.session.agent.state.messages.at(-1);
          assert.equal(last.role, 'assistant');
          const answer = last.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          for (const marker of step.contains)
            assert(answer.includes(marker), `Missing response marker ${marker}`);
          assert.equal(last.stopReason, 'stop', 'Final response did not finish normally');
        } else if (step.action === 'compact') {
          const compacted = await handle.session.compact(step.instructions);
          recordUsage('compaction', compacted.usage);
          assert(compacted.summary.trim(), 'Empty compaction summary');
          assert(
            handle.session.sessionManager.getEntries().some((entry) => entry.type === 'compaction')
          );
        } else {
          const previous = handle.session;
          const sessionFile = previous.sessionFile;
          const id = previous.sessionId;
          const messages = hash(JSON.stringify(previous.agent.state.messages));
          const calls = counts.turn;
          unsubscribe();
          await handle.dispose();
          bridge.dispose();
          await createRuntime(sessionFile);
          assert.equal(handle.session.sessionId, id);
          assert.equal(handle.session.sessionFile, sessionFile);
          assert.equal(hash(JSON.stringify(handle.session.agent.state.messages)), messages);
          assert.equal(counts.turn, calls, 'Resume replayed usage');
          trace({ type: 'resume_verified', id, sessionFile, messagesSha256: messages, calls });
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
      assert(
        /truncated|Showing lines|KB limit/.test(events),
        'Missing large-file truncation evidence'
      );
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
    if (handle) {
      handle.session.abortCompaction();
      bridge.cancelAll('aborted');
      await handle.session.abort();
      unsubscribe();
      await handle.dispose();
      bridge.dispose();
    }
    cpSync(cwd, join(caseOut, 'final-workspace'), { recursive: true });
  }
}

try {
  const sdk = await import(pathToFileURL(sdkEntry).href);
  const { AuthStorage } = await import(
    pathToFileURL(join(sdkRoot, 'dist/core/auth-storage.js')).href
  );
  for (const testCase of cases) {
    const result = await runCase(sdk, AuthStorage, testCase);
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
    `# P2-0 旧后端采集\n\n有效完整基线：${complete ? '是' : '否'}。模型：${suite.model.id}。费用：未知。\n\n| 场景 | 成功 | 模型调用 | input | cacheRead | cacheWrite | 命中率 |\n|---|---|---|---|---|---|---|\n` +
      results
        .map(
          (item) =>
            `| ${item.caseId} ${item.name} | ${item.passed} | ${item.usage?.calls ?? '—'} | ${item.usage?.input ?? '—'} | ${item.usage?.cacheRead ?? '—'} | ${item.usage?.cacheWrite ?? '—'} | ${percent(item.usage?.cacheHitRate ?? null)} |`
        )
        .join('\n') +
      `\n\n整体 token 加权命中率：${percent(summary.usage?.cacheHitRate ?? null)}。压缩摘要 usage 独立保存在 summary.json；不计入 D9 门禁分母。\n`
  );
  rmSync(work, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (!complete) process.exitCode = 1;
}
