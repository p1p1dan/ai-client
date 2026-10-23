import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../renderer/components/chat/__tests__/stripComments';

/**
 * dsh-rebase P1-12 (decisions 004, 130, 147): the self-owned runtime and its
 * native worker retire.
 *
 * Step 1, pinned here: the product and the installer no longer reach the
 * native worker. Nothing in Main or preload launches it, the first-screen
 * readiness check and the permission page's bundled scope no longer read
 * its artifact, and packaging neither builds nor copies `resources/agent-host`.
 *
 * Step 3, pinned below: `src/runtime`, `agent-host/worker.ts` and the worker's
 * npm package are gone; nothing under `src` or `scripts` imports `runtime/` or
 * the retired pi packages; the root manifest neither depends on them nor runs
 * the runtime's scripts; build.yml installs and gates none of it; and
 * verify-packaged-app reads app.asar to prove none of it shipped.
 *
 * Step 4, pinned last: `src/agent-host` itself is gone (its RPC server moved
 * into the DSH bridge, stderr redaction into `src/shared`, the Codex item
 * mapper into Main's legacy import), nothing imports or mocks a path inside
 * it, and no manifest, tsconfig, gate or build script still names it.
 *
 * Earlier retirements, pinned at the end: the Claude Code / Codex agent era
 * (T31, T35) and the pi Extension UI chain (T036, decision 012). The pi TUI's
 * removal is pinned in `piTuiRemovedStatic.test.ts`.
 *
 * Code only where it is code: comments are blanked first, so the prose that
 * explains a removal (like this one) cannot fail the scan.
 */

const SHARED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.dirname(SHARED);
const REPO = path.dirname(SRC);

function repoRelative(file: string): string {
  return path.relative(REPO, file).split(path.sep).join('/');
}

function productFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const entry = path.join(dir, name);
    if (statSync(entry).isDirectory()) productFiles(entry, found);
    else if (/\.(ts|tsx|mts|mjs)$/.test(name)) found.push(entry);
  }
  return found;
}

function code(file: string): string {
  return stripComments(readFileSync(file, 'utf8'), file);
}

function text(relative: string): string {
  return readFileSync(path.join(REPO, relative), 'utf8');
}

const MAIN_AND_PRELOAD = ['main', 'preload'].flatMap((root) => productFiles(path.join(SRC, root)));

/** Anything that names the native worker's entry or its artifact. */
const NATIVE_WORKER_REFERENCE =
  /PiWorkerProcess|resolveCurrentPiWorkerEntryPath|resolvePiWorkerEntryPath|worker\.(js|ts)\b|[\x27\x22\x60]agent-host[\x27\x22\x60]|(\.\.\/){3,}agent-host\/|@gotgenes\/pi-permission-system/;

