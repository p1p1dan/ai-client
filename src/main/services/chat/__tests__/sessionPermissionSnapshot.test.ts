import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDraftPermissionPreference } from '@shared/models/chatAgentDefaults';
import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import type { SessionPermissionPreference } from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDir),
  },
}));

/**
 * D48 S3 §5.7 — the session SNAPSHOT half: C9, C14, C15.
 *
 * The failure mode all three describe is the same one, seen from three sides: a
 * chat that silently changes what it is allowed to do while the user is not
 * looking. Through the template being re-read on resume (C9), through a factory
 * value being captured before settings existed (C15), or through an old row
 * being rewritten by a build that learned a new field (C14).
 */

// `as` for the same reason the shared guards need one: the exported agent
// constants are typed as the wide `AgentWireName` and cannot narrow a union.
const PLAN = {
  agent: CLAUDE_CODE_AGENT,
  permissionMode: 'plan',
} as SessionPermissionPreference;
const BYPASS = {
  agent: CLAUDE_CODE_AGENT,
  permissionMode: 'bypassPermissions',
} as SessionPermissionPreference;

function readIndexFile(): SessionIndexEntry[] {
  return JSON.parse(readFileSync(join(userDataDir, 'session-index.json'), 'utf8'));
}

describe('SessionIndexService — the permission snapshot (C9/C14/C15)', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'aiclient-permission-snapshot-'));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('C9 — the first send captures the tier, and it survives to disk', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({
      sessionId: 's1',
      workspacePath: '/ws/a',
      agent: CLAUDE_CODE_AGENT,
      permissionPreference: PLAN,
    });
    expect((await service.get('s1'))?.permissionPreference).toEqual(PLAN);
    expect(readIndexFile()[0].permissionPreference).toEqual(PLAN);
  });

  it('C9 — a LATER create with a different template does not move an already-captured tier', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({
      sessionId: 's1',
      workspacePath: '/ws/a',
      permissionPreference: PLAN,
    });
    // The user edits Settings, then the Host registry entry is dropped and the
    // renderer re-creates the same session. Re-capturing here is how a global
    // edit reaches an existing chat through the back door.
    await service.recordCreated({
      sessionId: 's1',
      workspacePath: '/ws/a',
      permissionPreference: BYPASS,
    });
    expect((await service.get('s1'))?.permissionPreference).toEqual(PLAN);
  });

  it('C9 — resume replays the captured tier and never drops it', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({
      sessionId: 's1',
      workspacePath: '/ws/a',
      permissionPreference: PLAN,
    });
    // `recordResumed` rebuilds the row field by field; a missing line here
    // would DELETE the snapshot on the first resume.
    await service.recordResumed({
      sessionId: 's1',
      workspacePath: '/ws/a',
      runtimeIdentity: 'sdk-session-1',
    });
    expect((await service.get('s1'))?.permissionPreference).toEqual(PLAN);
    expect((await service.get('s1'))?.runtimeIdentity).toBe('sdk-session-1');
  });

  it('C15 — a create with no preference writes no such key at all, rather than a factory value', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 's1', workspacePath: '/ws/a' });
    const onDisk = readIndexFile()[0];
    expect('permissionPreference' in onDisk).toBe(false);
    expect(onDisk.sessionId).toBe('s1');
  });

  it('C14 — a row written before this field existed is read, resumed and reflushed without gaining one', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({ sessionId: 'legacy', workspacePath: '/ws/a', model: 'sonnet' });
    await service.recordResumed({
      sessionId: 'legacy',
      workspacePath: '/ws/a',
      runtimeIdentity: 'thread-9',
    });
    const onDisk = readIndexFile()[0];
    expect('permissionPreference' in onDisk).toBe(false);
    expect(onDisk.model).toBe('sonnet');
  });

  it('the snapshot is per-session — one chat is never told about another one', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({
      sessionId: 'a',
      workspacePath: '/ws/a',
      permissionPreference: PLAN,
    });
    await service.recordCreated({ sessionId: 'b', workspacePath: '/ws/b' });
    expect((await service.get('a'))?.permissionPreference).toEqual(PLAN);
    expect((await service.get('b'))?.permissionPreference).toBeUndefined();
  });

  it('§5.5-4 — every write entry point this build has is first-write-wins, so S4 must bring its own', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({
      sessionId: 's1',
      workspacePath: '/ws/a',
      agent: CLAUDE_CODE_AGENT,
      model: 'sonnet',
      permissionPreference: PLAN,
    });

    // Every existing path that touches this row, exercised against a DIFFERENT
    // posture. None of them may move it — that is the point of §5.5-2, and it
    // is also why S4 cannot reach the field through any of them.
    await service.recordCreated({
      sessionId: 's1',
      workspacePath: '/ws/a',
      agent: CLAUDE_CODE_AGENT,
      model: 'opus',
      permissionPreference: BYPASS,
    });
    await service.recordResumed({
      sessionId: 's1',
      workspacePath: '/ws/a',
      runtimeIdentity: 'thr-1',
      agent: CLAUDE_CODE_AGENT,
    });

    const entry = await service.get('s1');
    expect(entry?.permissionPreference).toEqual(PLAN);
    // …while a field that IS meant to move moved, so this is a property of the
    // posture rather than of the whole row being frozen.
    expect(entry?.model).toBe('opus');
    expect(entry?.runtimeIdentity).toBe('thr-1');
    // The prerequisite S4 inherited, stated as an assertion rather than as prose
    // in a doc: the change could not be built out of `recordCreated`, so S4 had
    // to bring an entry point of its own. It did — and this now pins that the
    // capture paths are STILL not it, so exactly one method can move the field.
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter((name) =>
        /permission/i.test(name)
      )
    ).toEqual(['setPermissionPreference']);
  });
});

