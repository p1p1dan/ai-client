import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DshModelPlan } from '../../shared/dshModelPlan/types.ts';
import {
  compactSession,
  type ExperimentHost,
  type ExperimentSession,
  type FakeGateway,
  readyOrFatal,
  sendTurn,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
  stopFakeGateway,
} from '../tools/lib/experiment-host.ts';
import { BYPASS_PERMISSIONS, FAKE_ROUTE, fakeGatewayPlan } from '../tools/lib/hostClient.ts';
import { baseEnv, sandbox } from '../tools/lib/kit.ts';
import { installProbeBundle } from '../tools/lib/probe-bundle.ts';

/**
 * dsh-rebase decision 177 on a real host: the per-model compaction policies
 * reach DSH's `compaction-basic` row and do what the shared rules say.
 *
 *   AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run \
 *     src/dsh-host/__tests__/autoCompaction.integration.test.ts
 *
 * Opt-in and slow: three real hosts one after the other (200-350 MB each) and
 * the local fake gateway (plan dsh-p0-2, every request captured); run it alone
 * on the dev box. Needs out-node-runtime/node and `npm ci` in src/dsh-host.
 * Every model request goes to the fake gateway; signals only ever go to
 * children this file spawned.
 *
 * One route, four models: 64k / 8192 (DSH's defaults never compact it; the
 * policy lowers the headroom), 32k / 4096 (too small: off), 200k / 32000
 * (DSH's threshold, summary capped at 32000) and 1M / 128000 (DSH's defaults,
 * nothing added).
 *
 * - The host logs every model's threshold once.
 * - On 64k, two large prompts cross the policy's threshold, and the next
 *   turn's first step compacts first, asking for 8192 summary tokens.
 * - A manual `/compact` asks for 32000 on 200k and DSH's own 65536 on 1M.
 * - A row a layer tunes itself (here the checkout's home patch) is left as it
 *   is, and DSH's default headroom then never compacts 64k: the problem.
 * - With the test-only probe bundle's `auto` switch off
 *   (AICLIENT_DSH_COMPACTION_AUTO=0), the same three turns compact nothing:
 *   the policies are added to the row's config, never in place of it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = resolve(HERE, '..');
const REPO = resolve(HOST_DIR, '..', '..');
const NODE = join(REPO, 'out-node-runtime', 'node');
const enabled =
  process.env.AICLIENT_DSH_INTEGRATION === '1' &&
  process.platform === 'linux' &&
  existsSync(NODE) &&
  existsSync(join(HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh-app-boot'));

const MODELS = [
  { id: 'w64k', name: '64k', contextWindow: 65_536, maxTokens: 8192 },
  { id: 'w32k', name: '32k', contextWindow: 32_768, maxTokens: 4096 },
  { id: 'w200k', name: '200k', contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'w1m', name: '1M', contextWindow: 1_000_000, maxTokens: 128_000 },
];

/**
 * About 22k tokens in DSH's estimate (4 characters a token). With the system
 * prompt and tools (about 6k) one stays below 64k's threshold (33751), two
 * cross it, and one plus the summary is back below it.
 */
const FILLER_CHARS = 88_000;

function filler(tag: string): string {
  const line = `${tag}: the module keeps its state in one map keyed by session id, and every mutation goes through one queue. `;
  return line.repeat(Math.ceil(FILLER_CHARS / line.length)).slice(0, FILLER_CHARS);
}

interface CapturedRequest {
  seq: number;
  model: unknown;
  maxTokens: unknown;
  compaction: boolean;
}

