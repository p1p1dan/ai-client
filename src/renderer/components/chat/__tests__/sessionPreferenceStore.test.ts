import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EFFORT_DEFAULT_ID, toWireEffort } from '../efforts';
import {
  clearDraftPermission,
  readDraftPermission,
  readSessionEffort,
  readSessionModel,
  removeSessionEffort,
  removeSessionModel,
  SESSION_DRAFT_PERMISSION_STORAGE_KEY,
  SESSION_EFFORT_STORAGE_KEY,
  SESSION_MODEL_STORAGE_KEY,
  writeDraftPermission,
  writeSessionEffort,
  writeSessionModel,
} from '../sessionPreferenceStore';

/**
 * T-20 persistence, re-keyed by (session, agent) in D48 S2.
 *
 * Four behaviours are load-bearing: selections are per-session (switching
 * sessions must not leak the other's), per-AGENT (B12 — switching a zero-turn
 * draft away and back must return the user to what they picked), read-only for
 * pre-D48 blobs (B5 — a compatible read must never become an irreversible write
 * migration), and never-throwing (the Composer reads this on every Send, so a
 * throw would break sending).
 */

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeMemoryStorage());
});

describe('sessionPreferenceStore — effort', () => {
  it('returns null for a session with no stored selection', () => {
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBeNull();
  });

  it('round-trips a selection through storage, nested under the agent', () => {
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'xhigh');
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBe('xhigh');
    expect(JSON.parse(localStorage.getItem(SESSION_EFFORT_STORAGE_KEY) ?? '{}')).toEqual({
      s1: { 'claude-code': 'xhigh' },
    });
  });

  it('keeps selections independent per session', () => {
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'low');
    writeSessionEffort('s2', CLAUDE_CODE_AGENT, 'max');
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBe('low');
    expect(readSessionEffort('s2', CLAUDE_CODE_AGENT)).toBe('max');
  });

  // B12, effort half: one scalar per session would answer `max` for both reads.
  it('B12: keeps selections independent per agent within one session', () => {
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'low');
    writeSessionEffort('s1', CODEX_AGENT, 'max');
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBe('low');
    expect(readSessionEffort('s1', CODEX_AGENT)).toBe('max');
  });

  it('overwrites a prior selection for the same pair', () => {
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'low');
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'high');
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBe('high');
  });

  it('clears one pair without touching the others', () => {
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'low');
    writeSessionEffort('s1', CODEX_AGENT, 'high');
    writeSessionEffort('s2', CLAUDE_CODE_AGENT, 'max');
    removeSessionEffort('s1', CLAUDE_CODE_AGENT);
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBeNull();
    expect(readSessionEffort('s1', CODEX_AGENT)).toBe('high');
    expect(readSessionEffort('s2', CLAUDE_CODE_AGENT)).toBe('max');
  });

  it('drops the whole row once its last agent entry is cleared', () => {
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'low');
    removeSessionEffort('s1', CLAUDE_CODE_AGENT);
    expect(JSON.parse(localStorage.getItem(SESSION_EFFORT_STORAGE_KEY) ?? '{}')).toEqual({});
  });

  it('treats clearing an unset session as a no-op', () => {
    expect(() => removeSessionEffort('missing', CODEX_AGENT)).not.toThrow();
    expect(readSessionEffort('missing', CODEX_AGENT)).toBeNull();
  });

  it('persists the Default sentinel, which then omits the wire field', () => {
    // An explicit Default choice must survive a restart — otherwise the selector
    // would silently drift back to whatever the initial state was.
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, EFFORT_DEFAULT_ID);
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBe(EFFORT_DEFAULT_ID);
    expect(toWireEffort(readSessionEffort('s1', CLAUDE_CODE_AGENT))).toBeUndefined();
  });

  // B10, storage layer: `ultra` is the word §4.9-⑨ names, and the point of
  // counting layers is that no single one of them is trusted alone.
  it('B10: a word outside the vocabulary never reaches storage', () => {
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'ultra');
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBeNull();
    // Rejected on the way IN: the key is not created at all, so there is
    // nothing for a later read to have to decide about.
    expect(localStorage.getItem(SESSION_EFFORT_STORAGE_KEY)).toBeNull();
  });

  it('B10: rejecting an illegal write leaves the previous legal value intact', () => {
    // The failure mode a plain `try { validate } catch { clear }` would have:
    // an illegal write must be a no-op, not a reset.
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'high');
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'ultra');
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBe('high');
  });

  it('B10: all five measured levels and the sentinel are accepted', () => {
    // The other half of the guard: a vocabulary check that rejected a real
    // level would be caught here rather than as an unexplained selector reset.
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max', EFFORT_DEFAULT_ID]) {
      writeSessionEffort('s1', CLAUDE_CODE_AGENT, level);
      expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBe(level);
    }
  });

  it('B10: neither a blank string nor a near-miss casing gets through', () => {
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, '');
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'High');
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, ' high ');
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBeNull();
  });

  // The five levels are one shared vocabulary on both axes [实测 调查 04 探测
  // E/G], so a pre-D48 scalar answers for whichever agent asks.
  it('reads a pre-D48 flat value for either agent', () => {
    localStorage.setItem(SESSION_EFFORT_STORAGE_KEY, JSON.stringify({ s1: 'high' }));
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBe('high');
    expect(readSessionEffort('s1', CODEX_AGENT)).toBe('high');
  });

  it('degrades to unset when the stored blob is corrupt', () => {
    localStorage.setItem(SESSION_EFFORT_STORAGE_KEY, '{not json');
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBeNull();
  });

  it('degrades to unset when the stored blob is not an object', () => {
    localStorage.setItem(SESSION_EFFORT_STORAGE_KEY, '["high"]');
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBeNull();
  });

  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    } as unknown as Storage);
    expect(() => writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'high')).not.toThrow();
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBeNull();
  });
});

