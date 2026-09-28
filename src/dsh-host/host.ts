/**
 * DSH host launcher: ai-client's worker engine (dsh-rebase plan).
 *
 * Boots one application-owned profile, bundles
 * `['@deepseek-ai/dsh-base', '@aiclient/dsh-app']`, with dsh-app-boot on the
 * bundled Node. Mirrors `@deepseek-ai/dsh/profile-boot` `runProfile` (the path
 * DSH Desktop's host uses) minus the proxy, command-line and bin concerns.
 *
 * One file, two forms (decision 011). A source checkout runs it as is:
 * `node --expose-internals src/dsh-host/host.ts`. The packaged app runs
 * `resources/dsh-host/host.js`, its esbuild bundle (this file and `lib/`, npm
 * packages external), beside the artifact's own node_modules and
 * `dsh-host-manifest.json` (scripts/build-dsh-host.mjs). Both need DSH_HOME.
 * The runtime resolution patches Node's internal ESM/CJS resolvers; it reaches
 * them via `--expose-internals` or, failing that, the
 * `node-addon-require-builtin` addon.
 *
 * One host serves every chat session of the app (decision 019). IPC, when
 * spawned with an 'ipc' stdio slot (protocol: src/shared/types/dshHostProtocol.ts):
 *   host -> parent: { type: 'ready', pid, revision, routeDiagnostics, plugins,
 *                   ... } once boot() settles and the aiclient-bridge row holds
 *                   the channel; { type: 'fatal', message, code? } right
 *                   before exiting on a refused boot; { type: 'stopped' }
 *                   after disposal, just before disconnecting;
 *                   { host: 'credential' } whenever a model request needs a
 *                   key (lib/credentialRelay.ts).
 *   parent -> host: { host: 'configure' } first: the model plan (P1-5a,
 *                   decision 033). Nothing is composed before it, and a host
 *                   that gets none within 10 s refuses to boot. Then
 *                   { type: 'shutdown' }, and { host: 'credential-result' }
 *                   for the credential relay. Everything else is the
 *                   aiclient-bridge row's (bridge/plugin.ts): every chat
 *                   session's channel envelopes and the host controls (ping,
 *                   close). Probe drivers layer the test-only bundle
 *                   @aiclient/dsh-probe (tools/probe-bundle) on top of it
 *                   (decision 015).
 * Every IPC message is buffered from the first line of this file until the
 * bridge row claims the buffer, so nothing a driver writes before boot
 * settles is lost.
 *
 * Environment (decision 023): the launch environment snapshot is the process
 * layer alone. No .env file is read, from the launch directory or from
 * DSH_HOME, and nothing is written into process.env.
 *
 * Plugins (P1-10b; decisions 058, 059, 108, 110): the profile composes the
 * product bundles plus the allowlisted plugins Main enabled
 * (AICLIENT_DSH_PLUGINS' per-plugin overrides, or the allowlist's defaults)
 * that this host's own node_modules holds, audited layer by layer
 * (lib/hostPlugins.ts); the profile's own patch layer is never read, a
 * packaged host never reads the home layer either (a source checkout still
 * does, for development and the probes), and `ready.plugins` reports every
 * allowlisted plugin's state.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { CredentialRelay } from './lib/credentialRelay.ts';
import {
  CONFIGURE_TIMEOUT_MS,
  emptyHostModelPlan,
  type HostModelPlan,
  isConfigureMessage,
  modelPlanOverlays,
  publicModelPlan,
  readConfigure,
  routeDiagnostics,
} from './lib/hostModelPlan.ts';
import {
  allowlistFromManifest,
  allowlistFromSource,
  auditPluginLayers,
  enabledNames,
  type HostAllowlist,
  type HostPlugin,
  type InstalledPackage,
  type InstallVerdict,
  judgeInstalled,
  PLUGINS_ENV,
  PROBE_BUNDLE_ENV,
  packagedProfilePatches,
  planProfileBundles,
  pluginReport,
  readEnabledInput,
  withInactiveRows,
} from './lib/hostPlugins.ts';
import {
  AGENT_DIR_ENV,
  agentDirOverlays,
  PRODUCT_BUNDLES,
  partitionSkippedBundles,
  REQUIRED_DISABLED,
  REQUIRED_ENABLED,
  reconcileProductBundles,
  requiredDisabledOverlays,
  requiredEnabledOverlays,
  sameBundles,
} from './lib/hostProfile.ts';

const PROFILE_NAME = 'aiclient';
// Test-only bundle carrying the auto-approving IPC probe (decision 015).
const PROBE_BUNDLE = '@aiclient/dsh-probe';
const PROBE_ROW = 'aiclient-probe';
const BIN = 'dsh';
// Rows that must never be composed into a worker engine.
const FORBIDDEN_ROWS = ['webserver', 'frontend-static'];
const FORBIDDEN_PACKAGES = [
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-host-frontend-static',
];

const marks: Record<string, number> = { entry: performance.now() };

/** Shared with the aiclient-bridge row through a global symbol. */
interface BridgeInbox {
  queue: unknown[];
  deliver?: (message: unknown) => void;
}
const ipc = typeof process.send === 'function';
const bridgeInbox: BridgeInbox | undefined = ipc ? { queue: [] } : undefined;
/** Decision 033: the first `configure`, or why it was refused, until boot takes it. */
const configure: {
  received?: { ok: true; plan: HostModelPlan } | { ok: false; reason: string };
  wake?: () => void;
} = {};
/** Decision 034: set once the plan is known; answers go to it, never to the bridge. */
let credentialRelay: CredentialRelay | undefined;
if (bridgeInbox) {
  (globalThis as Record<symbol, unknown>)[Symbol.for('aiclient.dsh.bridge')] = bridgeInbox;
  process.on('message', (message: unknown) => {
    if (isConfigureMessage(message)) {
      if (configure.received) warn('a second configure was ignored; the plan is fixed at boot');
      else {
        configure.received = readConfigure(message);
        configure.wake?.();
      }
      return;
    }
    if (credentialRelay?.receive(message)) return;
    if (bridgeInbox.deliver) bridgeInbox.deliver(message);
    else bridgeInbox.queue.push(message);
  });
}

