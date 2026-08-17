import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { composerModelTriggerClass } from '../middleColumnLayout';
import { stripComments } from './stripComments';

/**
 * D48 S4 §6.5 — source-scan guards for the LIVE permission control's wiring
 * (D11 · D12 · D13 · D15) and for the boundary between the two write layers.
 *
 * BRITTLE BY DESIGN, same contract as `composerAgentPickerWiring.test.ts`: this
 * suite runs `environment: 'node'` (vitest.config.ts), so no component renders
 * and the only thing assertable about a `.tsx` is presence and relative position
 * in executable syntax, with comments blanked by the shared parser-backed strip.
 * Every decision that CAN be a function is one — `composerPermissionModel.ts`,
 * truth-tabled next door — and what is left here is the wiring those truth
 * tables cannot see.
 *
 * What this does not claim: reachability. A guard inside `if (false)` satisfies
 * every assertion below. The residual blind spot is accepted for the same reason
 * it is accepted next door, and it is why the gate itself is a pure function.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function source(relative: string, label: string): string {
  return stripComments(readFileSync(path.resolve(__dirname, relative), 'utf8'), label);
}

const trigger = source('../ComposerPermissionTrigger.tsx', 'ComposerPermissionTrigger.tsx');
const composer = source('../ChatComposer.tsx', 'ChatComposer.tsx');
const model = source('../composerPermissionModel.ts', 'composerPermissionModel.ts');
const settingsSection = source(
  '../../settings/ChatAgentDefaultsSection.tsx',
  'ChatAgentDefaultsSection.tsx'
);
const contextView = source(
  '../../workspace-shell/surfaces/ContextSurfaceView.tsx',
  'ContextSurfaceView.tsx'
);

function offsets(text: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

/** The `<ComposerPermissionTrigger ... />` element's own prop list, nothing else. */
function triggerElement(): string {
  const start = only(composer, '<ComposerPermissionTrigger');
  const end = composer.indexOf('/>', start);
  expect(end, 'unterminated ComposerPermissionTrigger element').toBeGreaterThan(start);
  return composer.slice(start, end);
}

/**
 * The two characters that open a template interpolation, as a value — the lint
 * rule forbids them inside a plain string literal, and these scans have to name
 * source that really does interpolate.
 */
const INTERP = '$';

function only(text: string, needle: string): number {
  const found = offsets(text, needle);
  expect(found, `expected exactly one occurrence of ${JSON.stringify(needle)}`).toHaveLength(1);
  return found[0];
}

describe('D15 — the control is absent on an old Host, not dead', () => {
  it('the render gate returns null rather than a disabled shell', () => {
    // The capability decision itself is truth-tabled in the model; what is
    // asserted here is that the component OBEYS it by not rendering. A version
    // that rendered a permanently disabled chip would pass every model test.
    expect(only(trigger, 'if (!view.rendered) return null;')).toBeGreaterThan(-1);
  });

  it('the capability rides in from the Host status, not from a local guess', () => {
    expect(
      only(composer, 'capabilityPermissionPolicy={hostStatus.capabilities?.permissionPolicy}')
    ).toBeGreaterThan(-1);
  });
});

describe('D12 — every pick goes through the gate, and only the dialog confirms', () => {
  it('there is exactly ONE call site for the update IPC, and it lives inside submit', () => {
    const submitStart = only(trigger, 'const submit = async (');
    const requestStart = only(trigger, 'const request = (');
    const ipc = only(trigger, 'await window.electronAPI.chat.updatePermission({');
    expect(ipc).toBeGreaterThan(submitStart);
    // Between `submit` and the next declaration: a second call site anywhere
    // else would be a path that skips the gate entirely.
    expect(ipc).toBeLessThan(requestStart);
  });

  it('both submit call sites are downstream of the dangerous-tier decision', () => {
    const gate = only(trigger, 'const action = decideLivePermissionAction(preference);');
    const applyArm = only(trigger, 'void submit(action.preference, false);');
    const confirmArm = only(trigger, 'if (confirmed) void submit(confirmed, true);');
    expect(applyArm).toBeGreaterThan(gate);
    // The confirm arm sits in the dialog's footer, i.e. after the dialog exists
    // at all — the value cannot be submitted before the dialog can show it.
    expect(confirmArm).toBeGreaterThan(only(trigger, 'open={held !== null}'));
    // And those two are the only CALLS: the declaration spells `const submit =
    // async (`, so every `submit(` in the file is an invocation.
    expect(offsets(trigger, 'submit(')).toEqual([
      applyArm + 'void '.length,
      confirmArm + 'if (confirmed) void '.length,
    ]);
  });

  it('the confirmed flag is only ever asserted by the confirm arm', () => {
    // `dangerousConfirmed: true` is written once, inside `submit`, and it is
    // conditional on the argument the confirm arm alone passes as `true`.
    expect(
      only(trigger, '...(dangerousConfirmed ? { dangerousConfirmed: true } : {}),')
    ).toBeGreaterThan(-1);
    expect(offsets(trigger, ', true)')).toHaveLength(1);
  });

  it('the held tier is the ONLY thing a confirmation dialog can open on', () => {
    // No local copy of the selection exists anywhere else: the chip's value is
    // derived from the runtime facts, so a cancel needs no cleanup and can leave
    // no "unsaved dangerous state" behind.
    expect(only(trigger, 'open={held !== null}')).toBeGreaterThan(-1);
    expect(only(trigger, 'if (!nextOpen) setHeld(null);')).toBeGreaterThan(-1);
  });
});

