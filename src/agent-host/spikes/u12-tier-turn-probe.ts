/**
 * U12 rev.2 probe — does `fullopen` really stop prompting for a write OUTSIDE
 * the workspace?
 *
 * Runs one real turn through the same bootstrap the Pi worker uses, with the
 * session tier seeded to `fullopen`, and asks the agent to write a file in a
 * directory that is not the session cwd. That path runs two gates —
 * `external_directory` first, then `write` — and before the 2026-09-04
 * distributor patch the first one prompted at every tier because the
 * bounded-delegation envelope capped our link's `allow` back to `defer`.
 *
 * Reads the outcome off `permission.activity`: a `phase: 'prompt'` record means
 * a dialog was raised (not fixed); `phase: 'decision'` with `result: 'allow'`
 * and no prompt means the tier decided it.
 *
 *   PI_CODING_AGENT_DIR=~/.pilab/t37c-agent \
 *   node --experimental-strip-types src/agent-host/spikes/u12-tier-turn-probe.ts
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortableExtensionUiBridge } from '../extensionUiBridge.ts';
import { bootstrapPiAgentSession, type PiSdkModule } from '../piAgentSessionBootstrap.ts';
import { createSessionTierAuthorizer } from '../sessionTierAuthorizer.ts';

const TURN_TIMEOUT_MS = 120_000;

const cwd = mkdtempSync(join(tmpdir(), 'u12-turn-cwd-'));
const outside = mkdtempSync(join(tmpdir(), 'u12-turn-outside-'));
const target = join(outside, 'probe.txt');
const log = (...args: unknown[]) => console.log('[probe]', ...args);

const prompts: unknown[] = [];
const decisions: unknown[] = [];

const sdk = (await import('@earendil-works/pi-coding-agent')) as unknown as PiSdkModule;
const tier = (process.env.PROBE_TIER ?? 'fullopen') as 'handsoff' | 'fullopen';
const { factory } = createSessionTierAuthorizer({ log, initialTier: tier });

const extensionUi = createPortableExtensionUiBridge({
  onRequest: (request) => {
    if (request.method === 'select' || request.method === 'confirm') {
      log('!! DIALOG RAISED →', request.method, JSON.stringify(request.args).slice(0, 200));
    }
  },
});

const bootstrapped = await bootstrapPiAgentSession({
  sdk,
  cwd,
  projectTrusted: true,
  extensionUi,
  // Explicit: without a model the SDK resolves nothing and `prompt()` returns
  // immediately, which looks exactly like "no gate fired".
  model: process.env.PROBE_MODEL ?? 'cx2/gpt-5.6-sol',
  additionalExtensionFactories: [{ name: 'aiclient-session-tier', factory, hidden: true }],
  log,
  onPermissionActivity: (payload) => {
    const record = payload as { phase?: string; surface?: string; result?: string };
    if (record.phase === 'prompt') prompts.push(record);
    else decisions.push(record);
    log('permission.activity:', JSON.stringify(record));
  },
});

log('agentDir =', bootstrapped.agentDir, '| gate =', bootstrapped.permissionGate);
log('cwd      =', cwd);
log('target   =', target, '(outside the session cwd)');

const session = bootstrapped.handle.session;
if (typeof session.prompt !== 'function') throw new Error('this Pi SDK build cannot prompt');

const turn = session.prompt(
  `Write the single word "hello" into the file ${target}. Use the write tool with that absolute path. Do not ask me anything.`
);
const timeout = new Promise<'timeout'>((resolve) =>
  setTimeout(() => resolve('timeout'), TURN_TIMEOUT_MS)
);
const outcome = await Promise.race([turn.then(() => 'done' as const), timeout]);

log('turn outcome      =', outcome);
log('file written      =', existsSync(target));
log('dialogs raised    =', prompts.length);
log('gate decisions    =', decisions.length);
// `handsoff` is the control: it must STILL raise the cross-directory dialog,
// which is what keeps the fullopen exemption from being a blanket one.
const expectation =
  tier === 'fullopen' ? prompts.length === 0 && existsSync(target) : prompts.length > 0;
log(
  expectation
    ? `PASS — ${tier} behaved as specified (${prompts.length} dialog(s))`
    : `FAIL — ${tier} raised ${prompts.length} dialog(s); see the records above`
);

await bootstrapped.handle.dispose?.();
rmSync(cwd, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
process.exit(0);