describe('P1-12 step 1 · the product does not reach the native worker', () => {
  it('walks Main and preload (a walker that found nothing would pass everything)', () => {
    expect(MAIN_AND_PRELOAD.length).toBeGreaterThan(150);
  });

  it('launches no utility process and no native worker anywhere in Main or preload', () => {
    const offenders = MAIN_AND_PRELOAD.filter((file) =>
      /utilityProcess\.fork\(|forkPiWorkerProcess|PiWorkerProcess/.test(code(file))
    ).map(repoRelative);
    expect(offenders).toEqual([]);
    for (const deleted of [
      'src/main/services/agent-host/PiWorkerProcess.ts',
      'src/main/services/agent-host/PiUtilityService.ts',
      'src/main/services/legacyImport/PiImportProcess.ts',
      'src/main/services/chat/NativeSessionIndexAdapter.ts',
      'src/main/services/agent-host/nativeSubagentSettings.ts',
      'src/main/services/agent-host/subagentCatalog.ts',
      'src/main/ipc/piSubagents.ts',
    ]) {
      expect(existsSync(path.join(REPO, deleted)), deleted).toBe(false);
    }
  });

  /**
   * Risk R1 of the plan: with the artifact gone, a check that still looked for
   * `resources/agent-host/worker.js` would put every packaged first screen on
   * `runtime-unavailable`.
   */
  it('judges runtime readiness by the DSH host layout, not the worker artifact', () => {
    const checker = code(path.join(SRC, 'main/services/cli/PiRuntimeChecker.ts'));
    expect(checker).toContain('resolveDshHostLayout(');
    expect(checker).toContain("from '../agent-host/DshHostProcess'");
    expect(checker).not.toMatch(NATIVE_WORKER_REFERENCE);
  });

  /** Risk R2: the bundled scope must not vanish with the artifact. */
  it('builds the permission page’s bundled scope from the shipped table in memory', () => {
    const service = code(path.join(SRC, 'main/services/piPermissionPolicy/index.ts'));
    expect(service).toContain('bundledPolicyScope()');
    expect(service).toContain("from '@shared/permissions/policy'");
    expect(service).not.toMatch(NATIVE_WORKER_REFERENCE);
    expect(service).not.toContain('getBundledPluginDir');
  });
});

describe('P1-12 step 1 · packaging neither builds nor ships the native worker', () => {
  it('afterPack copies only the DSH host and the node runtime', () => {
    const afterPack = code(path.join(REPO, 'scripts/afterPack.mjs'));
    expect(afterPack).toContain('copyDshHost(context);');
    expect(afterPack).not.toContain('copyAgentHost');
    expect(afterPack).not.toContain('out-agent-host');
    expect(afterPack).not.toContain("'agent-host'");
  });

  it('no script or workflow builds the worker artifact any more', () => {
    const pkg = JSON.parse(text('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts).not.toHaveProperty('build:agent-host');
    expect(Object.values(pkg.scripts).join('\n')).not.toContain('build-agent-host');
    expect(text('.github/workflows/build.yml')).not.toContain('build-agent-host');
    for (const deleted of [
      'scripts/build-agent-host.mjs',
      'scripts/agent-host-build-lib.mjs',
      'scripts/packaged-worker-smoke.cjs',
      'scripts/packaged-worker-report.mjs',
    ]) {
      expect(existsSync(path.join(REPO, deleted)), deleted).toBe(false);
    }
  });

  it('verify-packaged-app fails a package that still carries resources/agent-host', () => {
    const verify = code(path.join(REPO, 'scripts/verify-packaged-app.mjs'));
    expect(verify).toMatch(/RETIRED_RESOURCE_DIRS = \[\x27agent-host\x27\]/);
    expect(verify).toContain('checkNoRetiredResources(resourceDir, failures);');
    expect(verify).not.toContain('runWorkerSmoke');
    expect(verify).not.toContain('--skip-smoke');
  });
});

/** Every code file under `src` and `scripts`, tests included, `node_modules` excluded. */
function codeFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const entry = path.join(dir, name);
    if (statSync(entry).isDirectory()) codeFiles(entry, found);
    else if (/\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(name)) found.push(entry);
  }
  return found;
}

/**
 * Module specifiers of import / export-from / dynamic import / require in
 * code, and (P1-12 step 4) of Vitest's module mocks, which name a module path
 * without importing it.
 */
function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /\bfrom\s*(['"])([^'"\n]+)\1/g,
    /(?:^|[\s;])import\s*(['"])([^'"\n]+)\1/g,
    /\b(?:import|require)\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
    /\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<[^>]*>)?\(\s*(['"])([^'"\n]+)\1/g,
  ]) {
    for (const match of source.matchAll(pattern)) found.push(match[2]);
  }
  return found;
}

/** The same, for a file on disk with its comments blanked. */
function specifiers(file: string): string[] {
  return specifiersIn(code(file));
}

const RUNTIME_DIR = path.join(SRC, 'runtime');
const AGENT_HOST_DIR = path.join(SRC, 'agent-host');
const RETIRED_PACKAGES = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@gotgenes/pi-permission-system',
];

const files = ['src', 'scripts'].flatMap((root) => codeFiles(path.join(REPO, root)));
// Parsed once at collection time and shared by steps 3 and 4: two whole-tree
// scans inside test bodies exceeded the 5 s default timeout on a loaded CI
// runner.
const specifiersByFile = new Map(files.map((file) => [file, specifiers(file)] as const));

/** `file -> specifier` for every relative specifier that resolves into `dir`. */
function importsInto(dir: string): string[] {
  const offenders: string[] = [];
  for (const [file, found] of specifiersByFile) {
    for (const specifier of found) {
      if (!specifier.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (target === dir || target.startsWith(`${dir}${path.sep}`)) {
        offenders.push(`${repoRelative(file)} -> ${specifier}`);
      }
    }
  }
  return offenders;
}

describe('P1-12 step 3 · the runtime and the native worker are deleted', () => {
  it('walks src and scripts (a walker that found nothing would pass everything)', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it('leaves no runtime directory, worker entry or worker package behind', () => {
    for (const deleted of [
      'src/runtime',
      'src/agent-host/worker.ts',
      'src/agent-host/package.json',
      'src/agent-host/package-lock.json',
      'src/agent-host/bundledPlugins.mjs',
      'src/agent-host/permissionPolicy.mjs',
      'scripts/patch-pi-permission-system.mjs',
      'scripts/gen-legacy-pi-fixtures.ts',
      'scripts/runtime-baseline/run-native.mjs',
    ]) {
      expect(existsSync(path.join(REPO, deleted)), deleted).toBe(false);
    }
  });

  it('imports nothing from runtime/ anywhere under src or scripts', () => {
    expect(importsInto(RUNTIME_DIR)).toEqual([]);
  });

  /**
   * Merged from `agent-host/__tests__/piCliIsBundledToolOnly.test.ts` (P6-2,
   * P1-11), deleted with the worker package: the app imports none of the pi
   * packages as a library, deep imports included, and now no longer has them
   * to import.
   */
  it('imports none of the retired pi packages, deep imports included', () => {
    const offenders: string[] = [];
    for (const [file, found] of specifiersByFile) {
      for (const specifier of found) {
        if (
          RETIRED_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))
        ) {
          offenders.push(`${repoRelative(file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The matcher itself, so an empty answer above means something.
    expect(
      specifiersIn(
        [
          `import { S } from '${RETIRED_PACKAGES[0]}/dist/core/session-manager.js';`,
          `const core = await import('${RETIRED_PACKAGES[1]}');`,
          `const plugin = require('${RETIRED_PACKAGES[2]}');`,
          "import '../runtime/index.ts';",
        ].join('\n')
      ).sort()
    ).toEqual(
      [
        `${RETIRED_PACKAGES[0]}/dist/core/session-manager.js`,
        RETIRED_PACKAGES[1],
        RETIRED_PACKAGES[2],
        '../runtime/index.ts',
      ].sort()
    );
  });

  it('drops the pi packages and the runtime scripts from the root manifest', () => {
    const pkg = JSON.parse(text('package.json')) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const name of RETIRED_PACKAGES) expect(deps, name).not.toHaveProperty(name);
    for (const script of ['typecheck:runtime', 'smoke:runtime', 'smoke:runtime-tools']) {
      expect(pkg.scripts, script).not.toHaveProperty(script);
    }
    expect(Object.values(pkg.scripts).join('\n')).not.toContain('src/runtime');
    const lock = text('pnpm-lock.yaml');
    for (const name of RETIRED_PACKAGES) expect(lock, name).not.toContain(`'${name}@`);
    expect(text('tsconfig.json')).not.toContain('"src/runtime');
  });

  it('build.yml installs, checks and smokes nothing of the runtime', () => {
    const workflow = text('.github/workflows/build.yml');
    const steps = workflow
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(steps).not.toContain('src/runtime');
    expect(steps).not.toContain('working-directory: src/agent-host');
    for (const retired of ['typecheck:runtime', 'smoke:runtime', 'build-agent-host']) {
      expect(steps, retired).not.toContain(retired);
    }
  });

  it('verify-packaged-app reads app.asar for retired packages and runtime code', () => {
    const verify = code(path.join(REPO, 'scripts/verify-packaged-app.mjs'));
    expect(verify).toContain('checkAppAsar(resourceDir, failures);');
    expect(verify).toContain("from './asar-inspect.mjs'");
    for (const name of [...RETIRED_PACKAGES, "'cordis'", 'NativeWorkerRuntime']) {
      expect(verify, name).toContain(name.startsWith("'") ? name : `'${name}'`);
    }
    // Its own header parser, not the transitive `@electron/asar`.
    expect(verify).not.toContain('@electron/asar');
    expect(code(path.join(REPO, 'scripts/asar-inspect.mjs'))).not.toContain('@electron/asar');
  });
});

describe('P1-12 step 4 · src/agent-host is deleted', () => {
  it('leaves no src/agent-host directory behind', () => {
    expect(existsSync(AGENT_HOST_DIR)).toBe(false);
  });

  it('imports or mocks nothing inside src/agent-host anywhere under src or scripts', () => {
    expect(importsInto(AGENT_HOST_DIR)).toEqual([]);
    // The resolver itself: Main's own `services/agent-host` must not count,
    // and a path that does climb into `src/agent-host` must, mocks included.
    const main = path.join(SRC, 'main/services/chat/x.ts');
    const into = (specifier: string) =>
      path.resolve(path.dirname(main), specifier).startsWith(`${AGENT_HOST_DIR}${path.sep}`);
    expect(into('../agent-host/WorkerManager')).toBe(false);
    expect(into('../../../agent-host/stderrRedaction')).toBe(true);
    expect(specifiersIn("vi.mock('../../../agent-host/stderrRedaction', () => ({}));")).toEqual([
      '../../../agent-host/stderrRedaction',
    ]);
  });

  it('no manifest, tsconfig, gate or DSH build script names src/agent-host', () => {
    const pkg = JSON.parse(text('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts).not.toHaveProperty('typecheck:agent-host');
    expect(Object.values(pkg.scripts).join('\n')).not.toContain('src/agent-host');
    expect(text('tsconfig.json')).not.toContain('src/agent-host');
    expect(text('src/dsh-host/tsconfig.json')).not.toContain('"src/agent-host');
    const steps = text('.github/workflows/build.yml')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(steps).not.toContain('typecheck:agent-host');
    expect(steps).not.toContain('src/agent-host');
    for (const script of ['scripts/dsh-host-build-lib.mjs', 'scripts/build-dsh-host.mjs']) {
      expect(code(path.join(REPO, script)), script).not.toContain('src/agent-host');
    }
  });
});

describe('T31 / T35 · the Claude Code and Codex agent era stays retired', () => {
  it('leaves none of its pickers, detectors, installers or sharing entry points', () => {
    for (const deleted of [
      'src/main/ipc/agent.ts',
      'src/main/ipc/hapi.ts',
      'src/main/ipc/claudeRuntime.ts',
      'src/main/services/agent/AgentRegistry.ts',
      'src/main/services/auth/claudeHome.ts',
      'src/main/services/cli/ClaudeRuntimeChecker.ts',
      'src/main/services/cli/CliDetector.ts',
      'src/shared/models/familyWhitelist.ts',
      'src/shared/models/seedCatalog.ts',
      'src/shared/types/claude.ts',
      'src/shared/types/claudeRuntime.ts',
      'src/shared/types/cli.ts',
      'src/renderer/components/chat/AgentPickerMenu.tsx',
      'src/renderer/components/chat/ComposerAgentPicker.tsx',
      'src/renderer/components/chat/StatusLine.tsx',
      'src/renderer/components/settings/AgentSettings.tsx',
      'src/renderer/components/settings/HapiSettings.tsx',
      'src/renderer/hooks/useManagedMode.ts',
      'src/renderer/stores/agentStatus.ts',
      'packages/bootstrap/cmd/jyw-bootstrap/main.go',
    ]) {
      expect(existsSync(path.join(REPO, deleted)), deleted).toBe(false);
    }
  });

  /**
   * The root manifest only: electron-builder ships every root `dependencies`
   * entry inside app.asar. The Agent SDK engine depends on
   * `@anthropic-ai/claude-agent-sdk` from its own package in
   * `src/claude-sdk-host`, which is why this list is not `RETIRED_PACKAGES`.
   */
  it('keeps the agent packages out of the root manifest', () => {
    const pkg = JSON.parse(text('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const name of [
      '@anthropic-ai/claude-agent-sdk',
      '@cometix/claude-code',
      '@openai/codex',
      '@agentclientprotocol/sdk',
    ]) {
      expect(deps, name).not.toHaveProperty(name);
    }
  });

  it('exposes no legacy CLI, agent-status or remote-sharing IPC', () => {
    const contracts = [
      'src/shared/types/ipc.ts',
      'src/preload/index.ts',
      'src/main/ipc/auth.ts',
      'src/main/services/onboarding/OnboardingService.ts',
    ]
      .map(text)
      .join('\n');
    for (const token of [
      'CLAUDE_RUNTIME_CHECK',
      'CHAT_LIST_AGENT_MODELS',
      'CHAT_UPDATE_PERMISSION',
      'listAgentModels:',
      'CLI_DETECT_ONE',
      'REMOTE_HELPER_',
      'AGENT_LIST',
      'ONBOARDING_INSTALL_AGENTS',
      'HAPI_START',
      'HAPPY_CHECK_GLOBAL',
      'CLOUDFLARED_START',
      'onAgentStop',
      'AUTH_MANAGED_MODE',
      'AGENT_STATUS_UPDATE',
      'AGENT_ASK_USER_QUESTION_NOTIFICATION',
      'AGENT_PRE_TOOL_USE_NOTIFICATION',
      'checkCredentialsHealth',
      'claudeEnvOk',
      'codexAuthOk',
    ]) {
      expect(contracts, token).not.toContain(token);
    }
    expect(text('src/main/ipc/chat.ts')).not.toContain('assertModelMatchesAgent');
  });

  it('the remote helper cannot run a legacy agent or plugin CLI method', () => {
    const helper = text('src/main/services/remote/RemoteServerSource.ts');
    for (const token of [
      "command: 'claude'",
      "command: 'codex'",
      "'cli:detectOne'",
      "'claude:plugins:",
      "'hapi:checkGlobal'",
      "'happy:checkGlobal'",
    ]) {
      expect(helper, token).not.toContain(token);
    }
  });

  it('generic shell sessions have no agent PTY route left', () => {
    // dsh-rebase P1-11 (decision 128): `SessionKind` is `'terminal'` alone, and
    // Main stamps it on every create instead of rejecting `'agent'` — the IPC
    // payload is untyped, and the remote helper still branches on the value.
    const manager = text('src/main/services/session/SessionManager.ts');
    expect(manager).toContain(
      "const options: SessionCreateOptions = { ...requested, kind: 'terminal' };"
    );
    expect(manager).not.toContain("kind === 'agent'");
    expect(manager).not.toContain('Agent PTYs are not supported');
    expect(manager).not.toContain('withManagedClaudeEnv');
    expect(manager).not.toContain('withManagedPiEnv');
    expect(text('src/shared/types/session.ts')).toContain("export type SessionKind = 'terminal';");
  });

  it('keeps the agent-specific permission dialect out of the runtime contracts', () => {
    const contracts = [
      'src/shared/types/runtimeEvents.ts',
      'src/renderer/components/workspace-shell/surfaces/contextSurfaceModel.ts',
      'src/shared/types/onboarding.ts',
      'src/main/ipc/auth.ts',
    ]
      .map(text)
      .join('\n');
    for (const token of [
      'SessionPermissionPreference',
      'SessionPermissionPolicy',
      'session.permissionUpdated',
      'session.settingsEcho',
      "agent: 'claude-code'",
      "agent: 'codex'",
    ]) {
      expect(contracts, token).not.toContain(token);
    }
  });

  it('the composer answers no permission or question', () => {
    // The timeline's card answers permissions and `PendingQuestionDock`
    // answers questions; a composer that could also reply is how one gate
    // gets two answers.
    const composer = text('src/renderer/components/chat/ChatComposer.tsx');
    expect(composer).not.toContain('ComposerAgentPicker');
    for (const legacy of [
      'chat:respondPermission',
      'chat:updatePermission',
      'permissionMode',
      'chat:respondQuestion',
      'respondQuestion',
    ]) {
      expect(composer, legacy).not.toContain(legacy);
    }
    // Decision 169's one exception: the composer closes this chat's pending
    // plan review (always a cancel, never an answer) through this one store
    // action.
    expect(composer).toContain('closePlanReview(');
  });

  it('the legacy import readers import no agent runtime', () => {
    for (const relative of [
      'src/main/services/legacyImport/ClaudeSessionScanner.ts',
      'src/main/services/legacyImport/ClaudeSourceAdapter.ts',
      'src/main/services/legacyImport/codexItemMapper.ts',
    ]) {
      const source = text(relative);
      for (const forbidden of [
        './claudeRuntime',
        './codexRuntime',
        './codexConnection',
        './codexNodeEntry',
        './cometix',
      ]) {
        expect(source, `${relative} -> ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('onboarding copy names no Claude Code or Codex runtime', () => {
    const copy = [
      'src/renderer/Root.tsx',
      'src/renderer/components/onboarding/WelcomeView.tsx',
      'src/renderer/components/onboarding/OnboardingView.tsx',
    ]
      .map(text)
      .join('\n');
    for (const token of ['Claude Code 运行时', 'Claude Code 与 Codex', 'bundled Claude Code']) {
      expect(copy, token).not.toContain(token);
    }
  });
});

/** The Extension UI chain's vocabulary: `extensionUi`, `ExtensionUI`, `extension_ui`, … */
const EXTENSION_UI = /extension[_-]?ui/i;

describe('T036 · the pi Extension UI chain stays retired', () => {
  // The pi-era pipe that let an extension open a dialog, a status line or a
  // notification in the GUI. A deletion this wide is easy to half-undo, so the
  // whole tree is scanned for the vocabulary, comments included, rather than
  // for the files that used to exist.
  it('names the chain nowhere under src or scripts', () => {
    const self = fileURLToPath(import.meta.url);
    const offenders: string[] = [];
    for (const file of files) {
      if (path.resolve(file) === path.resolve(self)) continue;
      // latin1, not utf8: a few generated sources carry NUL bytes, and a
      // decoder that replaces them can drop the surrounding run of text.
      const source = readFileSync(file, 'latin1');
      if (!EXTENSION_UI.test(source)) continue;
      const line = source.split('\n').findIndex((row) => EXTENSION_UI.test(row)) + 1;
      offenders.push(`${repoRelative(file)}:${line}`);
    }
    expect(offenders).toEqual([]);
  });
});
