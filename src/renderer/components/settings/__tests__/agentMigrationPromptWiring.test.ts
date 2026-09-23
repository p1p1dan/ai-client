import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * H/21 P1 wiring smoke. BRITTLE BY DESIGN.
 *
 * vitest runs `node` here, so the dialog cannot be rendered and asserted on.
 * `migrationPromptModel.test.ts` truth-tables the rules; this file covers the
 * layer above — that the component reaches for them, that the dialog is
 * actually mounted, and that the few properties which only exist in the `.tsx`
 * (never overwrite; remember the answer; skip the scan once answered) are
 * present as executable syntax rather than as prose in a comment.
 *
 * Comments are blanked first, because every property below is also *explained*
 * in a comment immediately next to it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string, name: string) =>
  stripComments(readFileSync(path.join(HERE, relative), 'utf8'), name);

const PROMPT = read('../AgentMigrationPrompt.tsx', 'AgentMigrationPrompt.tsx');
const APP = read('../../../App.tsx', 'App.tsx');
const PANE = read('../AgentMigrationSettings.tsx', 'AgentMigrationSettings.tsx');
const ROOT = read('../../../Root.tsx', 'Root.tsx');

describe('AgentMigrationPrompt wiring (H/21 P1)', () => {
  it('[MPW-01] is mounted at app level, not inside settings', () => {
    // The whole point is reaching the user who never opens settings.
    expect(APP).toContain('<AgentMigrationPrompt />');
    expect(APP).toContain("from './components/settings/AgentMigrationPrompt'");
  });

  it('[MPW-02] asks the shared rule whether to open at all', () => {
    expect(PROMPT).toContain('shouldPromptMigration({');
    expect(PROMPT).toContain('defaultMigrationSelection(next)');
  });

  it('[MPW-03] skips the directory scan once the user has opted out', () => {
    // An inspection walks `~/.pi/agent`. Doing it on every launch forever, for
    // someone who pressed "Don't ask again", is work nobody asked for.
    expect(PROMPT).toContain('if (alreadySettled()) return;');
  });

  it('[MPW-04] never overwrites from this dialog', () => {
    // The user has seen counts, not file names — there is no informed answer to
    // a collision here. `overwrite` belongs to the pane, which shows the names.
    expect(PROMPT).toContain("onConflict: 'skip'");
    expect(PROMPT).not.toContain("onConflict: 'overwrite'");
    expect(PROMPT).not.toContain('setOverwrite');
  });

  it('[MPW-05] keeps the permanent exit separate from the transient one', () => {
    // Collapsing these was the first draft's bug: "Not now" promised a later
    // and never delivered one (user feedback, 2026-09-10).
    expect(PROMPT).toContain('const notNow = useCallback(() => {');
    expect(PROMPT).toContain('const neverAsk = useCallback(() => {');
    // Escape and the backdrop route to the transient one.
    expect(PROMPT).toContain('if (!next) notNow();');
  });

  it('[MPW-05b] only the explicit opt-out and a finished copy write the flag', () => {
    // Two writers, both named here. A third would mean some other exit is
    // silently permanent — exactly what this split exists to prevent.
    const writes = PROMPT.match(/markSettled\(\);/g) ?? [];
    expect(writes).toHaveLength(2);
    expect(PROMPT).toContain('onClick={neverAsk}');
    expect(PROMPT).toContain('onClick={notNow}');
  });

  it('[MPW-06] shows the API-key consent line only while that row is ticked', () => {
    expect(PROMPT).toContain('selectionCarriesSecrets([...selected])');
    expect(PROMPT).toContain('{secrets && (');
  });

  it('[MPW-07] renders nothing at all when there is no offer', () => {
    // The guard now also accounts for the Claude Code / Codex history guide:
    // the dialog renders when there is a Pi plan OR legacy conversations to
    // guide to, and nothing otherwise.
    expect(PROMPT).toContain('if (!plan && !showLegacyGuide) return null;');
  });

  it('[MPW-08] shows each item count, which is what makes unticking a huge one possible', () => {
    expect(PROMPT).toContain(`\`\${item.total}\``);
  });
});

describe('the entry screen yields to the offer (H/21 point-check D7)', () => {
  it('[MPW-11] the settings auto-open is gated on there being no migration', () => {
    // Both features aim at the same person — someone who has been running `pi`
    // and just arrived here — so both fired, on top of the announcement, and
    // the app greeted them with three stacked modals.
    expect(ROOT).toContain('await migrationOfferWillOpen()');
    expect(ROOT).toContain("requestSettings('pi')");
  });

  it('[MPW-12] the gate reads the same rule the dialog does', () => {
    // Two copies of "is there anything to migrate" is how the settings page and
    // the dialog would start disagreeing about the same user.
    expect(PROMPT).toContain('export async function migrationOfferWillOpen');
    expect(PROMPT).toContain('shouldPromptMigration({ plan, asked: false })');
  });

  it('[MPW-13] someone who opted out still gets the settings page', () => {
    // `alreadySettled()` short-circuits before the inspection, so a user who
    // pressed "Don't ask again" is not left with neither surface.
    const gate = PROMPT.slice(PROMPT.indexOf('export async function migrationOfferWillOpen'));
    expect(gate).toContain('if (alreadySettled()) return false;');
  });
});

