import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * dsh-rebase P1-1, GUI point-check 2026-09-26 D1/D2 — the `.tsx` half of
 * "a send refused by rule gives the user their message back".
 *
 * D1: a legacy chat's send was refused (then `legacy_session_readonly`; since
 * P1-9e a move to the current engine that failed, `legacy_migration_failed`);
 * the text vanished behind a Retry the composer could not make pass, and Main's
 * raw English sentence sat in a red box under the translated card.
 * D2: a DSH send carrying an image was refused (then `WORKER_DSH_UNSUPPORTED`,
 * since P1-4c2 the engine's own `WORKER_ATTACHMENT_REJECTED`); the text and the
 * image vanished the same way, under the same kind of raw box.
 *
 * The decisions are pure and tested where they live (`queueRelease.test.ts`,
 * `historyError.test.ts`, `sendDispatchError.test.ts`, `resumeIntent.test.ts`,
 * `middleColumnLayout.test.ts`). What is left is wiring in a component no test
 * mounts, so a source scan pins it — the shape `createFailureDraftWiring` uses.
 * Comments are stripped first: the explanations name every identifier below.
 */
const read = (relative: string) => {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  return stripComments(readFileSync(file, 'utf8'), file);
};
const COMPOSER = read('../ChatComposer.tsx');
const RESUME_HOOK = read('../sessionIndex/useResumeSession.ts');

function slice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`marker is unterminated: ${startMarker}`);
  return source.slice(start, end);
}

const count = (source: string, needle: string) => source.split(needle).length - 1;

const ATTACHMENT_NOTICES = [
  'The engine refused the attachment {{name}} ({{code}}). Remove or replace it to send the message.',
  'The engine refused the attachments ({{code}}). Remove or replace them to send the message.',
];
/** P1-1's blanket refusal, gone with P1-4c2. */
const P1_1_NOTICE =
  'The current engine does not support attachments yet; they will return in a later version. Remove them to send the message.';

/**
 * dsh-rebase P1-9e (decisions 050, 122): D1's path now carries a legacy chat
 * whose move to the current engine failed (`legacy_migration_failed`) or had
 * to happen first (`legacy_migration_required`), instead of P1-1's read-only
 * refusal, which Main no longer produces.
 */
describe('D1 — a legacy chat that could not be moved (legacy_migration_failed)', () => {
  const resumeBranch = () =>
    slice(
      COMPOSER,
      "} else if (preamble.action === 'resume') {",
      "if (preamble.action === 'direct' && fatalHostErrorCode === 'session_not_found')"
    );
  const reopenBranch = () =>
    slice(
      COMPOSER,
      "if (preamble.action === 'direct' && fatalHostErrorCode === 'session_not_found')",
      'if (retryUnavailable) {'
    );

  it('both resume sites keep the raw sentence out of lastError and hand the payload back', () => {
    for (const [name, branch] of [
      ['resume', resumeBranch()],
      ['reopen', reopenBranch()],
    ] as const) {
      expect(branch, name).toContain(
        'const migrationRefused = isLegacyMigrationRefusal(encodedError.code);'
      );
      expect(branch, name).toContain('lastError: migrationRefused ? null : encodedError.message,');
      // The card still gets its code: it is the report that remains.
      expect(branch, name).toContain('[sessionId]: encodedError.encoded,');
      expect(branch, name).toContain('{ refusedByRule: migrationRefused }');
      // No raw write slipped in beside the guarded one.
      expect(count(branch, 'lastError: encodedError.message'), name).toBe(0);
    }
    expect(count(COMPOSER, '{ refusedByRule: migrationRefused }')).toBe(2);
  });

  it('both resume sites go through the wrapper that shows the move and applies its answer', () => {
    for (const [name, branch] of [
      ['resume', resumeBranch()],
      ['reopen', reopenBranch()],
    ] as const) {
      expect(branch, name).toContain('resumeSessionWithMigration({');
      expect(branch, name).not.toContain('window.electronAPI.chat.resumeSession(');
    }
    // Nowhere else either: a resume that skipped the wrapper would move a chat
    // without showing it, and drop the answer's preference copy.
    expect(count(COMPOSER, 'window.electronAPI.chat.resumeSession(')).toBe(0);
    expect(count(RESUME_HOOK, 'window.electronAPI.chat.resumeSession(')).toBe(0);
    expect(RESUME_HOOK).toContain('await resumeSessionWithMigration(intent.args);');
  });

  it('opening a session reports it through the card alone', () => {
    expect(RESUME_HOOK).toContain(
      'lastError: isLegacyMigrationRefusal(encodedError.code) ? null : encodedError.message,'
    );
    expect(count(RESUME_HOOK, 'lastError: encodedError.message')).toBe(0);
  });

  it('the composer says the first send moves the chat, and says so while it does', () => {
    expect(COMPOSER).toContain('movesOnSend: willMigrateOnResume(activeSession),');
    expect(COMPOSER).toContain('migrating: migratingHere,');
    expect(COMPOSER).toContain('selectIsMigrating(state, activeSessionId)');
  });

  it('/compact on a chat not moved yet moves it first', () => {
    const compact = slice(COMPOSER, "case 'compact': {", "if (outcome.kind === 'turn-running')");
    expect(compact).toContain('runAfterLegacyMigration(');
    expect(compact).toContain('window.electronAPI.chat.compactSession({');
    expect(compact).toContain('resumeSessionById(sessionId, {');
  });

  it('leaves no trace of the read-only refusal it replaced', () => {
    for (const source of [COMPOSER, RESUME_HOOK]) {
      expect(source).not.toContain('isReadOnlyResumeRefusal');
      expect(source).not.toContain('isLegacyReadOnlySession');
      expect(source).not.toContain('legacy_session_readonly');
    }
  });
});