/** Resolves with Main's plan; refuses the boot after `CONFIGURE_TIMEOUT_MS` or on a malformed one. */
function awaitConfigure(): Promise<HostModelPlan> {
  return new Promise((done) => {
    const settle = () => {
      const received = configure.received;
      if (!received) return false;
      clearTimeout(timer);
      if (!received.ok) fail(`malformed configure: ${received.reason}`);
      done(received.plan);
      return true;
    };
    const timer = setTimeout(
      () =>
        fail(
          `no configure within ${CONFIGURE_TIMEOUT_MS} ms; the host composes nothing without Main's model plan`
        ),
      CONFIGURE_TIMEOUT_MS
    );
    configure.wake = () => void settle();
    settle();
  });
}

/** `code`, when given, is the refusal's stable name (e.g. decision 108's `DSH_HOST_UNDECLARED_ROWS`). */
function fail(message: string, code?: string): never {
  process.stderr.write(`[dsh-host] ${message}\n`);
  if (process.connected) process.send?.({ type: 'fatal', message, ...(code ? { code } : {}) });
  process.exit(1);
}

function warn(message: string): void {
  process.stderr.write(`[dsh-host] warning: ${message}\n`);
}

/**
 * Which form is running: `packaged` when scripts/build-dsh-host.mjs left its
 * manifest beside this file, `source` in a checkout. Reported in `ready`.
 */
function describeArtifact(): Record<string, unknown> {
  const own = JSON.parse(readFileSync(join(hostDir, 'package.json'), 'utf8')) as {
    version?: string;
  };
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(join(hostDir, 'dsh-host-manifest.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { form: 'source', version: own.version };
    }
    fail(`unreadable dsh-host-manifest.json: ${String(error)}`);
  }
  const pick = (key: string) => manifest[key];
  return {
    form: 'packaged',
    version: own.version,
    dsh: pick('dsh'),
    target: pick('target'),
    gitCommit: pick('gitCommit'),
    builtAt: pick('builtAt'),
  };
}

