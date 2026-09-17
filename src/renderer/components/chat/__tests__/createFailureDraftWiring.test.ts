import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D15 (2026-09-17 field run, DEV-4) — the half of "give the user their sentence
 * back" that lives in a `.tsx`.
 *
 * The decision itself is `decideFailureAffordance(..., { sessionNeverCreated })`
 * in `queueRelease.ts`, asserted behaviourally in `queueRelease.test.ts`. What
 * is left here is wiring: which branch states the fact, and whether the create
 * dispatch's own rejection still reaches the branch that can state it. The
 * repo's vitest environment is `node` and collects only `.ts`, so no `.tsx`
 * ever renders — a source scan is the only thing that can pin it. Same shape as
 * `forceTakeoverWiring.test.ts` / `piResumeNoFallback.test.ts`.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('../ChatComposer.tsx', import.meta.url)), 'utf8');

function slice(startMarker: string, endMarker: string): string {
  const start = SOURCE.indexOf(startMarker);
  if (start < 0) throw new Error(`ChatComposer marker not found: ${startMarker}`);
  const end = SOURCE.indexOf(endMarker, start);
  if (end < 0) throw new Error(`ChatComposer marker is unterminated: ${startMarker}`);
  return SOURCE.slice(start, end);
}

describe('create-failure draft restore wiring (D15)', () => {
  it('catches the createSession rejection at the call site instead of letting it reach the outer catch', () => {
    // Left to the outer `catch`, the branch that KNOWS the session was never
    // opened never runs — the payload goes to the Retry icon and the composer
    // stays empty, which is exactly what the field run saw.
    const sequence = slice(
      "const runCreateSequence = async (): Promise<'ok' | 'fatal' | 'timeout'> => {",
      'const sendAndWait ='
    );
    expect(sequence).toContain('createResult = await window.electronAPI.chat.createSession({');
    expect(sequence).toContain('} catch (error) {');
    // The user still has to SEE why, so the rejection text keeps its old route
    // to the error card the outer catch used to write.
    expect(sequence).toContain('lastError: error instanceof Error ? error.message : String(error)');
    // ...and the branch reports the create failure rather than falling through
    // to the 5s `session.created` wait, which would report a timeout instead.
    expect(sequence.indexOf('} catch (error) {')).toBeLessThan(sequence.indexOf("return 'fatal'"));
  });

  it('states `sessionNeverCreated` on both create failures, and nowhere else', () => {
    const createBranch = slice(
      "if (preamble.action === 'create') {",
      "} else if (preamble.action === 'resume') {"
    );
    expect(createBranch).toContain('sessionNeverCreated: true');
    // Both of them: the dispatch/host-error half (`'fatal'`) and the
    // session.created-never-arrived half (`'timeout'`).
    expect(createBranch.match(/sessionNeverCreated: true/g)).toHaveLength(2);
    // Nothing else in the file may claim it — a resume, a `chat.send` refusal
    // or an `ensureHost()` throw all happen where the session may well exist,
    // and the outer catch cannot tell the two apart.
    expect(SOURCE.match(/sessionNeverCreated: true/g)).toHaveLength(2);
  });

  it('routes the fact through the single affordance authority, not around it', () => {
    const finalize = slice('const finalizeOutcome = (', 'setSending(true);');
    expect(finalize).toContain('decideFailureAffordance(outcome, origin, context)');
    // ...and the `'restore-draft'` answer still lands in the composer draft
    // rather than anywhere new.
    expect(finalize).toContain("} else if (affordance === 'restore-draft') {");
    expect(finalize).toContain('restoreDraftIfComposerEmpty(sessionId, committed)');
  });

  /**
   * D15 round-2 (2026-09-17 review). The restore is allowed to refuse — it will
   * not overwrite input the user has typed since the commit point — and D15 had
   * left that refusal with nowhere to put the payload. The behaviour of the
   * fallback is asserted in `queueRelease.test.ts`; these two pin that the
   * component asks and obeys.
   */
  describe('a refused restore still has somewhere to put the payload', () => {
    it('reports whether the restore actually took', () => {
      const restore = slice('const restoreDraftIfComposerEmpty = useCallback(', 'const revoke');
      expect(restore).toContain('): boolean => {');
      // The refusal (composer not empty) and the success have to be
      // distinguishable — a bare `return` would read as "restored" here.
      expect(restore).toContain('if (!composerIsEmpty) return false;');
      expect(restore).toContain('return true;');
    });

    it('falls back to the Retry snapshot when the restore refused', () => {
      const finalize = slice('const finalizeOutcome = (', 'setSending(true);');
      expect(finalize).toContain(
        'const restored = restoreDraftIfComposerEmpty(sessionId, committed)'
      );
      // Still the authority's call, not this branch's: the component may not
      // decide on its own that a resend is safe here.
      expect(finalize).toContain(
        "if (!restored && decideDeclinedRestore(outcome, origin, context) === 'resend') {"
      );
      expect(finalize.indexOf('const restored =')).toBeLessThan(finalize.indexOf('if (!restored'));
    });
  });
});