describe('AgentMigrationSettings shares the prompt rules (H/21 P1)', () => {
  it('[MPW-09] the pane and the dialog name each kind through one function', () => {
    expect(PANE).toContain("from './migrationPromptModel'");
    expect(PANE).toContain('migrationKindLabel');
    // The old private copy is gone — two switch statements over the same five
    // kinds is exactly how two surfaces start calling one thing two names.
    expect(PANE).not.toContain('function kindLabel');
  });

  it('[MPW-10] the pane derives its default selection from the same rule', () => {
    expect(PANE).toContain('defaultMigrationSelection(next)');
    expect(PANE).not.toContain('item.total > item.conflicts + item.blocked');
  });
});

describe('Pi-migration suppression (@/lib/aRoundTesting)', () => {
  it('[MPW-14] the dialog still bails on the A-round gate, and suppresses the Pi copy separately', () => {
    expect(PROMPT).toContain("from '@/lib/aRoundTesting'");
    // The A-round gate still short-circuits the auto-open effect before any
    // inspect call — the dialog does not walk the filesystem while it is on.
    const effect = PROMPT.slice(PROMPT.indexOf('useEffect(() => {'));
    expect(effect.indexOf('LOCAL_SETUP_ENTRY_DISABLED')).toBeGreaterThan(-1);
    expect(effect.indexOf('LOCAL_SETUP_ENTRY_DISABLED')).toBeLessThan(
      effect.indexOf('agentMigration.inspect')
    );
    // The Pi copy is suppressed by its own flag, separate from the gate: the
    // inspect call is skipped while `PI_MIGRATION_DISABLED` is on, so the
    // Claude Code / Codex guide is the only thing the dialog offers.
    expect(PROMPT).toContain('PI_MIGRATION_DISABLED');
    const gate = PROMPT.slice(PROMPT.indexOf('export async function migrationOfferWillOpen'));
    expect(gate.indexOf('PI_MIGRATION_DISABLED')).toBeGreaterThan(-1);
  });

  it('[MPW-15] the settings-pane twin is greyed out, not removed', () => {
    expect(PANE).toContain("from '@/lib/aRoundTesting'");
    // The section still renders (no early `return null` keyed on the flag) —
    // only the interactive controls carry it.
    expect(PANE).not.toMatch(/if \(PI_MIGRATION_DISABLED\)\s*return null/);
    expect(PANE.match(/PI_MIGRATION_DISABLED/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('[MPW-16] WelcomeView reads the gate; the migration surfaces read the suppression flag', () => {
    const WELCOME = read('../../onboarding/WelcomeView.tsx', 'WelcomeView.tsx');
    // WelcomeView still defers to the A-round gate.
    expect(WELCOME).toContain('LOCAL_SETUP_ENTRY_DISABLED');
    expect(WELCOME).toContain("from '@/lib/aRoundTesting'");
    // The Pi-migration surfaces now key their disabled state on the dedicated
    // suppression flag rather than the A-round gate.
    for (const file of [PROMPT, PANE]) {
      expect(file).toContain('PI_MIGRATION_DISABLED');
    }
  });
});

describe('self-opening dialogs share one slot (@/hooks/useModalQueueSlot)', () => {
  it('[MPW-17] the migration prompt and the announcement dialog both register for it', () => {
    const ANNOUNCEMENT = read(
      '../../announcements/AnnouncementDialog.tsx',
      'AnnouncementDialog.tsx'
    );
    expect(PROMPT).toContain("from '@/hooks/useModalQueueSlot'");
    expect(PROMPT).toContain("useModalQueueSlot('agentMigrationPrompt', open)");
    expect(PROMPT).toContain('open={open && canShow}');
    expect(ANNOUNCEMENT).toContain("useModalQueueSlot('announcement', open)");
    expect(ANNOUNCEMENT).toContain('open={open && canShow}');
  });

  it('[MPW-18] the update-ready dialog registers too, lowest priority', () => {
    const UPDATE = read('../../UpdateNotification.tsx', 'UpdateNotification.tsx');
    expect(UPDATE).toContain("from '@/hooks/useModalQueueSlot'");
    expect(UPDATE).toContain("useModalQueueSlot('updateNotification', open)");
    expect(UPDATE).toContain('open={open && canShow}');
  });
});
