/**
 * D48 S1: every decision the Composer's agent picker makes, as pure functions.
 *
 * The picker itself is a `.tsx` and this repo's vitest run is `environment:
 * 'node'` with `include: *.test.ts` — no component ever renders under the
 * suite. So the component below this module is deliberately dumb: it maps the
 * output here onto elements and owns no branch of its own.
 *
 * Two shapes in here are load-bearing rather than cosmetic:
 *
 *  - `capabilitiesAgents` is `readonly AgentWireName[] | undefined`, and the
 *    two are NOT the same state. `undefined` means the Host build predates
 *    `capabilities.agents` entirely; `[]` means a current Host reports it can
 *    run none. Collapsing the first into the second disables Claude Code on
 *    every old Host; collapsing the second into the first sends a create the
 *    Host answers with `agent_unsupported`.
 *  - a fallback is REPORTED (`fellBack`), never applied silently. The caller
 *    has to write it back, because a picker showing Claude Code while
 *    `sessionAgent(session)` still says `codex` puts the display and the
 *    create payload on two different answers.
 *
 * `capabilities.agents` carries no reason code (the Host synthesizes
 * `HostAgentDetail.reason` in-process and only the wire NAMES cross the
 * protocol), so no copy here may claim WHY an agent is missing.
 *
 * Zero value imports beyond `agentWire` and `sessionBinding`, both leaves —
 * `pureModuleImports.test.ts` scans this file.
 */

import {
  AGENT_DISPLAY_NAMES,
  AGENT_WIRE_NAMES,
  type AgentWireName,
  sessionAgent,
} from '@shared/types/agentWire';
import type { HostStatus } from './hostStatus';
import { type ChatAgentBindingInput, isChatAgentBindingLocked } from './sessionBinding';

/**
 * Generic on purpose. The Host tells the renderer WHICH agents it can run and
 * never why one is missing, so anything more specific here ("the flag is off",
 * "credentials are missing") would be an invention.
 */
export const UNAVAILABLE_AGENT_REASON = 'Unavailable in the current Host';

export const OLD_HOST_REASON =
  'This Host predates agent capabilities; Claude Code is the compatibility fallback';

export const HOST_NOT_READY_REASON = 'Waiting for Agent Host to become ready';

export const AGENT_LOCKED_REASON = 'Agent is fixed after the first send';

export const BOUND_AGENT_UNAVAILABLE_REASON =
  'This session is bound to an agent the current Host cannot run';

export const NO_AGENT_AVAILABLE_NOTICE = 'No chat agent is available';

/** Shown once when a draft binding had to be resolved down to another agent. */
export function agentFallbackNotice(from: AgentWireName, to: AgentWireName): string {
  return `${AGENT_DISPLAY_NAMES[from]} is unavailable — this chat will use ${AGENT_DISPLAY_NAMES[to]}`;
}

/** Surfaced by the Composer when a send is refused for an unrunnable binding. */
export const AGENT_UNAVAILABLE_SEND_ERROR = `${BOUND_AGENT_UNAVAILABLE_REASON}. Restart or retry Agent Host, then send again.`;

export interface ComposerAgentOption {
  agent: AgentWireName;
  selected: boolean;
  /** The Host reports it can run this agent right now. */
  available: boolean;
  /** Not clickable — either unavailable, the Host is not ready, or locked. */
  disabled: boolean;
  /** Why it cannot be picked. Always set when `disabled`. */
  reason?: string;
}

/**
 * What a `capabilities.agents` of `undefined` means for availability: an old
 * Host can only be driven through the compatibility agent, so the effective
 * set is the legacy binding alone. This is the ONE place that translation
 * happens; `undefined` keeps its own identity everywhere else.
 */
function effectiveAgents(
  capabilitiesAgents: readonly AgentWireName[] | undefined
): readonly AgentWireName[] {
  return capabilitiesAgents ?? [sessionAgent({})];
}

/**
 * Draft value × what the Host can run → the agent actually in effect.
 *
 * A locked session never falls back: its binding is a fact about a
 * conversation that already exists, not a preference to be re-negotiated. Show
 * it as it is and let the send guard refuse the turn instead.
 *
 * Neither does a session whose Host has not answered yet. Before `ready` there
 * is no list to check the draft against — `capabilities` is simply absent —
 * and `effectiveAgents(undefined)` would read that silence as "an old Host
 * that can only run the legacy agent". Every Codex draft would then display as
 * Claude Code on a cold start while `sessionAgent(session)` and the create
 * payload still said `codex`: the display/send split of §3.3-6 and A11,
 * arrived at from the other direction. The §3.4 matrix calls this row a
 * READ-ONLY PLACEHOLDER, so the draft is returned untouched and
 * `deriveComposerAgentOptions` disables both segments until the answer is in.
 */
