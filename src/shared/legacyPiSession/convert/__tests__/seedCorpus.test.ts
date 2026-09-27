import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectDshHistory } from '../../../dshHistory/projection.ts';
import { branchEntries, decodeSession, isSuccessfulMessage } from '../../codec.ts';
import { buildSessionContext } from '../../context.ts';
import { convertLegacySession } from '../../legacy.ts';
import { projectPiSessionHistory } from '../../timeline.ts';
import type { Entry } from '../../types.ts';
import { checkSeed, convertPiSessionBytes, type SeedConversionResult } from '../index.ts';
import { compareContexts, compareHistories, piContextLines, seedContextLines } from './e4.ts';

/**
 * dsh-rebase P1-9b — the legacy pi corpus, converted to DSH seeds.
 *
 * For every file under `fixtures/legacy-pi/` (P1-9g), three goldens under
 * `fixtures/legacy-pi-dsh/`:
 * - `<file>.seed.json`: the seed, what the host would admit, sidecar grants,
 *   legacy permissions and the stub origin (images as hashes, not bytes);
 * - `<file>.projection.json`: the seed's DSH timeline (`projectDshHistory`),
 *   with E4 — every way it and the model context differ from what 1.0.x
 *   showed and sent, each under the reason it is expected;
 * - `<file>.report.json`: the migration report.
 *
 * Re-record at closeout only:
 *   AICLIENT_UPDATE_FIXTURES=1 pnpm vitest run src/shared/legacyPiSession/convert/__tests__/seedCorpus.test.ts
 *   pnpm exec biome format --write src/shared/__tests__/fixtures/legacy-pi-dsh
 */

interface ManifestEntry {
  file: string;
  read: 'v4' | 'legacy' | 'bytes';
  sourcePath: string;
  cwd: string;
}

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../__tests__/fixtures'
);
const CORPUS = path.join(FIXTURES, 'legacy-pi');
const GOLDEN = path.join(FIXTURES, 'legacy-pi-dsh');
const UPDATE = Boolean(process.env.AICLIENT_UPDATE_FIXTURES);
const manifest = (
  JSON.parse(readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8')) as {
    files: ManifestEntry[];
  }
).files;

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function convert(entry: ManifestEntry): SeedConversionResult {
  return convertPiSessionBytes(readFileSync(path.join(CORPUS, entry.file)), {
    sourceFile: entry.sourcePath,
    cwd: entry.cwd,
  });
}

/** The decode the preview does (`SessionReplayReader`), for the 1.0.x side of E4. */
function piBranch(entry: ManifestEntry, result: SeedConversionResult): Entry[] {
  const bytes = readFileSync(path.join(CORPUS, entry.file));
  let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
    stream: bytes.at(-1) !== 10,
  });
  if (entry.read === 'legacy') {
    const first = JSON.parse(text.split('\n').find((line) => line.trim()) ?? '{}');
    let next = 0;
    text = convertLegacySession(text, first.cwd || entry.cwd, entry.sourcePath, true, {
      newId: () => `${result.report.source.sha256}-${++next}`,
      now: () => 0,
    });
  }
  return branchEntries(decodeSession(text, { tolerateUnfinished: true }));
}

function e4(entry: ManifestEntry, result: SeedConversionResult & { ok: true }) {
  const branch = piBranch(entry, result);
  const kinds = new Map(
    branch.map((item) => [
      item.id,
      item.type === 'message' ? `message:${item.message.role}` : item.type,
    ])
  );
  const pi = projectPiSessionHistory({
    getBranch: () =>
      branch.map((item) => ({ ...item, timestamp: new Date(item.timestamp).toISOString() })),
  });
  const history = compareHistories(pi, projectDshHistory(result.seed), result.seed, kinds);
  const clean = branch.filter(
    (item) => item.type !== 'message' || isSuccessfulMessage(item.message)
  );
  const context = compareContexts(
    piContextLines(buildSessionContext(clean).messages.filter(isSuccessfulMessage)),
    seedContextLines(result.seed),
    result.seed
  );
  return { history, context };
}

