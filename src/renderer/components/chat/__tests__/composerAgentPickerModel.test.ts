import { AGENT_WIRE_NAMES, CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import { describe, expect, it } from 'vitest';
import {
  AGENT_LOCKED_REASON,
  BOUND_AGENT_UNAVAILABLE_REASON,
  composerAgentLockedChipClass,
  composerAgentPickerGroupClass,
  composerAgentSegmentClass,
  deriveComposerAgentOptions,
  deriveComposerAgentPicker,
  HOST_NOT_READY_REASON,
  isSendableAgent,
  NO_AGENT_AVAILABLE_NOTICE,
  OLD_HOST_REASON,
  resolveSelectedAgent,
  shouldCommitAgentFallback,
  UNAVAILABLE_AGENT_REASON,
} from '../composerAgentPickerModel';
import { composerModelTriggerClass } from '../middleColumnLayout';

/**
 * D48 S1 · A1 / A4 / A5b / A9 — the agent picker's view model.
 *
 * The picker is a `.tsx` and this suite runs `environment: 'node'`, so every
 * decision it makes lives here as a pure function and is truth-tabled here.
 * Two of the tables are load-bearing beyond "the UI looks right":
 *
 *  - `undefined` (an old Host that predates `capabilities.agents`) and `[]`
 *    (a current Host that reports zero usable agents) must NOT collapse into
 *    one state. Treating the first as the second disables Claude Code on
 *    every old Host; treating the second as the first sends a create for an
 *    agent the Host will answer with `agent_unsupported`.
 *  - A fallback must be visible (`fellBack: true`), because the caller has to
 *    write it back to the store — a picker showing Claude Code while the
 *    create payload still says `codex` is the exact display/send split A11
 *    exists to prevent.
 */

const bothAgents = [...AGENT_WIRE_NAMES];
const claudeOnly = [CLAUDE_CODE_AGENT];

const unlocked = { sendAttempted: false, hostBound: false, hasRuntimeIdentity: false };

function optionFor(options: ReturnType<typeof deriveComposerAgentOptions>, agent: string) {
  return options.find((option) => option.agent === agent);
}

describe('A1 — deriveComposerAgentOptions truth table', () => {
  it('both agents available: two live segments, neither disabled, no reason', () => {
    const options = deriveComposerAgentOptions({
      capabilitiesAgents: bothAgents,
      selectedAgent: CODEX_AGENT,
      locked: false,
      hostState: 'ready',
    });

    expect(options.map((option) => option.agent)).toEqual(bothAgents);
    expect(options.every((option) => option.available)).toBe(true);
    expect(options.every((option) => option.disabled)).toBe(false);
    expect(options.every((option) => option.reason === undefined)).toBe(true);
    expect(optionFor(options, CODEX_AGENT)?.selected).toBe(true);
    expect(optionFor(options, CLAUDE_CODE_AGENT)?.selected).toBe(false);
  });

  it('Claude only: Codex renders, disabled, with a reason that does not name a cause', () => {
    const options = deriveComposerAgentOptions({
      capabilitiesAgents: claudeOnly,
      selectedAgent: CLAUDE_CODE_AGENT,
      locked: false,
      hostState: 'ready',
    });

    // Rendered, not hidden: the capability exists, this Host just cannot run
    // it right now (runtimeEvents.ts's own type note says disable, not hide).
    expect(options).toHaveLength(3);
    expect(optionFor(options, CODEX_AGENT)).toMatchObject({
      available: false,
      disabled: true,
      reason: UNAVAILABLE_AGENT_REASON,
    });
    expect(optionFor(options, CLAUDE_CODE_AGENT)).toMatchObject({
      available: true,
      disabled: false,
    });
    // N2: `capabilities.agents` carries no reason code at all, so the copy
    // must not claim the flag is off, or that credentials are missing.
    expect(UNAVAILABLE_AGENT_REASON).not.toMatch(/flag|credential|api key/i);
  });

  it('old Host (undefined): Claude stays usable, Codex gets the compatibility reason', () => {
    const options = deriveComposerAgentOptions({
      capabilitiesAgents: undefined,
      selectedAgent: CLAUDE_CODE_AGENT,
      locked: false,
      hostState: 'ready',
    });

    expect(optionFor(options, CLAUDE_CODE_AGENT)).toMatchObject({
      available: true,
      disabled: false,
    });
    expect(optionFor(options, CODEX_AGENT)).toMatchObject({
      available: false,
      disabled: true,
      reason: OLD_HOST_REASON,
    });
  });

  it('empty list is NOT the same state as undefined: both segments go dead', () => {
    const options = deriveComposerAgentOptions({
      capabilitiesAgents: [],
      selectedAgent: CLAUDE_CODE_AGENT,
      locked: false,
      hostState: 'ready',
    });

    expect(options).toHaveLength(3);
    expect(options.every((option) => option.available)).toBe(false);
    expect(options.every((option) => option.disabled)).toBe(true);
    expect(optionFor(options, CLAUDE_CODE_AGENT)?.reason).toBe(UNAVAILABLE_AGENT_REASON);
    // …and the difference from `undefined` is observable on Claude Code, the
    // one segment an old Host must keep.
    const oldHost = deriveComposerAgentOptions({
      capabilitiesAgents: undefined,
      selectedAgent: CLAUDE_CODE_AGENT,
      locked: false,
      hostState: 'ready',
    });
    expect(optionFor(oldHost, CLAUDE_CODE_AGENT)?.disabled).toBe(false);
    expect(optionFor(options, CLAUDE_CODE_AGENT)?.disabled).toBe(true);
  });

  it('Host not ready: the current choice is a read-only placeholder, nothing is claimed usable', () => {
    for (const hostState of ['stopped', 'starting', 'error'] as const) {
      const options = deriveComposerAgentOptions({
        capabilitiesAgents: bothAgents,
        selectedAgent: CODEX_AGENT,
        locked: false,
        hostState,
      });
      expect(options).toHaveLength(3);
      expect(options.every((option) => option.disabled)).toBe(true);
      expect(options.every((option) => option.available)).toBe(false);
      expect(options.every((option) => option.reason === HOST_NOT_READY_REASON)).toBe(true);
      expect(optionFor(options, CODEX_AGENT)?.selected).toBe(true);
    }
  });
});

describe('A5b (view half) — a locked session collapses to one static chip', () => {
  it('renders the bound agent only, never two disabled segments', () => {
    const options = deriveComposerAgentOptions({
      capabilitiesAgents: bothAgents,
      selectedAgent: CODEX_AGENT,
      locked: true,
      hostState: 'ready',
    });

    // A permanently dead two-segment control would sit in every established
    // session's single docked row forever — session mode is where `locked` is
    // the norm, not the edge (deriveMiddleColumnMode locks on the same triple).
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ agent: CODEX_AGENT, selected: true, disabled: true });
    expect(options[0]?.reason).toContain(AGENT_LOCKED_REASON);
  });

  it('a bound agent that is no longer available still shows, with the extra reason', () => {
    const options = deriveComposerAgentOptions({
      capabilitiesAgents: claudeOnly,
      selectedAgent: CODEX_AGENT,
      locked: true,
      hostState: 'ready',
    });

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ agent: CODEX_AGENT, available: false, disabled: true });
    expect(options[0]?.reason).toContain(BOUND_AGENT_UNAVAILABLE_REASON);
  });

  // locked × hostState, every state of the second axis. The interesting half
  // is the non-ready column: a locked chip is what EVERY established session
  // shows, and every one of them starts a run with the Host not ready yet.
  // "Cannot run this agent" there would accuse the app of being broken on
  // every cold start, in the one place the user cannot act on it.
  const HOST_STATES = ['stopped', 'starting', 'error', 'ready'] as const;

  for (const hostState of HOST_STATES) {
    it(`hostState '${hostState}': the chip claims unavailability only once the Host has answered`, () => {
      const boundAndListed = deriveComposerAgentOptions({
        capabilitiesAgents: bothAgents,
        selectedAgent: CODEX_AGENT,
        locked: true,
        hostState,
      });
      // A binding the Host does list never carries the extra sentence.
      expect(boundAndListed).toHaveLength(1);
      expect(boundAndListed[0]?.reason).toBe(AGENT_LOCKED_REASON);
      expect(boundAndListed[0]?.available).toBe(hostState === 'ready');

      const boundAndMissing = deriveComposerAgentOptions({
        capabilitiesAgents: claudeOnly,
        selectedAgent: CODEX_AGENT,
        locked: true,
        hostState,
      });
      expect(boundAndMissing).toHaveLength(1);
      expect(boundAndMissing[0]?.reason).toBe(
        hostState === 'ready'
          ? `${AGENT_LOCKED_REASON}. ${BOUND_AGENT_UNAVAILABLE_REASON}`
          : AGENT_LOCKED_REASON
      );
      // Either way the chip is inert and states the binding.
      expect(boundAndMissing[0]).toMatchObject({
        agent: CODEX_AGENT,
        selected: true,
        disabled: true,
      });
    });
  }

  it('a cold start says nothing about availability even when capabilities are absent', () => {
    // The Host has not answered at all yet — `undefined` here is silence, not
    // "an old Host". Reading it as an answer is what put the unavailable copy
    // on every restored session's chip.
    const options = deriveComposerAgentOptions({
      capabilitiesAgents: undefined,
      selectedAgent: CODEX_AGENT,
      locked: true,
      hostState: 'starting',
    });

    expect(options).toHaveLength(1);
    expect(options[0]?.reason).toBe(AGENT_LOCKED_REASON);
    expect(options[0]?.reason).not.toContain(BOUND_AGENT_UNAVAILABLE_REASON);
  });
});