export function resolveSelectedAgent(input: {
  capabilitiesAgents: readonly AgentWireName[] | undefined;
  /** `session.agent` — genuinely unset for a live-only row that never sent. */
  draftAgent: AgentWireName | undefined;
  locked: boolean;
  hostState: HostStatus['state'];
}): { agent: AgentWireName; fellBack: boolean } {
  const drafted = sessionAgent({ agent: input.draftAgent });
  if (input.locked || input.hostState !== 'ready') {
    return { agent: drafted, fellBack: false };
  }
  if (effectiveAgents(input.capabilitiesAgents).includes(drafted)) {
    return { agent: drafted, fellBack: false };
  }
  const legacy = sessionAgent({});
  // `fellBack` reports that a USER CHOICE was overridden. An unset draft had
  // no choice in it, so resolving it to the legacy agent is not a fallback and
  // must not raise a notice or trigger a write-back.
  return { agent: legacy, fellBack: input.draftAgent !== undefined && input.draftAgent !== legacy };
}

/**
 * Selected agent × what the Host can run → one entry per segment.
 *
 * Unavailable agents are DISABLED, never hidden: the product has two agents,
 * and this Host merely cannot start one of them right now. Hiding it turns a
 * temporary state into a missing feature, and `runtimeEvents.ts`'s own type
 * note for the field says disable rather than hide.
 *
 * `locked` is the exception, and it is the common case rather than the edge —
 * `deriveMiddleColumnMode` docks the composer on the same triple, so an
 * established session is locked whenever it is in session mode. Two greyed
 * segments would then be a permanently dead control occupying width in every
 * docked row forever, so a locked session collapses to a single static chip
 * naming what it is bound to.
 */
export function deriveComposerAgentOptions(input: {
  capabilitiesAgents: readonly AgentWireName[] | undefined;
  selectedAgent: AgentWireName;
  locked: boolean;
  hostState: HostStatus['state'];
}): ComposerAgentOption[] {
  const available = (agent: AgentWireName): boolean =>
    input.hostState === 'ready' && effectiveAgents(input.capabilitiesAgents).includes(agent);

  if (input.locked) {
    // "The Host cannot run this agent" is a claim about an ANSWER, and only a
    // ready Host has given one. Folding `hostState !== 'ready'` into
    // `available` here would put that copy on the chip of every established
    // session during every cold start — session mode is where locked is the
    // norm — accusing the app of being broken while the Host is merely still
    // starting. Until the answer is in, the chip states the binding and
    // nothing else.
    const hostAnswered = input.hostState === 'ready';
    const boundAvailable = available(input.selectedAgent);
    return [
      {
        agent: input.selectedAgent,
        selected: true,
        available: boundAvailable,
        disabled: true,
        reason:
          !hostAnswered || boundAvailable
            ? AGENT_LOCKED_REASON
            : `${AGENT_LOCKED_REASON}. ${BOUND_AGENT_UNAVAILABLE_REASON}`,
      },
    ];
  }

  return AGENT_WIRE_NAMES.map((agent) => {
    const selected = agent === input.selectedAgent;
    if (input.hostState !== 'ready') {
      // Not "everything is broken" — the answer simply is not in yet, and
      // claiming an agent is usable before the Host says so is how a create
      // lands on a registry that has not been built.
      return { agent, selected, available: false, disabled: true, reason: HOST_NOT_READY_REASON };
    }
    if (available(agent)) {
      return { agent, selected, available: true, disabled: false };
    }
    return {
      agent,
      selected,
      available: false,
      disabled: true,
      reason: input.capabilitiesAgents === undefined ? OLD_HOST_REASON : UNAVAILABLE_AGENT_REASON,
    };
  });
}

/**
 * Whether a reported fallback may be committed back to the draft.
 *
 * Committing is what keeps "what the picker shows" and "what
 * `chat.createSession` sends" the same value. It is refused in exactly one
 * interesting case: when the fallback target is not runnable either (a ready
 * Host reporting an empty list). Writing there would only move the lie one
 * agent over — the send guard is what handles that state.
 */
export function shouldCommitAgentFallback(input: {
  capabilitiesAgents: readonly AgentWireName[] | undefined;
  resolvedAgent: AgentWireName;
  fellBack: boolean;
  locked: boolean;
  hostState: HostStatus['state'];
}): boolean {
  if (!input.fellBack || input.locked || input.hostState !== 'ready') {
    return false;
  }
  return effectiveAgents(input.capabilitiesAgents).includes(input.resolvedAgent);
}

/**
 * The send-side half of the same fact (§3.3-7): refuse to start a turn whose
 * binding the Host has told us it cannot run.
 *
 * `undefined` deliberately passes. It means "this Host build predates the
 * capability", and refusing there would break every pre-capabilities Host
 * instead of protecting it.
 */
