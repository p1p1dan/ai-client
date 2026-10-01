import fs from 'node:fs';
import path from 'node:path';

/**
 * DSH host artifact (dsh-rebase decision 014, re-set by P1-10a as it foresaw).
 * B-tier pruning measured 95-99 MiB and 10.2k files per platform with pnpm;
 * without it (decision 058) 80.4-84.6 MiB and 9.76k files. The ceilings fail
 * verification; the target is reported. They leave room for about three
 * default-size plugins (5 MiB / 500 files each), while a forgotten
 * `.map/.d.ts` sweep (+55 MiB), foreign node-pty prebuilds (+23 MiB) or
 * sharp's musl / wasm32 variants (+27 MiB) each still cross them.
 */
export const DSH_HOST_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;
export const DSH_HOST_ARTIFACT_MAX_FILES = 11_000;
export const DSH_HOST_ARTIFACT_TARGET_BYTES = 92 * 1024 * 1024;

export function evaluateDshHostArtifact({ bytes, files }) {
  const reasons = [];
  if (bytes > DSH_HOST_ARTIFACT_MAX_BYTES) reasons.push('bytes');
  if (files > DSH_HOST_ARTIFACT_MAX_FILES) reasons.push('files');
  return {
    status: reasons.length === 0 ? 'ok' : 'over',
    reasons,
    overTarget: bytes > DSH_HOST_ARTIFACT_TARGET_BYTES,
    bytes,
    files,
    ceiling: { bytes: DSH_HOST_ARTIFACT_MAX_BYTES, files: DSH_HOST_ARTIFACT_MAX_FILES },
  };
}

/**
 * One preinstalled plugin (decision 058), measured after pruning over its
 * package and the closure it brings: 5 MiB / 500 files unless its allowlist
 * entry carries `limits` approved in the review record.
 */
export const DSH_PLUGIN_MAX_BYTES = 5 * 1024 * 1024;
export const DSH_PLUGIN_MAX_FILES = 500;

export function evaluateDshPlugin({ bytes, files }, limits = undefined) {
  const ceiling = {
    bytes: limits?.maxBytes ?? DSH_PLUGIN_MAX_BYTES,
    files: limits?.maxFiles ?? DSH_PLUGIN_MAX_FILES,
  };
  const reasons = [];
  if (bytes > ceiling.bytes) reasons.push('bytes');
  if (files > ceiling.files) reasons.push('files');
  return { status: reasons.length === 0 ? 'ok' : 'over', reasons, bytes, files, ceiling };
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
