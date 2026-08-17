import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * D48 S1 · A3 / A6 / A10a / A10b / A11 / A12 — source-scan guards for the
 * picker's own `.tsx` and the two it is wired into.
 *
 * BRITTLE BY DESIGN, and for the same reason `composerStopStatic.test.ts` and
 * `messageTimelineWiring.test.ts` exist: this suite runs `environment: 'node'`
 * with `include: *.test.ts` (vitest.config.ts), so no component ever renders
 * and `runSend`'s ORDER facts cannot be asserted by calling anything. What is
 * asserted is presence and relative position in executable syntax, with
 * comments blanked by the shared parser-backed strip — every identifier below
 * is also quoted at length in the doc comments that explain why it is there.
 *
 * What this does NOT claim: reachability. A guard inside `if (false)` would
 * satisfy every assertion here. That residual blind spot is accepted (it needs
 * a rendering test the node-only environment cannot host) and is exactly why
 * the DECISIONS themselves live in `composerAgentPickerModel.ts`, truth-tabled
 * next door, instead of inline in the component.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSER_PATH = path.resolve(__dirname, '../ChatComposer.tsx');
const WORKSPACE_PATH = path.resolve(__dirname, '../ChatWorkspace.tsx');
const PICKER_PATH = path.resolve(__dirname, '../ComposerAgentPicker.tsx');

const composer = stripComments(readFileSync(COMPOSER_PATH, 'utf8'), 'ChatComposer.tsx');
const workspace = stripComments(readFileSync(WORKSPACE_PATH, 'utf8'), 'ChatWorkspace.tsx');
const picker = stripComments(readFileSync(PICKER_PATH, 'utf8'), 'ComposerAgentPicker.tsx');