/**
 * D48 S4 §6.3 / D10 — the one writer allowed to move a captured posture.
 *
 * Every other path into this field is a CAPTURE and is first-write-wins (above).
 * This one records a change the user made to THIS chat on purpose, and it is
 * what the next resume replays — so the assertions are about the two halves of
 * that: it really moves the value, and it really lands on disk, because a change
 * that survives only until the next restart is a change the user will make
 * twice and trust once.
 */
describe('SessionIndexService — the mid-session posture write (D48 S4)', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'aiclient-permission-update-'));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('overwrites a captured posture, and flushes it', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({
      sessionId: 's1',
      workspacePath: '/ws/a',
      agent: CLAUDE_CODE_AGENT,
      permissionPreference: PLAN,
    });

    expect(await service.setPermissionPreference('s1', BYPASS)).toBe(true);
    expect((await service.get('s1'))?.permissionPreference).toEqual(BYPASS);
    // On disk, not merely in the map: resume reads the file after a restart.
    expect(readIndexFile()[0].permissionPreference).toEqual(BYPASS);
  });

  it('a later capture cannot undo it — the change outranks the template forever', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({
      sessionId: 's1',
      workspacePath: '/ws/a',
      agent: CLAUDE_CODE_AGENT,
    });
    await service.setPermissionPreference('s1', PLAN);
    // `chat:createSession` runs again on every rebind (restart, crash, unbind).
    await service.recordCreated({
      sessionId: 's1',
      workspacePath: '/ws/a',
      agent: CLAUDE_CODE_AGENT,
      permissionPreference: BYPASS,
    });
    await service.recordResumed({
      sessionId: 's1',
      workspacePath: '/ws/a',
      runtimeIdentity: 'thr-1',
    });
    expect((await service.get('s1'))?.permissionPreference).toEqual(PLAN);
  });

  it('keeps the rest of the row intact while it moves the posture', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    await service.recordCreated({
      sessionId: 's1',
      workspacePath: '/ws/a',
      agent: CLAUDE_CODE_AGENT,
      model: 'sonnet',
    });
    await service.rename('s1', 'my chat');
    await service.setPermissionPreference('s1', PLAN);

    const entry = await service.get('s1');
    // A rebuild-field-by-field write here (the shape `recordCreated` uses) would
    // silently drop the title and the archived bit.
    expect(entry?.title).toBe('my chat');
    expect(entry?.model).toBe('sonnet');
    expect(entry?.agent).toBe(CLAUDE_CODE_AGENT);
    expect(entry?.archived).toBe(false);
  });

  it('refuses a session it has never heard of rather than inventing a row', async () => {
    const { SessionIndexService } = await import('../SessionIndexService');
    const service = new SessionIndexService();
    expect(await service.setPermissionPreference('ghost', PLAN)).toBe(false);
    expect(await service.get('ghost')).toBeUndefined();
  });
});

describe('C15 — the hydration gate, on the renderer side of the same rule', () => {
  const defaults = { byAgent: { [CLAUDE_CODE_AGENT]: { permission: PLAN } } };

  it('an unhydrated first send materialises nothing, so nothing is pinned', () => {
    expect(
      resolveDraftPermissionPreference({
        defaults,
        agent: CLAUDE_CODE_AGENT,
        settingsHydrated: false,
      })
    ).toBeUndefined();
  });

  it('a hydrated first send materialises what the user actually set', () => {
    expect(
      resolveDraftPermissionPreference({
        defaults,
        agent: CLAUDE_CODE_AGENT,
        settingsHydrated: true,
      })
    ).toEqual(PLAN);
  });

  it('the other agent gets nothing out of this agent’s template', () => {
    expect(
      resolveDraftPermissionPreference({ defaults, agent: CODEX_AGENT, settingsHydrated: true })
    ).toBeUndefined();
  });
});