/**
 * dsh-rebase P1-4c2 (decision 096): D2's path now carries the engine's own
 * refusal of an attachment (`WORKER_ATTACHMENT_REJECTED`, its DSH code and the
 * file to blame) instead of P1-1's blanket "not supported yet".
 */
describe('D2 — an attachment the engine refused (WORKER_ATTACHMENT_REJECTED)', () => {
  const dispatchCatch = () => {
    const dispatch = slice(
      COMPOSER,
      'const sendResult = await cancellation',
      'if (sendResult === SEND_CANCELLED)'
    );
    return dispatch.slice(dispatch.indexOf('.catch((error: unknown) => {'));
  };

  it('the dispatch catch records the refusal instead of throwing it to the outer catch', () => {
    const handler = dispatchCatch();
    const parsed = handler.indexOf(
      '!retryLastTurn && wireAttachments ? parseAttachmentRejection(error) : null;'
    );
    expect(parsed).toBeGreaterThan(-1);
    const refusal = handler.indexOf('if (rejection) {', parsed);
    expect(refusal).toBeGreaterThan(parsed);
    // Absorbed before the generic path rethrows it: the outer catch is what
    // unbound a healthy slot and wrote the raw box.
    expect(refusal).toBeLessThan(handler.indexOf('if (!code) throw error;'));
    const branch = handler.slice(refusal, handler.indexOf('}', refusal));
    expect(branch).toContain('attachmentRejection = rejection;');
    expect(branch).toContain('return null;');
  });

  it('the refusal hands text and attachments back, names the file, and arms nothing', () => {
    const body = slice(COMPOSER, 'const runSend = async (', 'useQueueRelease({');
    const start = body.indexOf('if (attachmentRejection) {');
    expect(start).toBeGreaterThan(body.indexOf('if (retryUnavailable) {'));
    // Decided before a generic failure could claim it.
    expect(start).toBeLessThan(body.indexOf('if (fatalHostError) {', start));
    const branch = body.slice(start, body.indexOf('if (fatalHostError) {', start));
    expect(branch).toContain('showAttachmentRejection(attachmentRejection);');
    expect(branch).toContain('return finalizeOutcome(');
    expect(branch).toContain('{ refusedByRule: true }');
    // The slot that refused is healthy, nothing failed, and a resend of the
    // same payload is refused the same way.
    expect(branch).not.toContain('unbindHost(');
    expect(branch).not.toContain('lastError');
    expect(branch).not.toContain('setRetryable(');
    expect(count(COMPOSER, 'refusedByRule: true')).toBe(1);
  });

  it('a Ctrl+Enter interjection refused the same way keeps its draft and says why', () => {
    const interject = slice(COMPOSER, 'const interjectIntoTurn = async (', 'finally {');
    const handler = interject.slice(interject.indexOf('} catch (error) {'));
    expect(handler).toContain('wireAttachments ? parseAttachmentRejection(error) : null;');
    expect(handler).toContain('showAttachmentRejection(rejection);');
    // A refusal never clears the draft: only an accepted interjection does.
    expect(handler).not.toContain("updateValue('')");
    expect(handler).not.toContain('removeDrafts(');
  });

  it('the notice names the file and the code, next to the attachments', () => {
    const notice = slice(
      COMPOSER,
      'const showAttachmentRejection = (rejection: AttachmentRejection) => {',
      '};'
    );
    expect(notice).toContain('attachments.showNotice({');
    for (const key of ATTACHMENT_NOTICES) expect(notice).toContain(`'${key}'`);
  });

  it('ships both notices in the dictionary, and not the old one', () => {
    for (const key of ATTACHMENT_NOTICES) expect(zhTranslations[key]).toBeDefined();
    expect(zhTranslations[P1_1_NOTICE]).toBeUndefined();
    expect(COMPOSER).not.toContain(P1_1_NOTICE);
  });
});

describe('both refusals go through the one affordance authority', () => {
  it('finalizeOutcome still defers to decideFailureAffordance and its declined-restore fallback', () => {
    const finalize = slice(
      COMPOSER,
      'const finalizeOutcome = (',
      'setSendingSessionId(sessionId);'
    );
    expect(finalize).toContain('decideFailureAffordance(outcome, origin, context)');
    expect(finalize).toContain('restoreDraftIfComposerEmpty(sessionId, committed)');
    expect(finalize).toContain(
      "if (!restored && decideDeclinedRestore(outcome, origin, context) === 'resend') {"
    );
  });
});

/**
 * dsh-rebase P1-3c — the shared DSH engine is down (Main's
 * `dsh_host_unavailable`). The card names it; the status strip under the
 * composer, which is on screen when the card has scrolled away, says it in
 * words too instead of printing Main's English sentence.
 */
describe('P1-3c — the shared engine is down (dsh_host_unavailable)', () => {
  it('the status strip says so in words, ahead of the raw fallback', () => {
    const detector = COMPOSER.indexOf('isEngineUnavailableError(lastError)');
    expect(detector).toBeGreaterThan(-1);
    expect(COMPOSER).toContain('t(ENGINE_UNAVAILABLE_HINT)');
    expect(detector).toBeLessThan(COMPOSER.indexOf(`\`Error: \${lastError}\``));
  });
});
