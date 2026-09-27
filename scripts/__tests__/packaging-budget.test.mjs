import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DSH_HOST_ARTIFACT_MAX_BYTES,
  DSH_HOST_ARTIFACT_MAX_FILES,
  DSH_HOST_ARTIFACT_TARGET_BYTES,
  evaluateDshHostArtifact,
  evaluateWorkerArtifactSize,
  formatBytes,
  topDirectories,
  WORKER_ARTIFACT_MAX_BYTES,
} from '../packaging-budget.mjs';

describe('worker artifact safety ceiling', () => {
  it('uses an inclusive ceiling', () => {
    expect(evaluateWorkerArtifactSize(WORKER_ARTIFACT_MAX_BYTES).status).toBe('ok');
    expect(evaluateWorkerArtifactSize(WORKER_ARTIFACT_MAX_BYTES + 1).status).toBe('over');
  });

  it('rejects the former Codex-sized payload', () => {
    expect(evaluateWorkerArtifactSize(388 * 1024 * 1024).status).toBe('over');
  });
});

describe('DSH host artifact budget (dsh-rebase decision 014)', () => {
  const MiB = 1024 * 1024;

  it('pins 128 MiB / 12,000 files as ceilings and 110 MiB as the target', () => {
    expect(DSH_HOST_ARTIFACT_MAX_BYTES).toBe(128 * MiB);
    expect(DSH_HOST_ARTIFACT_MAX_FILES).toBe(12_000);
    expect(DSH_HOST_ARTIFACT_TARGET_BYTES).toBe(110 * MiB);
  });

  it('uses inclusive ceilings for bytes and files alike', () => {
    const at = { bytes: DSH_HOST_ARTIFACT_MAX_BYTES, files: DSH_HOST_ARTIFACT_MAX_FILES };
    expect(evaluateDshHostArtifact(at).status).toBe('ok');
    expect(evaluateDshHostArtifact({ ...at, bytes: at.bytes + 1 }).reasons).toEqual(['bytes']);
    expect(evaluateDshHostArtifact({ ...at, files: at.files + 1 }).reasons).toEqual(['files']);
  });

  it('passes the measured B-tier builds and flags the regressions it exists for', () => {
    // 2026-09-27, linux-x64 / win32-x64 / darwin-arm64 builds of 0.1.7-rc.2.
    for (const measured of [
      { bytes: 100_672_732, files: 10_166 },
      { bytes: 103_915_153, files: 10_167 },
      { bytes: 99_326_733, files: 10_168 },
    ]) {
      const verdict = evaluateDshHostArtifact(measured);
      expect(verdict.status).toBe('ok');
      expect(verdict.overTarget).toBe(false);
    }
    // A forgotten .map / .d.ts sweep adds about 55 MiB and some 11k files.
    expect(evaluateDshHostArtifact({ bytes: 156 * MiB, files: 21_000 }).reasons).toEqual([
      'bytes',
      'files',
    ]);
    // Foreign node-pty prebuilds alone (about +23 MiB) end over the target.
    expect(evaluateDshHostArtifact({ bytes: 119 * MiB, files: 10_200 }).overTarget).toBe(true);
  });
});

describe('size diagnostics', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-budget-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('ranks immediate children by recursive size', () => {
    fs.mkdirSync(path.join(tmp, 'big', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'big', 'nested', 'a'), 'x'.repeat(3000));
    fs.writeFileSync(path.join(tmp, 'loose'), 'x'.repeat(500));
    expect(topDirectories(tmp, 2).map((entry) => entry.name)).toEqual(['big', 'loose']);
  });

  it('returns an empty report for a missing directory', () => {
    expect(topDirectories(path.join(tmp, 'missing'))).toEqual([]);
  });

  it('formats binary megabytes', () => {
    expect(formatBytes(256 * 1024 * 1024)).toBe('256.0MiB');
  });
});
