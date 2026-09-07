import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * U29 — the composer bar is not empty before a conversation exists.
 *
 * Reported after U28 landed: the start screen had a live textarea but a bar
 * with nothing on it except attach and send, so the first message could only go
 * out on whatever the default model was.
 *
 * pix has no such state — its access menu and model menu are always live,
 * because in pix those belong to the host process and a global preference, not
 * to a conversation (`main.tsx`'s `lastComposerChromeRef`: "survives snapshot
 * gaps so composer never flashes 未选择模型"). We are multi-session, so the
 * values stay per-chat; what U29 adopts is the RULE that the controls never go
 * blank, with the global template standing in until a chat exists.
 *
 * Source scans because these are JSX branches.
 */
const read = (relative: string) => {
  const file = path.join(process.cwd(), relative);
  return stripComments(readFileSync(file, 'utf8'), file);
};

const COMPOSER = read('src/renderer/components/chat/ChatComposer.tsx');
const MODEL = read('src/renderer/components/chat/ComposerModelTrigger.tsx');
const PERMISSION = read('src/renderer/components/chat/ComposerPermissionTrigger.tsx');
const STORE = read('src/renderer/components/chat/sessionPreferenceStore.ts');

describe('U29 the start screen keeps its bar controls', () => {
  it('model/effort and permission render without a session', () => {
    expect(COMPOSER).not.toContain('const modelEffortControls = activeSessionId ? (');
    expect(COMPOSER).not.toContain('permission: activeSessionId ? (');
    expect(COMPOSER).toContain('const modelEffortControls = (');
  });

  it('occupancy stays session-only — it is a measurement, not a preference', () => {
    // The one slot U29 deliberately did NOT widen: a chat that has never run a
    // turn has no context to report. pix reads it the same way.
    expect(COMPOSER).toContain(
      'usage: activeSessionId ? <ComposerUsageChip sessionId={activeSessionId} /> : null,'
    );
  });

  it('both controls accept a null session rather than being handed a fake id', () => {
    // A placeholder id would be written into the per-session maps and then
    // inherited by whichever real chat happened to collide with it.
    expect(MODEL).toContain('sessionId: string | null;');
    expect(PERMISSION).toContain('sessionId: string | null;');
  });

  it('with no session the model pick lands in the global template only', () => {
    // `setChatAgentDefaults` was already called on every explicit pick (§4.3's
    // "an explicit pick also becomes this agent's template"), so the change is
    // that the per-session writes are skipped, not that a new store appeared.
    expect(MODEL).toContain('if (sessionId) setSessionEffort(sessionId, itemId);');
    expect(MODEL).toContain('sessionId ? getSessionModel(sessionId) : null');
    expect(MODEL).toContain('sessionId ? getSessionEffort(sessionId) : null');
  });

  it('with no session the tier lands in its own global key, not the per-chat map', () => {
    // The per-chat map is keyed by real session ids and swept by
    // `removeSessionTier`; a sentinel row among them is one cleanup away from
    // being deleted.
    expect(STORE).toContain("export const DEFAULT_TIER_STORAGE_KEY = 'aiclient:chat:default-tier'");
    expect(STORE).toContain('export function readDefaultTier()');
    expect(PERMISSION).toContain('writeDefaultTier(newTier);');
    // …and a live chat still writes its own row plus tells its worker.
    expect(PERMISSION).toContain('writeSessionTier(sessionId, newTier);');
    expect(PERMISSION).toContain('.setPermissionTier({ sessionId, tier: newTier })');
  });

  it('the host-ready gate stands down when there is no session to be ready', () => {
    // `hostState` describes a runtime this control is not talking to yet.
    // Pinned as the two terms that carry the rule (a null session never gates,
    // and the gate itself is the shared `isHostUsable` predicate) rather than
    // the whole line — see the U30 lesson about assertions that pin a spelling
    // and stay green while the behavior breaks.
    expect(PERMISSION).toContain('sessionId !== null && !isHostUsable(hostState)');
    expect(PERMISSION).not.toContain("hostState !== 'ready'");
  });
});