/** All start offsets of `needle` in `source`. */
function offsets(source: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

/** Sole start offset of `needle` — fails loudly if absent or duplicated. */
function only(source: string, needle: string): number {
  const found = offsets(source, needle);
  expect(found, `expected exactly one occurrence of ${JSON.stringify(needle)}`).toHaveLength(1);
  return found[0];
}

/** The order the JSX children of one bar appear in, restricted to known slots. */
function slotOrder(block: string, slots: readonly string[]): string[] {
  return slots
    .map((slot) => ({ slot, at: block.indexOf(`{${slot}}`) }))
    .filter((entry) => entry.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.slot);
}

/** Text between the first `composerBarClass('<mode>')` and the div that closes it. */
function barBlock(mode: 'session' | 'empty'): string {
  const start = only(composer, `composerBarClass('${mode}')`);
  const end = composer.indexOf('</div>', start);
  expect(end, `unterminated ${mode} bar`).toBeGreaterThan(start);
  return composer.slice(start, end);
}

const SLOTS = [
  'attachButton',
  'textareaEl',
  'agentPicker',
  'modelEffortControls',
  'actionButtons',
] as const;

describe('A10a / A10b — where the picker sits in each bottom bar', () => {
  it('empty mode reads ⊕ → agent → model → status → actions', () => {
    const block = barBlock('empty');
    expect(slotOrder(block, SLOTS)).toEqual([
      'attachButton',
      'agentPicker',
      'modelEffortControls',
      'actionButtons',
    ]);
    // The status line is a call, not a `{slot}` reference — pin it separately
    // so "agent and model sit together at the left" stays the assertion.
    const status = block.indexOf('renderStatusLine(');
    expect(status).toBeGreaterThan(block.indexOf('{modelEffortControls}'));
  });

  it('session mode reads ⊕ → textarea → status → agent → model → actions', () => {
    const block = barBlock('session');
    expect(slotOrder(block, SLOTS)).toEqual([
      'attachButton',
      'textareaEl',
      'agentPicker',
      'modelEffortControls',
      'actionButtons',
    ]);
    const status = block.indexOf('renderStatusLine(');
    expect(status).toBeGreaterThan(block.indexOf('{textareaEl}'));
    expect(status).toBeLessThan(block.indexOf('{agentPicker}'));
  });

  it('the picker is adjacent to the model trigger in BOTH bars', () => {
    // A9 cross-checks the picker's height and horizontal inset against
    // `composerModelTriggerClass()` on the premise that the two chips sit side
    // by side. Anything wedged between them (a status line, the textarea)
    // retires that premise silently.
    for (const mode of ['empty', 'session'] as const) {
      const block = barBlock(mode);
      const agentAt = block.indexOf('{agentPicker}');
      const modelAt = block.indexOf('{modelEffortControls}');
      expect(agentAt, `${mode}: no agent picker in the bar`).toBeGreaterThan(-1);
      expect(modelAt).toBeGreaterThan(agentAt);
      expect(block.slice(agentAt + '{agentPicker}'.length, modelAt).trim()).toBe('');
    }
  });
});

describe('A3 (composer path) — the create payload states the pre-IPC binding', () => {
  it('reads the agent off the same snapshot as the resume handle', () => {
    const snapshot = only(composer, 'const preState = useChatSessionsStore.getState();');
    const agentRead = only(composer, 'const agent = sessionAgent(preSession ?? {});');
    const identity = only(composer, 'const knownIdentity = preSession?.runtimeIdentity ?? null;');
    expect(agentRead).toBeGreaterThan(snapshot);
    // The binding and the handle only mean anything together, so they must
    // come from the same instant.
    expect(Math.abs(agentRead - identity)).toBeLessThan(600);
  });

  it('the snapshot read precedes every IPC call in runSend', () => {
    const agentRead = only(composer, 'const agent = sessionAgent(preSession ?? {});');
    const create = only(composer, 'await window.electronAPI.chat.createSession({');
    const ensure = only(composer, 'await window.electronAPI.chat.ensureHost();');
    expect(agentRead).toBeLessThan(ensure);
    expect(agentRead).toBeLessThan(create);
  });

  it('createSession sends the binding, not a value re-read at dispatch time', () => {
    const create = only(composer, 'await window.electronAPI.chat.createSession({');
    const payload = composer.slice(create, composer.indexOf('});', create));
    expect(payload).toContain('agent,');
    expect(payload).not.toContain('sessionAgent(');
    expect(payload).not.toContain('getState()');
  });
});

describe('A6 / A12 — what has to happen before the send commits', () => {
  it('onSendStart is called exactly once, and after every guard', () => {
    const commit = only(composer, 'onSendStart?.();');
    const canSendGuard = only(composer, 'if (!canSend || !activeSessionId || !cwd) {');
    const inFlightGuard = only(composer, "if (inFlightRef.current) return 'skipped';");
    expect(commit).toBeGreaterThan(canSendGuard);
    expect(commit).toBeGreaterThan(inFlightGuard);
  });

  it('the commit is still ahead of the first IPC of the turn', () => {
    // The latch is what docks the middle column and locks the binding the same
    // frame; behind the create it would leave a window in which the user can
    // repoint a session whose create is already in flight.
    const commit = only(composer, 'onSendStart?.();');
    expect(commit).toBeLessThan(only(composer, 'await window.electronAPI.chat.ensureHost();'));
    expect(commit).toBeLessThan(only(composer, 'await window.electronAPI.chat.createSession({'));
  });

  it('A12: the unavailable-agent guard bails out before the latch and before inFlight', () => {
    const guard = only(composer, 'if (!isSendableAgent(knownAgents, agentAtEntry)) {');
    const commit = only(composer, 'onSendStart?.();');
    const claimInFlight = only(composer, 'inFlightRef.current = true;');
    expect(guard).toBeLessThan(commit);
    // Returning after the in-flight ref is claimed would wedge the composer
    // shut for the rest of the run — the ref has exactly one reset, in the
    // send's own teardown.
    expect(guard).toBeLessThan(claimInFlight);
  });

  it('A12: the guard is keyed on the Host list, and `undefined` is not a trigger', () => {
    // An old Host reports no list at all; refusing to send there would break
    // every pre-capabilities build instead of protecting it.
    expect(composer).toContain('const knownAgents = hostStatus.capabilities?.agents;');
    // The predicate itself is a pure function next door, truth-tabled there —
    // the composer must not re-spell `agents !== undefined && !includes(...)`.
    expect(composer).toMatch(/import \{[^}]*isSendableAgent[^}]*\} from '\.\/composerAgentPicker/s);
  });
});

