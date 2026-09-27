import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSessionContext as piBuildSessionContext } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { buildPiSessionTreeSnapshot } from '../../agent-host/piSessionTree.ts';
import { PiWorkerSessionError } from '../../agent-host/piWorkerErrors.ts';
import * as shared from '../../shared/legacyPiSession/codec.ts';
import { buildSessionContext } from '../../shared/legacyPiSession/context.ts';
import { LegacyPiSessionError } from '../../shared/legacyPiSession/errors.ts';
import { convertLegacySession as sharedConvert } from '../../shared/legacyPiSession/legacy.ts';
import type { Entry } from '../../shared/legacyPiSession/types.ts';
import { RuntimeHostError } from '../host/errors.ts';
import { branchEntries, decodeSession } from '../plugins/session/codec.ts';
import { convertLegacySession } from '../plugins/session/legacy.ts';

/**
 * dsh-rebase P1-9a — the runtime half of the move.
 *
 * Two promises the thin wrappers make and nothing else checks: the vendored
 * `buildSessionContext` is still pi-agent-core's (while the runtime ships the
 * package to compare against), and a refusal still reaches the runtime as a
 * `RuntimeHostError` / `PiWorkerSessionError`, the types its callers test for.
 */

const CORPUS = resolve(import.meta.dirname, '../../shared/__tests__/fixtures/legacy-pi');
const BASELINE = resolve(
  import.meta.dirname,
  '../../../docs/plantree/plans/runtime-evolution/evidence/p2-0/baseline-20260908'
);

interface ManifestEntry {
  file: string;
  read: 'v4' | 'legacy' | 'bytes';
  sourcePath: string;
  cwd: string;
}

/** Every decodable session the repo holds: the P1-9g corpus and the B01–B06 baselines. */
function documents(): [string, shared.SessionDocument][] {
  const manifest = (
    JSON.parse(readFileSync(join(CORPUS, 'manifest.json'), 'utf8')) as { files: ManifestEntry[] }
  ).files;
  const found: [string, shared.SessionDocument][] = [];
  for (const entry of manifest) {
    if (entry.read === 'bytes') continue;
    const content = readFileSync(join(CORPUS, entry.file), 'utf8');
    try {
      const native =
        entry.read === 'legacy'
          ? sharedConvert(content, entry.cwd, entry.sourcePath, true)
          : content;
      found.push([entry.file, shared.decodeSession(native, { tolerateUnfinished: true })]);
    } catch {
      // Refused files (a seq gap) have no branch to compare on.
    }
  }
  for (const id of ['B01', 'B02', 'B03', 'B04', 'B05', 'B06']) {
    const folder = join(BASELINE, id, 'sessions');
    const name = readdirSync(folder).find((item) => item.endsWith('.jsonl')) as string;
    const file = join(folder, name);
    const content = readFileSync(file, 'utf8');
    found.push([id, shared.decodeSession(sharedConvert(content, '/baseline', file, true))]);
  }
  return found;
}

describe('the vendored buildSessionContext', () => {
  const all = documents();

  it('covers the corpus and the baselines', () => {
    expect(all.length).toBeGreaterThan(25);
  });

  it.each(all)('matches pi-agent-core 0.84.4 on every path through %s', (_name, document) => {
    // Every entry's path, not only the active branch: that is what reaches the
    // compaction boundaries, the branch summaries and the abandoned replies.
    for (const item of document.entries) {
      const path = shared.branchEntries(document, item.id);
      const ours = buildSessionContext(path);
      const theirs = piBuildSessionContext(path as never);
      expect(ours).toEqual(theirs);
    }
  });
});

describe('refusals keep the runtime error types', () => {
  it('decodeSession and branchEntries throw RuntimeHostError with the shared code and message', () => {
    const content =
      '{"kind":"header","version":4,"id":"s","cwd":"/r","createdAt":1}\n{"kind":"entry" "seq":1}\n';
    const original = (() => {
      try {
        shared.decodeSession(content);
      } catch (error) {
        return error as LegacyPiSessionError;
      }
    })();
    expect(original).toBeInstanceOf(LegacyPiSessionError);
    let wrapped: unknown;
    try {
      decodeSession(content);
    } catch (error) {
      wrapped = error;
    }
    expect(wrapped).toBeInstanceOf(RuntimeHostError);
    expect(wrapped).toMatchObject({
      code: original?.code,
      message: original?.message,
      name: 'RuntimeHostError',
    });
    const document = decodeSession(
      '{"kind":"header","version":4,"id":"s","cwd":"/r","createdAt":1}\n'
    );
    expect(() => branchEntries(document, 'missing')).toThrow(RuntimeHostError);
  });

  it('convertLegacySession throws RuntimeHostError, other errors pass through untouched', () => {
    let refused: unknown;
    try {
      convertLegacySession('{"type":"session","version":9}\n', '/r', '/s');
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(RuntimeHostError);
    expect(refused).toMatchObject({ code: 'session_format_unsupported' });
    // A middle row that is not JSON: pi's own SyntaxError, as before the move.
    expect(() =>
      convertLegacySession(
        '{"type":"session","version":3,"id":"x","timestamp":"2026-01-01T00:00:00Z"}\n{\n{}\n',
        '/r',
        '/s'
      )
    ).toThrow(SyntaxError);
  });

  it('the worker tree still refuses with PiWorkerSessionError', () => {
    let refused: unknown;
    try {
      buildPiSessionTreeSnapshot({
        manager: {},
        logicalSessionId: 'l',
        sessionFile: 'f',
        workspacePath: '/r',
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PiWorkerSessionError);
    expect(refused).toMatchObject({ code: 'WORKER_TREE_UNAVAILABLE', retryable: false });
  });

  it('hands the store pi-typed entries that are the shared ones', () => {
    const content =
      '{"kind":"header","version":4,"id":"s","cwd":"/r","createdAt":1}\n' +
      '{"kind":"entry","type":"message","seq":1,"id":"a","parentId":null,"lane":"main","timestamp":1,"message":{"role":"user","content":"hi","timestamp":1}}\n';
    const runtime = decodeSession(content);
    expect(runtime).toEqual(shared.decodeSession(content));
    expect(branchEntries(runtime)).toEqual(shared.branchEntries(runtime) as Entry[]);
  });
});
