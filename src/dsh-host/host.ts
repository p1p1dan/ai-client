/**
 * P0-1 DSH host launcher.
 *
 * Boots one application-owned profile, bundles
 * `['@deepseek-ai/dsh-base', '@aiclient/dsh-app']`, with dsh-app-boot on plain
 * Node. Mirrors `@deepseek-ai/dsh/profile-boot` `runProfile` (the path DSH
 * Desktop's host uses) minus the proxy, command-line and bin concerns.
 *
 * Run: `node --expose-internals host.ts` with DSH_HOME set. The runtime
 * resolution patches Node's internal ESM/CJS resolvers; it reaches them via
 * `--expose-internals` or, failing that, the `node-addon-require-builtin` addon.
 *
 * IPC (when spawned with an 'ipc' stdio slot):
 *   host -> parent: { type: 'ready', ... } once boot() settles,
 *                   { type: 'stopped', ms } after disposal.
 *   parent -> host: { type: 'shutdown' }. Session requests go to the
 *                   aiclient-probe row of @aiclient/dsh-app.
 */

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

const PROFILE_NAME = 'aiclient';
const BUNDLES = ['@deepseek-ai/dsh-base', '@aiclient/dsh-app'] as const;
const BIN = 'dsh';
// Rows that must never be composed into a worker engine.
const FORBIDDEN_ROWS = ['webserver', 'frontend-static'];
const FORBIDDEN_PACKAGES = [
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-host-frontend-static',
];
// Rows this bundle turns off; checked on the composed list.
const REQUIRED_DISABLED = [
  'session-telemetry-otel',
  'deepseek-account',
  'llm-deepseek-account',
  'hmr',
];

const marks: Record<string, number> = { entry: performance.now() };

function fail(message: string): never {
  process.stderr.write(`[dsh-host] ${message}\n`);
  if (process.connected) process.send?.({ type: 'fatal', message });
  process.exit(1);
}

const home = process.env.DSH_HOME;
if (home === undefined || home === '') fail('DSH_HOME must be set; the probe never uses ~/.dsh');
// os.userInfo() reads the account database, so an overridden HOME cannot hide the real one.
if (resolve(home) === resolve(os.userInfo().homedir, '.dsh'))
  fail('DSH_HOME points at the real ~/.dsh');

const appBoot = await import('@deepseek-ai/dsh-app-boot');
const { DSH_LAUNCH_ENVIRONMENT_KEY } = await import('@deepseek-ai/dsh-launch-environment');
marks.modulesLoaded = performance.now();

const installAnchor = join(dirname(fileURLToPath(import.meta.url)), 'package.json');
const profileDir = appBoot.resolveProfileDir(PROFILE_NAME, home);
appBoot.initProfile(profileDir, BUNDLES);
const profile = appBoot.loadProfileDirectory(BIN, profileDir, installAnchor);
if (profile.skippedBundles.length > 0) {
  appBoot.reportSkippedBundles(BIN, profile);
  fail(`bundles skipped: ${JSON.stringify(profile.skippedBundles)}`);
}
// The Loader needs a real include root to anchor baseUrl; the composition is all patches.
const rootConfig = join(profile.dir, 'cordis.yml');
writeFileSync(rootConfig, '[]\n');
const resolution = await appBoot.createRuntimeResolution({ installAnchor, profile, home });
marks.profileResolved = performance.now();

const environment = appBoot.loadLayeredEnv(BIN);
const profileContext = {
  name: PROFILE_NAME,
  dir: profile.dir,
  patchPath: profile.patchPath,
  installAnchor,
  startedBundles: profile.layers.map((layer) => layer.packageName),
  cwd: process.cwd(),
  home,
  overlays: [],
  telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
};
const patches = appBoot.readProfilePatches(BIN, profileContext, profile);

