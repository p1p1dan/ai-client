import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODEL_NOT_IN_CATALOG_CODE_TOKEN } from '../modelMissingError';
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

const COMPOSER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ChatComposer.tsx');

const NOTICE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'ModelMissingNotice.tsx'
);

/**
 * T062 / D19 — the two runtime files the detector's code token depends on.
 *
 * Read as text rather than imported: `src/runtime` is its own npm package with
 * its own `node_modules` (cordis + pi-ai), and importing into a renderer suite
 * would make this file unrunnable on a checkout that has not installed it.
 */
const RUNTIME_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'runtime',
  'plugins'
);
const ADAPTER = path.join(RUNTIME_ROOT, 'model-adapter', 'index.ts');
const LOOP = path.join(RUNTIME_ROOT, 'agent-loop', 'index.ts');

const SOURCE = stripComments(readFileSync(TIMELINE, 'utf8'), 'MessageTimeline.tsx');
const TERMINAL_SOURCE = stripComments(readFileSync(TERMINAL, 'utf8'), 'AgentTerminal.tsx');
const COMPOSER_SOURCE = stripComments(readFileSync(COMPOSER, 'utf8'), 'ChatComposer.tsx');
const NOTICE_SOURCE = stripComments(readFileSync(NOTICE, 'utf8'), 'ModelMissingNotice.tsx');
const ADAPTER_SOURCE = stripComments(readFileSync(ADAPTER, 'utf8'), 'model-adapter-index.ts');
const LOOP_SOURCE = stripComments(readFileSync(LOOP, 'utf8'), 'agent-loop-index.ts');

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
    // the bug this fix exists to close. concurrency-02 added a third disjunct
    // (the forced takeover) and the rule is unchanged: every action is its own
    // term, so none of them can be hidden by another one's absence.
    expect(SOURCE).toContain('retryControl.visible || takeoverControl.visible || view.recovery');
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

describe('ChatComposer status strip (H/21 point-check D2)', () => {
  it('[MMW-12] the strip under the composer stops printing the raw diagnostic', () => {
    // Found on the real app: the mapped notice at the top of the timeline and
    // `Error: … WorkerSlotError: WORKER_REQUEST_FAILED: Pi model not found: …`
    // under the composer, on the same screen at the same time.
    expect(COMPOSER_SOURCE).toContain('isModelMissingError(lastError)');
    expect(COMPOSER_SOURCE).toContain('MODEL_MISSING_ERROR_VIEW.hint');
  });

  it('[MMW-13] the raw fallback survives for every OTHER failure', () => {
    // This strip is the only place most Host errors are ever shown. Replacing
    // the fallback instead of ranking above it would hide all of them.
    expect(COMPOSER_SOURCE).toContain(`\`Error: \${lastError}\``);
  });

  it('[MMW-17] the strip translates the mapped hint instead of printing the key', () => {
    // 2026-09-17 re-verification: the strip showed the English dictionary key
    // under a Chinese UI, because this one call site was the only surface that
    // read the view without `t()`.
    expect(COMPOSER_SOURCE).toContain('t(MODEL_MISSING_ERROR_VIEW.hint)');
  });
});

/**
 * T062 round-2 — the recovery card on the SEND path.
 *
 * The three H/21 surfaces all need something a failed send does not produce (a
 * `'failed'` status that survives, an error MESSAGE in the transcript, or a
 * failed history read). `lastError` is the durable one, so the card is mounted
 * on the surface `lastError` already lights.
 */
