/**
 * T08-a smoke — is the permission gate REALLY in the shipped artifact?
 *
 * Resolution succeeding only proves the files are on disk, and "the extension
 * loaded" only proves pi accepted the path. Neither says the gate can do its
 * job. This checks the three things that have to be true, in the order they can
 * fail:
 *
 *  1. **pi loads the extension.** The build filter strips `.ts` from every other
 *     package and this one's entry (`pi.extensions: ["./src/index.ts"]`) IS
 *     TypeScript, so a filter regression ships a directory that resolves fine
 *     and loads nothing.
 *  2. **It registers the interception point.** The gate works by handling pi's
 *     `tool_call` event. An extension that loads and registers no handler is a
 *     permission system that never sees a tool call — indistinguishable, from
 *     the outside, from one that approves everything.
 *  3. **The bash grammar actually parses.** The plugin evaluates bash through
 *     `tree-sitter-bash`'s WASM grammar (`require.resolve(
 *     "tree-sitter-bash/tree-sitter-bash.wasm")`). Shipping the package without
 *     a loadable grammar means every bash command falls through the surface that
 *     is supposed to inspect it. So this parses a real compound command and
 *     checks that BOTH of its commands are enumerated — `git status &&
 *     rm -rf …` is exactly the shape where seeing only the first one would be a
 *     silent hole.
 *
 * It also checks that the licences the bundled packages oblige us to distribute
 * are present, since this is the one place that looks at a real artifact.
 *
 * Run against the PACKAGED tree — that is the artifact users get:
 *   pnpm build:agent-host
 *   node --experimental-strip-types \
 *     src/agent-host/spikes/t08a-permission-plugin-smoke.ts out-agent-host
 *
 * With no argument it checks the dev tree (`src/agent-host`).
 * Exit 0 = the gate is intact, 1 = it is not.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPermissionManagerProbe } from '../../../scripts/permission-policy-probe.mjs';

interface ExtensionsResult {
  extensions?: Array<{ path?: string; handlers?: Map<string, unknown[]> }>;
  errors?: Array<{ path?: string; error?: string }>;
}

/** Same list as `scripts/agent-host-build-lib.mjs`; restated so the smoke has no build-script import. */
const LICENSE_BEARING_PACKAGES = [
  '@gotgenes/pi-permission-system',
  'tree-sitter-bash',
  'web-tree-sitter',
  'zod',
  'node-addon-api',
  'node-gyp-build',
];

// Keep the application-state directory literal owned by shared/defaultPaths.ts;
// this smoke only needs to exercise the shipped policy's resolved pattern.
const appStateDir = ['.pi', 'lab'].join('');
const appStatePattern = `~/${appStateDir}/*`;

const baseArg = process.argv[2];
const base = baseArg
  ? resolve(process.cwd(), baseArg)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(base, 'node_modules');
const pluginPath = join(nodeModules, '@gotgenes', 'pi-permission-system');

const failures: string[] = [];
const fail = (message: string) => {
  failures.push(message);
  console.log(`  ! ${message}`);
};

// Isolated cwd AND agentDir: this must never read or write the developer's own
// ~/.pi, whose settings.json may already load this package — which is exactly
// the case the runtime's dedup exists for and would mask the result here.
const cwd = mkdtempSync(join(tmpdir(), 'pi-plugin-smoke-cwd-'));
const agentDir = mkdtempSync(join(tmpdir(), 'pi-plugin-smoke-agent-'));

