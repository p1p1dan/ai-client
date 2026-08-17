import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeEverHostBound, isChatAgentBindingLocked } from '../sessionBinding';
import { stripComments } from './stripComments';

/**
 * D48 S1 · A2 — the chat-session binding criterion has exactly one home.
 *
 * Three copies of "this session is already bound" already existed before this
 * slice (`computeEverHostBound` in `useComposerTarget.ts`, `isLiveOnlySession`
 * in `useSessionIndex.ts`, and `MiddleColumnModeInput`'s triple in
 * `middleColumnLayout.ts`, whose own comments each say they mirror the first).
 * A fourth would not merely look inconsistent: a session restored from
 * session-index.json that gets judged "not yet materialized" can have its
 * agent switched, and the next message then carries a Codex threadId into the
 * Claude runtime's resume branch.
 *
 * So the truth table below is only half the assertion. The other half is the
 * import scan: the agent picker's lock, the target bar's lock, the composer
 * chain's lock and the store action's write guard must all reach for THIS
 * module, and neither `ChatWorkspace` nor `chatSessions` may spell the
 * disjunction out itself.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_DIR = path.resolve(__dirname, '..');

function readStripped(relative: string): string {
  const file = path.join(CHAT_DIR, relative);
  return stripComments(readFileSync(file, 'utf8'), file);
}

/** Import statement lines only — the scan is about the edge, not about prose. */
function importLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('import '));
}

describe('A2 — isChatAgentBindingLocked truth table', () => {
  it('a persisted runtimeIdentity alone locks the binding', () => {
    // The restored-session case: Host is not running, the id is in no live
    // list, and the row still names a conversation that exists upstream.
    expect(
      isChatAgentBindingLocked({
        sendAttempted: false,
        hostBound: false,
        hasRuntimeIdentity: true,
      })
    ).toBe(true);
  });

  it('a send attempt alone locks the binding', () => {
    // The create IPC is in flight: nothing is host-bound yet and no identity
    // has come back, but the agent for this turn is already committed.
    expect(
      isChatAgentBindingLocked({
        sendAttempted: true,
        hostBound: false,
        hasRuntimeIdentity: false,
      })
    ).toBe(true);
  });

  it('host-bound alone locks the binding', () => {
    expect(
      isChatAgentBindingLocked({
        sendAttempted: false,
        hostBound: true,
        hasRuntimeIdentity: false,
      })
    ).toBe(true);
  });

  it('all three false is the only unlocked state', () => {
    expect(
      isChatAgentBindingLocked({
        sendAttempted: false,
        hostBound: false,
        hasRuntimeIdentity: false,
      })
    ).toBe(false);
  });
});

describe('A2 — computeEverHostBound keeps both of its disjuncts', () => {
  it('is false for no session at all', () => {
    expect(computeEverHostBound(undefined, ['s1'])).toBe(false);
  });

  it('is true for a session in the live host-bound list', () => {
    expect(computeEverHostBound({ id: 's1' }, ['s1'])).toBe(true);
  });

  it('is true for a restored session carrying a runtimeIdentity only', () => {
    expect(computeEverHostBound({ id: 's1', runtimeIdentity: 'thread-1' }, [])).toBe(true);
  });

  it('is false for a live-only session that never sent', () => {
    expect(computeEverHostBound({ id: 's1' }, ['other'])).toBe(false);
  });
});

describe('A2 — every S1 consumer imports the same symbol', () => {
  /**
   * Four, not the three §3.3 listed: `setDraftSessionAgent` landed the same
   * criterion inside the red-line store as well, because the picker's UI gate
   * and the store's write guard are the same rule and the store cannot see the
   * component's props. The relative specifier is `@/components/chat/…` from
   * there, so the scan matches either spelling of the one module.
   */
  const CONSUMERS = [
    'useComposerTarget.ts',
    'ChatWorkspace.tsx',
    'composerAgentPickerModel.ts',
    '../../stores/chatSessions.ts',
  ] as const;

  const SESSION_BINDING = /['"](?:\.\/|@\/components\/chat\/)sessionBinding['"]/;

  for (const consumer of CONSUMERS) {
    it(`${consumer} imports from sessionBinding exactly once`, () => {
      const lines = importLines(readStripped(consumer));
      const hits = lines.filter((line) => SESSION_BINDING.test(line));
      expect(hits, `${consumer} import lines: ${lines.join(' | ')}`).toHaveLength(1);
    });
  }

  it('chatSessions does not spell the disjunction out itself either', () => {
    // The store is the last place a fourth copy could hide: it can read two of
    // the three arms directly off its own state, so `hostBoundSessionIds
    // .includes(id) || session.runtimeIdentity != null` is a one-line
    // temptation there — and the arm it would drop is `sendAttempted`, the one
    // that covers the whole create-IPC flight.
    const source = readStripped('../../stores/chatSessions.ts');
    const guard = source.indexOf('setDraftSessionAgent: (sessionId, agent, options)');
    expect(guard, 'setDraftSessionAgent implementation not found').toBeGreaterThan(-1);
    const body = source.slice(guard, source.indexOf('\n  },', guard));

    expect(body).toContain('isChatAgentBindingLocked({');
    expect(body).toContain('sendAttempted: options.sendAttempted,');
    expect(body).not.toMatch(/runtimeIdentity != null\s*\)?\s*\|\|/);
    expect(body).not.toMatch(/\|\|\s*session\.runtimeIdentity/);
  });

  it('ChatWorkspace does not spell the three-way disjunction out itself', () => {
    // The prop it hands the composer must come from the shared function, not
    // from a hand-written `a || b || c` that can drift one disjunct at a time.
    const source = readStripped('ChatWorkspace.tsx');
    expect(source).toContain('isChatAgentBindingLocked(');
    expect(source).not.toMatch(/sendAttempted[^\n]*\|\|/);
  });

  it('useComposerTarget no longer declares its own copy', () => {
    const source = readStripped('useComposerTarget.ts');
    expect(source).not.toContain('function computeEverHostBound');
  });
});
