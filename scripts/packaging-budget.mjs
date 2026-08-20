/**
 * Size budget for the packaged agent-host payload (REQ-14, packaging spec §6.3).
 *
 * Pure: no IO beyond the explicit directory walk in topDirectories(), no
 * process reads. Consumed by verify-packaged-app.mjs and its unit tests.
 *
 * All figures are BYTES as measured by dirSize() — never `du` block usage. The
 * two differ by ~19% on this tree, which is more than the entire headroom, so
 * mixing the units silently invents budget that is not there.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CODEX_BINARY_FLOOR } from './agent-host-build-lib.mjs';

// Re-exported so the packaged verifier and the build-time preflight assert the
// same single constant rather than each carrying a copy (spec §6.3).
export { CODEX_BINARY_FLOOR };

/**
 * `baseAgentHost` (A0) = the artifact's size BEFORE codex was bundled.
 * `codexPayload` (P)   = codex's effective contribution after pruning.
 *
 * Separate headroom per term on purpose (改判 ⑩): A0 is in-repo dependencies
 * that creep upward slowly, P is one upstream binary whose volatility we have
 * no history for. One combined percentage lets A0's normal growth borrow P's
 * room and vice versa, costing resolution on both sides. h1/h2 are engineering
 * judgements, not measurements — the criterion is "absorbs normal upstream
 * growth, does NOT absorb one stray platform variant (+347MB ≈ +87%)".
 */
export const PACKAGING_BUDGET = {
  'linux-x64': {
    // Measured 2026-08-19; re-verified 2026-08-20 against a real build:
    // dirSize(out-agent-host) = 406,599,430 B vs A0+P = 406,504,952 B (+0.023%).
    baseAgentHost: 42788670,
    codexPayload: 363716282,
    h1: 0.1,
    h2: 0.15,
  },
  // Deliberately null, NOT a guessed copy of the linux figures: this repo has
  // never produced a Windows artifact, so any number here would be invented.
  // The first Windows CI run prints the measured bytes (see the OK line in
  // build-agent-host.mjs) and they get filled in then — spec §11-Q1 two-step.
  // Until then the size gate reports PENDING on win32-x64 and is NOT counted
  // as a pass.
  'win32-x64': null,
};

export function hasBudget(platformKey) {
  return Boolean(PACKAGING_BUDGET[platformKey]);
}

/** Upper bound: per-term headroom, rounded up. `null` when unbudgeted. */
export function agentHostCeiling(platformKey) {
  const b = PACKAGING_BUDGET[platformKey];
  if (!b) return null;
  return Math.ceil(b.baseAgentHost * (1 + b.h1) + b.codexPayload * (1 + b.h2));
}

/** Lower bound: 90% of the combined baseline, rounded down. `null` when unbudgeted. */
export function agentHostFloor(platformKey) {
  const b = PACKAGING_BUDGET[platformKey];
  if (!b) return null;
  return Math.floor((b.baseAgentHost + b.codexPayload) * 0.9);
}

/**
 * Verdict for a measured artifact size. Bounds are INCLUSIVE on both ends.
 *
 * The lower bound is the load-bearing half: "codex did not get bundled at all"
 * is invisible on any machine that has a global codex to fall back on, which
 * means every dev box and every CI runner. Only a user's machine would notice.
 *
 * @returns {{status:'ok'|'under'|'over'|'no-budget', bytes:number, floor:number|null, ceiling:number|null}}
 */
export function evaluateAgentHostSize(platformKey, bytes) {
  const floor = agentHostFloor(platformKey);
  const ceiling = agentHostCeiling(platformKey);
  if (floor === null || ceiling === null) {
    return { status: 'no-budget', bytes, floor: null, ceiling: null };
  }
  if (bytes < floor) return { status: 'under', bytes, floor, ceiling };
  if (bytes > ceiling) return { status: 'over', bytes, floor, ceiling };
  return { status: 'ok', bytes, floor, ceiling };
}

/** Single-file floor verdict for the codex entry binary. Inclusive. */
export function evaluateCodexBinarySize(bytes) {
  return bytes >= CODEX_BINARY_FLOOR
    ? { status: 'ok', bytes, floor: CODEX_BINARY_FLOOR }
    : { status: 'under', bytes, floor: CODEX_BINARY_FLOOR };
}

/**
 * Top-N immediate children of `dir` by recursive size, largest first.
 *
 * A gate that only says "12MB over" and not WHO grew is not a gate — the next
 * person has to re-derive the breakdown by hand before they can act on it.
 */
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
          /* vanished mid-walk; not worth failing a size report over */
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
      const size = entry.isDirectory() ? measure(full) : fs.statSync(full).size;
      return { name: entry.name, bytes: size, isDirectory: entry.isDirectory() };
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

/** `406599430` -> `387.8MiB`, for human-readable gate output. */
export function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}