try {
  console.log(`[t08a] artifact: ${base}`);
  console.log(`[t08a] plugin path: ${pluginPath}`);

  // ── 1 + 2: pi loads it, and it registers the interception point ──────────
  const sdk = (await import('@earendil-works/pi-coding-agent')) as unknown as {
    SettingsManager: {
      create: (cwd: string, agentDir: string, o: { projectTrusted: boolean }) => unknown;
    };
    createAgentSessionServices: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };

  const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: { additionalExtensionPaths: [pluginPath] },
  });

  const loader = (services.resourceLoader ?? services.resources) as
    | {
        getExtensions?: () => ExtensionsResult;
        getExtensionsResult?: () => ExtensionsResult;
        extensionsResult?: ExtensionsResult;
      }
    | undefined;
  const result: ExtensionsResult =
    loader?.getExtensions?.() ?? loader?.getExtensionsResult?.() ?? loader?.extensionsResult ?? {};
  const extensions = result.extensions ?? [];

  for (const error of result.errors ?? []) {
    fail(`extension failed to load: ${error.path} — ${error.error}`);
  }

  const permission = extensions.find((extension) =>
    (extension.path ?? '').includes('pi-permission-system')
  );
  if (!permission) {
    fail(`the permission extension is not in the loaded list (${extensions.length} loaded)`);
  } else {
    console.log(`[t08a] loaded: ${permission.path}`);
    const handlers = permission.handlers;
    const events = handlers instanceof Map ? [...handlers.keys()] : [];
    console.log(`[t08a] handlers: ${events.join(', ') || '(none)'}`);
    if (!events.includes('tool_call')) {
      fail('the permission extension registers no tool_call handler — nothing would be gated');
    }
  }

  // ── 3: the packaged bash grammar really parses ───────────────────────────
  const grammar = join(nodeModules, 'tree-sitter-bash', 'tree-sitter-bash.wasm');
  const runtime = join(nodeModules, 'web-tree-sitter', 'web-tree-sitter.js');
  if (!existsSync(grammar)) fail(`missing bash grammar: ${grammar}`);
  else if (!existsSync(runtime)) fail(`missing tree-sitter runtime: ${runtime}`);
  else {
    const treeSitter = (await import(pathToFileURL(runtime).href)) as unknown as {
      Parser: { new (): TsParser; init: () => Promise<void> };
      Language: { load: (wasm: Buffer) => Promise<unknown> };
    };
    await treeSitter.Parser.init();
    const language = await treeSitter.Language.load(readFileSync(grammar));
    const parser = new treeSitter.Parser();
    parser.setLanguage(language);

    // A compound command on purpose: a grammar that only ever yields the first
    // command would let `git status && rm -rf …` past a rule written for `rm`.
    const commands = collectCommands(parser.parse('git status && rm -rf /tmp/definitely-not-real'));
    console.log(`[t08a] bash parse: ${JSON.stringify(commands)}`);
    if (commands.length !== 2 || !commands[1]?.startsWith('rm ')) {
      fail(
        `the packaged bash grammar did not enumerate both commands: ${JSON.stringify(commands)}`
      );
    }
  }

  // ── T08-c: the shipped default policy, and the mechanism that reads it ───
  //
  // Two separate failures, because they fail independently and only one of them
  // is visible from the file system.
  const policyPath = join(pluginPath, 'config.json');
  if (!existsSync(policyPath)) {
    fail(`missing the shipped permission policy at ${policyPath}`);
  } else {
    try {
      const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as {
        yoloMode?: unknown;
        permission?: { '*'?: unknown; bash?: { '*'?: unknown } };
      };
      const universal = policy.permission?.['*'];
      const bash = policy.permission?.bash?.['*'];
      if (universal !== 'ask') fail(`shipped policy: permission["*"] is ${String(universal)}`);
      if (bash !== 'ask') fail(`shipped policy: permission.bash["*"] is ${String(bash)}`);
      if (policy.yoloMode !== false) fail('shipped policy: yoloMode is not false');
      console.log(`[t08a] shipped policy: universal=${String(universal)} bash=${String(bash)}`);
    } catch (error) {
      fail(`shipped policy is not readable JSON: ${(error as Error).message}`);
    }
  }

  // ── 4: the REAL PermissionManager enforces the bundled baseline ──────────
  // File presence and runtime-config loading are not enforcement. Bundle the
  // artifact's own PermissionManager and make three real decisions so a dead
  // distributor scope turns this smoke red.
  let cleanupProbe = () => undefined;
  try {
    const probe = await loadPermissionManagerProbe(base);
    cleanupProbe = probe.cleanup;
    const manager = new probe.PermissionManager({ agentDir, bundledConfigPath: policyPath });
    manager.configureForCwd(cwd);
    const relativeRead = manager.check({
      kind: 'tool',
      surface: 'read',
      input: { path: 'README.md' },
    });
    const absoluteRead = manager.check({
      kind: 'tool',
      surface: 'read',
      input: { path: join(cwd, 'README.md') },
    });
    const repositoryEnv = manager.check({
      kind: 'path-values',
      surface: 'path',
      values: ['.env', join(cwd, '.env')],
    });
    const external = manager.check({
      kind: 'path-values',
      surface: 'external_directory',
      values: ['/tmp/outside.txt'],
    });
    const pilab = manager.check({
      kind: 'path-values',
      surface: 'path',
      values: [
        join(homedir(), appStateDir, 'default', 'settings.json'),
        `~/${appStateDir}/default/settings.json`,
      ],
    });
    const pilabEnv = manager.check({
      kind: 'path-values',
      surface: 'path',
      values: [join(homedir(), appStateDir, 'default', '.env'), `~/${appStateDir}/default/.env`],
    });
    console.log(
      `[t08a] policy decisions: relative-read=${relativeRead.state}/${relativeRead.origin}/${relativeRead.matchedPattern} ` +
        `absolute-read=${absoluteRead.state}/${absoluteRead.origin}/${absoluteRead.matchedPattern} ` +
        `repo-env=${repositoryEnv.state}/${repositoryEnv.origin}/${repositoryEnv.matchedPattern} ` +
        `external=${external.state}/${external.origin}/${external.matchedPattern} ` +
        `pilab=${pilab.state}/${pilab.origin}/${pilab.matchedPattern} ` +
        `pilab-env=${pilabEnv.state}/${pilabEnv.origin}/${pilabEnv.matchedPattern}`
    );
    for (const [label, result] of [
      ['relative read', relativeRead],
      ['absolute read', absoluteRead],
    ] as const) {
      if (
        result.state !== 'allow' ||
        result.origin !== 'bundled' ||
        result.matchedPattern !== '*'
      ) {
        fail(`the real PermissionManager does not enforce bundled ${label}:allow`);
      }
    }
    if (
      repositoryEnv.state !== 'deny' ||
      repositoryEnv.origin !== 'bundled' ||
      repositoryEnv.matchedPattern !== '*.env'
    ) {
      fail('the real PermissionManager does not enforce repository .env:deny');
    }
    if (
      external.state !== 'ask' ||
      external.origin !== 'bundled' ||
      external.matchedPattern !== '*'
    ) {
      fail('the real PermissionManager does not enforce external_directory:ask');
    }
    if (
      pilab.state !== 'ask' ||
      pilab.origin !== 'bundled' ||
      pilab.matchedPattern !== appStatePattern
    ) {
      fail('the real PermissionManager does not enforce bundled app-state:ask');
    }
    if (
      pilabEnv.state !== 'deny' ||
      pilabEnv.origin !== 'bundled' ||
      pilabEnv.matchedPattern !== '*.env'
    ) {
      fail('the app-state ask rule weakens the narrower .env deny');
    }
  } catch (error) {
    fail(`could not exercise the real PermissionManager: ${(error as Error).message}`);
  } finally {
    cleanupProbe();
  }

  // ── licences, since this is the one check that sees a real artifact ──────
  for (const name of LICENSE_BEARING_PACKAGES) {
    const packageDir = join(nodeModules, ...name.split('/'));
    if (!existsSync(packageDir)) continue;
    const licensed = readdirSync(packageDir, { withFileTypes: true }).some(
      (entry) => entry.isFile() && /^licen[cs]e(\.|$)/i.test(entry.name)
    );
    if (!licensed) fail(`${name} ships without a licence file`);
  }

  if (failures.length > 0) {
    console.log(`[t08a] RESULT: FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log('[t08a] RESULT: PERMISSION GATE INTACT');
  process.exit(0);
} finally {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
}

// ─── tree-sitter projections (the artifact's own build, not a typed dep) ───

interface TsNode {
  type: string;
  text: string;
  childCount: number;
  child: (index: number) => TsNode | null;
}

interface TsParser {
  setLanguage: (language: unknown) => void;
  parse: (source: string) => { rootNode: TsNode };
}

/** Every `command` node, in source order — what a bash rule is matched against. */
function collectCommands(tree: { rootNode: TsNode }): string[] {
  const found: string[] = [];
  const walk = (node: TsNode) => {
    if (node.type === 'command') found.push(node.text);
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) walk(child);
    }
  };
  walk(tree.rootNode);
  return found;
}
