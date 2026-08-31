import fs from 'node:fs';
import path from 'node:path';

/**
 * Worker-only safety ceiling. Missing runtime pieces are structural failures in
 * verifyArtifact(); this ceiling exists only to catch an accidentally restored
 * legacy CLI/platform payload. It is intentionally not derived from the old
 * Claude/Codex A0 + P budget.
 */
export const WORKER_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;

export function evaluateWorkerArtifactSize(bytes) {
  return {
    status: bytes <= WORKER_ARTIFACT_MAX_BYTES ? 'ok' : 'over',
    bytes,
    ceiling: WORKER_ARTIFACT_MAX_BYTES,
  };
}

export function topDirectories(dir, limit = 10) {
  const measure = (target) => {
    let total = 0;
    let entries;
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) total += measure(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          // A diagnostic walk tolerates a file disappearing mid-report.
        }
      }
    }
    return total;
  };

  let children;
  try {
    children = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return children
    .map((entry) => {
      const full = path.join(dir, entry.name);
      return {
        name: entry.name,
        bytes: entry.isDirectory() ? measure(full) : fs.statSync(full).size,
        isDirectory: entry.isDirectory(),
      };
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

export function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}