describe('A11 / A5b (component half) — what the picker itself does with the model', () => {
  /**
   * The attribute block of every `<button …>` open tag, one attribute per line
   * (biome's formatting is what makes this readable rather than clever). The
   * open tag cannot be matched with `<button[\s\S]*?>` because an arrow
   * function in `onClick` puts a `>` inside it.
   */
  function buttonAttributeLines(): string[][] {
    const blocks: string[][] = [];
    for (const at of offsets(picker, '<button')) {
      const rest = picker.slice(at);
      const end = rest.search(/\n\s*>\n/);
      expect(end, 'unterminated <button open tag').toBeGreaterThan(-1);
      blocks.push(
        rest
          .slice(0, end)
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      );
    }
    expect(blocks.length, 'expected the locked chip, the segment and Retry Host').toBe(3);
    return blocks;
  }

  it('A11: the fallback effect writes the resolved agent back to the store', () => {
    // The half a pure function cannot hold: `shouldCommitAgentFallback` only
    // REPORTS that a write is owed. If the effect merely renders the resolved
    // value, the picker shows Claude Code while `sessionAgent(session)` — and
    // therefore the `chat.createSession` payload — still says `codex`.
    const effect = only(picker, 'if (!commitFallback || !draftAgent) {');
    const deps = picker.indexOf('}, [commitFallback', effect);
    expect(deps, 'fallback effect has no dependency array').toBeGreaterThan(effect);
    const body = picker.slice(effect, deps);

    expect(body).toContain('setDraftSessionAgent(sessionId, selectedAgent, { sendAttempted });');
    // …and the one-shot notice sits in the same body, keyed so it cannot
    // re-fire on every store tick while the stale draft is still on the row.
    expect(body).toContain('toastManager.add(');
    expect(body).toContain('noticedFallbackRef.current = key;');
  });

  it('a segment click writes the picked agent through the same narrow action', () => {
    const click = only(picker, 'onClick={() => {');
    const body = picker.slice(click, picker.indexOf('}}', click));

    expect(body).toContain('setDraftSessionAgent(sessionId, option.agent, { sendAttempted });');
    // An inert or already-selected segment must not write at all — a write on
    // the current value is a no-op the store would answer `true` to, but a
    // write on a disabled one is the lock leaking.
    expect(body).toContain('if (inert || option.selected) {');
    expect(body.indexOf('return;')).toBeLessThan(body.indexOf('setDraftSessionAgent('));
  });

  it('m9: EVERY write is handed the RAW latch, never the folded lock', () => {
    // `setDraftSessionAgent`'s third argument is documented as the one fact no
    // store holds. Passing `locked` — a fold of three — makes the action's
    // guard hold by coincidence and leaves that arm untested at its only call
    // site.
    //
    // Counted against the number of CALL SITES rather than against a literal 2:
    // D48 S2 added a third (the `lastAgent` adoption effect), and a test that
    // pinned the old number would have failed for the arrival of a correct call
    // site while still passing if one of them started handing over `locked`.
    expect(picker).not.toContain('sendAttempted: locked');
    const callSites = offsets(picker, 'setDraftSessionAgent(sessionId,').length;
    expect(callSites).toBeGreaterThanOrEqual(2);
    expect(offsets(picker, '{ sendAttempted }')).toHaveLength(callSites);
    expect(picker).toContain('binding: { sendAttempted, hostBound, hasRuntimeIdentity },');
    expect(picker).toContain('lockedUpstream: locked,');
  });

  it('unavailable segments carry aria-disabled, never the disabled attribute', () => {
    // A real `disabled` button receives no pointer events, so its `title`
    // never renders: the agent would be greyed out with the reason unreadable,
    // which is the exact state this picker exists to replace. §3.1 requires
    // the reason to be reachable, not just the opacity.
    for (const attributes of buttonAttributeLines()) {
      for (const line of attributes) {
        expect(line.startsWith('disabled'), `disabled attribute on a picker button: ${line}`).toBe(
          false
        );
      }
    }
    const [lockedChip, segment] = buttonAttributeLines();
    expect(lockedChip).toContain('aria-disabled="true"');
    expect(lockedChip).toContain('aria-checked="true"');
    expect(segment).toContain('aria-disabled={inert || undefined}');
    // The reason copy hangs off `title`/`aria-label` on the same element.
    expect(lockedChip.some((line) => line.startsWith('title='))).toBe(true);
    expect(segment.some((line) => line.startsWith('title='))).toBe(true);
  });

  it('Retry Host renders inside the empty-state notice, never on its own', () => {
    // The action only means anything next to "No chat agent is available".
    // Hoisted out of that conditional it becomes a permanent Restart button in
    // every composer row.
    const guard = only(picker, '{model.emptyStateNotice && (');
    const block = picker.slice(guard, picker.indexOf('</>', guard));

    expect(block).toContain('{model.emptyStateNotice}');
    expect(block).toContain('{onRetryHost && (');
    expect(block).toContain('onClick={onRetryHost}');
    expect(block.indexOf('{model.emptyStateNotice}')).toBeLessThan(block.indexOf('{onRetryHost'));
  });

  it('the locked branch returns before any interactive segment is built', () => {
    // One static chip, not two dead segments: session mode is where locked is
    // the norm, so two greyed segments would occupy width in every established
    // chat's docked row forever.
    const lockedBranch = only(picker, 'if (model.locked) {');
    expect(lockedBranch).toBeLessThan(only(picker, 'onClick={() => {'));
    expect(only(picker, 'const option = model.options[0];')).toBeGreaterThan(lockedBranch);
  });
});

