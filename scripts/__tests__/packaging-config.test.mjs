import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { RETIRED_BUNDLED_PLUGIN_PACKAGES } from '../../src/agent-host/bundledPlugins.mjs';
import { copyDshHost, resolveResourcesDir } from '../afterPack.mjs';
import { npmCiArgs, PROBE_BUNDLE } from '../dsh-host-build-lib.mjs';

/**
 * Packaging spec C4 / C5 / C6 — structural assertions on the two config files
 * that no unit test would otherwise reach. These are the "the YAML says one
 * thing and the code says another" class of defect: nothing fails to build,
 * the release is just wrong.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const builderYmlText = readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8');
const builderYml = yaml.load(builderYmlText);
const workflowText = readFileSync(path.join(repoRoot, '.github', 'workflows', 'build.yml'), 'utf8');
const workflow = yaml.load(workflowText);
const workerPackage = JSON.parse(
  readFileSync(path.join(repoRoot, 'src', 'agent-host', 'package.json'), 'utf8')
);
const dshHostDir = path.join(repoRoot, 'src', 'dsh-host');
const dshPackage = JSON.parse(readFileSync(path.join(dshHostDir, 'package.json'), 'utf8'));
const dshLock = JSON.parse(readFileSync(path.join(dshHostDir, 'package-lock.json'), 'utf8'));
const dshBundle = JSON.parse(readFileSync(path.join(dshHostDir, 'bundle', 'package.json'), 'utf8'));

describe('afterPack resource layout', () => {
  it('copies resources inside the macOS app bundle', () => {
    expect(
      resolveResourcesDir({
        appOutDir: '/tmp/dist/mac-arm64',
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'PiLab Ai' } },
      })
    ).toBe(path.join('/tmp/dist/mac-arm64', 'PiLab Ai.app', 'Contents', 'Resources'));
  });

  it('keeps the flat resources directory on Windows and Linux', () => {
    expect(
      resolveResourcesDir({
        appOutDir: '/tmp/dist/linux-unpacked',
        electronPlatformName: 'linux',
        packager: { appInfo: { productFilename: 'PiLab Ai' } },
      })
    ).toBe(path.join('/tmp/dist/linux-unpacked', 'resources'));
  });
});

/**
 * The 1.0.0-test.17 rename: `AiClient` -> `PiLab Ai`, with `pilab-v*` artifact
 * names (`pilab-alpha-v*` until the 1.0.1 drop of the `alpha` marker). Four files
 * have to agree about it, and none of them would
 * fail to BUILD if they drifted — the release would just be wrong, or the
 * artifact upload would find nothing.
 */
