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

describe('DSH host artifact budget (dsh-rebase decision 014, re-set by P1-10a)', () => {
  const MiB = 1024 * 1024;

  it('pins 100 MiB / 11,000 files as ceilings and 92 MiB as the target', () => {
    expect(DSH_HOST_ARTIFACT_MAX_BYTES).toBe(100 * MiB);
    expect(DSH_HOST_ARTIFACT_MAX_FILES).toBe(11_000);
    expect(DSH_HOST_ARTIFACT_TARGET_BYTES).toBe(92 * MiB);
  });

  it('uses inclusive ceilings for bytes and files alike', () => {
    const at = { bytes: DSH_HOST_ARTIFACT_MAX_BYTES, files: DSH_HOST_ARTIFACT_MAX_FILES };
    expect(evaluateDshHostArtifact(at).status).toBe('ok');
    expect(evaluateDshHostArtifact({ ...at, bytes: at.bytes + 1 }).reasons).toEqual(['bytes']);
    expect(evaluateDshHostArtifact({ ...at, files: at.files + 1 }).reasons).toEqual(['files']);
  });

  it('passes the measured B-tier builds and flags the regressions it exists for', () => {
    // 2026-09-27, linux-x64 / win32-x64 / darwin-arm64 builds of 0.1.7-rc.2
    // without pnpm (P1-10a; with it they were 100.7 / 103.9 / 99.3 MB).
    const measured = [
      { bytes: 86_083_867, files: 9_760 },
      { bytes: 88_692_319, files: 9_758 },
      { bytes: 84_333_068, files: 9_760 },
    ];
    for (const build of measured) {
      const verdict = evaluateDshHostArtifact(build);
      expect(verdict.status).toBe('ok');
      expect(verdict.overTarget).toBe(false);
      // Foreign node-pty prebuilds (about +23 MiB) cross the ceiling on every platform.
      expect(
        evaluateDshHostArtifact({ bytes: build.bytes + 23 * MiB, files: build.files + 60 }).reasons
      ).toEqual(['bytes']);
      // Three default-size plugins (5 MiB / 500 files each) still fit.
      expect(
        evaluateDshHostArtifact({ bytes: build.bytes + 15 * MiB, files: build.files + 1_200 })
          .status
      ).toBe('ok');
    }
    // A forgotten .map / .d.ts sweep adds about 55 MiB and some 11k files.
    expect(evaluateDshHostArtifact({ bytes: 140 * MiB, files: 20_700 }).reasons).toEqual([
      'bytes',
      'files',
    ]);
    // The pnpm-carrying builds would now end over the target.
    expect(evaluateDshHostArtifact({ bytes: 103_915_153, files: 10_167 }).overTarget).toBe(true);
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
