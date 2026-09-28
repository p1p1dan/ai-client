/**
 * Experiment E1 (dsh-rebase P1-10b; decisions 058 rule 3, 082 rule 6, 108):
 * with `plugin-manager` and `tool-plugin-manager` off and the profile's own
 * patch layer out of the composition, does the host start and work as before?
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/e1-plugin-manager-off.ts
 *      [--out file.json] [--keep])
 *
 * Two checkout hosts, one after the other, each on a DSH home of its own:
 *   baseline  a fresh profile (DSH's template user layer, `[]`)
 *   hostile   a profile whose own patch layer turns both plugin-manager rows
 *             back on, turns the permission gate off and inserts a row — all of
 *             which DSH composed before P1-10b
 * For each: `ready`; both plugin-manager rows composed off; the same rows as
 * the baseline; nothing inactive in the activation census; the warning that
 * the user layer is ignored (hostile only); one P0-TOOL turn (a bash call,
 * bypass posture) through the local fake gateway; `shutdown`, exit 0.
 *
 * Refuses to start below 800 MB available. Every model request goes to the
 * fake gateway; signals only ever go to a ChildProcess this script spawned.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ExperimentHost,
  oneTurn,
  readyOrFatal,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
} from './lib/experiment-host.ts';
import { fakeGatewayPlan, type Message } from './lib/hostClient.ts';
import { baseEnv, sandbox } from './lib/kit.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const nodeBin = join(repoRoot, 'out-node-runtime', 'node');
const argv = process.argv.slice(2);
const outFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : '';
const keep = argv.includes('--keep');
const scratchRoot = join('/var/tmp', `aiclient-dsh-p1-10b-e1-${Date.now()}`);
const PLUGIN_MANAGER_ROWS = ['plugin-manager', 'tool-plugin-manager'];
/** What the hostile profile's own patch layer asks for; none of it may compose. */
const HOSTILE_USER_LAYER = `# E1: none of this may compose (decision 058 rule 3).
- id: plugin-manager
  disabled: false
- id: tool-plugin-manager
  disabled: false
- id: aiclient-permissions
  disabled: true
- insert:
    - id: e1-user-layer-row
      name: '@aiclient/dsh-app/bridge'
`;

function availableMb(): number {
  const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
  return match ? Math.round(Number(match[1]) / 1024) : Math.round(os.freemem() / 1048576);
}

async function runHost(label: 'baseline' | 'hostile', port: number) {
  const box = sandbox(scratchRoot, label);
  if (label === 'hostile') {
    // initProfile never touches existing files: this profile keeps its own layer.
    const profile = join(box.dshHome, 'profiles', 'aiclient');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profile, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-aiclient',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@aiclient/dsh-app'] } },
        },
        null,
        2
      )}\n`
    );
    writeFileSync(join(profile, 'cordis.patch.yml'), HOSTILE_USER_LAYER);
  }
  const cwd = join(box.root, 'host-cwd');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const env = { ...baseEnv(box), DSH_HOME: box.dshHome, DSH_TELEMETRY_DISABLED: '1' };
  const host: ExperimentHost = startExperimentHost({
    label,
    nodeBin,
    entry: join(hostDir, 'host.ts'),
    cwd,
    env,
    plan: fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${port}`, clientVersion: 'e1' }),
    key: 'p1-10b-e1-fake-key',
  });
  try {
    const ready = await readyOrFatal(host);
    const composition = (ready?.composition ?? {}) as {
      rows?: number;
      disabledLiteral?: string[];
    };
    const census = (ready?.census ?? {}) as { active?: number; inactive?: string[] };
    const turn =
      ready?.type === 'ready'
        ? await oneTurn(host, {
            sessionId: `e1-${label}`,
            cwd: box.workspace,
            text: 'P0-TOOL: list the workspace.',
          })
        : undefined;
    const stop = await stopExperimentHost(host);
    const stderr = host.stderr();
    return {
      ready: ready?.type === 'ready',
      fatal: ready?.type === 'fatal' ? ready.message : undefined,
      rows: composition.rows,
      pluginManagerRowsOff: PLUGIN_MANAGER_ROWS.every((id) =>
        composition.disabledLiteral?.includes(id)
      ),
      census,
      plugins: ready?.plugins as Message | undefined,
      userLayerIgnoredWarning: /cordis\.patch\.yml is ignored: a profile's own patch layer/.test(
        stderr
      ),
      turn,
      stop,
      stderrTail: stderr.slice(-2000),
    };
  } catch (error) {
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
    throw error;
  }
}

async function main() {
  const available = availableMb();
  if (available < 800) {
    throw new Error(`only ${available} MB available; E1 needs 800 MB (wait for other runs)`);
  }
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const gateway = await startFakeGateway(nodeBin, join(here, 'fake-gateway.mjs'), scratchRoot);
  const results: Record<string, Awaited<ReturnType<typeof runHost>>> = {};
  try {
    results.baseline = await runHost('baseline', gateway.port);
    results.hostile = await runHost('hostile', gateway.port);
  } finally {
    gateway.child.kill();
  }
  const { baseline, hostile } = results;
  const turnOk = (run: typeof baseline) =>
    run.turn?.idle === true &&
    run.turn.tools.some((tool) => tool.name === 'bash' && tool.ok === true);
  const checks = {
    bothReady: baseline.ready && hostile.ready,
    pluginManagerRowsOff: baseline.pluginManagerRowsOff && hostile.pluginManagerRowsOff,
    sameRowsAsBaseline: baseline.rows !== undefined && baseline.rows === hostile.rows,
    nothingInactive:
      (baseline.census.inactive ?? []).length === 0 && (hostile.census.inactive ?? []).length === 0,
    userLayerWarned: hostile.userLayerIgnoredWarning && !baseline.userLayerIgnoredWarning,
    toolTurns: turnOk(baseline) && turnOk(hostile),
    cleanStops:
      baseline.stop.stopped &&
      hostile.stop.stopped &&
      baseline.stop.exit.code === 0 &&
      hostile.stop.exit.code === 0,
  };
  const pass = Object.values(checks).every(Boolean);
  const report = { experiment: 'E1', pass, checks, results, scratch: scratchRoot };
  if (outFile) writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ experiment: 'E1', pass, checks }, null, 2)}\n`);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  process.exitCode = pass ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`[e1] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