/**
 * P1-10b (decision 108 rule 3): the plugins this host may compose. Packaged,
 * the manifest's `plugins` section the build audited; in a checkout,
 * `plugins/allowlist.json`. An unreadable list allowlists nothing.
 */
function readHostAllowlist(): HostAllowlist {
  const file =
    artifact.form === 'packaged'
      ? join(hostDir, 'dsh-host-manifest.json')
      : join(hostDir, 'plugins', 'allowlist.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      plugins: [],
      failures: [`${file} is unreadable (${String(error)}); no plugin is allowlisted`],
    };
  }
  return artifact.form === 'packaged'
    ? allowlistFromManifest((raw as { plugins?: unknown } | null)?.plugins)
    : allowlistFromSource(raw);
}

/** Each allowlisted plugin as its own directory under this host's node_modules has it. */
function inspectInstalledPlugins(plugins: readonly HostPlugin[]): Map<string, InstallVerdict> {
  const verdicts = new Map<string, InstallVerdict>();
  for (const plugin of plugins) {
    const file = join(hostDir, 'node_modules', ...plugin.name.split('/'), 'package.json');
    let found: InstalledPackage;
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
        name?: unknown;
        version?: unknown;
        dsh?: { bundle?: { patch?: unknown } };
      } | null;
      found = {
        found: true,
        name: manifest?.name,
        version: manifest?.version,
        bundle: manifest?.dsh?.bundle?.patch !== undefined,
      };
    } catch (error) {
      found =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? { found: false }
          : { found: 'unreadable', error: String(error) };
    }
    verdicts.set(plugin.name, judgeInstalled(plugin, found));
  }
  return verdicts;
}

/**
 * The real path of `dir` (or `dir` itself when it cannot be resolved), in a
 * form two paths compare equal in: Windows paths are case-insensitive.
 */
