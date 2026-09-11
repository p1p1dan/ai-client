import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * H/21 P0 wiring smoke. BRITTLE BY DESIGN, and for the usual reason: vitest
 * runs `node` here, so nothing can render `MessageTimeline.tsx` and assert on
 * the result. The decision logic is truth-tabled in `historyError.test.ts`; this
 * file only claims that the component reaches for it.
 *
 * Comments are blanked before every assertion — this fix is one whose whole
 * point has to be *explained* in prose right next to the code, so a raw-text
 * scan would pass on the explanation alone.
 *
 * What it does NOT claim: that either branch is reachable, that the button is
 * visible, or that pressing it opens anything. Those need a rendering test.
 */

const TIMELINE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'MessageTimeline.tsx'
);

const TERMINAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'AgentTerminal.tsx');

const SOURCE = stripComments(readFileSync(TIMELINE, 'utf8'), 'MessageTimeline.tsx');
const TERMINAL_SOURCE = stripComments(readFileSync(TERMINAL, 'utf8'), 'AgentTerminal.tsx');

describe('MessageTimeline wires the model-missing recovery (H/21 P0)', () => {
  it('[MMW-01] imports the shared detector and view rather than re-spelling the needle', () => {
    expect(SOURCE).toContain("from './modelMissingError'");
    expect(SOURCE).toContain('isModelMissingError');
    expect(SOURCE).toContain('MODEL_MISSING_ERROR_VIEW');
    // The raw worker text must live in exactly one place. A second copy here
    // is how the two surfaces drift apart.
    expect(SOURCE).not.toContain('Pi model not found');
  });

  it('[MMW-02] branches the session-failed card on the detector', () => {
    expect(SOURCE).toContain('isModelMissingError(lastError)');
  });

  it('[MMW-03] the session-failed branch shows the copy and the action label', () => {
    expect(SOURCE).toContain('MODEL_MISSING_ERROR_VIEW.message');
    expect(SOURCE).toContain('MODEL_MISSING_ERROR_VIEW.hint');
    expect(SOURCE).toContain('MODEL_MISSING_ERROR_VIEW.actionLabel');
  });

  it('[MMW-04] both surfaces open settings through the intent store', () => {
    expect(SOURCE).toContain("from '@/stores/settingsIntent'");
    expect(SOURCE).toContain('requestSettings(MODEL_MISSING_ERROR_VIEW.settingsCategory)');
    // The history notice takes its pane from the parsed view, not a literal —
    // otherwise a later code with a different pane would open the wrong one.
    expect(SOURCE).toContain('requestSettings(view.recovery?.settingsCategory)');
  });

  it('[MMW-05] the history notice renders a recovery button independently of Retry', () => {
    // `model_missing` is not retryable, so gating the button on
    // `retryControl.visible` would render nothing at all — the exact shape of
    // the bug this fix exists to close.
    expect(SOURCE).toContain('retryControl.visible || view.recovery');
    expect(SOURCE).toContain('view.recovery.label');
  });

  it('[MMW-06] gives the code its own icon, so it does not read as a missing file', () => {
    expect(SOURCE).toContain('model_missing: PackageSearch');
  });

  it('[MMW-07] maps the error bubble too, and keeps the raw text that names the model', () => {
    // A failed SEND lands here as a `role:'error'` message, not as a history
    // error — a third surface for one failure, and the one a user hits by
    // typing into a stale session.
    expect(SOURCE).toContain('isModelMissingError(block.text)');
    // The mapped copy replaces the diagnostic in the notice body, so the
    // diagnostic has to be re-rendered somewhere or the model id is simply lost.
    expect(SOURCE).toContain('font-mono text-code text-muted-foreground');
  });

  it('[MMW-08] ranks auth above model-missing on every surface', () => {
    // Both can be true at once for a session that cannot start. Signing in is
    // the prerequisite, so the model branch must be the one that yields.
    expect(SOURCE).toContain('!authRequired');
    expect(TERMINAL_SOURCE).toContain('!isAuthRequiredError(startupError)');
  });
});

describe('AgentTerminal wires the model-missing recovery (H/21 P0)', () => {
  it('[MMW-09] the embedded TUI maps the same failure to the same copy', () => {
    // H/19 U3 put GUI and TUI on one sessions directory, so the TUI resumes the
    // same stale sessions and hits the same missing model.
    expect(TERMINAL_SOURCE).toContain("from './modelMissingError'");
    expect(TERMINAL_SOURCE).toContain('isModelMissingError(startupError)');
    expect(TERMINAL_SOURCE).toContain('MODEL_MISSING_ERROR_VIEW.title');
    expect(TERMINAL_SOURCE).toContain('MODEL_MISSING_ERROR_VIEW.message');
  });

  it('[MMW-10] offers the same way out rather than leaving a dead overlay', () => {
    expect(TERMINAL_SOURCE).toContain("from '@/stores/settingsIntent'");
    expect(TERMINAL_SOURCE).toContain('requestSettings(MODEL_MISSING_ERROR_VIEW.settingsCategory)');
    expect(TERMINAL_SOURCE).toContain('MODEL_MISSING_ERROR_VIEW.actionLabel');
  });

  it('[MMW-11] spells the worker text nowhere — the detector owns it', () => {
    expect(TERMINAL_SOURCE).not.toContain('Pi model not found');
  });
});