describe('A4 — resolveSelectedAgent reports a fallback instead of swallowing it', () => {
  it('passes a draft that is still available straight through', () => {
    expect(
      resolveSelectedAgent({
        capabilitiesAgents: bothAgents,
        draftAgent: CODEX_AGENT,
        locked: false,
        hostState: 'ready',
      })
    ).toEqual({ agent: CODEX_AGENT, fellBack: false });
  });

  it('falls back to the legacy agent AND says so when the draft disappeared', () => {
    expect(
      resolveSelectedAgent({
        capabilitiesAgents: claudeOnly,
        draftAgent: CODEX_AGENT,
        locked: false,
        hostState: 'ready',
      })
    ).toEqual({ agent: CLAUDE_CODE_AGENT, fellBack: true });
  });

  it('treats an old Host the same way — it can only run the compatibility agent', () => {
    expect(
      resolveSelectedAgent({
        capabilitiesAgents: undefined,
        draftAgent: CODEX_AGENT,
        locked: false,
        hostState: 'ready',
      })
    ).toEqual({ agent: CLAUDE_CODE_AGENT, fellBack: true });
  });

  it('an unset draft resolves through sessionAgent and is not a fallback', () => {
    // Nothing was overridden: there was no user choice to override.
    expect(
      resolveSelectedAgent({
        capabilitiesAgents: bothAgents,
        draftAgent: undefined,
        locked: false,
        hostState: 'ready',
      })
    ).toEqual({ agent: CLAUDE_CODE_AGENT, fellBack: false });
  });

  it('never falls back for a locked session — the binding is a fact, not a preference', () => {
    expect(
      resolveSelectedAgent({
        capabilitiesAgents: claudeOnly,
        draftAgent: CODEX_AGENT,
        locked: true,
        hostState: 'ready',
      })
    ).toEqual({ agent: CODEX_AGENT, fellBack: false });
  });

  it('never falls back before the Host has answered — silence is not an empty list', () => {
    // The cold-start shape: capabilities are absent because nothing has been
    // reported yet, not because this is an old Host. Resolving that silence
    // would show Claude Code on a Codex draft while `sessionAgent(session)`
    // and the create payload still said `codex` — display ≠ send, which is
    // the split §3.3-6 / A11 exist to prevent, reached from the other side.
    for (const hostState of ['stopped', 'starting', 'error'] as const) {
      expect(
        resolveSelectedAgent({
          capabilitiesAgents: undefined,
          draftAgent: CODEX_AGENT,
          locked: false,
          hostState,
        })
      ).toEqual({ agent: CODEX_AGENT, fellBack: false });

      // Same answer when a stale list is still on screen from a Host that has
      // since stopped: the read-only placeholder shows the draft as it is.
      expect(
        resolveSelectedAgent({
          capabilitiesAgents: claudeOnly,
          draftAgent: CODEX_AGENT,
          locked: false,
          hostState,
        })
      ).toEqual({ agent: CODEX_AGENT, fellBack: false });
    }
  });

  it('an unset draft still resolves to the legacy agent while the Host is starting', () => {
    // Not a fallback and not a placeholder for anything — `sessionAgent`'s
    // own default, which must not become a second inline default here.
    expect(
      resolveSelectedAgent({
        capabilitiesAgents: undefined,
        draftAgent: undefined,
        locked: false,
        hostState: 'starting',
      })
    ).toEqual({ agent: CLAUDE_CODE_AGENT, fellBack: false });
  });
});