describe('D13 — the permission gate does not borrow the agent-binding lock', () => {
  it.each([
    ['agentBindingLocked', 'the fold ChatWorkspace computes for the picker'],
    ['isChatAgentBindingLocked', 'the shared lock predicate'],
    ['sessionBinding', 'the module that predicate lives in'],
    ['sendAttempted', "the picker's raw latch"],
    ['hostBoundSessionIds', 'the store slice behind the second arm'],
  ])('neither the control nor its model names %s (%s)', (symbol) => {
    // Mutation ⑬ is precisely the edit these forbid: reusing the lock makes a
    // chat that has been sent once un-retunable, which is the requirement
    // (§8.0-Q1) implemented away.
    expect(trigger).not.toContain(symbol);
    expect(model).not.toContain(symbol);
  });

  it('the control gates on the turn, the way the model trigger does', () => {
    // Scoped to this element's own props: `busy`/`sending` are handed to several
    // controls on this card, and what matters here is that the permission chip
    // gets THOSE two and not a lock.
    const props = triggerElement();
    expect(props).toContain('busy={busy}');
    expect(props).toContain('sending={sending}');
    expect(props).not.toContain('agentBindingLocked');
    expect(props).not.toContain('locked=');
  });
});

describe('D11 — the live layer cannot reach the template layer, or vice versa', () => {
  it.each([
    'chatAgentDefaults',
    'setChatAgentDefaults',
    'withAgentPreference',
    'agentDefaultPermission',
    '@/stores/settings',
    'useSettingsStore',
  ])('the live control has no way to write %s', (symbol) => {
    // A mid-session change that also retuned the template would make one
    // deliberate escalation the default for every chat created afterwards —
    // the silent-privilege-expansion path R18 names, and mutation ⑪.
    expect(trigger).not.toContain(symbol);
  });

  it('the template panel has no way to reach a session either (the other direction)', () => {
    expect(settingsSection).not.toContain('updatePermission');
    expect(settingsSection).not.toContain('electronAPI');
  });

  it('the Context surface stays read-only through all of this', () => {
    // Both write layers exist so this one never has to: it renders the runtime's
    // own statement, and a request control here would make a single row both the
    // question and the answer. (It does reach `electronAPI.env.appVersion` for a
    // display row — the ban is on the chat command surface, not on the bridge.)
    expect(contextView).not.toContain('updatePermission');
    expect(contextView).not.toContain('electronAPI.chat');
    expect(contextView).not.toContain('permissionPreference');
  });
});

describe('D7 (wiring half) — the chip subscribes to the facts, not to its own request', () => {
  it('the displayed value comes off the runtime-facts store', () => {
    expect(
      only(trigger, 'useSessionRuntimeFactsStore((state) => state.factsBySession[sessionId])')
    ).toBeGreaterThan(-1);
  });

  it('the pending marker is cleared by the facts, not by the reply', () => {
    // `permissionChangeSettled` compares the FACTS against the accepted request.
    // Clearing on the reply instead would drop the marker the instant codex
    // answered `null`, i.e. before anything was confirmed (mutation ⑦).
    expect(
      only(trigger, 'if (permissionChangeSettled(agent, facts, pending)) setPending(null);')
    ).toBeGreaterThan(-1);
  });
});

describe('§6.3 — a refused change reports INLINE, where the control is', () => {
  it('the failure path writes the composer status line and opens no toast', () => {
    // §6.3 spells the failure shape as "roll the control back and say so inline".
    // There is nothing to roll back (the chip is derived from the facts and never
    // showed the request), so the whole obligation is the inline half — and a
    // toast is not it: it floats away on a timer while the chip beside it still
    // shows the old tier with no explanation. Same channel
    // `AGENT_UNAVAILABLE_SEND_ERROR` uses two controls away.
    expect(only(trigger, 'useChatSessionsStore.setState({')).toBeGreaterThan(-1);
    expect(
      only(
        trigger,
        `lastError: \`${INTERP}{t(PERMISSION_UPDATE_FAILED_TITLE)} — ${INTERP}{detail}\`,`
      )
    ).toBeGreaterThan(-1);
    expect(trigger).not.toContain('toastManager');
    expect(trigger).not.toContain('@/components/ui/toast');
    // The composer renders it; without this the write would be into a field
    // nothing shows.
    expect(composer).toContain(`\`Error: ${INTERP}{lastError}\``);
  });
});