describe('product rename and artifact naming', () => {
  const nshText = readFileSync(path.join(repoRoot, 'build', 'installer.nsh'), 'utf8');
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  /** The subset of glob syntax `actions/upload-artifact` paths use here. */
  function matchesGlob(pattern, name) {
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    return new RegExp(`^${source}$`).test(name);
  }

  function expandArtifactName(template, ext) {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder's own macro syntax, not a JS template
    return template.replaceAll('${version}', pkg.version).replaceAll('${ext}', ext);
  }

  it('names the product once, in electron-builder.yml', () => {
    expect(builderYml.productName).toBe('PiLab Ai');
  });

  /**
   * `<userData>`'s basename is the `<profile>` segment of `~/.pilab/<profile>`,
   * so a space in the executable name is a space in the vault's path. The main
   * process pins the directory (`PACKAGED_USER_DATA_DIR_NAME`); this keeps the
   * Windows binary, which every shortcut and registry entry spells by hand,
   * on the same rule.
   */
  it('keeps the Windows executable name space-free', () => {
    expect(builderYml.win.executableName).toBe('PiLabAi');
    expect(builderYml.win.executableName).not.toMatch(/\s/);
  });

  it('registers the URL scheme against the executable the build actually emits', () => {
    // A stale path here does not fail the build: `aiclient://` just stops
    // opening the app after the next rename.
    expect(nshText).toContain(`$INSTDIR\\${builderYml.win.executableName}.exe`);
  });

  it('checks the packaged Windows binary under the name the build emits', () => {
    // This one DOES fail CI — but only after the Windows packaging job has
    // already spent its twenty minutes, which is why it is bound here.
    const verifyText = readFileSync(
      path.join(repoRoot, 'scripts', 'verify-packaged-app.mjs'),
      'utf8'
    );
    expect(verifyText).toContain(`'${builderYml.win.executableName}.exe'`);
  });

  it('produces an installer name the Build workflow can upload', () => {
    // The workflow globs for this literal pattern. An artifactName that dropped
    // "Setup" would make the upload step fail with if-no-files-found: error,
    // AFTER the full 20-minute packaging job.
    const installer = expandArtifactName(builderYml.nsis.artifactName, 'exe');

    expect(installer).toBe(`pilab-v${pkg.version}-Setup.exe`);
    expect(matchesGlob('*Setup*.exe', installer)).toBe(true);
    expect(workflowText).toContain('dist/*Setup*.exe');
  });

  /**
   * The 2026-09-23 decision (「就生产个 linux window macos 的安装包」) cut the
   * Windows portable exe and the Linux deb. Asserted here because the cost of
   * a silent re-add is a 500MB-class asset nobody asked for, and because the
   * two survivors are load-bearing for auto-update: electron-updater needs the
   * macOS zip and the Linux AppImage, and cannot update a deb at all.
   */
  it('builds exactly one installer per platform, plus the macOS update zip', () => {
    expect(builderYml.win.target.map((entry) => entry.target)).toEqual(['nsis']);
    expect(builderYml.linux.target.map((entry) => entry.target)).toEqual(['AppImage']);
    expect(builderYml.mac.target).toEqual(['dmg', 'zip']);
    expect(builderYml.portable).toBeUndefined();
    expect(workflowText).not.toContain('portable*.exe');
    expect(workflowText).not.toContain('dist/*.deb');
  });

  it('keeps the macOS zip suffix the workflow globs for', () => {
    expect(matchesGlob('*-mac.zip', expandArtifactName(builderYml.mac.artifactName, 'zip'))).toBe(
      true
    );
  });

  /**
   * The bundle directory is named after `productName`, and the workflow spells
   * it out twice to hand it to `verify-packaged-app.mjs`. A rename that misses
   * these lines turns the macOS verify step red with "app dir not found".
   */
  it('resolves the macOS bundle path from the current product name', () => {
    expect(workflowText).toContain(`dist/mac-arm64/${builderYml.productName}.app`);
    expect(workflowText).toContain(`dist/mac/${builderYml.productName}.app`);
    // Quoted at the call site, because the name has a space in it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax
    expect(workflowText).toContain('--app-dir "${{ steps.target.outputs.app_dir }}"');
  });
});

describe('electron-builder.yml (C4)', () => {
  it('contains no legacy Claude/Codex execution packaging rules', () => {
    expect(builderYmlText).not.toContain('@openai/codex');
    expect(builderYmlText).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(builderYmlText).not.toContain('@cometix/claude-code');
  });

  it('keeps the agent-host artifact out of extraResources', () => {
    // It is copied by afterPack instead; extraResources drops node_modules.
    const extra = builderYml.extraResources ?? [];
    for (const entry of extra) {
      const from = typeof entry === 'string' ? entry : entry.from;
      expect(from).not.toContain('out-agent-host');
      expect(from).not.toContain('agent-host');
    }
  });

  it('keeps the DSH host artifact out of extraResources and the asar', () => {
    // dsh-rebase P1-2: afterPack copies out-dsh-host to resources/dsh-host.
    for (const entry of builderYml.extraResources ?? []) {
      const from = typeof entry === 'string' ? entry : entry.from;
      expect(from).not.toContain('dsh-host');
    }
    for (const pattern of builderYml.files) expect(String(pattern)).not.toContain('dsh-host');
  });
});

/**
 * dsh-rebase P1-2 — the DSH host package is the chat engine's dependency
 * boundary: every entry is code the packaged host loads. Exact names, exact
 * pins, one DSH version (decisions 003, 013).
 */