describe('sessionPreferenceStore — model', () => {
  it('round-trips a model id under its agent', () => {
    writeSessionModel('s1', CODEX_AGENT, 'gpt-5.6-sol');
    expect(readSessionModel('s1', CODEX_AGENT)).toBe('gpt-5.6-sol');
    expect(JSON.parse(localStorage.getItem(SESSION_MODEL_STORAGE_KEY) ?? '{}')).toEqual({
      s1: { codex: 'gpt-5.6-sol' },
    });
  });

  // B12 load-bearing: the case a single scalar per session cannot express, and the one
  // the pre-existing "no cross-agent selection exists" wording passed either
  // way. Claude → Codex → Claude, and the first pick is still there.
  it('B12: switching agent away and back returns the original selection', () => {
    writeSessionModel('s1', CLAUDE_CODE_AGENT, 'claude-haiku-4-5');
    writeSessionModel('s1', CODEX_AGENT, 'gpt-5.6-terra');
    expect(readSessionModel('s1', CLAUDE_CODE_AGENT)).toBe('claude-haiku-4-5');
    expect(readSessionModel('s1', CODEX_AGENT)).toBe('gpt-5.6-terra');
  });

  it('clearing one agent is how Automatic is stored, and leaves the other alone', () => {
    writeSessionModel('s1', CLAUDE_CODE_AGENT, 'claude-opus-5');
    writeSessionModel('s1', CODEX_AGENT, 'gpt-5.6-sol');
    removeSessionModel('s1', CLAUDE_CODE_AGENT);
    expect(readSessionModel('s1', CLAUDE_CODE_AGENT)).toBeNull();
    expect(readSessionModel('s1', CODEX_AGENT)).toBe('gpt-5.6-sol');
  });

  // B5: a pre-D48 blob is `{ "<id>": "sonnet" }`. It must still answer, and it
  // must answer only for the agent that could actually run the value — the same
  // three-valued ownership rule Main's dispatch guard uses.
  it('B5: a pre-D48 flat model value is readable, and only by its owning agent', () => {
    localStorage.setItem(SESSION_MODEL_STORAGE_KEY, JSON.stringify({ s1: 'sonnet' }));
    expect(readSessionModel('s1', CLAUDE_CODE_AGENT)).toBe('sonnet');
    expect(readSessionModel('s1', CODEX_AGENT)).toBeNull();
  });

  it('an unclassifiable pre-D48 value stays available on both axes', () => {
    localStorage.setItem(SESSION_MODEL_STORAGE_KEY, JSON.stringify({ s1: 'house-blend-1' }));
    expect(readSessionModel('s1', CLAUDE_CODE_AGENT)).toBe('house-blend-1');
    expect(readSessionModel('s1', CODEX_AGENT)).toBe('house-blend-1');
  });

  // B5 load-bearing: reading is a READ. Asserted as a byte-for-byte snapshot, because
  // the failure mode is not "wrong value returned" but "the only copy of the
  // user's value was overwritten during a render".
  it('B5: reading never rewrites the stored blob', () => {
    const before = JSON.stringify({ s1: 'sonnet', s2: { codex: 'gpt-5.6-sol' } });
    localStorage.setItem(SESSION_MODEL_STORAGE_KEY, before);

    readSessionModel('s1', CLAUDE_CODE_AGENT);
    readSessionModel('s1', CODEX_AGENT);
    readSessionModel('s2', CODEX_AGENT);
    readSessionModel('missing', CLAUDE_CODE_AGENT);

    expect(localStorage.getItem(SESSION_MODEL_STORAGE_KEY)).toBe(before);
  });

  // §4.4-4: the migration is completed by the user's next click, and it is
  // behaviour-preserving — the legacy value is fanned out to exactly the agents
  // that were already reading it before the new value lands on top.
  it('a write upgrades a legacy row without losing what the other agent was reading', () => {
    localStorage.setItem(SESSION_MODEL_STORAGE_KEY, JSON.stringify({ s1: 'house-blend-1' }));
    writeSessionModel('s1', CODEX_AGENT, 'gpt-5.6-sol');
    expect(readSessionModel('s1', CODEX_AGENT)).toBe('gpt-5.6-sol');
    expect(readSessionModel('s1', CLAUDE_CODE_AGENT)).toBe('house-blend-1');
  });

  it('a write does not resurrect a legacy value for an agent that could not read it', () => {
    localStorage.setItem(SESSION_MODEL_STORAGE_KEY, JSON.stringify({ s1: 'sonnet' }));
    writeSessionModel('s1', CODEX_AGENT, 'gpt-5.6-sol');
    expect(readSessionModel('s1', CODEX_AGENT)).toBe('gpt-5.6-sol');
    expect(readSessionModel('s1', CLAUDE_CODE_AGENT)).toBe('sonnet');
    expect(JSON.parse(localStorage.getItem(SESSION_MODEL_STORAGE_KEY) ?? '{}')).toEqual({
      s1: { 'claude-code': 'sonnet', codex: 'gpt-5.6-sol' },
    });
  });

  it('the two storage keys stay disjoint', () => {
    writeSessionModel('s1', CLAUDE_CODE_AGENT, 'claude-opus-5');
    writeSessionEffort('s1', CLAUDE_CODE_AGENT, 'high');
    expect(readSessionModel('s1', CLAUDE_CODE_AGENT)).toBe('claude-opus-5');
    expect(readSessionEffort('s1', CLAUDE_CODE_AGENT)).toBe('high');
    expect(JSON.parse(localStorage.getItem(SESSION_MODEL_STORAGE_KEY) ?? '{}')).toEqual({
      s1: { 'claude-code': 'claude-opus-5' },
    });
  });

  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    } as unknown as Storage);
    expect(() => writeSessionModel('s1', CODEX_AGENT, 'gpt-5.6-sol')).not.toThrow();
    expect(readSessionModel('s1', CODEX_AGENT)).toBeNull();
  });
});