/** Every captured request, in order: its model, `max_tokens`, and whether it is DSH's summary request. */
function capturedRequests(dir: string): CapturedRequest[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        seq: number;
        body: string;
      };
      const body = JSON.parse(record.body) as {
        model?: unknown;
        max_tokens?: unknown;
        messages?: Array<{ content?: unknown }>;
      };
      const last = body.messages?.at(-1);
      return {
        seq: record.seq,
        model: body.model,
        maxTokens: body.max_tokens,
        compaction: JSON.stringify(last?.content ?? '').includes(
          'You are now acting as a compaction engine'
        ),
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

async function openModelSession(
  host: ExperimentHost,
  input: { logicalSessionId: string; cwd: string; model: string }
): Promise<ExperimentSession> {
  const ch = host.client.openChannel();
  const boot = await host.client.request(
    ch,
    'worker.bootstrap',
    {
      logicalSessionId: input.logicalSessionId,
      cwd: input.cwd,
      model: `${FAKE_ROUTE}/${input.model}`,
      permissions: BYPASS_PERMISSIONS,
    },
    120_000
  );
  return {
    ch,
    logicalSessionId: input.logicalSessionId,
    dshSessionId: String(boot.piSessionId),
    stubFile: String(boot.sessionFile),
    cwd: input.cwd,
    boot,
  };
}

/**
 * One host on the shared gateway. `probeAutoOff` layers the probe bundle with
 * automatic compaction off; `homePatch` is written to `$DSH_HOME/cordis.patch.yml`,
 * which a source checkout composes after the bundles (decision 110).
 */
async function startHost(
  root: string,
  label: string,
  plan: DshModelPlan,
  probeAutoOff: boolean,
  homePatch?: string
): Promise<{ host: ExperimentHost; workspace: string }> {
  const box = sandbox(root, label);
  if (probeAutoOff) installProbeBundle(box.dshHome);
  if (homePatch) writeFileSync(join(box.dshHome, 'cordis.patch.yml'), homePatch);
  const env: Record<string, string> = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    ...(probeAutoOff
      ? { AICLIENT_DSH_COMPACTION_AUTO: '0', AICLIENT_DSH_PROBE_ROW: '0' }
      : { AICLIENT_DSH_PROBE_BUNDLE: '0' }),
  };
  const host = startExperimentHost({
    label,
    nodeBin: NODE,
    entry: join(HOST_DIR, 'host.ts'),
    cwd: box.workspace,
    env,
    plan,
    key: 'ac-fake-key',
  });
  const ready = await readyOrFatal(host);
  if (ready?.type !== 'ready') {
    await stopExperimentHost(host);
    throw new Error(`host ${label} did not start: ${JSON.stringify(ready)}\n${host.stderr()}`);
  }
  return { host, workspace: box.workspace };
}

/**
 * Two large prompts, then a short one. DSH measures before each step, before
 * that step's new message joins the session, so the third turn's first step
 * is the first to see both large prompts (over 64k's threshold).
 */
async function threeTurns(host: ExperimentHost, session: ExperimentSession): Promise<boolean[]> {
  const idle: boolean[] = [];
  for (const [index, text] of [filler('first'), filler('second'), 'third: a short one'].entries()) {
    const turn = await sendTurn(host, session, {
      requestId: `${session.logicalSessionId}-${index + 1}`,
      text,
    });
    idle.push(turn.idle);
  }
  return idle;
}