describe('DSH host package dependency boundary', () => {
  const pin = dshPackage.dependencies['@deepseek-ai/dsh-base'];

  it('declares exactly the host, the bundle and pnpm', () => {
    expect(Object.keys(dshPackage.dependencies).sort()).toEqual([
      '@aiclient/dsh-app',
      '@deepseek-ai/cordis',
      '@deepseek-ai/cordis-plugin-group',
      '@deepseek-ai/cordis-plugin-include',
      '@deepseek-ai/cordis-plugin-loader',
      '@deepseek-ai/dsh-app-boot',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-launch-environment',
      '@deepseek-ai/dsh-system-prompt',
      'pnpm',
    ]);
    expect(dshPackage.devDependencies).toBeUndefined();
    expect(dshPackage.dependencies['@aiclient/dsh-app']).toBe('file:./bundle');
    expect(dshPackage.dependencies).not.toHaveProperty(PROBE_BUNDLE);
  });

  it('pins every registry dependency exactly', () => {
    for (const [name, spec] of Object.entries(dshPackage.dependencies)) {
      if (name === '@aiclient/dsh-app') continue;
      expect(spec, name).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    }
  });

  it('locks every @deepseek-ai/dsh-* package at the one DSH pin', () => {
    const dsh = Object.entries(dshLock.packages).filter(([rel]) =>
      /(^|\/)node_modules\/@deepseek-ai\/dsh-[^/]+$/.test(rel)
    );
    expect(dsh.length).toBeGreaterThan(100);
    for (const [rel, entry] of dsh) expect(entry.version, rel).toBe(pin);
    expect(dshLock.packages[''].version).toBe(dshPackage.version);
  });

  it('gives the bundle a dsh peer DSH accepts: the pin itself', () => {
    expect(dshBundle.peerDependencies['@deepseek-ai/dsh-llm']).toBe(pin);
    expect(dshLock.packages.bundle.version).toBe(dshBundle.version);
  });

  it('ships no probe row in the product bundle (decision 015)', () => {
    const patch = readFileSync(path.join(dshHostDir, 'bundle', 'cordis.patch.yml'), 'utf8');
    expect(patch).not.toMatch(/id:\s*aiclient-probe\b/);
    expect(patch).not.toContain('compaction-basic');
    const probePatch = readFileSync(
      path.join(dshHostDir, 'tools', 'probe-bundle', 'cordis.patch.yml'),
      'utf8'
    );
    expect(probePatch).toMatch(/id:\s*aiclient-probe\b/);
  });
});