describe('A11 (pure half) — when a fallback may be written back', () => {
  it('commits when the fallback target is itself available', () => {
    expect(
      shouldCommitAgentFallback({
        capabilitiesAgents: claudeOnly,
        resolvedAgent: CLAUDE_CODE_AGENT,
        fellBack: true,
        locked: false,
        hostState: 'ready',
      })
    ).toBe(true);
  });

  it('commits on an old Host too, so the picker and the create payload agree', () => {
    expect(
      shouldCommitAgentFallback({
        capabilitiesAgents: undefined,
        resolvedAgent: CLAUDE_CODE_AGENT,
        fellBack: true,
        locked: false,
        hostState: 'ready',
      })
    ).toBe(true);
  });

  it('refuses when the fallback target is unavailable too (empty list)', () => {
    // Writing `claude-code` here would only move the lie: the send guard is
    // what stops this state, not a store write.
    expect(
      shouldCommitAgentFallback({
        capabilitiesAgents: [],
        resolvedAgent: CLAUDE_CODE_AGENT,
        fellBack: true,
        locked: false,
        hostState: 'ready',
      })
    ).toBe(false);
  });

  it('refuses while the Host is not ready, and refuses for a locked session', () => {
    expect(
      shouldCommitAgentFallback({
        capabilitiesAgents: claudeOnly,
        resolvedAgent: CLAUDE_CODE_AGENT,
        fellBack: true,
        locked: false,
        hostState: 'starting',
      })
    ).toBe(false);
    expect(
      shouldCommitAgentFallback({
        capabilitiesAgents: claudeOnly,
        resolvedAgent: CLAUDE_CODE_AGENT,
        fellBack: true,
        locked: true,
        hostState: 'ready',
      })
    ).toBe(false);
  });

  it('refuses when nothing fell back', () => {
    expect(
      shouldCommitAgentFallback({
        capabilitiesAgents: bothAgents,
        resolvedAgent: CODEX_AGENT,
        fellBack: false,
        locked: false,
        hostState: 'ready',
      })
    ).toBe(false);
  });
});

