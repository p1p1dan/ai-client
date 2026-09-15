import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  archiveGeneration,
  archiveSkeletonFailures,
  comparabilityReport,
  readArchive,
} from '../runtime-baseline/archive.mjs';

/**
 * The baseline comparison rules, exercised without a gateway (T028).
 *
 * `compare.mjs` used to hold these as a run of `assert` calls that only ran when
 * somebody had two real collections on disk — which, since the legacy collector
 * was deleted with the engine it drove, will not happen again. The rules are a
 * pure function now, and these cases feed it the archive pairs that must not be
 * compared.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const evidence = path.join(repoRoot, 'docs/plantree/plans/runtime-evolution/evidence/p2-5');
const LEGACY_ARCHIVE = path.join(evidence, 'run-20260912-legacy-01');
const NATIVE_ARCHIVE = path.join(evidence, 'run-20260912-native-02');

/** A manifest with every field the rules read, so a case can change one. */
function archive(overrides = {}, summaryOverrides = {}) {
  return {
    root: '/archives/example',
    manifest: {
      schemaVersion: 1,
      suiteVersion: 'p2-0-v3',
      suiteSha256: 'a'.repeat(64),
      backend: 'native',
      entry: 'createRuntime',
      configVersion: 'runtime_p6_hardening_v1',
      gitHead: 'c'.repeat(40),
      nodeVersion: 'v22.23.2',
      dependencies: { cordis: '4.0.0-rc.9' },
      baseUrl: 'http://gateway:23000',
      model: { id: 'claude-sonnet-5' },
      settings: { defaultThinkingLevel: 'off' },
      settingDeviations: { 'compaction.reserveTokens': 'derived from the model window' },
      work: '/tmp/aiclient-p2-0-work',
      caseOrder: ['B01', 'B02'],
      formula: 'sum(cacheRead) / (sum(input) + sum(cacheRead))',
      files: { 'src/runtime/bootstrap.ts': 'b'.repeat(64) },
      ...overrides,
    },
    summary: { validBaseline: true, results: [], ...summaryOverrides },
  };
}

describe('runtime baseline archive rules', () => {
  it('still accepts the two archived collections the comparison was built on', () => {
    // The real data, not a fixture: if a rule added later rejects the pair that
    // produced the P2-6 report, that is a broken rule, not a broken archive.
    const legacy = readArchive(LEGACY_ARCHIVE);
    const native = readArchive(NATIVE_ARCHIVE);
    expect(comparabilityReport(legacy, native).failures).toEqual([]);
    expect(legacy.manifest.backend).toBe('legacy');
    expect(native.manifest.backend).toBe('native');
    // Both predate T028, so neither states its generation. That is reported as
    // unknown rather than assumed equal.
    expect(archiveGeneration(legacy)).toBeNull();
    expect(comparabilityReport(legacy, native).notes).toHaveLength(1);
    expect(comparabilityReport(legacy, native).notes[0]).toContain('分代不可判');
  });

  it('compares one native collection against another, which is the only form left', () => {
    const reference = archive({ gitHead: 'd'.repeat(40) });
    const current = archive();
    expect(comparabilityReport(reference, current)).toEqual({ failures: [], notes: [] });
  });

  it('refuses two archives from different behaviour generations', () => {
    // core-host-02: the constant was frozen from P3 to T028 while prompts,
    // tools, compaction and permissions all changed, so "same suite, same
    // gateway" stopped meaning "same work".
    const reference = archive({ configVersion: 'runtime_p3_complete_v1' });
    const { failures } = comparabilityReport(reference, archive());
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('runtime_p3_complete_v1 vs runtime_p6_hardening_v1');
  });

  it('refuses a dry run, an incomplete run, and a non-native current side', () => {
    const dry = archive({ dryRun: true }, { validBaseline: false });
    expect(comparabilityReport(archive(), dry).failures).toContain(
      'The current archive is not a complete valid collection: /archives/example'
    );
    expect(comparabilityReport(dry, archive()).failures).toContain(
      'The reference archive is not a complete valid collection: /archives/example'
    );
    expect(
      comparabilityReport(archive(), archive({ backend: 'legacy', settingDeviations: {} })).failures
    ).toContain(
      'The current archive reports backend legacy; the only collector left is run-native.mjs'
    );
  });

  it('names every reason at once instead of stopping at the first', () => {
    // The old shape was `assert` per rule: fix one, run again, find the next.
    const { failures } = comparabilityReport(
      archive({ baseUrl: 'http://other:23000', work: '/tmp/other', model: { id: 'gpt' } }),
      archive()
    );
    expect(failures).toHaveLength(3);
    expect(failures.join('\n')).toContain('baseUrl differs');
    expect(failures.join('\n')).toContain('work differs');
    expect(failures.join('\n')).toContain('model row differs');
  });

  it('refuses two native runs that declared different deviations, or none', () => {
    expect(
      comparabilityReport(
        archive({ settingDeviations: { 'retry.enabled': 'own retry' } }),
        archive()
      ).failures
    ).toContain('Not comparable: the two native collections declare different setting deviations');
    expect(comparabilityReport(archive(), archive({ settingDeviations: {} })).failures).toContain(
      'The current native manifest declares no setting deviations; refusing to imply exact parity'
    );
  });

  it('checks an archive skeleton field by field, generation included', () => {
    expect(archiveSkeletonFailures(archive())).toEqual([]);
    const { configVersion: _dropped, ...withoutGeneration } = archive().manifest;
    expect(archiveSkeletonFailures({ ...archive(), manifest: withoutGeneration })).toEqual([
      'manifest has no configVersion',
    ]);
    expect(archiveSkeletonFailures(archive({ files: {} }))).toEqual(['manifest.files is empty']);
  });

  it('is actually wired into the collector and the comparison', () => {
    // Guards the guard. A perfect rule set that nobody calls, or a collector
    // that never writes the generation, would leave every case above green
    // while the real scripts went on as before.
    const collector = readFileSync(
      path.join(repoRoot, 'scripts/runtime-baseline/run-native.mjs'),
      'utf8'
    );
    expect(collector).toContain('configVersion: RUNTIME_CONFIG_VERSION');
    expect(collector).toContain('archiveSkeletonFailures');
    const compare = readFileSync(
      path.join(repoRoot, 'scripts/runtime-baseline/compare.mjs'),
      'utf8'
    );
    expect(compare).toContain('comparabilityReport(reference, native)');
    // `--legacy` alone can no longer be required: there is no legacy collector.
    expect(compare).toContain('--baseline');
  });
});