function realDirOf(dir: string): string {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    real = resolve(dir);
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * Decision 058 rule 3: the profile's own patch file never composes. Say so
 * when someone (or something) wrote patches into it.
 */
function warnIgnoredUserLayer(file: string): void {
  if (!existsSync(file)) return;
  try {
    const patches = appBoot.loadOverlayPatches(BIN, file);
    if (patches.length > 0) {
      warn(
        `${file} is ignored: a profile's own patch layer never composes (${patches.length} patch(es))`
      );
    }
  } catch (error) {
    warn(`${file} is ignored, and unreadable: ${String(error)}`);
  }
}

const home = process.env.DSH_HOME;
if (home === undefined || home === '') fail('DSH_HOME must be set; the host never uses ~/.dsh');
// os.userInfo() reads the account database, so an overridden HOME cannot hide the real one.
if (resolve(home) === resolve(os.userInfo().homedir, '.dsh'))
  fail('DSH_HOME points at the real ~/.dsh');
// Decision 023: .env files are never read. Say so when one is lying there.
for (const file of new Set([resolve(process.cwd(), '.env'), resolve(home, '.env')])) {
  if (existsSync(file)) warn(`${file} is ignored: the DSH host reads no .env file`);
}
// P1-16a (decision 101 rule 1): <agentDir>, the same directory P1-6c's
// permission policy reads as its user layer. Absent when the host was handed
// none (e.g. the packaged smoke): the two overlays below are then omitted, and
// `agent-instructions` / `skill-filesystem` keep DSH's own defaults.
const agentDir = process.env[AGENT_DIR_ENV]?.trim() || undefined;

const appBoot = await import('@deepseek-ai/dsh-app-boot');
const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await import(
  '@deepseek-ai/dsh-launch-environment'
);
marks.modulesLoaded = performance.now();

const hostDir = dirname(fileURLToPath(import.meta.url));
const installAnchor = join(hostDir, 'package.json');
const artifact = describeArtifact();
const profileDir = appBoot.resolveProfileDir(PROFILE_NAME, home);
appBoot.initProfile(profileDir, PRODUCT_BUNDLES);
// P1-10b (decisions 058, 059, 108): the plugins this host may compose, and the
// ones Main enabled (its list, or the allowlist's defaults when it sent none).
const allowlist = readHostAllowlist();
for (const failure of allowlist.failures) warn(`plugin allowlist: ${failure}`);
const enabledInput = readEnabledInput(process.env[PLUGINS_ENV]);
if (enabledInput.from === 'invalid') {
  warn(`${PLUGINS_ENV} is ${enabledInput.error}; no plugin is enabled`);
}
// Decision 015: the auto-approving probe bundle composes only in a checkout,
// and only when the probe driver that listed it says so. Main never does.
const testBundles =
  artifact.form === 'source' && process.env[PROBE_BUNDLE_ENV] === '1' ? [PROBE_BUNDLE] : [];
// Decision 025 rule 5: `initProfile` writes the bundle list once, so the product
// bundles are restated at every start. Decision 058 rule 2: after them, only the
// enabled allowlisted plugins this host's install directory holds; anything
// else the profile lists is dropped, and said so.
const manifest = appBoot.readProfileManifest(BIN, profileDir);
const listedBundles: unknown = manifest.dsh?.profile?.bundles;
const bundlePlan = planProfileBundles({
  listed: reconcileProductBundles(listedBundles),
  product: PRODUCT_BUNDLES,
  plugins: allowlist.plugins,
  enabled: enabledNames(allowlist.plugins, enabledInput),
  installed: inspectInstalledPlugins(allowlist.plugins),
  testBundles,
});
for (const dropped of bundlePlan.dropped) {
  warn(`bundle ${JSON.stringify(dropped.name)} is not composed: ${dropped.reason}`);
}
for (const plugin of bundlePlan.plugins) {
  if (plugin.state === 'missing' || plugin.state === 'rejected') {
    warn(`plugin ${JSON.stringify(plugin.name)} ${plugin.state}: ${plugin.reason}`);
  }
}
const bundles = bundlePlan.bundles;
if (!Array.isArray(listedBundles) || !sameBundles(listedBundles, bundles)) {
  appBoot.writeProfileBundles(profileDir, manifest, bundles);
}
// Decision 058 rule 3: the bundles alone; the profile's own patch layer is not read.
const profile = appBoot.loadProfileDirectory(BIN, profileDir, installAnchor, { userLayer: false });
warnIgnoredUserLayer(profile.patchPath);
const skipped = partitionSkippedBundles(profile.skippedBundles);
for (const bundle of skipped.plugins) {
  warn(`plugin bundle ${JSON.stringify(bundle.packageName)} skipped: ${bundle.reason}`);
}
if (skipped.product.length > 0) {
  appBoot.reportSkippedBundles(BIN, profile);
  fail(`product bundles skipped: ${JSON.stringify(skipped.product)}`);
}
// Decision 059 rule 3: a plugin layer comes from this host's node_modules and
// inserts only its declared rows; one that does not is left out (only warned,
// as decision 025 rule 5 has it for any plugin).
const layerAudit = auditPluginLayers({
  layers: profile.layers.map((layer) => ({
    packageName: layer.packageName,
    patches: layer.patches,
    packageUrl: pathToFileURL(layer.packageDir).href,
    realDir: realDirOf(layer.packageDir),
  })),
  skipped: skipped.plugins,
  plugins: allowlist.plugins,
  statuses: bundlePlan.plugins,
  expectedDirs: new Map(
    allowlist.plugins.map((plugin) => [
      plugin.name,
      realDirOf(join(hostDir, 'node_modules', ...plugin.name.split('/'))),
    ])
  ),
});
for (const status of layerAudit.plugins) {
  if (status.state === 'rejected' && layerAudit.rejected.includes(status.name)) {
    warn(`plugin ${JSON.stringify(status.name)} rejected: ${status.reason}`);
  }
}
const composedProfile = {
  ...profile,
  layers: profile.layers.filter((layer) => !layerAudit.rejected.includes(layer.packageName)),
};
// The Loader needs a real include root to anchor baseUrl; the composition is all patches.
const rootConfig = join(profile.dir, 'cordis.yml');
writeFileSync(rootConfig, '[]\n');
const resolution = await appBoot.createRuntimeResolution({
  installAnchor,
  profile: composedProfile,
  home,
});
marks.profileResolved = performance.now();

const processLayer: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value !== undefined) processLayer[name] = value;
}
const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: processLayer }]);
// Decision 110 (revising decision 023 rule 3 and decision 108 rule 12): a
// packaged host never reads $DSH_HOME/cordis.patch.yml at all, and only warns
// that it was ignored when the file is there. A source checkout still reads
// it (below, via appBoot.readProfilePatches), for development and the
// probes; the required-disabled overlays restate the rows it could turn back
// on regardless.
const homePatch = join(home, 'cordis.patch.yml');
if (existsSync(homePatch)) {
  warn(
    artifact.form === 'packaged'
      ? `${homePatch} is ignored: a packaged host never reads $DSH_HOME/cordis.patch.yml`
      : `${homePatch} is applied; the privacy and endpoint rows stay off regardless`
  );
}
// Decision 033: nothing is composed before Main's plan. A host run by hand
// without IPC gets an empty one: no route, so no model request can go out.
const modelPlan = ipc ? await awaitConfigure() : emptyHostModelPlan();
marks.configured = performance.now();
// Decision 034: keys are asked for per request, with this host's nonce.
credentialRelay = ipc
  ? new CredentialRelay({
      nonce: modelPlan.nonce,
      refs: modelPlan.refs,
      send: (message) => {
        if (!process.connected) return false;
        process.send?.(message, undefined, undefined, (error) => {
          if (error) warn(`credential request could not be sent: ${error.message}`);
        });
        return true;
      },
      log: (...args) => warn(format(...args)),
    })
  : undefined;
