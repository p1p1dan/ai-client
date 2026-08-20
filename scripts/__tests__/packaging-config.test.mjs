import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

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

describe('electron-builder.yml (C4)', () => {
  it('has no exclusion rule for the Codex package in files:', () => {
    // The rule targeted the ROOT node_modules, where the codex package has
    // never existed — it was dead from the day it was written, and its comment
    // ("we use system-installed CLIs") contradicts REQ-1 now that we bundle it.
    const excludes = (builderYml.files ?? []).filter(
      (entry) => typeof entry === 'string' && entry.startsWith('!')
    );
    expect(excludes.filter((e) => e.includes('@openai'))).toEqual([]);
  });

  it('does not mention the codex package name anywhere in the file', () => {
    // Comments included: a rule that can never match reads as evidence that
    // the package IS a root dependency. Parsed-YAML-only checking would miss a
    // comment reintroducing exactly that misreading.
    expect(builderYmlText).not.toContain('@openai/codex');
  });

  it('still excludes the Agent SDK binaries it is actually responsible for', () => {
    // Falsifies "deleted one line too many".
    const files = builderYml.files ?? [];
    expect(files).toContain('!node_modules/@anthropic-ai/claude-agent-sdk/vendor/**');
    expect(files).toContain('!node_modules/@anthropic-ai/claude-agent-sdk/cli.js');
  });

  it('keeps the agent-host artifact out of extraResources', () => {
    // It is copied by afterPack instead; an extraResources entry drops its
    // node_modules tree and races rcedit over ~388MB.
    const extra = builderYml.extraResources ?? [];
    for (const entry of extra) {
      const from = typeof entry === 'string' ? entry : entry.from;
      expect(from).not.toContain('out-agent-host');
      expect(from).not.toContain('agent-host');
    }
  });
});

describe('build.yml gate wiring (C5)', () => {
  const jobs = workflow.jobs;

  it('defines the gate job', () => {
    expect(jobs.gate).toBeDefined();
  });

  it('runs all four gates as separate serial steps', () => {
    // Chaining them into one command has OOM'd (exit 137) before.
    const runs = jobs.gate.steps.filter((s) => s.run).map((s) => s.run);
    for (const cmd of ['pnpm typecheck', 'pnpm typecheck:agent-host', 'pnpm lint', 'pnpm test']) {
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
    for (const job of ['build-windows', 'build-linux']) {
      expect([jobs[job].needs].flat()).toContain('build-app');
    }
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

  it('fetches a bundled runtime on both packaging jobs, each for its platform', () => {
    const fetchRun = (job) =>
      jobs[job].steps.find((s) => s.run?.includes('fetch-node-runtime.mjs'))?.run;
    expect(fetchRun('build-windows')).toContain('--platform win32-x64');
    expect(fetchRun('build-linux')).toContain('--platform linux-x64');
  });

  it('keys the runtime cache on the pin file, not a hardcoded version', () => {
    // actions/cache never overwrites an existing key, so a literal key survives
    // a pin bump and keeps restoring the stale runtime forever.
    for (const job of ['build-windows', 'build-linux']) {
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