describe('D-i18n — every string this control renders comes from t()', () => {
  /**
   * The defect: a Chinese menu with an English tooltip beside it. The model is
   * locale-blind by design, so anything it CONCATENATES arrives at the DOM in
   * English and `t()` can no longer reach the halves. The fix is that the model
   * hands over keys and templates and the component composes AFTER translating,
   * which is what these two scans pin.
   */
  it('the model builds no user-visible sentence of its own', () => {
    // Template placeholders are allowed (they are keys); a live interpolation of
    // a label into a sentence is not. `${` inside the model's copy constants
    // would be exactly that.
    expect(model).toContain('{{tier}}');
    // The three fields the trigger renders are keys/templates, not sentences.
    expect(model).toContain('labelKeys: readonly string[]');
    expect(model).toContain('titleTemplate: string');
    expect(model).toContain('spokenTemplate: string');
    // And the pre-joined English forms are gone for good.
    expect(model).not.toContain('spokenLabel:');
    expect(model).not.toContain('`Permission tier: ');
    expect(model).not.toContain('`Permissions: ');
  });

  it.each([
    ['aria-label={spokenLabel}', 'the spoken label'],
    ['title={title}', 'the tooltip'],
    ['{tierLabel}', 'the chip text'],
    ['{pendingLabel && <span', 'the pending suffix'],
  ])('%s is a composed value, not a raw view field (%s)', (needle) => {
    expect(only(trigger, needle)).toBeGreaterThan(-1);
  });

  it('each composed value is built by a t() call, and the tier parts are translated before the join', () => {
    expect(only(trigger, 'const title = t(view.titleTemplate, {')).toBeGreaterThan(-1);
    expect(only(trigger, 'const spokenLabel = t(view.spokenTemplate, {')).toBeGreaterThan(-1);
    expect(
      only(trigger, 'return keys.map((key) => t(key)).join(PERMISSION_TIER_JOINER);')
    ).toBeGreaterThan(-1);
    expect(
      only(trigger, 'const reasonText = view.disabledReason ? t(view.disabledReason) : ')
    ).toBeGreaterThan(-1);
  });
});

describe('§6.3 — one chip form on this toolbar, not a second one', () => {
  it('the trigger wears the same class function the model chip does', () => {
    expect(only(trigger, 'className={composerModelTriggerClass()}')).toBeGreaterThan(-1);
  });

  it('that class still obeys the four ghost-chip bans it is shared under', () => {
    // Cross-asserted here as well as in `middleColumnLayout.test.ts`, because
    // the premise of reusing the function is that it is the toolbar's one
    // permitted form — if it ever grew a border, this chip would grow one too.
    const cls = composerModelTriggerClass();
    expect(cls).toContain('h-6');
    expect(cls).toContain('rounded-sm');
    expect(cls).not.toMatch(/(^|\s)border/);
    expect(cls).not.toMatch(/(^|\s)shadow/);
    expect(cls).not.toMatch(/(^|\s)min-w-/);
    expect(cls).not.toMatch(/rounded-(md|lg|xl|full)/);
    // Keyboard users get the same shape hover gives the mouse.
    expect(cls).toContain('hover:bg-hover');
    expect(cls).toContain('focus-visible:bg-hover');
  });
});

describe('where the chip sits in the two bottom bars', () => {
  function barBlock(mode: 'session' | 'empty'): string {
    const start = only(composer, `composerBarClass('${mode}')`);
    const end = composer.indexOf('</div>', start);
    expect(end, `unterminated ${mode} bar`).toBeGreaterThan(start);
    return composer.slice(start, end);
  }

  it.each([
    'session',
    'empty',
  ] as const)('%s mode puts it directly after the model chip, on the same toolbar', (mode) => {
    const block = barBlock(mode);
    const modelAt = block.indexOf('{modelEffortControls}');
    const permissionAt = block.indexOf('{permissionControl}');
    expect(modelAt).toBeGreaterThan(-1);
    expect(permissionAt).toBeGreaterThan(modelAt);
    // Adjacent, so the height/inset cross-assertion above keeps meaning what
    // it says about a row of chips the eye reads as one control group.
    expect(block.slice(modelAt + '{modelEffortControls}'.length, permissionAt).trim()).toBe('');
  });
});