const profileContext = {
  name: PROFILE_NAME,
  dir: profile.dir,
  patchPath: profile.patchPath,
  installAnchor,
  startedBundles: composedProfile.layers.map((layer) => layer.packageName),
  cwd: process.cwd(),
  home,
  // The plan's two rows, then <agentDir>'s two rows (P1-16a, decision 101),
  // then the required rows off, then the permission gate on (P1-6b, decision
  // 042) — all after every user layer.
  overlays: [
    ...modelPlanOverlays(modelPlan),
    ...agentDirOverlays(agentDir),
    ...requiredDisabledOverlays(),
    ...requiredEnabledOverlays(),
  ],
  telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
  // No `packageManager` (decision 082, closing decision 016): plugin-manager
  // is disabled at every start (bundle/cordis.patch.yml, REQUIRED_DISABLED),
  // so nothing ever reads this field's fallback (`?? {command: 'pnpm'}`).
};
// Decision 110 (revising decision 108 rule 12): a packaged host composes its
// patch list without the home layer at all (lib/hostPlugins.ts, kept free of
// DSH's own patch type); a source checkout still calls
// appBoot.readProfilePatches, home layer included.
const patches: ReturnType<typeof appBoot.readProfilePatches> =
  artifact.form === 'packaged'
    ? (packagedProfilePatches(composedProfile, profileContext.overlays) as ReturnType<
        typeof appBoot.readProfilePatches
      >)
    : appBoot.readProfilePatches(BIN, profileContext, composedProfile);