function goldens(entry: ManifestEntry) {
  const result = convert(entry);
  if (!result.ok) {
    return {
      seed: { file: entry.file, ok: false, failure: result.failure },
      projection: { file: entry.file, messages: null },
      report: { file: entry.file, ...result.report },
    };
  }
  const { history, context } = e4(entry, result);
  return {
    seed: {
      file: entry.file,
      ok: true,
      cwd: result.cwd,
      origin: result.origin,
      grants: result.grants,
      legacyPermissions: result.legacyPermissions,
      images: result.images.map(({ data, ...image }) => ({
        ...image,
        bytes: Buffer.from(data, 'base64').length,
        sha256: sha256(data),
      })),
      seed: result.seed,
    },
    projection: {
      file: entry.file,
      messages: projectDshHistory(result.seed),
      e4: {
        history: history.map(({ category, id, field }) => ({ category, id, field })),
        context: context.map(({ category, side }) => ({ category, side })),
      },
    },
    report: { file: entry.file, ...result.report },
  };
}

function pin(name: string, actual: unknown) {
  const target = path.join(GOLDEN, name);
  if (UPDATE) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(target, `${JSON.stringify(actual, null, 2)}\n`);
  }
  expect(actual).toEqual(JSON.parse(readFileSync(target, 'utf8')));
}

describe('the legacy pi corpus as DSH seeds', () => {
  it.each(
    manifest.map((entry) => [entry.file, entry] as const)
  )('converts %s as its goldens say', (_file, entry) => {
    const actual = goldens(entry);
    pin(`${entry.file}.seed.json`, actual.seed);
    pin(`${entry.file}.projection.json`, actual.projection);
    pin(`${entry.file}.report.json`, actual.report);
  });

  it('has exactly three goldens per corpus file and nothing else', () => {
    expect(readdirSync(GOLDEN).sort()).toEqual(
      manifest
        .flatMap((entry) =>
          ['projection', 'report', 'seed'].map((kind) => `${entry.file}.${kind}.json`)
        )
        .sort()
    );
  });

  it('refuses only the files 1.0.x could not read either, at the stage that fails', () => {
    const refused = manifest.flatMap((entry) => {
      const result = convert(entry);
      return result.ok ? [] : [[entry.file, result.failure]];
    });
    expect(refused).toEqual([
      ['damaged-empty.jsonl', { stage: 'decode', code: 'session_invalid' }],
      ['damaged-invalid-utf8.jsonl', { stage: 'read', code: 'source_invalid_utf8' }],
      ['damaged-seq-gap.jsonl', { stage: 'decode', code: 'session_invalid' }],
    ]);
  });

  it.each(
    manifest.map((entry) => [entry.file, entry] as const)
  )('%s: the seed passes the checker, is lossless JSON and is a pure function of the bytes', (_file, entry) => {
    const result = convert(entry);
    if (!result.ok) return;
    expect(checkSeed(result.seed)).toEqual([]);
    expect(JSON.parse(JSON.stringify(result.seed))).toEqual(result.seed);
    expect(convert(entry)).toEqual(result);
  });

  it.each(
    manifest.map((entry) => [entry.file, entry] as const)
  )('%s: every E4 difference has a known reason', (_file, entry) => {
    const result = convert(entry);
    if (!result.ok) return;
    const { history, context } = e4(entry, result);
    expect(history.filter((diff) => !diff.category)).toEqual([]);
    expect(context.filter((diff) => !diff.category)).toEqual([]);
  });

  it('keeps the model context 1.0.x built, except where decision 055 or a crash says otherwise', () => {
    const categories = new Set(
      manifest.flatMap((entry) => {
        const result = convert(entry);
        return result.ok ? e4(entry, result).context.map((diff) => diff.category) : [];
      })
    );
    expect([...categories].sort()).toEqual(['dangling-closure', 'interrupted-reply']);
  });
});