describe.skipIf(!enabled)('decision 177 on a real host', () => {
  let root = '';
  let capture = '';
  let gateway: FakeGateway | undefined;
  let plan: DshModelPlan;

  beforeAll(async () => {
    root = mkdtempSync(join('/var/tmp', 'aiclient-dsh-ac-'));
    capture = join(root, 'capture');
    mkdirSync(capture, { recursive: true, mode: 0o700 });
    gateway = await startFakeGateway(NODE, join(HOST_DIR, 'tools', 'fake-gateway.mjs'), root, {
      capture,
    });
    plan = fakeGatewayPlan({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      routes: [
        {
          provider: FAKE_ROUTE,
          baseUrl: `http://127.0.0.1:${gateway.port}`,
          models: MODELS,
        },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    if (gateway) await stopFakeGateway(gateway);
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('logs the thresholds, compacts 64k by itself and caps every summary at the model limit', async () => {
    const { host, workspace } = await startHost(root, 'product', plan, false);
    try {
      const lines = host.stderrLines().filter((line) => line.includes('auto compaction, plan '));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`(4 models, 1 headroom lowered, 1 off; 3 model policies)`);
      expect(lines[0]).toContain(
        `${FAKE_ROUTE}/w64k 65536/8192 at 33751 headroom 23593 summary 8192`
      );
      expect(lines[0]).toContain(
        `${FAKE_ROUTE}/w32k 32768/4096 off (window too small) summary 4096`
      );
      expect(lines[0]).toContain(`${FAKE_ROUTE}/w200k 200000/32000 at 102464 summary 32000`);
      // DSH's own defaults: no summary cap of ours, no policy entry.
      expect(lines[0]).toMatch(new RegExp(`${FAKE_ROUTE}/w1m 1000000/128000 at 800000$`));

      // 64k: the third turn's first step sees 33751 crossed and compacts first.
      const before = capturedRequests(capture).length;
      const small = await openModelSession(host, {
        logicalSessionId: 'ac-64k',
        cwd: workspace,
        model: 'w64k',
      });
      expect(await threeTurns(host, small)).toEqual([true, true, true]);
      const sent = capturedRequests(capture).slice(before);
      expect(sent.map((request) => request.compaction)).toEqual([false, false, true, false]);
      expect(sent[2]?.maxTokens).toBe(8192);
      // The turns' own requests: the model's output limit, as before (pi-ai may cut it to fit).
      for (const request of [sent[0], sent[1], sent[3]]) {
        expect(request?.maxTokens).toBeLessThanOrEqual(8192);
      }
      expect(sent[0]?.maxTokens).toBe(8192);
      // DSH's own refusal (TargetPressureConfigError, warned once) never came.
      expect(host.stderr()).not.toContain('leaving no pressure budget');

      // Manual /compact: 32000 on 200k, DSH's own 65536 on 1M.
      for (const [model, cap] of [
        ['w200k', 32_000],
        ['w1m', 65_536],
      ] as const) {
        const session = await openModelSession(host, {
          logicalSessionId: `ac-${model}`,
          cwd: workspace,
          model,
        });
        const turn = await sendTurn(host, session, {
          requestId: `ac-${model}-1`,
          text: filler(model).slice(0, 8000),
        });
        expect(turn.idle).toBe(true);
        const mark = capturedRequests(capture).length;
        const answer = await compactSession(host, session);
        expect(answer.ok, JSON.stringify(answer)).toBe(true);
        const compactions = capturedRequests(capture)
          .slice(mark)
          .filter((request) => request.compaction);
        expect(compactions.map((request) => request.maxTokens)).toEqual([cap]);
      }
    } finally {
      await stopExperimentHost(host);
    }
  }, 300_000);

  it("leaves a row a layer tunes itself as it is: DSH's defaults then never compact 64k", async () => {
    // The problem decision 177 fixes, on the same host: the default headroom.
    const { host, workspace } = await startHost(
      root,
      'home-tuned',
      plan,
      false,
      '- id: compaction-basic\n  config:\n    headroomTokens: 65536\n'
    );
    try {
      const lines = host.stderrLines().filter((line) => line.includes('auto compaction, plan '));
      expect(lines[0]).toContain('not applied: a layer already sets headroomTokens');
      expect(host.stderr()).toContain(
        'per-model compaction policies not applied: a layer already sets headroomTokens'
      );
      const before = capturedRequests(capture).length;
      const small = await openModelSession(host, {
        logicalSessionId: 'ac-64k-dsh',
        cwd: workspace,
        model: 'w64k',
      });
      expect(await threeTurns(host, small)).toEqual([true, true, true]);
      const sent = capturedRequests(capture).slice(before);
      expect(sent.map((request) => request.compaction)).toEqual([false, false, false]);
      // DSH's own refusal, warned once for the model.
      expect(host.stderr()).toContain('leaving no pressure budget');
    } finally {
      await stopExperimentHost(host);
    }
  }, 300_000);

  it("keeps a layer's own switch: the probe bundle's auto=false still compacts nothing", async () => {
    const { host, workspace } = await startHost(root, 'probe-auto-off', plan, true);
    try {
      const lines = host.stderrLines().filter((line) => line.includes('auto compaction, plan '));
      expect(lines[0]).toContain('3 model policies');
      const before = capturedRequests(capture).length;
      const small = await openModelSession(host, {
        logicalSessionId: 'ac-64k-off',
        cwd: workspace,
        model: 'w64k',
      });
      expect(await threeTurns(host, small)).toEqual([true, true, true]);
      const sent = capturedRequests(capture).slice(before);
      expect(sent.map((request) => request.compaction)).toEqual([false, false, false]);
    } finally {
      await stopExperimentHost(host);
    }
  }, 300_000);
});
