import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
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