// readProfilePatches' last step, kept for parity (the row is off regardless).
if (artifact.form === 'packaged') {
  const telemetryPatch = appBoot.resolveTelemetryPatch(
    profileContext.telemetryDisabledEnv,
    appBoot.composeEntries([patches]).some((row) => row.id === 'session-telemetry-otel')
  );
  if (telemetryPatch !== undefined) patches.push(telemetryPatch);
}

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
// P1-8 (decision 065): the loop guard must be composed and on; its kill switch
// is AICLIENT_RUNTIME_LOOP_GUARD=0, never a disabled row. P1-5b (decision 034):
// so must the read-only credentials row that replaces dsh-base's. P1-6b
// (decision 042): and the permission gate, which the overlays restate on.
const notEnabled = REQUIRED_ENABLED.filter((id) => {
  const row = flat.find((item) => item.id === id);
  return row === undefined || (row.disabled !== undefined && row.disabled !== false);
});
if (notEnabled.length > 0) fail(`rows expected enabled: ${notEnabled.join(', ')}`);
// The auto-approving probe row may only arrive with its own test bundle.
const probeLayered = composedProfile.layers.some((layer) => layer.packageName === PROBE_BUNDLE);
const probeRows = flat.filter(
  (row) => row.id === PROBE_ROW || String(row.name ?? '').startsWith(PROBE_BUNDLE)
);
if (!probeLayered && probeRows.length > 0)
  fail(`probe rows composed without ${PROBE_BUNDLE}: ${JSON.stringify(probeRows)}`);
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
  credentialRelay?.close();
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
  // Decision 033: the plan the bridge routes each turn by (the nonce stays
  // here); decision 034: the relay aiclient-credentials resolves keys through.
  hostCtx.provide('aiclientModelPlan', publicModelPlan(modelPlan));
  if (credentialRelay) hostCtx.provide('aiclientCredentialRelay', credentialRelay);
  await hostCtx.plugin(appBoot.PluginPackages, { resolution });
});
app.current = ctx;
marks.bootResolved = performance.now();

// Activation census of the settled Loader tree.
const FIBER_ACTIVE = 2; // FiberState.ACTIVE (a const enum in @deepseek-ai/cordis)
const census = { active: 0, disabled: 0, inactive: [] as string[] };
/** Row ids of `census.inactive`, for the plugin report. */
const inactiveIds = new Set<string>();
for (const entry of ctx.get('loader')?.entries() ?? []) {
  try {
    if (entry.disabled) {
      census.disabled += 1;
      continue;
    }
  } catch {
    census.inactive.push(`${entry.options.id}: disabled expression threw`);
    inactiveIds.add(String(entry.options.id));
    continue;
  }
  if (entry.fiber?.state === FIBER_ACTIVE) census.active += 1;
  else {
    census.inactive.push(`${entry.options.id}: state ${String(entry.fiber?.state)}`);
    inactiveIds.add(String(entry.options.id));
  }
}

// A host whose bridge never took the channel would swallow every session's
// messages until Main's heartbeat gave up on it; refuse it at once instead.
if (bridgeInbox && !bridgeInbox.deliver) {
  fail(`the aiclient-bridge row did not take the IPC channel: ${JSON.stringify(census.inactive)}`);
}

// The drift gate: every route of the plan registered, none with a diagnostic.
const llm = ctx.get('llm') as
  | { listConfigurableProviders(): Array<{ provider?: unknown; error?: unknown }> }
  | undefined;
let diagnostics: ReturnType<typeof routeDiagnostics>;
try {
  diagnostics = routeDiagnostics(modelPlan, llm?.listConfigurableProviders());
} catch (error) {
  diagnostics = Object.keys(modelPlan.routes).map((provider) => ({
    provider,
    error: `the llm directory could not be read: ${String(error)}`,
  }));
}
for (const diagnostic of diagnostics) {
  warn(`route ${JSON.stringify(diagnostic.provider)} of the plan: ${diagnostic.error}`);
}

const ready = {
  type: 'ready',
  pid: process.pid,
  revision: modelPlan.revision,
  routeDiagnostics: diagnostics,
  node: process.version,
  execPath: process.execPath,
  execArgv: process.execArgv,
  artifact,
  dshRuntimeVersion: appBoot.getDshRuntimeVersion(),
  bundles: composedProfile.layers.map((layer) => layer.packageName),
  skippedPlugins: skipped.plugins,
  // P1-10b (decision 108 rule 8): every allowlisted plugin's state, for Main.
  plugins: pluginReport(
    enabledInput,
    withInactiveRows(layerAudit.plugins, allowlist.plugins, inactiveIds),
    bundlePlan.dropped
  ),
  composition,
  census,
  marks,
  memory: process.memoryUsage(),
};
if (process.connected) process.send?.(ready);
else process.stdout.write(`${JSON.stringify(ready)}\n`);
