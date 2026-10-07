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
