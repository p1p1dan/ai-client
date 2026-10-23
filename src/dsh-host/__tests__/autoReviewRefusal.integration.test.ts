import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DshModelPlan } from '../../shared/dshModelPlan/types.ts';
import {
  type FakeGateway,
  openSession,
  readyOrFatal,
  sendTurn,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
  stopFakeGateway,
} from '../tools/lib/experiment-host.ts';
import { FAKE_MODEL, FAKE_ROUTE, fakeGatewayPlan, type Message } from '../tools/lib/hostClient.ts';
import { baseEnv, sandbox } from '../tools/lib/kit.ts';

/**
 * The auto gear's review on a real host, when the review model's service
 * refuses the request (an Anthropic `refusal` stop, as the user's gateway
 * relayed one on 2026-10-24) and when the review call fails.
 *
 *   AICLIENT_DSH_INTEGRATION=1 pnpm exec vitest run \
 *     src/dsh-host/__tests__/autoReviewRefusal.integration.test.ts
 *
 * Opt-in: one real host (200-350 MB). Every model request, the review's
 * included, goes to the local fake gateway (`P1-AUTO-REVIEW-REFUSE`).
 *
 * - The refused review raises the user's card, carrying the service's words;
 *   the call is not refused on the model's behalf.
 * - The failed review refuses the call without a card, and the record and the
 *   model's text both say why (the gateway's status line).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_DIR = resolve(HERE, '..');
const REPO = resolve(HOST_DIR, '..', '..');
const BUNDLED_NODE = join(
  REPO,
  'out-node-runtime',
  process.platform === 'win32' ? 'node.exe' : 'node'
);
const NODE = existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath;
const enabled =
  process.env.AICLIENT_DSH_INTEGRATION === '1' &&
  (process.platform === 'linux' || process.platform === 'win32') &&
  existsSync(join(HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh-app-boot'));

const payloadOf = (event: Message): Message => (event.payload ?? {}) as Message;
/** `claude auto-mode defaults`, as bridge-record's `auto-review` stands it in. */
const RULES = {
  allow: ['Local Operations: deleting files the agent created in this session.'],
  soft_deny: [
    'Irreversible Local Destruction [must name the exact target]: deleting files that existed before this session.',
  ],
  hard_deny: ['Data Exfiltration: sending credentials or sensitive data out of this machine.'],
  environment: [],
};

describe.skipIf(!enabled)('a review the service refuses, on a real host', () => {
  let root = '';
  let gateway: FakeGateway | undefined;

  beforeAll(async () => {
    root = mkdtempSync(
      join(process.platform === 'win32' ? tmpdir() : '/var/tmp', 'aiclient-dsh-refuse-')
    );
    gateway = await startFakeGateway(NODE, join(HOST_DIR, 'tools', 'fake-gateway.mjs'), root, {});
  }, 60_000);

  afterAll(async () => {
    if (gateway) await stopFakeGateway(gateway);
    if (root) rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('raises the card with the service’s words; a failed review says why', async () => {
    if (!gateway) throw new Error('no gateway');
    const box = sandbox(root, 'refuse');
    for (const name of ['REVIEW-REFUSE-f.txt', 'REVIEW-ERROR-g.txt']) {
      writeFileSync(join(box.workspace, name), 'x\n');
    }
    const cli = join(root, 'auto-mode-cli.mjs');
    writeFileSync(
      cli,
      `if (process.argv.slice(2).join(' ') === 'auto-mode defaults') console.log(${JSON.stringify(
        JSON.stringify(RULES)
      )}); else process.exit(2);\n`
    );
    mkdirSync(box.dshHome, { recursive: true });
    const host = startExperimentHost({
      label: 'refuse',
      nodeBin: NODE,
      entry: join(HOST_DIR, 'host.ts'),
      cwd: box.workspace,
      env: {
        ...baseEnv(box),
        DSH_HOME: box.dshHome,
        DSH_TELEMETRY_DISABLED: '1',
        AICLIENT_DSH_PROBE_BUNDLE: '0',
      },
      // The launch passes `autoModeCli` on beside the plan (`hostClient.ts`).
      plan: {
        ...fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gateway.port}` }),
        reviewModel: `${FAKE_ROUTE}/${FAKE_MODEL}`,
        autoModeCli: cli,
      } as DshModelPlan,
      key: 'refuse-fake-key',
    });
    const cards: Message[] = [];
    try {
      const ready = await readyOrFatal(host);
      if (ready?.type !== 'ready') throw new Error(`host did not start: ${host.stderr()}`);
      const session = await openSession(host, {
        logicalSessionId: 'refuse-chat',
        cwd: box.workspace,
        permissions: { mode: 'agent', gear: 'auto' },
      });
      const requestId = 'refuse-1';
      const turn = await sendTurn(host, session, {
        requestId,
        text: 'P1-AUTO-REVIEW-REFUSE: remove the review files.',
        during: async (start) => {
          const { client } = host;
          const idle = (events: Message[]) =>
            events
              .slice(start)
              .some(
                (event) =>
                  event.type === 'session.status' &&
                  payloadOf(event).status === 'idle' &&
                  event.requestId === requestId
              );
          const waiting = (events: Message[]) =>
            events
              .slice(start)
              .filter(
                (event) =>
                  event.type === 'permission.requested' &&
                  !cards.some((card) => card.permissionId === payloadOf(event).permissionId)
              );
          for (;;) {
            const woke = await client.until(
              session.ch,
              (events) => idle(events) || waiting(events).length > 0,
              120_000
            );
            for (const card of waiting(client.events(session.ch))) {
              const payload = payloadOf(card);
              cards.push(payload);
              await client.request(session.ch, 'worker.permission.respond', {
                logicalSessionId: session.logicalSessionId,
                permissionId: payload.permissionId,
                decision: 'allow',
              });
            }
            if (!woke || idle(client.events(session.ch))) return;
          }
        },
      });
      expect(turn.reply).toContain('P1-AUTO-REVIEW-REFUSE finished.');

      // The refused review: one card, with the service's words; the user allowed it.
      expect(cards).toHaveLength(1);
      expect(String(cards[0]?.reviewRefusal)).toContain("violate Anthropic's Terms of Service");
      expect(existsSync(join(box.workspace, 'REVIEW-REFUSE-f.txt'))).toBe(false);

      // The failed review: no card, refused, and why.
      const failed = turn.events
        .filter((event) => event.type === 'permission.activity')
        .map(payloadOf)
        .find((record) => record.resolution === 'review_failed');
      expect(failed).toMatchObject({ reviewFailure: 'error' });
      expect(String(failed?.reviewFailureDetail)).toMatch(/502|fake review upstream failed/);
      const results = turn.events.filter((event) => event.type === 'tool.completed').map(payloadOf);
      expect(String(results[1]?.error)).toMatch(/could not be completed \(error: .*\)/);
      expect(existsSync(join(box.workspace, 'REVIEW-ERROR-g.txt'))).toBe(true);
    } finally {
      await stopExperimentHost(host);
    }
  }, 240_000);
});
