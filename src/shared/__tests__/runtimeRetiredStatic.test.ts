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
 * Step 3 adds the rest: `src/runtime` and `agent-host/worker.ts` gone, no
 * import of `runtime/` under `src` or `scripts`, no pi packages in the root
 * dependencies, no `src/runtime` in build.yml.
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
