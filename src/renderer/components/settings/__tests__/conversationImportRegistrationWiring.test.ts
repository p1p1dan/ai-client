import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The registration callback has to survive four files to do anything.
 *
 * `App` owns the repository list, the import pane is three levels down inside
 * a dialog, and the failure mode of dropping one hop is silent: the import
 * still succeeds, the report still prints — and every conversation it just
 * imported shows up in the sidebar under no project, because nobody was ever
 * added. Nothing else in the suite can see this: the pane's own test supplies
 * the callback directly, and `App` has no unit test at all.
 *
 * A source scan is the honest tool here for the same reason it is elsewhere in
 * this repo (`legacyImportStatic.test.ts`, `compositionPanelLabels.test.ts`):
 * the components cannot be rendered in this environment, and the claim is about
 * wiring rather than behaviour.
 */

const repoRoot = path.resolve(__dirname, '../../../../..');

function source(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

const APP = 'src/renderer/App.tsx';
const DIALOG = 'src/renderer/components/settings/SettingsDialog.tsx';
const CONTENT = 'src/renderer/components/settings/SettingsContent.tsx';
const PANE = 'src/renderer/components/settings/ConversationImportSettings.tsx';

describe('conversation import project registration wiring', () => {
  it('carries onRegisterRepository from App down to the import pane', () => {
    expect(source(APP)).toContain('onRegisterRepository={handleRegisterRepository}');
    // The dialog takes it and passes it on; same for the content shell.
    expect(source(DIALOG)).toContain('onRegisterRepository,');
    expect(source(DIALOG)).toContain('onRegisterRepository={onRegisterRepository}');
    expect(source(CONTENT)).toContain('onRegisterRepository,');
    expect(source(CONTENT)).toContain(
      '<ConversationImportSettings onRegisterRepository={onRegisterRepository} />'
    );
  });

  it('registers through the repository list App itself reads', () => {
    const app = source(APP);
    // Saving through `saveRepositories` is what updates `App`'s own state AND
    // localStorage; writing localStorage directly would leave the running
    // window's tree stale until the next restart.
    expect(app).toContain('handleRegisterRepository');
    expect(app).toContain('saveRepositories([...repositories, candidate])');
  });

  it('no longer decides the folder question in the renderer', () => {
    // `workspaceMatched` and the badge/warning around it were the defect: they
    // answered "is this already a project here" to a question that is "is this
    // directory on disk".
    //
    // Matched against the REQUEST the pane builds rather than the whole file:
    // the pane's own docblock names `workspaceMatched` on purpose, to record
    // what it replaced. What must not come back is the field in the payload.
    const request = source(PANE).slice(source(PANE).indexOf('importMutation.mutateAsync'));
    expect(request).not.toContain('workspaceMatched');
    expect(source(PANE)).not.toContain('No matching folder');
    expect(source(APP)).not.toContain('workspaceMatched');
  });
});