describe('the lock is computed once, upstream, and handed down', () => {
  it('ChatWorkspace derives agentBindingLocked from its own latch', () => {
    expect(workspace).toContain('isChatAgentBindingLocked({');
    expect(workspace).toContain(
      "const sendAttempted = sendAttempts.includes(activeSessionId ?? '')"
    );
    expect(workspace).toContain('agentBindingLocked={agentBindingLocked}');
    // The raw latch travels beside the fold — the picker needs both, for two
    // different contracts (see the picker's own prop doc).
    expect(workspace).toContain('agentSendAttempted={sendAttempted}');
  });

  it('ChatComposer takes it as a prop rather than re-deriving it', () => {
    // `turnSendStatus` is a one-slot in-flight snapshot, not a per-session
    // sticky latch, and the latch itself is ChatWorkspace-local state — the
    // composer genuinely cannot compute this.
    expect(composer).toContain('agentBindingLocked');
    expect(composer).not.toContain('sendAttempts');
  });

  it('the picker gets the lock, and the model/effort gate stays separate', () => {
    const pickerEl = only(composer, '<ComposerAgentPicker');
    const block = composer.slice(pickerEl, composer.indexOf('/>', pickerEl));
    expect(block).toContain('locked={agentBindingLocked}');
    expect(block).toContain('sendAttempted={agentSendAttempted}');
    // The model trigger is `disabled || busy || sending` because a model
    // change applies to the NEXT turn; an agent change never does, so the
    // agent gate is `locked` plus the "nowhere to put this draft" kill switch.
    expect(block).not.toContain('busy');
    expect(block).not.toContain('sending');
  });
});