describe('worker package dependency boundary', () => {
  /**
   * The worker's dependency list is a security surface, not a convenience: each
   * entry is code that runs in the Pi utility process alongside the permission
   * gate. The assertion stays EXACT (not a superset check) so an unvetted
   * package cannot arrive unnoticed.
   */
  it('ships only the Pi runtime and the permission package', () => {
    expect(Object.keys(workerPackage.dependencies).sort()).toEqual([
      '@earendil-works/pi-coding-agent',
      '@gotgenes/pi-permission-system',
    ]);
    expect(Object.keys(workerPackage.devDependencies ?? {})).toEqual([]);
  });

  it('declares every worker dependency as an exact pin', () => {
    // A range here would let `npm install` drift the package out from under the
    // artifact verification, which asserts specific file paths inside it.
    for (const pkg of Object.keys(workerPackage.dependencies)) {
      expect(workerPackage.dependencies[pkg], pkg).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('no longer declares the two retired pi feature extensions', () => {
    // T025: ~1.7 MB of payload with no loader since P6-5. Asserted on the
    // manifest as well as on the copy filter, because a stray `npm install`
    // here is how they would come back.
    for (const name of RETIRED_BUNDLED_PLUGIN_PACKAGES) {
      expect(workerPackage.dependencies).not.toHaveProperty(name);
    }
  });
});

describe('build.yml gate wiring (C5)', () => {
  const jobs = workflow.jobs;

  it('defines the gate job', () => {
    expect(jobs.gate).toBeDefined();
  });

  it('runs all release gates as separate serial steps', () => {
    // Chaining the heavy gates into one command has OOM'd (exit 137) before.
    const runs = jobs.gate.steps.filter((s) => s.run).map((s) => s.run);
    for (const cmd of [
      'pnpm typecheck',
      'pnpm typecheck:agent-host',
      'pnpm typecheck:dsh-host',
      'pnpm lint',
      'pnpm test',
      'pnpm verify:release',
    ]) {
      expect(runs, cmd).toContain(cmd);
    }
  });

  it('blocks both packaging entry points on the gate', () => {
    // Two edges, and BOTH are load-bearing: build-remote-runtime-linux has no
    // path through build-app, so without its own edge a red gate still ships
    // its asset into the release.
    expect(jobs['build-app'].needs).toContain('gate');
    expect(jobs['build-remote-runtime-linux'].needs).toContain('gate');
  });

  it('leaves every packaging job transitively gated', () => {
    for (const job of ['build-windows', 'build-linux', 'build-macos']) {
      expect([jobs[job].needs].flat()).toContain('build-app');
    }
    // `build-macos` is NOT in this list: d0d129bc (2026-09-23) took it off the
    // tag path — unsigned dmg, never a download, and hdiutil was blocking every
    // release. It still exists and is still gated above (dispatch-only).
    expect([jobs['generate-release-notes'].needs].flat().sort()).toEqual(
      ['build-remote-runtime-linux', 'build-linux', 'build-windows'].sort()
    );
  });

  it('gives every job a timeout so a hang cannot burn the 360-minute default', () => {
    for (const [name, job] of Object.entries(jobs)) {
      expect(job['timeout-minutes'], `${name} has no timeout-minutes`).toBeGreaterThan(0);
    }
  });
});

describe('build.yml node runtime steps (C6, D36④)', () => {
  const jobs = workflow.jobs;

  it('no longer installs Node 24 just to make the packaged-state verify pass', () => {
    // That step existed because Linux shipped no bundled runtime. It does now,
    // and leaving the step in would let machine Node cover for a broken bundle.
    expect(workflowText).not.toContain('Setup Node.js 24 (packaged-state verify)');
  });

  it('fetches a bundled runtime on every packaging job for its native platform', () => {
    const fetchRun = (job) =>
      jobs[job].steps.find((s) => s.run?.includes('fetch-node-runtime.mjs'))?.run;
    expect(fetchRun('build-windows')).toContain('--platform win32-x64');
    expect(fetchRun('build-linux')).toContain('--platform linux-x64');
    expect(fetchRun('build-macos')).toContain(`--platform \${{ steps.target.outputs.platform }}`);
  });

  it('keys the runtime cache on the pin file, not a hardcoded version', () => {
    // actions/cache never overwrites an existing key, so a literal key survives
    // a pin bump and keeps restoring the stale runtime forever.
    for (const job of ['build-windows', 'build-linux', 'build-macos']) {
      // Match on the cached path: these jobs also cache the pnpm store, and
      // picking the first actions/cache step would assert against that one.
      const cacheStep = jobs[job].steps.find(
        (s) => s.uses?.startsWith('actions/cache') && s.with?.path === 'out-node-runtime'
      );
      expect(cacheStep, job).toBeDefined();
      expect(cacheStep.with.key, job).toContain("hashFiles('scripts/node-runtime-pin.mjs')");
      expect(cacheStep.with.key, job).not.toMatch(/24\.18\.0/);
    }
  });
});

describe('local packaging is host-platform only (#9, user decision 2026-08-21)', () => {
  const jobs = workflow.jobs;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  // dist:prereq stages HOST inputs (fetch-node-runtime defaults to
  // process.platform and build-agent-host prunes target-specific Pi dependencies)
  // while afterPack takes TARGET files. Every packaging entry
  // point must refuse the mismatch before any of that work happens.
  const guarded = [
    ['build:win', 'win32-x64'],
    ['build:linux', 'linux-x64'],
    ['build:mac', 'darwin'],
    ['build:mac:unsigned', 'darwin'],
    ['build:mac:debug', 'darwin'],
  ];

  for (const [script, target] of guarded) {
    it(`${script} asserts the target before dist:prereq`, () => {
      const command = pkg.scripts[script];
      expect(command, script).toBeDefined();
      // Order matters: guarding after dist:prereq would still burn the download
      // and the 400MB copy before refusing.
      expect(command, script).toMatch(
        new RegExp(`^node scripts/assert-build-target\\.mjs ${target} &&`)
      );
      expect(command.indexOf('assert-build-target'), script).toBeLessThan(
        command.indexOf('dist:prereq')
      );
    });
  }

  it('the guard exits 0 for this host and 1 for a foreign target', () => {
    const run = (target) =>
      spawnSync(
        process.execPath,
        [path.join(repoRoot, 'scripts/assert-build-target.mjs'), target],
        {
          encoding: 'utf8',
        }
      );

    expect(run(`${process.platform}-${process.arch}`).status).toBe(0);
    expect(run(process.platform).status).toBe(0);

    const foreign = run('nosuchplatform-x64');
    expect(foreign.status).toBe(1);
    // The message has to name both sides, or the reader cannot tell what to do.
    expect(foreign.stderr).toContain('nosuchplatform-x64');
    expect(foreign.stderr).toContain(`${process.platform}-${process.arch}`);
  });

  it('no agent-host npm cache step survives (REQ-7: measured zero gain)', () => {
    for (const job of ['build-windows', 'build-linux']) {
      const steps = jobs[job].steps.filter((step) => step.uses?.startsWith('actions/cache'));
      const paths = steps.map((step) => String(step.with?.path ?? ''));
      expect(
        paths.some((p) => /npm-cache|\.npm/.test(p)),
        job
      ).toBe(false);
    }
  });

  it('uses the worker manifest in the gate and omits dev dependencies for packaging', () => {
    const installRun = (job) =>
      jobs[job].steps.find((step) => step['working-directory'] === 'src/agent-host')?.run;
    expect(installRun('gate')).toBe('npm ci --omit=optional');
    expect(installRun('build-windows')).toBe('npm ci --omit=dev --omit=optional');
    expect(installRun('build-linux')).toBe('npm ci --omit=dev --omit=optional');
  });

  it('installs the DSH host with its optional platform packages (decision 013)', () => {
    // --omit=optional would drop koffi, ripgrep, sharp, NARB and node-addon-system.
    const gate = jobs.gate.steps.find((step) => step['working-directory'] === 'src/dsh-host');
    expect(gate?.run).toBe('npm ci --ignore-scripts --no-audit --no-fund');
    for (const args of [
      npmCiArgs({ platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'x64' }),
      npmCiArgs({ platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'x64' }),
    ]) {
      expect(args.join(' ')).not.toContain('--omit');
    }
  });

  it('builds the DSH host artifact before electron-builder on every packaging job', () => {
    for (const job of ['build-windows', 'build-linux', 'build-macos']) {
      const steps = jobs[job].steps;
      const build = steps.findIndex((s) => s.run === 'node scripts/build-dsh-host.mjs');
      const pack = steps.findIndex((s) => s.run?.includes('electron-builder'));
      expect(build, job).toBeGreaterThanOrEqual(0);
      expect(build, job).toBeLessThan(pack);
      const verify = steps.find((s) => s.run?.includes('verify-packaged-app.mjs'));
      expect(verify.run, job).toContain('--dsh-report-file');
      expect(verify.run, job).not.toContain('--skip-dsh-smoke');
      const upload = steps.find((s) => s.name === 'Upload DSH host evidence');
      expect(upload?.with?.path, job).toContain('out-dsh-host/dsh-host-manifest.json');
    }
  });

  it('smokes the Windows package once more from a path with a space', () => {
    const run = jobs['build-windows'].steps.find(
      (s) => s.name === 'DSH host smoke from a path with a space'
    )?.run;
    expect(run).toContain("'C:\\p12app\\PiLab Ai'");
    expect(run).toContain('packaged-dsh-host-smoke.mjs --app-dir $dir --level 1');
  });

  it('stages the DSH host in dist:prereq', () => {
    expect(pkg.scripts['build:dsh-host']).toBe('node scripts/build-dsh-host.mjs');
    expect(pkg.scripts['dist:prereq']).toContain('pnpm build:dsh-host');
  });

  it('every job runs Node 24, matching src/agent-host engines', () => {
    // Three contradictory Node truths (.nvmrc 22 / CI 20 / engines >=24) cost a
    // full red CI run once already: Node 20 has no --experimental-strip-types.
    const engines = JSON.parse(
      readFileSync(path.join(repoRoot, 'src/agent-host/package.json'), 'utf8')
    ).engines.node;
    expect(engines).toBe('>=24');

    for (const [name, job] of Object.entries(jobs)) {
      const setup = job.steps?.filter((step) => step.uses?.startsWith('actions/setup-node')) ?? [];
      for (const step of setup) {
        expect(String(step.with['node-version']), name).toBe('24');
      }
    }
  });
});

describe('[FB9-5] the no-bundled-webfont red line has an artifact-level gate', () => {
  const gate = readFileSync(new URL('../assert-no-webfonts.mjs', import.meta.url), 'utf8');

  /**
   * The source scan in `chatMarkdownPolicy.test.ts` forbids the one import that
   * would pull KaTeX's faces in. This asserts the OTHER half exists: something
   * checks the built output, where the rule actually lives, and it runs in the
   * pipeline rather than as a unit test that skips itself when `out/` is absent.
   */
  it('the gate scans the built renderer for font assets and inlined faces', () => {
    expect(gate).toContain("join(ROOT, 'out', 'renderer')");
    for (const ext of ['.woff2', '.woff', '.ttf', '.otf']) {
      expect(gate, `${ext} must be caught`).toContain(ext);
    }
    // A face inlined as a data URI never lands as a file — that is exactly what
    // importing `katex.min.css` does, so scanning for files alone would miss it.
    expect(gate).toContain('@font-face');
    expect(gate).toMatch(/data:\(\?:font/);
    // Absent output is a failure, not a pass: a gate that green-lights when it
    // cannot see anything is worse than no gate.
    expect(gate).toContain('does not exist');
  });

  it('the gate runs before packaging, on every platform build', () => {
    const scripts = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ).scripts;
    expect(scripts['dist:prereq']).toContain('assert-no-webfonts.mjs');
    // …and after the build that produces what it scans.
    expect(scripts['dist:prereq'].indexOf('pnpm build')).toBeLessThan(
      scripts['dist:prereq'].indexOf('assert-no-webfonts.mjs')
    );
  });
});

describe('afterPack copies the DSH host for its own target only (dsh-rebase P1-2)', () => {
  const afterPackText = readFileSync(path.join(repoRoot, 'scripts', 'afterPack.mjs'), 'utf8');

  function context(root, platform) {
    return {
      appOutDir: path.join(root, 'app'),
      electronPlatformName: platform,
      arch: 1,
      packager: { info: { projectDir: root }, appInfo: { productFilename: 'PiLab Ai' } },
    };
  }

  function artifact(root, target) {
    const out = path.join(root, 'out-dsh-host');
    for (const rel of ['host.js', 'package.json', 'node_modules/@aiclient/dsh-app/lib/bridge.js']) {
      mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
      writeFileSync(path.join(out, rel), '// x\n');
    }
    writeFileSync(
      path.join(out, 'dsh-host-manifest.json'),
      JSON.stringify({ version: '0.1.0', dsh: '0.1.7-rc.2', target })
    );
  }

  it('copies a matching artifact to resources/dsh-host', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'afterpack-dsh-'));
    try {
      artifact(root, { platform: 'linux', arch: 'x64' });
      copyDshHost(context(root, 'linux'));
      expect(readFileSync(path.join(root, 'app', 'resources', 'dsh-host', 'host.js'), 'utf8')).toBe(
        '// x\n'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an artifact built for another platform or none at all', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'afterpack-dsh-'));
    try {
      expect(() => copyDshHost(context(root, 'linux'))).toThrow(/pnpm build:dsh-host/);
      artifact(root, { platform: 'darwin', arch: 'arm64' });
      expect(() => copyDshHost(context(root, 'linux'))).toThrow(
        /built for darwin-arm64, not linux-x64/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the Windows TSD rewrite over resources/dsh-host too', () => {
    expect(afterPackText).toContain("path.join(context.appOutDir, 'resources', 'dsh-host')");
    expect(afterPackText).toMatch(/copyAgentHost\(context\);\s+copyDshHost\(context\);/);
  });
});
