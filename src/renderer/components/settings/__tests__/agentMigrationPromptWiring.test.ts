import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * H/21 P1 wiring smoke. BRITTLE BY DESIGN.
 *
 * vitest runs `node` here, so the dialog cannot be rendered and asserted on.
 * `agentMigrationPrompt.test.ts` truth-tables the rules; this file covers the
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

  it('[MPW-03] skips the directory scan once the question has been answered', () => {
    // An inspection walks `~/.pi/agent`. Doing it on every launch forever, for
    // a question already answered, is work nobody asked for.
    expect(PROMPT).toContain('if (alreadyAsked()) return;');
  });

  it('[MPW-04] never overwrites from this dialog', () => {
    // The user has seen counts, not file names — there is no informed answer to
    // a collision here. `overwrite` belongs to the pane, which shows the names.
    expect(PROMPT).toContain("onConflict: 'skip'");
    expect(PROMPT).not.toContain("onConflict: 'overwrite'");
    expect(PROMPT).not.toContain('setOverwrite');
  });

  it('[MPW-05] remembers the answer whether it was yes or no', () => {
    // Three ways out of this dialog, and all three have to count as answered,
    // or it returns next launch to someone who already said no.
    expect(PROMPT).toContain('const dismiss = useCallback(() => {');
    expect(PROMPT).toContain('markAsked();');
    expect(PROMPT).toContain('if (!next) dismiss();');
  });

  it('[MPW-06] shows the API-key consent line only while that row is ticked', () => {
    expect(PROMPT).toContain('selectionCarriesSecrets([...selected])');
    expect(PROMPT).toContain('{secrets && (');
  });

  it('[MPW-07] renders nothing at all when there is no offer', () => {
    expect(PROMPT).toContain('if (!plan) return null;');
  });

  it('[MPW-08] shows each item count, which is what makes unticking a huge one possible', () => {
    expect(PROMPT).toContain(`\`\${item.total}\``);
  });
});

describe('AgentMigrationSettings shares the prompt rules (H/21 P1)', () => {
  it('[MPW-09] the pane and the dialog name each kind through one function', () => {
    expect(PANE).toContain("from './agentMigrationPrompt'");
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