// Static composition audit, before any plugin imports.
const entries = appBoot.composeEntries([patches]);
const flat: Array<{ id?: string; name?: string; disabled?: unknown }> = [];
const walk = (list: unknown[]): void => {
  for (const row of list as Array<Record<string, unknown>>) {
    flat.push(row as { id?: string; name?: string; disabled?: unknown });
    const nested = (row.config as { initial?: unknown[] } | undefined)?.initial;
    if (Array.isArray(nested)) walk(nested);
  }
};
walk(entries as unknown[]);
const forbidden = flat.filter(
  (row) =>
    FORBIDDEN_ROWS.includes(row.id ?? '') || FORBIDDEN_PACKAGES.includes(String(row.name ?? ''))
);
if (forbidden.length > 0) fail(`forbidden rows composed: ${JSON.stringify(forbidden)}`);
const notDisabled = REQUIRED_DISABLED.filter(
  (id) => flat.find((row) => row.id === id)?.disabled !== true
);
if (notDisabled.length > 0) fail(`rows expected disabled: ${notDisabled.join(', ')}`);
const composition = {
  rows: flat.length,
  disabledLiteral: flat.filter((row) => row.disabled === true).map((row) => row.id),
  disabledByExpression: flat
    .filter((row) => row.disabled !== undefined && typeof row.disabled !== 'boolean')
    .map((row) => row.id),
};

type AppContext = Awaited<ReturnType<typeof appBoot.boot>>;
const app: { current?: AppContext } = {};
appBoot.installFailLoud(BIN, process, async () => {
  await app.current?.fiber.dispose();
});

let stopping: Promise<void> | undefined;
const stop = (reason: string): Promise<void> => {
  stopping ??= stopOnce(reason);
  return stopping;
};
async function stopOnce(reason: string): Promise<void> {
  const started = performance.now();
  await app.current?.fiber.dispose();
  const ms = performance.now() - started;
  process.stderr.write(`[dsh-host] stopped (${reason}) in ${ms.toFixed(0)}ms\n`);
  const send = process.send?.bind(process);
  if (process.connected && send !== undefined) {
    await new Promise<void>((done) => send({ type: 'stopped', ms, reason }, () => done()));
    process.disconnect?.();
  }
  // Exit naturally when nothing lingers; otherwise name what does and force it.
  setTimeout(() => {
    process.stderr.write(
      `[dsh-host] lingering after dispose: ${JSON.stringify(process.getActiveResourcesInfo())}\n`
    );
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
process.on('message', (message: unknown) => {
  if ((message as { type?: unknown } | null)?.type === 'shutdown') void stop('ipc');
});
// A vanished supervisor must not leave an orphaned engine behind.
process.on('disconnect', () => void stop('parent-disconnect'));

const ctx = await appBoot.boot(BIN, rootConfig, patches, async (hostCtx) => {
  app.current = hostCtx;
  // No console logger row in dsh-base; surface plugin warnings and errors.
  hostCtx.logger.exporter({
    levels: { default: 2 },
    export: ({ name, type, args }: { name: string; type: string; args: unknown[] }) => {
      if (type === 'warn' || type === 'error') {
        process.stderr.write(`[dsh-host] ${type} ${name}: ${format(...args)}\n`);
      }
    },
  });
  hostCtx.provide('profileContext', profileContext);
  hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
  await hostCtx.plugin(appBoot.PluginPackages, { resolution });
});
app.current = ctx;
marks.bootResolved = performance.now();

// Activation census of the settled Loader tree.
const FIBER_ACTIVE = 2; // FiberState.ACTIVE (a const enum in @deepseek-ai/cordis)
const census = { active: 0, disabled: 0, inactive: [] as string[] };
for (const entry of ctx.get('loader')?.entries() ?? []) {
  try {
    if (entry.disabled) {
      census.disabled += 1;
      continue;
    }
  } catch {
    census.inactive.push(`${entry.options.id}: disabled expression threw`);
    continue;
  }
  if (entry.fiber?.state === FIBER_ACTIVE) census.active += 1;
  else census.inactive.push(`${entry.options.id}: state ${String(entry.fiber?.state)}`);
}

const ready = {
  type: 'ready',
  pid: process.pid,
  node: process.version,
  execPath: process.execPath,
  execArgv: process.execArgv,
  dshRuntimeVersion: appBoot.getDshRuntimeVersion(),
  bundles: profile.layers.map((layer) => layer.packageName),
  composition,
  census,
  marks,
  memory: process.memoryUsage(),
};
if (process.connected) process.send?.(ready);
else process.stdout.write(`${JSON.stringify(ready)}\n`);
