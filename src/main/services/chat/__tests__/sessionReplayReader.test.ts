import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paginatePiSessionHistory } from '../../../../shared/legacyPiSession/timeline';
import type { HistoryMessage } from '../../../../shared/types/sessionHistory';
import { readSessionReplayPage, SESSION_REPLAY_UNAVAILABLE } from '../SessionReplayReader';

/**
 * T102 (decision 030) — the read-only history path, against the legacy pi corpus.
 *
 * Two questions, and the second is the one that matters:
 *
 *  1. Does reading a session leave the file and its directory untouched? The
 *     whole reason this path exists rather than a second session store is that
 *     the 1.0.x store took the advisory writer lock unconditionally and wrote
 *     repairs back. A reader that did either would be a second writer.
 *  2. Does it produce the SAME transcript 1.0.x produced? A cheaper reader that
 *     quietly renders a different conversation is worse than no reader.
 *
 * dsh-rebase P1-12 step 2: this used to build its session files with the
 * runtime's own store and compare each page with that store's `history()`.
 * The runtime goes in step 3, so the reference is now the corpus under
 * `src/shared/__tests__/fixtures/legacy-pi/`, written by the real 1.0.x writers
 * (the CLI's v3 writer, the native store, the 1.0.x legacy copy), and the
 * `history` each golden pins next to it, which `legacyPiCorpus.test.ts` keeps
 * equal to the shared library's reading of that file. The goldens are only
 * read here, never written.
 *
 * The golden reads a file under `tolerateUnfinished`; the reader decodes the
 * way 1.0.x resumed, strictly. So a golden whose `strict` is a refusal stands
 * for a replay refused with that code as its `cause`.
 */

interface ManifestEntry {
  file: string;
  read: 'v4' | 'legacy' | 'bytes';
  /** Where the generator wrote the file; v1 conversion ids derive from it. */
  sourcePath: string;
  copyOf?: string;
}

interface Failure {
  stage?: string;
  code?: string;
}

interface Golden {
  bytes: number;
  sha256: string;
  unreadable?: Failure;
  strict?: 'ok' | Failure;
  history?: HistoryMessage[];
}

const CORPUS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../shared/__tests__/fixtures/legacy-pi'
);
const manifest = (
  JSON.parse(readFileSync(join(CORPUS, 'manifest.json'), 'utf8')) as { files: ManifestEntry[] }
).files;
const goldenOf = (file: string) =>
  JSON.parse(readFileSync(join(CORPUS, 'golden', `${file}.golden.json`), 'utf8')) as Golden;
const entryOf = (file: string) => manifest.find((entry) => entry.file === file) as ManifestEntry;

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * v1 rows carry no ids: the converter derives each one from the path it is
 * handed and the row's position, `sha256("<path>:<index>")` cut to 16 hex
 * digits. The golden was converted under the generator's path, the reader
 * converts a staged copy under its own, so those ids are re-derived for the
 * staged path before comparing. Every other format carries its own ids, and
 * nothing in them matches a derived one.
 */
const derivedId = (file: string, index: number) => sha256(`${file}:${index}`).slice(0, 16);
function rebaseDerivedIds<T>(value: T, entry: ManifestEntry, staged: string): T {
  if (entry.read !== 'legacy') return value;
  const rows = readFileSync(join(CORPUS, entry.file), 'utf8').split('\n').length;
  let json = JSON.stringify(value);
  for (let index = 1; index < rows; index++)
    json = json.replaceAll(derivedId(entry.sourcePath, index), derivedId(staged, index));
  return JSON.parse(json) as T;
}

type Outcome = { history: HistoryMessage[] } | { refusal: { cause?: string } };

/**
 * What the reader must make of `entry`, staged at `staged`, by its golden.
 *
 * A file unreadable as UTF-8 is refused with the decoder's code. An empty file
 * is refused by the reader's own header check, which carries no cause (the
 * golden's `session_invalid` comes from the shared `firstRow`, which the
 * reader does not call).
 */
