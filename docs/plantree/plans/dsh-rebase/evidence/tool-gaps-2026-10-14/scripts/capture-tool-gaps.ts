// Decision 190: what the model is sent with each tool-gap switch, captured
// without a real model. Derived from the quality-gap study's
// capture-pilab-request.ts (branch docs/quality-gap-study): one real host from
// this source checkout, the local fake gateway with --capture, the bundled
// Claude route, and a user-added Anthropic route whose reasoning row declares
// no output limit (decision 190 item 3). One turn on each.
//
// The switches pass through as the app's launch environment would forward
// them: AICLIENT_RUNTIME_WEB_FETCH and AICLIENT_RUNTIME_RICH_GREP reach the
// host; AICLIENT_RUNTIME_PROTOCOL_MAX_TOKENS selects the plan's mode, as Main
// reads it. Prints the request shape only (no prompt text): tool names, the
// grep and web_fetch schemas' parameter names, description and system sizes,
// and each request's max_tokens. The capture files stay under the OS temp dir.
//
// Prerequisite: `npm ci` in src/dsh-host. Run with Node 24 from the repo root:
//   node docs/plantree/plans/dsh-rebase/evidence/tool-gaps-2026-10-14/scripts/capture-tool-gaps.ts
//   AICLIENT_RUNTIME_WEB_FETCH=0 AICLIENT_RUNTIME_RICH_GREP=0 \
//     AICLIENT_RUNTIME_PROTOCOL_MAX_TOKENS=0 node <the same>

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../../..');
const src = (path: string) => pathToFileURL(join(REPO, 'src', path)).href;
const eh = await import(src('dsh-host/tools/lib/experiment-host.ts'));
const kit = await import(src('dsh-host/tools/lib/kit.ts'));
const { buildDshModelPlan, resolveDefaultMaxTokensMode, PROTOCOL_MAX_TOKENS_ENV } = await import(
  src('shared/dshModelPlan/index.ts')
);

const scratch = join(os.tmpdir(), `tool-gaps-capture-${Date.now()}`);
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
const base = `http://127.0.0.1:${gateway.port}`;
const mode = resolveDefaultMaxTokensMode(process.env[PROTOCOL_MAX_TOKENS_ENV]);
const plan = buildDshModelPlan({
  models: {
    providers: {
      claude: {
        baseUrl: base,
        api: 'anthropic-messages',
        compat: snap.providers.claude.compat,
        models: snap.providers.claude.models,
      },
      // A user-added service as the model settings panel writes it: reasoning
      // and adaptive thinking on, no context window, no output limit.
      mine: {
        baseUrl: base,
        api: 'anthropic-messages',
        models: [
          {
            id: 'my-claude',
            reasoning: true,
            compat: { forceAdaptiveThinking: true },
            thinkingLevelMap: { off: null },
          },
        ],
      },
    },
  },
  keyed: { claude: true, mine: true },
  clientVersion: '1.1.1-test.1',
  settings: { defaultMaxTokens: mode },
});

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
  // Decision 190's host switches, forwarded as Main forwards them.
  ...pass('AICLIENT_RUNTIME_WEB_FETCH'),
  ...pass('AICLIENT_RUNTIME_RICH_GREP'),
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
  });
  await eh.waitIdle(host, session, requestId, from, 120_000);
}

await turn('cap-claude', 'claude/claude-opus-5', 'Please list the workspace files.');
await turn('cap-mine', 'mine/my-claude', 'Please list the workspace files.');
await eh.stopExperimentHost(host);
await eh.stopFakeGateway(gateway);

const switchLine = host
  .stderr()
  .split('\n')
  .find((line: string) => line.includes('tool switches:'));
console.log(
  `plan mode: ${mode}; host: ${switchLine?.replace(/^.*\[dsh-host\] /, '') ?? '(no line)'}`
);
const bySeq = (a: string, b: string) => Number.parseInt(a, 10) - Number.parseInt(b, 10);
for (const file of readdirSync(capture).sort(bySeq)) {
  const body = JSON.parse(JSON.parse(readFileSync(join(capture, file), 'utf8')).body);
  const tools: Array<{
    name: string;
    description?: string;
    input_schema?: { properties?: object };
  }> = body.tools ?? [];
  const named = (name: string) => tools.find((tool) => tool.name === name);
  const system = Array.isArray(body.system)
    ? body.system.map((block: { text?: string }) => block.text ?? '').join('')
    : String(body.system ?? '');
  const shape = (name: string) => {
    const tool = named(name);
    return tool
      ? `${tool.description?.length ?? 0} chars; ${Object.keys(tool.input_schema?.properties ?? {}).join(',')}`
      : 'absent';
  };
  console.log(
    [
      `${file}: ${body.model} max_tokens ${body.max_tokens}`,
      `  tools ${tools.length}: ${tools.map((tool) => tool.name).join(',')}`,
      `  grep: ${shape('grep')}`,
      `  web_fetch: ${shape('web_fetch')}`,
      `  system ${system.length} chars; description chars ${tools.reduce((n, tool) => n + (tool.description?.length ?? 0), 0)}`,
    ].join('\n')
  );
}