describe('ChatComposer mounts the recovery card on the send path (T062 round-2)', () => {
  it('[MMW-18] the error surface above the composer branches on the detector', () => {
    expect(COMPOSER_SOURCE).toContain("from './ModelMissingNotice'");
    expect(COMPOSER_SOURCE).toContain('isModelMissingError(lastError) ? (');
    expect(COMPOSER_SOURCE).toContain('<ModelMissingNotice error={lastError}');
    // Reverse: every other failure keeps the raw diagnostic box it had.
    expect(COMPOSER_SOURCE).toContain('{statusHint}');
  });

  it('[MMW-19] the card asks the dictionary for every one of its four fields', () => {
    for (const field of ['title', 'message', 'hint', 'actionLabel']) {
      expect(NOTICE_SOURCE).toContain(`t(MODEL_MISSING_ERROR_VIEW.${field})`);
    }
    // ...and never renders one raw — that is the defect this file just caught
    // on the status strip.
    expect(NOTICE_SOURCE).not.toMatch(
      /\{MODEL_MISSING_ERROR_VIEW\.(title|message|hint|actionLabel)\}/
    );
  });

  it('[MMW-20] the card keeps the diagnostic that names the model, and the way out', () => {
    expect(NOTICE_SOURCE).toContain('{error}');
    expect(NOTICE_SOURCE).toContain('requestSettings(MODEL_MISSING_ERROR_VIEW.settingsCategory)');
  });
});

/**
 * T062 / D19 — the signal the session path sends, pinned at both ends.
 *
 * The 2026-09-17 point-check found this card unreachable from a real send: the
 * detector matched `WORKER_MODEL_NOT_FOUND` and `Pi model not found`, and the
 * session path had moved to a `RuntimeConfigError` carrying neither. The code
 * is now the contract; these two scans are what stop it drifting again, since
 * the producer and the consumer are in different npm packages and no compiler
 * checks the seam.
 */
describe('the session path carries a code the renderer can match (T062 / D19)', () => {
  it('[MMW-14] the model-adapter throw site still spells the code the detector expects', () => {
    expect(ADAPTER_SOURCE).toContain(`'${MODEL_NOT_IN_CATALOG_CODE_TOKEN}'`);
  });

  it('[MMW-15] the loop pastes a thrown failure code onto the session.failed text', () => {
    // Only the CODE is asserted to travel. The sentence beside it belongs to
    // the runtime and is free to change.
    expect(LOOP_SOURCE).toContain('payload: { error: thrownRunErrorText(error) }');
    expect(LOOP_SOURCE).toMatch(/\$\{code\}: \$\{error\.message\}/);
  });

  it('[MMW-16] the renderer never matches the runtime sentence itself', () => {
    // Matching `no model "…" in the catalog` would tie a Chinese recovery card
    // to an English diagnostic, which is the shape of the original defect.
    for (const source of [SOURCE, TERMINAL_SOURCE, COMPOSER_SOURCE, NOTICE_SOURCE]) {
      expect(source).not.toContain('in the catalog');
    }
  });
});

/**
 * T023 — the same notice body, now with a translatable branch.
 *
 * Asserted by source scan for the reason stated at the top of this file:
 * `MessageTimeline.tsx` cannot be rendered here. What the notice resolves TO
 * is covered where it can be executed — `piSessionTimeline.test.ts` (the key
 * and its params), `chatSessionsHistory.test.ts` (the field survives the
 * store) and `i18n`'s own catalog. This only claims the component asks.
 */
describe('MessageTimeline translates app-written history notices (T023)', () => {
  it('[T023-01] branches the notice body on the marker, not on the text', () => {
    expect(SOURCE).toContain('block.notice');
    expect(SOURCE).toContain('t(block.notice.key, block.notice.params)');
  });

  it('[T023-02] keeps the raw-text fallback for everything without a marker', () => {
    // Model output must not go near the dictionary: the marker is the whole
    // permission to translate, so the untouched `block.text` branch has to
    // survive next to it.
    expect(SOURCE).toContain(': block.text}');
  });

  it('[T023-03] spells the imported-history sentence nowhere in the renderer', () => {
    // The producer (`agent-host/piSessionTimeline.ts`) owns the key. A second
    // copy of the sentence here is how the two drift into different wording
    // and the dictionary lookup starts missing.
    expect(SOURCE).not.toContain('This history was imported');
    expect(SOURCE).not.toContain('这段历史从');
  });
});