describe('deriveComposerAgentPicker — the single entry point the component calls', () => {
  it('folds the binding triple through the shared lock symbol', () => {
    const model = deriveComposerAgentPicker({
      binding: { sendAttempted: false, hostBound: false, hasRuntimeIdentity: true },
      lockedUpstream: false,
      capabilitiesAgents: bothAgents,
      draftAgent: CODEX_AGENT,
      hostState: 'ready',
    });

    expect(model.locked).toBe(true);
    expect(model.options).toHaveLength(1);
    expect(model.selectedAgent).toBe(CODEX_AGENT);
    expect(model.commitFallback).toBe(false);
  });

  it('surfaces the empty-state notice only for a ready Host reporting zero agents', () => {
    const empty = deriveComposerAgentPicker({
      binding: unlocked,
      lockedUpstream: false,
      capabilitiesAgents: [],
      draftAgent: undefined,
      hostState: 'ready',
    });
    expect(empty.emptyStateNotice).toBe(NO_AGENT_AVAILABLE_NOTICE);

    const oldHost = deriveComposerAgentPicker({
      binding: unlocked,
      lockedUpstream: false,
      capabilitiesAgents: undefined,
      draftAgent: undefined,
      hostState: 'ready',
    });
    expect(oldHost.emptyStateNotice).toBeNull();

    const starting = deriveComposerAgentPicker({
      binding: unlocked,
      lockedUpstream: false,
      capabilitiesAgents: [],
      draftAgent: undefined,
      hostState: 'starting',
    });
    expect(starting.emptyStateNotice).toBeNull();
  });

  it('reports the write-back a stale draft needs', () => {
    const model = deriveComposerAgentPicker({
      binding: unlocked,
      lockedUpstream: false,
      capabilitiesAgents: claudeOnly,
      draftAgent: CODEX_AGENT,
      hostState: 'ready',
    });

    expect(model.selectedAgent).toBe(CLAUDE_CODE_AGENT);
    expect(model.fellBack).toBe(true);
    expect(model.commitFallback).toBe(true);
  });

  it('takes the workspace fold as its own input and resolves any disagreement to locked', () => {
    // `lockedUpstream` is ChatWorkspace's fold of this same triple. It is a
    // separate input rather than something poured into `binding.sendAttempted`
    // — that arm is a contract about one latch, and the store action's option
    // of the same name is handed the same value. If the two folds ever
    // disagree (a store read one render behind, a different session id), the
    // safe answer is the one that does not let the agent be repointed.
    const model = deriveComposerAgentPicker({
      binding: unlocked,
      lockedUpstream: true,
      capabilitiesAgents: bothAgents,
      draftAgent: CODEX_AGENT,
      hostState: 'ready',
    });

    expect(model.locked).toBe(true);
    expect(model.options).toHaveLength(1);
    expect(model.commitFallback).toBe(false);
    expect(model.emptyStateNotice).toBeNull();
  });

  it('a cold start shows the draft it will actually send, and writes nothing back', () => {
    // The whole M4 chain end to end: an unlocked Codex draft, a Host that has
    // not answered yet. The picker must not display Claude Code here — the
    // create payload would still carry `codex`.
    const model = deriveComposerAgentPicker({
      binding: unlocked,
      lockedUpstream: false,
      capabilitiesAgents: undefined,
      draftAgent: CODEX_AGENT,
      hostState: 'starting',
    });

    expect(model.selectedAgent).toBe(CODEX_AGENT);
    expect(model.fellBack).toBe(false);
    expect(model.commitFallback).toBe(false);
    // Both segments stay inert until the answer is in — nothing is claimed
    // usable, and the selected one is the draft.
    expect(model.options).toHaveLength(3);
    expect(model.options.every((option) => option.disabled)).toBe(true);
    expect(optionFor(model.options, CODEX_AGENT)?.selected).toBe(true);
  });
});