function outcomeOf(entry: ManifestEntry, staged: string): Outcome {
  const golden = goldenOf(entry.file);
  if (golden.unreadable)
    return {
      refusal: golden.unreadable.stage === 'utf-8' ? { cause: golden.unreadable.code } : {},
    };
  if (golden.strict !== 'ok') return { refusal: { cause: golden.strict?.code } };
  return { history: rebaseDerivedIds(golden.history as HistoryMessage[], entry, staged) };
}

/** Default page, newest page, an older page, and the largest page there is. */
const PAGE_SHAPES = [
  [undefined, undefined],
  [0, 2],
  [2, 2],
  [0, 500],
] as const;

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'session-replay-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A byte-exact copy of one corpus file in this case's own directory. */
async function stage(file: string): Promise<string> {
  const target = join(dir, file);
  await copyFile(join(CORPUS, file), target);
  return target;
}

/** The point of every case: no sidecar of any kind, and the file untouched. */
async function expectUntouched(file: string, golden: Golden, before: { mtimeMs: number }) {
  // `.writer.lock` and `<file>.native-v4.jsonl` are what a writer would leave.
  expect(await readdir(dir)).toEqual([basename(file)]);
  const after = await stat(file);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.size).toBe(golden.bytes);
  expect(sha256(await readFile(file))).toBe(golden.sha256);
}

