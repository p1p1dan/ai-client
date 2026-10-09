import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * Decision 166 (GitHub issue #5): where `ChatComposer.runSend` switches the
 * posture for a goal-creating `/goal`. `runSend` cannot be rendered in this
 * suite (see `retryLastTurn.test.ts`), so its call sites are pinned by source
 * scan; what the called functions do is `goalStart.test.ts`'s, and that the
 * chip follows is `composerPermissions.test.ts`'s.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPOSER = stripComments(
  readFileSync(path.resolve(here, '../ChatComposer.tsx'), 'utf8'),
  'ChatComposer.tsx'
);
const runSendStart = COMPOSER.indexOf('const runSend = async (');
const RUN_SEND = COMPOSER.slice(runSendStart, COMPOSER.indexOf('\n  };\n', runSendStart));
const HANDLE_SEND = COMPOSER.slice(
  COMPOSER.indexOf('const handleSend = async'),
  COMPOSER.indexOf('const interjectIntoTurn')
);

describe('[decision 166] a goal-creating `/goal` switches the posture as it is dispatched', () => {
  it('is decided inside runSend, never when a line is queued', () => {
    expect(runSendStart).toBeGreaterThan(0);
    expect(RUN_SEND).toContain('planGoalStart(');
    // `handleSend`'s enqueue path hands the text to the queue; the release
    // re-enters `runSend`, which is where the switch happens.
    expect(HANDLE_SEND).not.toContain('planGoalStart');
    expect(HANDLE_SEND).not.toContain('applyGoalStart');
    // A retry re-runs a turn; it starts no goal.
    expect(RUN_SEND.replace(/\s+/g, ' ')).toContain(
      'const goalStart = retryLastTurn ? null : planGoalStart( trimmed,'
    );
  });

  it('stores the posture before the spawn reads it, for a chat whose worker is not up', () => {
    const plan = RUN_SEND.indexOf('const goalStart =');
    const beforeSpawn = RUN_SEND.indexOf(
      'applyGoalStartBeforeSpawn(sessionId, goalStart, goalStartEffects)'
    );
    const spawn = RUN_SEND.indexOf('let spawnPermissions =');
    expect(plan).toBeGreaterThan(RUN_SEND.indexOf('const preamble = decideSendPreamble('));
    expect(beforeSpawn).toBeGreaterThan(plan);
    expect(spawn).toBeGreaterThan(beforeSpawn);
    expect(RUN_SEND.slice(plan, beforeSpawn)).toContain("preamble.action !== 'direct'");
  });

  it('switches a live chat after the host is up and before the first send', () => {
    const live = RUN_SEND.indexOf('applyGoalStartLive(sessionId, goalStart, goalStartEffects)');
    expect(live).toBeGreaterThan(RUN_SEND.indexOf('window.electronAPI.chat.ensureHost()'));
    expect(live).toBeLessThan(RUN_SEND.indexOf('let waitResult = await sendAndWait();'));
    const guard = RUN_SEND.slice(RUN_SEND.lastIndexOf('if (', live), live);
    expect(guard).toContain("preamble.action === 'direct'");
    // A Stop while it is in flight ends the attempt like any other handshake
    // step, and a switch that took also moves a `session_not_found` re-create.
    const after = RUN_SEND.slice(live, RUN_SEND.indexOf('let waitResult', live));
    expect(after).toContain('if (switched === SEND_CANCELLED) return settleStoppedAttempt();');
    expect(after).toContain('if (switched) spawnPermissions = goalStart.next;');
  });

  it('tells the chip through the revision it re-reads on', () => {
    const effects = COMPOSER.slice(COMPOSER.indexOf('const goalStartEffects: GoalStartEffects'));
    const body = effects.slice(0, effects.indexOf('};'));
    expect(body).toContain('useLegacyMigrationStore.getState().notePostureSynced(sessionId)');
    expect(body).toContain('window.electronAPI.chat.setPermissions({ sessionId, permissions })');
    expect(body).toContain('writeSessionPermissions');
    // Never the new-chat default.
    expect(body).not.toContain('writeDefaultPermissions');
  });

  it('hands the menu its goal entry', () => {
    expect(COMPOSER).toContain('goalEntry={{ ...goalEntry, onSelect: startGoal }}');
  });
});
