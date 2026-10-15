// Captures the exact model requests PiLab's DSH host sends, without a real
// model: one real host from this source checkout, the local fake gateway with
// --capture, a Claude route (anthropic-messages) and a GLM route
// (openai-completions) built from the bundled catalog, one turn on each.
// The captured bodies hold full request content and stay in the scratch
// directory under the OS temp dir; summarize them with compare-captures.mjs.
//
// Prerequisite: `npm ci --ignore-scripts` in src/dsh-host. Run with Node 24:
//   node capture-pilab-request.ts [--effort high]
//
// Every model request goes to the fake gateway on 127.0.0.1; the probe hooks
// drop any non-loopback connect from the host.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../../..');
const src = (path: string) => pathToFileURL(join(REPO, 'src', path)).href;
const eh = await import(src('dsh-host/tools/lib/experiment-host.ts'));
const kit = await import(src('dsh-host/tools/lib/kit.ts'));
const { buildDshModelPlan } = await import(src('shared/dshModelPlan/build.ts'));

const effortFlag = process.argv.indexOf('--effort');
const effort = effortFlag >= 0 ? process.argv[effortFlag + 1] : undefined;

const scratch = join(os.tmpdir(), `pilab-capture-${Date.now()}`);
mkdirSync(scratch, { recursive: true });
const box = kit.sandbox(scratch, 'run');
const capture = join(scratch, 'capture');
const gateway = await eh.startFakeGateway(
  process.execPath,
  join(REPO, 'src/dsh-host/tools/fake-gateway.mjs'),
  scratch,
  { capture }
);

const snap = JSON.parse(readFileSync(join(REPO, 'resources/model-catalog/snapshot.json'), 'utf8'));
const claudeModels = [...snap.providers.claude.models];
const opus5 = claudeModels.find((m: { id: string }) => m.id === 'claude-opus-5');
if (opus5) claudeModels.push({ ...opus5, id: 'claude-opus-5-5', name: 'Claude Opus 5.5' });
const base = `http://127.0.0.1:${gateway.port}`;
const plan = buildDshModelPlan({
  models: {
    providers: {
      claude: {
        baseUrl: base,
        api: 'anthropic-messages',
        compat: snap.providers.claude.compat,
        models: claudeModels,
      },
      china: {
        baseUrl: `${base}/v1`,
        api: 'openai-completions',
        compat: snap.providers.china.compat,
        models: snap.providers.china.models,
      },
    },
  },
  keyed: { claude: true, china: true },
  clientVersion: '1.1.1-test.1',
});

// A small git workspace with a project instruction file, like the Claude Code capture.
const ws = join(box.workspace, 'proj');
mkdirSync(join(ws, 'src'), { recursive: true });
writeFileSync(join(ws, 'CLAUDE.md'), '# Project rules\n\nUse TypeScript strict mode.\n');
writeFileSync(join(ws, 'src', 'index.ts'), 'export const x = 1;\n');

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
  ...pass('ProgramFiles(x86)'),
  ...pass('ProgramW6432'),
  ...pass('ProgramData'),
};
// The product composition, not the test-only probe bundle.
delete env.AICLIENT_DSH_PROBE_BUNDLE;
mkdirSync(env.APPDATA, { recursive: true });
mkdirSync(env.LOCALAPPDATA, { recursive: true });

const host = eh.startExperimentHost({
  label: 'capture',
  nodeBin: process.execPath,
  nodeArgs: ['--import', src('dsh-host/tools/lib/probe-hooks.mjs')],
  entry: join(REPO, 'src/dsh-host/host.ts'),
  cwd: ws,
  env,
  plan,
  key: 'capture-fake-key',
});
const ready = await eh.readyOrFatal(host);
if (ready?.type !== 'ready') {
  console.error(`host did not start: ${String(ready?.message ?? 'no ready in time')}`);
  console.error(host.stderr().slice(-4000));
  process.exit(1);
}

async function turn(sessionId: string, model: string, text: string) {
  const session = await eh.openSession(host, { logicalSessionId: sessionId, cwd: ws });
  const from = host.client.events(session.ch).length;
  const requestId = `${sessionId}-t1`;
  await host.client.request(session.ch, 'worker.send', {
    logicalSessionId: sessionId,
    requestId,
    attemptId: `${requestId}-a`,
    text,
    model,
    ...(effort ? { effort } : {}),
  });
  const idle = await eh.waitIdle(host, session, requestId, from, 120_000);
  console.log(`${sessionId}: ${model}, effort ${effort ?? '(default)'}, idle ${idle}`);
}

await turn('cap-claude', 'claude/claude-opus-5-5', 'P0-TOOL: list the workspace.');
await turn('cap-glm', 'china/glm-5.2', 'Please list the workspace files.');

await eh.stopExperimentHost(host);
await eh.stopFakeGateway(gateway);
writeFileSync(join(scratch, 'host-stderr.txt'), host.stderr());
console.log(`captures: ${capture}`);
