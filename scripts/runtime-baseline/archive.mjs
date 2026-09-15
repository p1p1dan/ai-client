/**
 * What makes two baseline archives comparable (P2-5 / P2-6, T028).
 *
 * The rules used to live inside `compare.mjs` as a run of `assert` calls, which
 * meant two things: nothing could exercise them without two real collections on
 * disk, and the first broken rule hid every other one. They are here as a pure
 * function instead — `scripts/__tests__/runtime-baseline-archive.test.mjs` feeds
 * it manifests, `compare.mjs` prints everything it returns at once.
 *
 * ## Why "reference vs current" and not "legacy vs native"
 *
 * There was a second collector, `run.mjs`, that drove the retired engine. P6-5
 * deleted it with that engine on 2026-09-13, so the two legacy archives in
 * `evidence/p2-0` and `evidence/p2-5` are the last ones that will ever exist:
 * a legacy number can be re-read, never re-measured. Every comparison from here
 * is one native collection against another — usually a pinned reference against
 * a fresh run — and the shape of the check is the same either way, so the sides
 * are named by their role rather than by an engine.
 *
 * A cache hit rate is mostly a property of the gateway, not of the engine. That
 * is why comparability is asserted rather than assumed, and why an archive taken
 * against a different gateway is reported as context and never as the baseline.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Fields that would silently change the number being compared. */
const MUST_MATCH = ['suiteVersion', 'suiteSha256', 'baseUrl', 'work'];

/** Load one collection directory. Throws with the path when a file is missing. */
export function readArchive(dir) {
  const root = resolve(dir);
  const load = (name) => {
    try {
      return JSON.parse(readFileSync(join(root, name), 'utf8'));
    } catch (error) {
      throw new Error(`${root}: cannot read ${name} — ${error.message}`);
    }
  };
  return { root, manifest: load('manifest.json'), summary: load('summary.json') };
}

/**
 * The behaviour generation an archive was collected on, or `null`.
 *
 * `manifest.configVersion` is `RUNTIME_CONFIG_VERSION` (`src/runtime/bootstrap.ts`),
 * the same value stamped into every run trace. Archives collected before T028
 * do not carry it, which is reported as unknown rather than treated as equal —
 * the whole reason the field exists is that the constant was frozen from P3 to
 * T028 while prompts, tools, compaction and permissions all changed.
 */
export function archiveGeneration(archive) {
  const value = archive.manifest.configVersion;
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Is this directory shaped like an archive at all?
 *
 * Separate from comparability because it answers a different question: a dry
 * run has no measurements and can never be compared, but its manifest still has
 * to carry every field a real collection's manifest carries — that is the only
 * way the plumbing can be checked without a gateway (T028).
 */
export function archiveSkeletonFailures(archive) {
  const failures = [];
  const { manifest, summary } = archive;
  for (const field of [
    'schemaVersion',
    'suiteVersion',
    'suiteSha256',
    'backend',
    'entry',
    'configVersion',
    'gitHead',
    'nodeVersion',
    'dependencies',
    'baseUrl',
    'model',
    'settings',
    'work',
    'formula',
  ]) {
    if (manifest[field] === undefined || manifest[field] === null) {
      failures.push(`manifest has no ${field}`);
    }
  }
  for (const [field, value] of [
    ['caseOrder', manifest.caseOrder],
    ['files', manifest.files],
    ['settingDeviations', manifest.settingDeviations],
  ]) {
    if (Object.keys(value ?? {}).length === 0) failures.push(`manifest.${field} is empty`);
  }
  if (typeof summary.validBaseline !== 'boolean') failures.push('summary has no validBaseline');
  if (!Array.isArray(summary.results)) failures.push('summary has no results array');
  return failures;
}

/**
 * @returns `{failures, notes}` — failures block the report, notes go into it.
 */
export function comparabilityReport(reference, current) {
  const failures = [];
  const notes = [];

  for (const [role, side] of [
    ['reference', reference],
    ['current', current],
  ]) {
    if (!side.summary.validBaseline) {
      failures.push(`The ${role} archive is not a complete valid collection: ${side.root}`);
    }
  }
  if (current.manifest.backend !== 'native') {
    failures.push(
      `The current archive reports backend ${String(current.manifest.backend)}; the only collector left is run-native.mjs`
    );
  }

  for (const field of MUST_MATCH) {
    if (reference.manifest[field] !== current.manifest[field]) {
      failures.push(
        `Not comparable: ${field} differs (${String(reference.manifest[field])} vs ${String(current.manifest[field])})`
      );
    }
  }
  if (!sameJson(reference.manifest.model, current.manifest.model)) {
    failures.push('Not comparable: model row differs');
  }
  if (!sameJson(reference.manifest.settings, current.manifest.settings)) {
    failures.push('Not comparable: suite settings differ');
  }
  if (!sameJson(reference.manifest.caseOrder, current.manifest.caseOrder)) {
    failures.push('Not comparable: case order differs');
  }

  // A native side must have DECLARED where it cannot honour a baseline setting,
  // so a report can never imply an exactness the collection never had.
  for (const [role, side] of [
    ['reference', reference],
    ['current', current],
  ]) {
    if (side.manifest.backend !== 'native') continue;
    if (Object.keys(side.manifest.settingDeviations ?? {}).length === 0) {
      failures.push(
        `The ${role} native manifest declares no setting deviations; refusing to imply exact parity`
      );
    }
  }
  if (
    reference.manifest.backend === 'native' &&
    current.manifest.backend === 'native' &&
    !sameJson(reference.manifest.settingDeviations, current.manifest.settingDeviations)
  ) {
    failures.push(
      'Not comparable: the two native collections declare different setting deviations'
    );
  }

  const referenceGeneration = archiveGeneration(reference);
  const currentGeneration = archiveGeneration(current);
  if (referenceGeneration && currentGeneration && referenceGeneration !== currentGeneration) {
    failures.push(
      `Not comparable: behaviour generation differs (${referenceGeneration} vs ${currentGeneration}); a prompt/tool/compaction/permission change makes the two runs different work, not the same work measured twice`
    );
  } else if (!referenceGeneration || !currentGeneration) {
    notes.push(
      `分代不可判：${referenceGeneration ?? '参考归档未记录 configVersion'} / ${currentGeneration ?? '本次归档未记录 configVersion'}。T028 之前采集的归档没有这个字段，两份归档是否跑的同一套行为只能靠提交号人工判断。`
    );
  }

  return { failures, notes };
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