/**
 * The draft posture map (2026-08-25): what a zero-turn chat will START under.
 *
 * Storage-layer rules only — whether the chip should be rendered at all is
 * `composerPermissionModel`'s question, and whether a pick outranks the template
 * is `resolveDraftPermissionPreference`'s.
 */
describe('draft permission posture', () => {
  const claude = { agent: 'claude-code', permissionMode: 'bypassPermissions' } as const;
  const codex = { agent: 'codex', approvalPolicy: 'never', sandboxMode: 'read-only' } as const;

  it('round-trips a posture for one (session, agent)', () => {
    writeDraftPermission('s1', CLAUDE_CODE_AGENT, claude);
    expect(readDraftPermission('s1', CLAUDE_CODE_AGENT)).toEqual(claude);
  });

  /**
   * The same rule the model and effort maps carry: a zero-turn draft can be
   * switched between runtimes freely, and switching away and back has to return
   * the user to what they picked rather than to the template.
   */
  it('keeps the two agents apart on one session', () => {
    writeDraftPermission('s1', CLAUDE_CODE_AGENT, claude);
    writeDraftPermission('s1', CODEX_AGENT, codex);
    expect(readDraftPermission('s1', CLAUDE_CODE_AGENT)).toEqual(claude);
    expect(readDraftPermission('s1', CODEX_AGENT)).toEqual(codex);
  });

  /**
   * Rejected on the way IN, like `writeSessionEffort`: a value that reached the
   * create payload could pin a posture nobody chose into the session snapshot,
   * and resume reads that snapshot forever.
   */
  it('refuses a posture addressed to the other agent', () => {
    writeDraftPermission('s1', CODEX_AGENT, claude as never);
    expect(readDraftPermission('s1', CODEX_AGENT)).toBeNull();
    writeDraftPermission('s1', CLAUDE_CODE_AGENT, codex as never);
    expect(readDraftPermission('s1', CLAUDE_CODE_AGENT)).toBeNull();
    // …and NOTHING was written. The read guard would mask a bad value anyway,
    // which is exactly why this half exists: `writeSessionEffort`'s header
    // states the rule — rejecting on the way in rather than discarding on the
    // way out, because discarding on read leaves the bad value on disk to be
    // re-decided on every read, and the obvious fix (rewriting during a read)
    // is forbidden by `sessionIndex.ts`'s no-migration-on-read rule.
    expect(localStorage.getItem(SESSION_DRAFT_PERMISSION_STORAGE_KEY)).toBeNull();
  });

  it('refuses a tier outside the vocabulary', () => {
    writeDraftPermission('s1', CLAUDE_CODE_AGENT, {
      agent: 'claude-code',
      permissionMode: 'ultra',
    } as never);
    expect(readDraftPermission('s1', CLAUDE_CODE_AGENT)).toBeNull();
  });

  /** A hand-edited blob must not become a posture on read either. */
  it('refuses a stored value that no longer validates', () => {
    localStorage.setItem(
      SESSION_DRAFT_PERMISSION_STORAGE_KEY,
      JSON.stringify({ s1: { 'claude-code': { agent: 'claude-code', permissionMode: 'ultra' } } })
    );
    expect(readDraftPermission('s1', CLAUDE_CODE_AGENT)).toBeNull();
  });

  /**
   * Cleared once the chat has started. From the first turn on the session's own
   * snapshot is the posture, and a leftover intent that could outrank a
   * mid-session change is the silent-privilege swap R18 names.
   */
  it('clearing a session drops both agents and leaves other sessions alone', () => {
    writeDraftPermission('s1', CLAUDE_CODE_AGENT, claude);
    writeDraftPermission('s1', CODEX_AGENT, codex);
    writeDraftPermission('s2', CLAUDE_CODE_AGENT, claude);
    clearDraftPermission('s1');
    expect(readDraftPermission('s1', CLAUDE_CODE_AGENT)).toBeNull();
    expect(readDraftPermission('s1', CODEX_AGENT)).toBeNull();
    expect(readDraftPermission('s2', CLAUDE_CODE_AGENT)).toEqual(claude);
  });

  it('never throws on a corrupt blob or an unavailable store', () => {
    localStorage.setItem(SESSION_DRAFT_PERMISSION_STORAGE_KEY, 'not json{{');
    expect(() => readDraftPermission('s1', CLAUDE_CODE_AGENT)).not.toThrow();
    expect(readDraftPermission('s1', CLAUDE_CODE_AGENT)).toBeNull();
    expect(() => clearDraftPermission('s1')).not.toThrow();
  });
});
