// T1, PiLab side: sends one tiny prompt per fresh session through a REAL
// gateway with PiLab's own request shape (a source-checkout DSH host, the
// bundled Claude route compat), and reports what the gateway billed for each
// request next to what PiLab itself sent. No local account is used: the URL
// and key come only from the environment of this process and are not written
// anywhere.
//
//   T1_BASE_URL=<gateway root, no /v1> T1_API_KEY=<key> \
//   node t1-pilab-real-gateway.ts [--runs 10] [--model claude-opus-5-5] [--effort low]
//
// Output: one JSON line per run, then a summary. Prompt text is never printed.

import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLog } from './readlog.mjs';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../../..');
const src = (path: string) => pathToFileURL(join(REPO, 'src', path)).href;
const eh = await import(src('dsh-host/tools/lib/experiment-host.ts'));
const kit = await import(src('dsh-host/tools/lib/kit.ts'));
const { buildDshModelPlan } = await import(src('shared/dshModelPlan/build.ts'));

const arg = (flag: string, fallback: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const runs = Number(arg('--runs', '10'));
const model = arg('--model', 'claude-opus-5-5');
const effort = arg('--effort', 'low');
// `--text` swaps the prompt (e.g. ask which tools the model sees); `--show-reply`
// prints the model's answer, which is model output, not prompt text.
const text = arg('--text', 'Reply with exactly: OK');
const showReply = process.argv.includes('--show-reply');
const baseUrl = process.env.T1_BASE_URL;
const apiKey = process.env.T1_API_KEY;
if (!baseUrl || !apiKey) {
  console.error('set T1_BASE_URL and T1_API_KEY');
  process.exit(2);
}

const scratch = join(os.tmpdir(), `t1-pilab-${Date.now()}`);
mkdirSync(scratch, { recursive: true });
const box = kit.sandbox(scratch, 'run');
const ws = join(box.workspace, 'proj');
mkdirSync(ws, { recursive: true });

const plan = buildDshModelPlan({
  models: {
    providers: {
      claude: {
        baseUrl,
        api: 'anthropic-messages',
        compat: { forceAdaptiveThinking: true, supportsToolReferences: false },
        models: [
          {
            id: model,
            name: model,
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            thinkingLevelMap: {
              low: 'low',
              medium: 'medium',
              high: 'high',
              xhigh: 'xhigh',
              max: 'max',
            },
          },
        ],
      },
    },
  },
  keyed: { claude: true },
  clientVersion: '1.1.1-test.1',
});

const pass = (name: string) => (process.env[name] ? { [name]: process.env[name] as string } : {});
const env: Record<string, string> = {
  ...kit.baseEnv(box),
  DSH_HOME: box.dshHome,
  DSH_TELEMETRY_DISABLED: '1',
  USERPROFILE: box.home,
  TEMP: box.tmp,
  TMP: box.tmp,
  APPDATA: join(box.home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(box.home, 'AppData', 'Local'),
  ...pass('SystemRoot'),
  ...pass('SYSTEMROOT'),
  ...pass('windir'),
  ...pass('ComSpec'),
  ...pass('PATHEXT'),
  ...pass('SystemDrive'),
  ...pass('ProgramFiles'),
  ...pass('ProgramData'),
  ...pass('HTTPS_PROXY'),
  ...pass('HTTP_PROXY'),
  ...pass('NO_PROXY'),
};
delete env.AICLIENT_DSH_PROBE_BUNDLE;
delete env.AICLIENT_PROBE_HOOK_LOG;
mkdirSync(env.APPDATA, { recursive: true });
mkdirSync(env.LOCALAPPDATA, { recursive: true });

// No probe hooks here: they drop every non-loopback connection.
const host = eh.startExperimentHost({
  label: 't1',
  nodeBin: process.execPath,
  entry: join(REPO, 'src/dsh-host/host.ts'),
  cwd: ws,
  env,
  plan,
  key: apiKey,
});
const ready = await eh.readyOrFatal(host);
if (ready?.type !== 'ready') {
  console.error(`host did not start: ${String(ready?.message ?? 'no ready in time')}`);
  process.exit(1);
}

function sessionLogs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.jsonl.zstd')) out.push(path);
    }
  };
  walk(join(box.dshHome, 'sessions'));
  return out;
}

const dshSessionIds: string[] = [];
for (let run = 1; run <= runs; run++) {
  const sessionId = `t1-p-${run}`;
  const session = await eh.openSession(host, { logicalSessionId: sessionId, cwd: ws });
  const from = host.client.events(session.ch).length;
  const requestId = `${sessionId}-t1`;
  await host.client.request(session.ch, 'worker.send', {
    logicalSessionId: sessionId,
    requestId,
    attemptId: `${requestId}-a`,
    text,
    model: `claude/${model}`,
    effort,
  });
  await eh.waitIdle(host, session, requestId, from, 180_000);
  dshSessionIds.push(session.dshSessionId);
}

// Session logs are flushed for certain once the host has stopped.
await eh.stopExperimentHost(host);
const rows: Array<Record<string, unknown>> = [];
for (const [index, dshSessionId] of dshSessionIds.entries()) {
  const run = index + 1;
  const log = sessionLogs().find((file) => file.includes(dshSessionId));
  const events = log ? readLog(log) : [];
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const usage = event.data?.usage ?? {};
    const reasoning = (event.data?.message?.content ?? []).filter(
      (b: { type: string }) => b.type === 'reasoning'
    );
    rows.push({
      run,
      billedPrompt:
        (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      input: usage.inputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      output: usage.outputTokens ?? 0,
      reasoningBlocks: reasoning.length,
      reasoningSummaryChars: reasoning.reduce(
        (n: number, b: { text?: string }) => n + (b.text?.length ?? 0),
        0
      ),
    });
    console.log(JSON.stringify(rows.at(-1)));
    if (showReply) {
      const reply = (event.data?.message?.content ?? [])
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('');
      console.log(`--- reply (run ${run}):\n${reply.slice(0, 3000)}`);
    }
  }
}

const billed = rows.map((r) => Number(r.billedPrompt)).sort((a, b) => a - b);
const summary = {
  side: 'pilab',
  model,
  effort,
  runs: rows.length,
  billedPromptMin: billed[0],
  billedPromptMedian: billed[Math.floor(billed.length / 2)],
  billedPromptMax: billed.at(-1),
  emptySummaries: rows.filter(
    (r) => Number(r.reasoningBlocks) > 0 && Number(r.reasoningSummaryChars) === 0
  ).length,
};
console.log(JSON.stringify(summary));
writeFileSync(join(scratch, 't1-pilab.json'), JSON.stringify({ summary, rows }, null, 2));
