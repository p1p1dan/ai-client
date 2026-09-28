/**
 * Experiment E3 (dsh-rebase P1-10b; decisions 058 rule 1, 108): can a plugin
 * bundle preinstalled in the host's install directory load when that
 * directory is read-only, as an installed app's resources are?
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/e3-readonly-plugin-install.ts
 *      [--host-dir ../../out-dsh-host] [--out file.json] [--keep])
 *
 * A real copy of a built host (scripts/build-dsh-host.mjs) gets the test-only
 * fixture plugin preinstalled the way the product ships one — its own
 * directory under node_modules, a dependency of the host's package.json, an
 * entry in the manifest's `plugins` section (tools/lib/plugin-install.ts) —
 * and is then made read-only for everyone (files 0444, directories 0555).
 * Two packaged hosts on it, with Main's own environment rule:
 *   enabled   AICLIENT_DSH_PLUGINS names the fixture: `ready.plugins` reports
 *             it loaded, its row is active, it says it runs from the install
 *             directory, and a turn's model request carries one tool more
 *   disabled  AICLIENT_DSH_PLUGINS is `[]`: reported disabled, not composed
 * Afterwards the install directory must be byte-for-byte what it was: no file
 * added, removed or changed. Permissions are restored before the scratch
 * directory is removed.
 *
 * Refuses to start below 800 MB available. Every model request goes to the
 * fake gateway; signals only ever go to a ChildProcess this script spawned.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Main's rule itself, loaded by Node's type stripping (the module has no imports).
import { buildDshHostEnvironment } from '../../main/services/agent-host/dshHostEnvironment.ts';
import {
  gatewayRequests,
  oneTurn,
  readyOrFatal,
  startExperimentHost,
  startFakeGateway,
  stopExperimentHost,
} from './lib/experiment-host.ts';
import { fakeGatewayPlan, type Message } from './lib/hostClient.ts';
import { sandbox } from './lib/kit.ts';
import {
  assembleInstall,
  FIXTURE_ACTIVE_MARKER,
  FIXTURE_PLUGIN,
  FIXTURE_ROW,
  fixtureManifestEntry,
  fixtureVariant,
  setTreeWritable,
  snapshotTree,
  treeChanges,
} from './lib/plugin-install.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostSource = resolve(here, '..');
const repoRoot = resolve(hostSource, '..', '..');
const nodeBin = join(repoRoot, 'out-node-runtime', 'node');
const argv = process.argv.slice(2);
const option = (name: string, fallback: string) =>
  argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback;
const artifactDir = resolve(option('host-dir', join(repoRoot, 'out-dsh-host')));
const outFile = option('out', '');
const keep = argv.includes('--keep');
const scratchRoot = join('/var/tmp', `aiclient-dsh-p1-10b-e3-${Date.now()}`);

function availableMb(): number {
  const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
  return match ? Math.round(Number(match[1]) / 1024) : Math.round(os.freemem() / 1048576);
}

async function runHost(
  label: 'enabled' | 'disabled',
  install: { dir: string; entry: string },
  port: number,
  enabledPlugins: string[]
) {
  const box = sandbox(scratchRoot, label);
  const cwd = join(box.root, 'host-cwd');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const env = buildDshHostEnvironment({
    dshHome: box.dshHome,
    nativeCacheDir: join(box.root, 'native-cache'),
    isPackaged: true,
    enabledPlugins,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HOME: box.home,
      TMPDIR: box.tmp,
      USER: os.userInfo().username,
      SHELL: '/bin/bash',
    },
  });
  const host = startExperimentHost({
    label,
    nodeBin,
    entry: install.entry,
    cwd,
    env,
    plan: fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${port}`, clientVersion: 'e3' }),
    key: 'p1-10b-e3-fake-key',
  });
  try {
    const ready = await readyOrFatal(host);
    const before = gatewayRequests(join(scratchRoot, 'gateway.jsonl')).length;
    const turn =
      ready?.type === 'ready'
        ? await oneTurn(host, {
            sessionId: `e3-${label}`,
            cwd: box.workspace,
            text: 'P0-STREAM: stream a short answer.',
          })
        : undefined;
    const requests = gatewayRequests(join(scratchRoot, 'gateway.jsonl')).slice(before);
    const stop = await stopExperimentHost(host);
    const stderr = host.stderr();
    const report = ready?.plugins as { plugins?: Message[] } | undefined;
    const census = (ready?.census ?? {}) as { active?: number; inactive?: string[] };
    const marker = stderr
      .split('\n')
      .find((line) => line.startsWith(FIXTURE_ACTIVE_MARKER))
      ?.slice(FIXTURE_ACTIVE_MARKER.length);
    return {
      ready: ready?.type === 'ready',
      fatal: ready?.type === 'fatal' ? ready.message : undefined,
      artifact: ready?.artifact,
      bundles: ready?.bundles,
      fixture: report?.plugins?.find((item) => item.name === FIXTURE_PLUGIN),
      census,
      activeFrom: marker,
      toolsPerRequest: requests.map((request) => request.tools),
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
    throw new Error(`only ${available} MB available; E3 needs 800 MB (wait for other runs)`);
  }
  if (!existsSync(join(artifactDir, 'host.js'))) {
    throw new Error(`${artifactDir} holds no built host; run node scripts/build-dsh-host.mjs`);
  }
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const install = await assembleInstall({
    into: join(scratchRoot, 'install'),
    base: { artifact: artifactDir },
    plugins: [{ dir: fixtureVariant(scratchRoot, 'good'), entry: fixtureManifestEntry() }],
  });
  const pluginDir = join(install.dir, 'node_modules', ...FIXTURE_PLUGIN.split('/'));
  setTreeWritable(install.dir, false);
  const snapshotBefore = snapshotTree(install.dir);
  const gateway = await startFakeGateway(nodeBin, join(here, 'fake-gateway.mjs'), scratchRoot);
  const results: Record<string, Awaited<ReturnType<typeof runHost>>> = {};
  let changes: string[] = [];
  try {
    results.enabled = await runHost('enabled', install, gateway.port, [FIXTURE_PLUGIN]);
    results.disabled = await runHost('disabled', install, gateway.port, []);
    changes = treeChanges(snapshotBefore, snapshotTree(install.dir));
  } finally {
    gateway.child.kill();
    setTreeWritable(install.dir, true);
  }
  const { enabled, disabled } = results;
  const tools = (run: typeof enabled) => Number(run.toolsPerRequest[0] ?? Number.NaN);
  const checks = {
    bothReadyPackaged:
      enabled.ready &&
      disabled.ready &&
      (enabled.artifact as Message | undefined)?.form === 'packaged' &&
      (disabled.artifact as Message | undefined)?.form === 'packaged',
    enabledLoaded:
      enabled.fixture?.state === 'loaded' &&
      (enabled.bundles as string[] | undefined)?.includes(FIXTURE_PLUGIN) === true,
    loadedFromInstallDir: resolve(String(enabled.activeFrom ?? '')) === resolve(pluginDir),
    rowActive: (enabled.census.active ?? 0) === (disabled.census.active ?? 0) + 1,
    nothingInactive:
      (enabled.census.inactive ?? []).length === 0 && (disabled.census.inactive ?? []).length === 0,
    disabledNotComposed:
      disabled.fixture?.state === 'disabled' &&
      (disabled.bundles as string[] | undefined)?.includes(FIXTURE_PLUGIN) === false &&
      disabled.activeFrom === undefined,
    oneToolMoreInTheRequest: tools(enabled) === tools(disabled) + 1,
    turnsFinished: enabled.turn?.idle === true && disabled.turn?.idle === true,
    installUntouched: changes.length === 0,
    cleanStops:
      enabled.stop.stopped &&
      disabled.stop.stopped &&
      enabled.stop.exit.code === 0 &&
      disabled.stop.exit.code === 0,
  };
  const pass = Object.values(checks).every(Boolean);
  const report = {
    experiment: 'E3',
    pass,
    checks,
    artifact: artifactDir,
    fixtureRow: FIXTURE_ROW,
    installChanges: changes.slice(0, 50),
    results,
    scratch: scratchRoot,
  };
  if (outFile) writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ experiment: 'E3', pass, checks }, null, 2)}\n`);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  process.exitCode = pass ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`[e3] ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
