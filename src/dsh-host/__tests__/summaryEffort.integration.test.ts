import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DSH_COMPACT_REQUEST_FAILED_KEY,
  DSH_COMPACT_REQUEST_FAILED_MARK,
} from '../../shared/dshHistory/types.ts';
import type { DshModelPlan } from '../../shared/dshModelPlan/types.ts';
import {
  type ExperimentHost,
  type ExperimentSession,
  type FakeGateway,
  readyOrFatal,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
  stopFakeGateway,
  waitIdle,
} from '../tools/lib/experiment-host.ts';
import {
  BYPASS_PERMISSIONS,
  FAKE_ROUTE,
  fakeGatewayPlan,
  type Message,
} from '../tools/lib/hostClient.ts';
import { baseEnv, sandbox } from '../tools/lib/kit.ts';

/**
 * dsh-rebase decision 181 on a real host: every summary request names the
 * reasoning effort of the conversation's latest request.
 *
 *   AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run \
 *     src/dsh-host/__tests__/summaryEffort.integration.test.ts
 *
 * Opt-in: one real host (200-350 MB) and the local fake gateway (plan
 * dsh-p0-2, every request captured); run it alone on the dev box. Needs
 * out-node-runtime/node and `npm ci` in src/dsh-host. Every model request
 * goes to the fake gateway; signals only ever go to children this file
 * spawned.
 *
 * Two routes. `aiclient-responses/fake-sol` speaks OpenAI Responses and, like
 * GPT 6.1 Sol behind the company gateway, refuses `reasoning.effort: 'none'`
 * with a 400 (`fake-gateway.mjs`, `-sol` models) — what pi-ai sends for a
 * request that names no effort, DSH's summary request before decision 181.
 * `aiclient-gateway/claude-adaptive` is an adaptive-only Claude row (decision
 * 141: no `off`) with a 64k window, so two large prompts make the third
 * turn's first step compact by itself.
 *
 * - `/compact` on fake-sol after two turns at `high`: the summary request
 *   goes out at `high` as the turns did, and the compaction succeeds.
 * - A turn at `off` (refused upstream like the agent request), then
 *   `/compact`: the summary inherits `off` and is refused the same way; the
 *   row and the answer name the service's reason (DA-2).
 * - An automatic compaction on claude-adaptive at `high`: the summary
 *   request carries the turns' `thinking` and `output_config`.
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

const RESPONSES_ROUTE = 'aiclient-responses';
const COMPACTION_MARK = 'You are now acting as a compaction engine';

/** About 22k tokens in DSH's estimate, as `autoCompaction.integration.test.ts` sizes it. */
function filler(tag: string, chars = 88_000): string {
  const line = `${tag}: the module keeps its state in one map keyed by session id, and every mutation goes through one queue. `;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

interface CapturedRequest {
  seq: number;
  path: string;
  compaction: boolean;
  reasoning: unknown;
  thinking: unknown;
  outputConfig: unknown;
}

/** Every captured request, in order, with the reasoning fields of either wire. */
function capturedRequests(dir: string): CapturedRequest[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        seq: number;
        path: string;
        body: string;
      };
      const body = JSON.parse(record.body) as Record<string, unknown>;
      return {
        seq: record.seq,
        path: record.path,
        compaction: record.body.includes(COMPACTION_MARK),
        reasoning: body.reasoning,
        thinking: body.thinking,
        outputConfig: body.output_config,
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
      model: input.model,
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

/** One turn at `effort`, to its end (completed or failed). */
async function turnAt(
  host: ExperimentHost,
  session: ExperimentSession,
  requestId: string,
  text: string,
  effort: string
): Promise<Message[]> {
  const from = host.client.events(session.ch).length;
  await host.client.request(session.ch, 'worker.send', {
    logicalSessionId: session.logicalSessionId,
    requestId,
    attemptId: `${requestId}-attempt`,
    text,
    effort,
  });
  expect(await waitIdle(host, session, requestId, from)).toBe(true);
  return host.client.events(session.ch).slice(from);
}

/** `worker.compact`, answered whole: `{ok, result}` or `{ok: false, error: {code, message}}`. */
async function compact(host: ExperimentHost, session: ExperimentSession): Promise<Message> {
  return host.client.call(
    session.ch,
    'worker.compact',
    { logicalSessionId: session.logicalSessionId },
    120_000
  );
}

describe.skipIf(!enabled)('decision 181 on a real host', () => {
  let root = '';
  let capture = '';
  let gateway: FakeGateway | undefined;
  let host: ExperimentHost | undefined;
  let workspace = '';
  let plan: DshModelPlan;

  beforeAll(async () => {
    root = mkdtempSync(join('/var/tmp', 'aiclient-dsh-se-'));
    capture = join(root, 'capture');
    mkdirSync(capture, { recursive: true, mode: 0o700 });
    gateway = await startFakeGateway(NODE, join(HOST_DIR, 'tools', 'fake-gateway.mjs'), root, {
      capture,
    });
    const baseUrl = `http://127.0.0.1:${gateway.port}`;
    plan = fakeGatewayPlan({
      baseUrl,
      routes: [
        {
          provider: FAKE_ROUTE,
          baseUrl,
          models: [
            {
              id: 'claude-adaptive',
              name: 'adaptive',
              contextWindow: 65_536,
              maxTokens: 8192,
              reasoning: true,
              compat: { forceAdaptiveThinking: true },
            },
          ],
        },
        {
          provider: RESPONSES_ROUTE,
          baseUrl,
          api: 'openai-responses',
          models: [
            {
              id: 'fake-sol',
              name: 'sol',
              contextWindow: 200_000,
              maxTokens: 8192,
              reasoning: true,
              thinkingLevelMap: { off: 'none', xhigh: 'xhigh', max: 'max' },
            },
          ],
        },
      ],
    });
    const box = sandbox(root, 'host');
    workspace = box.workspace;
    host = startExperimentHost({
      label: 'se',
      nodeBin: NODE,
      entry: join(HOST_DIR, 'host.ts'),
      cwd: box.workspace,
      env: {
        ...baseEnv(box),
        DSH_HOME: box.dshHome,
        DSH_TELEMETRY_DISABLED: '1',
        AICLIENT_DSH_PROBE_BUNDLE: '0',
      },
      plan,
      key: 'se-fake-key',
    });
    const ready = await readyOrFatal(host);
    if (ready?.type !== 'ready') {
      throw new Error(`host did not start: ${JSON.stringify(ready)}\n${host.stderr()}`);
    }
  }, 240_000);

  afterAll(async () => {
    if (host) await stopExperimentHost(host);
    if (gateway) await stopFakeGateway(gateway);
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('plans the two rows as the catalog would: Sol offers off, the adaptive Claude row does not', () => {
    expect(plan.index[`${RESPONSES_ROUTE}/fake-sol`]?.efforts).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(plan.index[`${FAKE_ROUTE}/claude-adaptive`]?.efforts).not.toContain('off');
  });

  it('[181-I-1] /compact on fake-sol goes out at the turns’ level and succeeds', async () => {
    if (!host) throw new Error('no host');
    const session = await openModelSession(host, {
      logicalSessionId: 'se-sol',
      cwd: workspace,
      model: `${RESPONSES_ROUTE}/fake-sol`,
    });
    const mark = capturedRequests(capture).length;
    for (const index of [1, 2]) {
      await turnAt(host, session, `se-sol-${index}`, filler(`sol-${index}`, 8000), 'high');
    }
    const answer = await compact(host, session);
    expect(answer.ok, JSON.stringify(answer.error ?? answer.result)).toBe(true);
    const sent = capturedRequests(capture).slice(mark);
    expect(sent.every((request) => request.path.endsWith('/responses'))).toBe(true);
    const turns = sent.filter((request) => !request.compaction);
    const summaries = sent.filter((request) => request.compaction);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(summaries).toHaveLength(1);
    for (const request of turns)
      expect(request.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    // The summary request's reasoning is the turns', never pi-ai's `none`.
    expect(summaries[0]?.reasoning).toEqual(turns.at(-1)?.reasoning);
    expect(host.stderr()).toContain(
      `summary request of aiclient-se-sol on ${RESPONSES_ROUTE}/fake-sol: reasoning effort high (conversation)`
    );
  }, 240_000);

  it('[181-I-2] a turn at off, then /compact: refused the same way, and the row says why (DA-2)', async () => {
    if (!host) throw new Error('no host');
    const session = await openModelSession(host, {
      logicalSessionId: 'se-off',
      cwd: workspace,
      model: `${RESPONSES_ROUTE}/fake-sol`,
    });
    await turnAt(host, session, 'se-off-1', filler('off-1', 8000), 'high');
    const failed = await turnAt(host, session, 'se-off-2', filler('off-2', 8000), 'off');
    expect(failed.some((event) => event.type === 'session.failed')).toBe(true);
    const mark = capturedRequests(capture).length;
    const from = host.client.events(session.ch).length;
    const answer = await compact(host, session);
    expect(answer.ok).toBe(false);
    const error = (answer.error ?? {}) as { code?: string; message?: string };
    expect(error.code).toBe('WORKER_COMPACT_FAILED');
    expect(error.message).toContain(
      `${DSH_COMPACT_REQUEST_FAILED_MARK}HTTP 400 · unsupported_value: Unsupported value: 'none' is not supported with the 'fake-sol' model.`
    );
    // The conversation's own level, `off`: pi-ai sends `none`, as for the turn.
    expect(
      capturedRequests(capture)
        .slice(mark)
        .map((request) => request.reasoning)
    ).toEqual([{ effort: 'none' }]);
    const failedRow = host.client
      .events(session.ch)
      .slice(from)
      .find(
        (event) =>
          event.type === 'session.compaction' &&
          (event.payload as Message | undefined)?.phase === 'failed'
      );
    const note = (failedRow?.payload as Message | undefined)?.note as Message | undefined;
    expect(note?.key).toBe(DSH_COMPACT_REQUEST_FAILED_KEY);
    expect(String((note?.params as Message | undefined)?.reason)).toMatch(
      /^HTTP 400 · unsupported_value: Unsupported value: 'none' is not supported with the 'fake-sol' model\./
    );
  }, 240_000);

  it('[181-I-3] an automatic compaction on the adaptive Claude row carries the turns’ thinking', async () => {
    if (!host) throw new Error('no host');
    const session = await openModelSession(host, {
      logicalSessionId: 'se-claude',
      cwd: workspace,
      model: `${FAKE_ROUTE}/claude-adaptive`,
    });
    const mark = capturedRequests(capture).length;
    for (const [index, text] of [
      filler('first'),
      filler('second'),
      'third: a short one',
    ].entries()) {
      await turnAt(host, session, `se-claude-${index + 1}`, text, 'high');
    }
    const sent = capturedRequests(capture).slice(mark);
    // The third turn's first step compacted first (decision 177's 64k policy).
    expect(sent.map((request) => request.compaction)).toEqual([false, false, true, false]);
    const [first, , summary] = sent;
    expect(first?.thinking).toMatchObject({ type: 'adaptive' });
    expect(first?.outputConfig).toEqual({ effort: 'high' });
    // Before decision 181 the summary request named no thinking at all.
    expect(summary?.thinking).toEqual(first?.thinking);
    expect(summary?.outputConfig).toEqual(first?.outputConfig);
  }, 300_000);
});