export function isSendableAgent(
  capabilitiesAgents: readonly AgentWireName[] | undefined,
  agent: AgentWireName
): boolean {
  return capabilitiesAgents === undefined || capabilitiesAgents.includes(agent);
}

export interface ComposerAgentPickerModel {
  locked: boolean;
  selectedAgent: AgentWireName;
  fellBack: boolean;
  /** The caller must write `selectedAgent` back to the draft when true. */
  commitFallback: boolean;
  options: ComposerAgentOption[];
  /** Inline copy for "the Host is up and can run nothing", else null. */
  emptyStateNotice: string | null;
}

/**
 * The single entry point the component calls — assembled here rather than in
 * the `.tsx` so the call ORDER (resolve, then derive off the resolved value)
 * is part of the tested surface instead of a convention.
 */
export function deriveComposerAgentPicker(input: {
  /**
   * The raw triple. `sendAttempted` is specifically ChatWorkspace's latch, not
   * a lock folded somewhere upstream — the store action's option of the same
   * name is a contract about that one arm, and a superset dropped into the
   * slot makes both guards fire for reasons they never agreed to check.
   */
  binding: ChatAgentBindingInput;
  /**
   * ChatWorkspace's own fold of that same triple (§3.2), kept as its own input
   * rather than merged into an arm it did not come from. OR-ed with the local
   * fold, so if the two ever disagree — different session id, a store read one
   * render behind — the disagreement can only ever resolve to LOCKED.
   */
  lockedUpstream: boolean;
  capabilitiesAgents: readonly AgentWireName[] | undefined;
  draftAgent: AgentWireName | undefined;
  hostState: HostStatus['state'];
}): ComposerAgentPickerModel {
  const locked = isChatAgentBindingLocked(input.binding) || input.lockedUpstream;
  const { agent, fellBack } = resolveSelectedAgent({
    capabilitiesAgents: input.capabilitiesAgents,
    draftAgent: input.draftAgent,
    locked,
    hostState: input.hostState,
  });
  return {
    locked,
    selectedAgent: agent,
    fellBack,
    commitFallback: shouldCommitAgentFallback({
      capabilitiesAgents: input.capabilitiesAgents,
      resolvedAgent: agent,
      fellBack,
      locked,
      hostState: input.hostState,
    }),
    options: deriveComposerAgentOptions({
      capabilitiesAgents: input.capabilitiesAgents,
      selectedAgent: agent,
      locked,
      hostState: input.hostState,
    }),
    emptyStateNotice:
      !locked && input.hostState === 'ready' && input.capabilitiesAgents?.length === 0
        ? NO_AGENT_AVAILABLE_NOTICE
        : null,
  };
}

// ---- Class strings (docs/design-system.md:355-388) ----

/**
 * The four hard bans on a ghost chip — no `border*`, no `shadow*`, no
 * `min-w-*`, no radius at or above `rounded-md` — are not style preferences
 * here; each is a defect this composer has already shipped once. A hover
 * border adds 2px and jumps the whole row; a width floor manufactures the dead
 * space that gets misreported as "the text is not centred"; and CSS clamps any
 * radius at or above half the box height, so `rounded-md` on a 24px control
 * renders as a full pill while the class name still reads "medium".
 *
 * The height and horizontal inset are cross-asserted against
 * `composerModelTriggerClass()` rather than restated as prose: one toolbar,
 * one chip form.
 */
export function composerAgentPickerGroupClass(): string {
  return 'inline-flex h-6 shrink-0 items-center gap-0.5';
}

/**
 * One segment.
 *
 * `hover:` and `focus-visible:` fill the same layer, always together: with no
 * resting frame at all, a hover-only shell leaves a keyboard user with no
 * control boundary whatsoever. The disabled variant drops BOTH (a shell that
 * appears on something that cannot be pressed is a worse lie than no shell)
 * but keeps the focus outline, because the reason copy hangs off this element
 * and a keyboard user has to be able to reach it.
 *
 * Disabled segments are marked with `aria-disabled`, not the `disabled`
 * attribute, precisely so they stay hoverable: a real `disabled` button fires
 * no pointer events, so its `title` tooltip never appears — and "unavailable
 * with a reason nobody can read" is the state this picker exists to avoid.
 */
export function composerAgentSegmentClass(state: { selected: boolean; disabled: boolean }): string {
  const base = [
    'inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-ui',
    'transition-colors duration-150',
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary',
  ];
  if (state.disabled) {
    base.push('cursor-default opacity-64');
  } else {
    base.push('hover:bg-hover', 'focus-visible:bg-hover');
  }
  base.push(state.selected ? 'bg-selection text-foreground' : 'text-muted-foreground');
  return base.join(' ');
}

/**
 * The locked session's single static chip: no shell at all, because there is
 * nothing to press. Same height/inset tier so the docked row keeps one
 * baseline.
 */
export function composerAgentLockedChipClass(): string {
  return 'inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-ui text-muted-foreground';
}