describe('SessionReplayReader — history without a worker (T102)', () => {
  it('refuses exactly the corpus files 1.0.x could not resume', () => {
    // Pins what the loop below covers: without these four, its refusal branch
    // (among them the unfinished operation the old hand-built fixture had)
    // could pass by never being reached.
    const refused = Object.fromEntries(
      manifest.flatMap((entry) => {
        const outcome = outcomeOf(entry, join(dir, entry.file));
        return 'refusal' in outcome ? [[entry.file, outcome.refusal.cause ?? null]] : [];
      })
    );
    expect(refused).toEqual({
      'damaged-empty.jsonl': null,
      'damaged-invalid-utf8.jsonl': 'ERR_ENCODING_INVALID_ENCODED_DATA',
      'damaged-seq-gap.jsonl': 'session_invalid',
      'damaged-unfinished-record.jsonl': 'session_operation_unfinished',
    });
  });

  it.each(
    manifest.map((entry) => [entry.file, entry] as const)
  )('%s replays as its golden says, and is only read', async (_file, entry) => {
    const file = await stage(entry.file);
    const golden = goldenOf(entry.file);
    const before = await stat(file);
    const outcome = outcomeOf(entry, file);

    if ('refusal' in outcome) {
      await expect(readSessionReplayPage({ sessionFile: file })).rejects.toMatchObject({
        code: SESSION_REPLAY_UNAVAILABLE,
        ...(outcome.refusal.cause === undefined ? {} : { cause: outcome.refusal.cause }),
      });
    } else {
      expect(await readSessionReplayPage({ sessionFile: file, limit: 500 })).toEqual({
        messages: outcome.history,
        offset: 0,
        limit: 500,
        totalCount: outcome.history.length,
        hasMore: false,
      });
      // The shapes `chat:loadHistoryPage` can ask for, paged the way the
      // worker's history RPC paged the same transcript.
      for (const [offset, limit] of PAGE_SHAPES)
        expect(await readSessionReplayPage({ sessionFile: file, offset, limit })).toEqual(
          paginatePiSessionHistory(outcome.history, offset, limit)
        );
    }
    // A torn tail or a dropped middle row is repaired in memory only, a legacy
    // file is converted in memory only, and a refusal leaves no lock behind.
    await expectUntouched(file, golden, before);
  });

  it('pages backwards from the leaf, and says when an older page exists', async () => {
    const file = await stage('v4-compaction.jsonl');
    const history = goldenOf('v4-compaction.jsonl').history as HistoryMessage[];
    const total = history.length;
    expect(total).toBeGreaterThan(4);

    expect(await readSessionReplayPage({ sessionFile: file, offset: 0, limit: 2 })).toEqual({
      messages: history.slice(total - 2),
      offset: 0,
      limit: 2,
      totalCount: total,
      hasMore: true,
    });
    expect(await readSessionReplayPage({ sessionFile: file, offset: 2, limit: 2 })).toEqual({
      messages: history.slice(total - 4, total - 2),
      offset: 2,
      limit: 2,
      totalCount: total,
      hasMore: true,
    });
    const oldest = await readSessionReplayPage({ sessionFile: file, offset: total - 1, limit: 2 });
    expect(oldest.messages).toEqual(history.slice(0, 1));
    expect(oldest.hasMore).toBe(false);
    const beyond = await readSessionReplayPage({ sessionFile: file, offset: total, limit: 2 });
    expect(beyond).toMatchObject({ messages: [], totalCount: total, hasMore: false });
    // The default page holds the whole of a short session.
    expect(await readSessionReplayPage({ sessionFile: file })).toMatchObject({
      messages: history,
      offset: 0,
      limit: 80,
      hasMore: false,
    });
  });

  it.each(
    manifest
      .filter((entry) => entry.copyOf && !entry.file.includes('drifted'))
      .map((entry) => [entry.copyOf as string, entry] as const)
  )('converts %s in memory into the transcript 1.0.x copied to disk', async (source, copy) => {
    // The legacy format travels a different route on each side: 1.0.x
    // converted it to a `.native-v4.jsonl` sibling on disk and opened that,
    // the reader converts the same bytes in memory. The transcript must not
    // notice. The copy can hold more than the conversion (1.0.x went on
    // writing to it), so the source's transcript is the copy's oldest part.
    const sourceFile = await stage(source);
    const replayed = await readSessionReplayPage({ sessionFile: sourceFile, limit: 500 });
    const copied = await readSessionReplayPage({ sessionFile: await stage(copy.file), limit: 500 });

    expect(replayed.totalCount).toBeGreaterThan(0);
    expect(copied.totalCount).toBeGreaterThanOrEqual(replayed.totalCount);
    expect(
      rebaseDerivedIds(copied.messages.slice(0, replayed.totalCount), entryOf(source), sourceFile)
    ).toEqual(replayed.messages);
  });

  it('reports session_replay_unavailable for a file that is not a session', async () => {
    // No corpus file is valid JSON in no session format, so this one is
    // written here.
    const file = join(dir, 'notes.jsonl');
    await writeFile(file, '{"hello":"world"}\n');
    await expect(readSessionReplayPage({ sessionFile: file })).rejects.toMatchObject({
      code: SESSION_REPLAY_UNAVAILABLE,
    });
    await expect(
      readSessionReplayPage({ sessionFile: join(dir, 'missing.jsonl') })
    ).rejects.toMatchObject({ code: SESSION_REPLAY_UNAVAILABLE, cause: 'ENOENT' });
    expect(await readdir(dir)).toEqual(['notes.jsonl']);
  });
});

describe('SessionReplayReader — legacy files with no recorded cwd', () => {
  it('converts using the indexed workspace when the header names no cwd', async () => {
    // A PI-Desktop header never names a cwd, so the conversion takes the
    // indexed workspace; the transcript does not depend on which one.
    const file = await stage('legacy-desktop.jsonl');
    const golden = goldenOf('legacy-desktop.jsonl');
    const before = await stat(file);
    const page = await readSessionReplayPage({
      sessionFile: file,
      workspacePath: join(dir, 'workspace'),
      limit: 500,
    });
    expect(page.messages).toEqual(golden.history);
    await expectUntouched(file, golden, before);
  });

  it('ignores the indexed workspace when the header names its own cwd', async () => {
    // A session whose workspace moved is still a session to look at: the
    // reader converts with the file's own cwd, so the relocation guard inside
    // the conversion never fires on a read.
    const file = await stage('legacy-pi-v3.jsonl');
    const page = await readSessionReplayPage({
      sessionFile: file,
      workspacePath: join(dir, 'elsewhere'),
      limit: 500,
    });
    expect(page.messages).toEqual(goldenOf('legacy-pi-v3.jsonl').history);
  });
});