describe('A12 (pure half) — isSendableAgent', () => {
  it('lets an agent through when the Host lists it', () => {
    expect(isSendableAgent(bothAgents, CODEX_AGENT)).toBe(true);
    expect(isSendableAgent(claudeOnly, CLAUDE_CODE_AGENT)).toBe(true);
  });

  it('refuses an agent the Host reports it cannot run', () => {
    // Sending anyway buys nothing: the create comes back `agent_unsupported`
    // after the composer has already cleared the draft and locked the picker.
    expect(isSendableAgent(claudeOnly, CODEX_AGENT)).toBe(false);
  });

  it('refuses everything when the Host reports an empty list', () => {
    expect(isSendableAgent([], CLAUDE_CODE_AGENT)).toBe(false);
    expect(isSendableAgent([], CODEX_AGENT)).toBe(false);
  });

  it('does NOT fire for an old Host that reports no list at all', () => {
    // `undefined` means "this build predates the capability", not "zero
    // agents" — refusing here would break every pre-capabilities Host.
    expect(isSendableAgent(undefined, CLAUDE_CODE_AGENT)).toBe(true);
    expect(isSendableAgent(undefined, CODEX_AGENT)).toBe(true);
  });
});

describe('A9 — the picker wears this repo’s ghost chip, not a form control', () => {
  const CLASSES = {
    group: composerAgentPickerGroupClass(),
    selected: composerAgentSegmentClass({ selected: true, disabled: false }),
    idle: composerAgentSegmentClass({ selected: false, disabled: false }),
    disabled: composerAgentSegmentClass({ selected: false, disabled: true }),
    locked: composerAgentLockedChipClass(),
  };

  // The four hard bans (docs/design-system.md:355-377). Each one is a
  // regression this composer has already shipped once: a border adds 2px on
  // hover and jumps the row, a shadow re-opens the "too round / too AI"
  // reading, a width floor manufactures the dead space that gets misreported
  // as "the text is not centred", and a radius at or above half the box height
  // is clamped by CSS to a full pill on a 24px control.
  const BANNED = [/\bborder/, /\bshadow/, /\bmin-w-/, /\brounded-(md|lg|xl|2xl|3xl|full)\b/];

  for (const [name, value] of Object.entries(CLASSES)) {
    it(`${name} carries none of the four banned ghost-chip shapes`, () => {
      for (const banned of BANNED) {
        expect(banned.test(value), `${name}: ${value}`).toBe(false);
      }
    });
  }

  it('shares the composer’s one height and one horizontal inset tier', () => {
    // Same toolbar, one ghost chip form — cross-checked against the control it
    // sits next to rather than restated as a literal.
    const model = composerModelTriggerClass();
    const heightOf = (value: string) => value.match(/(?:^|\s)(h-[\w.[\]]+)/)?.[1];
    const insetOf = (value: string) => value.match(/(?:^|\s)(px-[\w.[\]]+)/)?.[1];

    expect(heightOf(model)).toBe('h-6');
    for (const value of [CLASSES.selected, CLASSES.idle, CLASSES.disabled, CLASSES.locked]) {
      expect(heightOf(value)).toBe(heightOf(model));
      expect(insetOf(value)).toBe(insetOf(model));
    }
    expect(heightOf(CLASSES.group)).toBe(heightOf(model));
  });

  it('never leaves a responsive height leftover that would win at every real width', () => {
    // `Button`'s `sm:size-7` leak, transcribed: a bare `h-6` only displaces the
    // unprefixed half, so a breakpoint-prefixed sibling keeps rendering 28/32px
    // while every class assertion still passes.
    for (const value of Object.values(CLASSES)) {
      expect(/\bsm:h-/.test(value), value).toBe(false);
    }
  });

  it('pairs hover and focus-visible on the same fill wherever a shell exists', () => {
    // A resting state with no frame plus a hover-only shell means a keyboard
    // user tabbing onto the control sees no shape at all.
    for (const [name, value] of Object.entries(CLASSES)) {
      const hover = value.match(/hover:(bg-[\w-]+)/)?.[1];
      if (!hover) continue;
      expect(value, `${name} has hover:${hover} without the matching focus-visible`).toContain(
        `focus-visible:${hover}`
      );
    }
    // …and the interactive segment really does have one, so the rule above is
    // not vacuously satisfied by a class string with no shell at all.
    expect(CLASSES.idle).toContain('hover:bg-hover');
  });

  it('marks the selected segment with the repo’s pre-composited selection fill', () => {
    expect(CLASSES.selected).toContain('bg-selection');
    // `--hover` / `--selection` are already solid colours here; stacking an
    // alpha on top is the Color System note this repo keeps re-learning.
    expect(CLASSES.selected).not.toMatch(/bg-selection\/\d/);
  });
});
