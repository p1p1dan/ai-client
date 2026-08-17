import { canPersistLastAgent, resolveInitialDraftAgent } from '@shared/models/chatAgentDefaults';
import {
  AGENT_DISPLAY_NAMES,
  type AgentWireName,
  CODEX_AGENT,
  sessionAgent,
} from '@shared/types/agentWire';
import { Asterisk, Braces } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { toastManager } from '@/components/ui/toast';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSettingsHydrated, useSettingsStore } from '@/stores/settings';
import {
  agentFallbackNotice,
  type ComposerAgentOption,
  composerAgentLockedChipClass,
  composerAgentPickerGroupClass,
  composerAgentSegmentClass,
  deriveComposerAgentPicker,
} from './composerAgentPickerModel';
import type { HostStatus } from './hostStatus';

/**
 * D48 S1: the Composer's chat-agent entry point — `capabilities.agents`'s
 * first UI consumer.
 *
 * Deliberately dumb. Every branch lives in `composerAgentPickerModel.ts`,
 * truth-tabled under the node-env vitest run that can never render this file;
 * what is left here is store access, the write-back effect, and the mapping
 * from view-model entries onto elements.
 *
 * Three things that look like details and are not:
 *
 *  - unavailable segments carry `aria-disabled`, not the `disabled` attribute.
 *    A real `disabled` button receives no pointer events, so its `title` never
 *    renders — and an agent greyed out with no readable reason is precisely
 *    the state this picker exists to replace.
 *  - a locked session renders ONE static chip, not two dead segments. Session
 *    mode is where locked is the norm (`deriveMiddleColumnMode` docks on the
 *    same triple), so two greyed segments would occupy width in every
 *    established chat's docked row forever.
 *  - the fallback is written back to the store, not just displayed. Otherwise
 *    the picker says Claude Code while `sessionAgent(session)` — and therefore
 *    the `chat.createSession` payload — still says `codex`.
 *
 * WHY THIS IS NOT `ToggleGroup` (spec §3.1 says components first, and this is
 * the documented deviation — see §3.8). `ui/toggle.tsx`'s `toggleVariants` is
 * the base every `ToggleGroupItem` renders through, and its base string alone
 * carries `rounded-lg`, `border`, and a `before:` inset highlight, while its
 * smallest size is `h-8 min-w-8 sm:h-7 sm:min-w-7`. That is four of the four
 * hard bans this repo's ghost-chip rule states (`docs/design-system.md`: no
 * `border*`, no `shadow*` including `before:` highlights, no `min-w-*`, no
 * radius at or above `rounded-md`) plus the wrong height tier and a
 * breakpoint-prefixed height that would out-specify a bare `h-6` at every real
 * window width. Those bans are asserted, not advisory: A9 fails the build on
 * any of them. Reaching the required form through `ToggleGroup` would mean
 * overriding the whole base string — a component used for its class list and
 * then stripped of it, keeping only the `role=radiogroup` semantics that the
 * 30 lines below spell out directly. `AGENT_WIRE_NAMES` is a closed pair, so
 * there is no list logic to inherit either.
 *
 * Terminal-axis `AgentPickerMenu`/`SessionBar` are a different question about
 * a different table (`BuiltinAgentId`); nothing here converts between the two.
 */

interface ComposerAgentPickerProps {
  sessionId: string;
  /** `hostStatus.capabilities?.agents` — `undefined` ≠ `[]`, see the model. */
  agents: readonly AgentWireName[] | undefined;
  hostState: HostStatus['state'];
  /** `isChatAgentBindingLocked(...)`, computed by ChatWorkspace (it owns the latch). */
  locked: boolean;
  /**
   * The RAW sticky latch behind `locked`'s first arm — ChatWorkspace's own
   * `sendAttempts` membership for this session, handed down unfolded.
   *
   * `locked` is a superset of it, and passing the superset where this is
   * wanted happens to behave the same today (both extra arms make the store
   * action refuse anyway). It is still wrong: `setDraftSessionAgent`'s third
   * argument is named `sendAttempted` and is documented as the one fact no
   * store holds, so handing it a fold of three facts makes the guard hold by
   * coincidence rather than by contract — and leaves the arm that fold was
   * invented for untested at the only place it is passed.
   */
  sendAttempted: boolean;
  /** The composer's own "there is nowhere to put this draft" kill switch. */
  disabled?: boolean;
  /** Host restart, offered inline when a ready Host reports zero agents. */
  onRetryHost?: () => void;
}

/**
 * Icon per agent, as a lookup rather than a literal-keyed `Record`: a wire
 * value spelled here — key position included — is a second home for a string
 * that is written into `session-index.json`, which `agentWireStatic.test.ts`
 * bans outright. The exported constants are the only way to name one.
 */
function agentIcon(agent: AgentWireName): typeof Asterisk {
  return agent === CODEX_AGENT ? Braces : Asterisk;
}

function AgentSegmentBody({ option }: { option: ComposerAgentOption }) {
  const Icon = agentIcon(option.agent);
  const label = AGENT_DISPLAY_NAMES[option.agent];
  return (
    <>
      <Icon className="size-3.5 shrink-0" />
      {/* Narrow windows keep the icon and drop the label to the accessible
          name only — a width floor here would take it out of the textarea. */}
      <span className={option.selected ? 'truncate' : 'sr-only md:not-sr-only md:truncate'}>
        {label}
      </span>
    </>
  );
}

export function ComposerAgentPicker({
  sessionId,
  agents,
  hostState,
  locked,
  sendAttempted,
  disabled,
  onRetryHost,
}: ComposerAgentPickerProps) {
  // Scalar selectors only: subscribing to `sessions` wholesale re-renders this
  // on every streaming session's status tick, not just the active one.
  const draftAgent = useChatSessionsStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.agent
  );
  const hasRuntimeIdentity = useChatSessionsStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.runtimeIdentity != null
  );
  const hostBound = useChatSessionsStore((state) => state.hostBoundSessionIds.includes(sessionId));
  const setDraftSessionAgent = useChatSessionsStore((state) => state.setDraftSessionAgent);
  // D48 S2 §4.3 (B15): the cross-session memory, moved out of S1 because it
  // needs app settings and app settings hydrate asynchronously.
  const chatAgentDefaults = useSettingsStore((state) => state.chatAgentDefaults);
  const setChatAgentDefaults = useSettingsStore((state) => state.setChatAgentDefaults);
  const settingsHydrated = useSettingsHydrated();
  const rememberedAgent = resolveInitialDraftAgent({
    lastAgent: chatAgentDefaults.lastAgent,
    capabilitiesAgents: agents,
    settingsHydrated,
  });

  const model = deriveComposerAgentPicker({
    // Each arm in the slot it actually came from: the raw latch from the
    // workspace, the two the store can see read back from the store so this
    // component reaches the SAME symbol rather than trusting a prop to be the
    // whole answer (the store action layers its own copy of the same guard for
    // the same reason). `locked` — the workspace's fold of this same triple —
    // rides alongside instead of being poured into one of the arms, so a
    // disagreement between the two folds can only ever resolve to locked.
    binding: { sendAttempted, hostBound, hasRuntimeIdentity },
    lockedUpstream: locked,
    capabilitiesAgents: agents,
    // The remembered agent stands in for an untouched draft so the SAME value
    // the effect below commits is what this render already shows — the store
    // write and the paint must not be one frame apart.
    draftAgent: draftAgent ?? (settingsHydrated ? rememberedAgent : undefined),
    hostState,
  });

  // B15 wiring: a draft that has never been touched adopts the remembered agent
  // — and WRITES it, rather than only displaying it. A display-only version
  // would put the picker on Codex while `sessionAgent(session)`, and therefore
  // the `chat.createSession` payload, still said Claude Code: the exact
  // display≠send split A11 exists to forbid, reached from the other side.
  //
  // The write is skipped when the answer is the legacy binding anyway, so an
  // untouched draft on a machine with no memory stays byte-identical to S1 —
  // materialising `session.agent` for every session would be a second default
  // in a place `chatSessions.ts:109-113` reserves for `mergeSessionIndex`.
  useEffect(() => {
    if (draftAgent !== undefined) return;
    if (rememberedAgent === sessionAgent({})) return;
    setDraftSessionAgent(sessionId, rememberedAgent, { sendAttempted });
  }, [draftAgent, rememberedAgent, sessionId, sendAttempted, setDraftSessionAgent]);

  const { commitFallback, selectedAgent } = model;
  // One notice per resolved fallback, not one per render: this effect re-runs
  // on every store tick while the stale draft is still on the row.
  const noticedFallbackRef = useRef<string | null>(null);
  useEffect(() => {
    if (!commitFallback || !draftAgent) {
      return;
    }
    const key = `${sessionId}:${draftAgent}->${selectedAgent}`;
    if (noticedFallbackRef.current !== key) {
      noticedFallbackRef.current = key;
      toastManager.add({ type: 'info', title: agentFallbackNotice(draftAgent, selectedAgent) });
    }
    setDraftSessionAgent(sessionId, selectedAgent, { sendAttempted });
  }, [commitFallback, draftAgent, selectedAgent, sessionId, sendAttempted, setDraftSessionAgent]);

  if (model.locked) {
    const option = model.options[0];
    const label = AGENT_DISPLAY_NAMES[option.agent];
    return (
      // Still a radiogroup, now with one permanently-checked option: that is
      // what a settled binding IS. The chip stays a `<button>` with no click
      // handler rather than a styled span — `aria-disabled` and `aria-label`
      // need a role that supports them, and that role in turn needs a
      // focusable element, or the reason copy is unreachable by keyboard. It
      // carries no hover shell, so nothing about it invites a press.
      <span aria-label="Chat agent" className={composerAgentPickerGroupClass()} role="radiogroup">
        <button
          aria-checked="true"
          aria-disabled="true"
          aria-label={option.reason ? `${label} — ${option.reason}` : label}
          className={composerAgentLockedChipClass()}
          role="radio"
          title={option.reason}
          type="button"
        >
          <AgentSegmentBody option={option} />
        </button>
      </span>
    );
  }

  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1">
      <span aria-label="Chat agent" className={composerAgentPickerGroupClass()} role="radiogroup">
        {model.options.map((option) => {
          const label = AGENT_DISPLAY_NAMES[option.agent];
          const inert = Boolean(disabled) || option.disabled;
          return (
            <button
              aria-checked={option.selected}
              aria-disabled={inert || undefined}
              aria-label={option.reason ? `${label} — ${option.reason}` : label}
              className={composerAgentSegmentClass({ selected: option.selected, disabled: inert })}
              key={option.agent}
              onClick={() => {
                if (inert || option.selected) {
                  return;
                }
                setDraftSessionAgent(sessionId, option.agent, { sendAttempted });
                // §3.3-5 / §4.3: the same click that sets the draft records the
                // memory. Gated on hydration so the first pick of a launch
                // cannot persist an empty default over the user's real one —
                // that arm is `canPersistLastAgent`, truth-tabled next door.
                if (canPersistLastAgent(settingsHydrated)) {
                  setChatAgentDefaults({ ...chatAgentDefaults, lastAgent: option.agent });
                }
              }}
              role="radio"
              title={option.reason}
              type="button"
            >
              <AgentSegmentBody option={option} />
            </button>
          );
        })}
      </span>
      {model.emptyStateNotice && (
        <>
          <span className="min-w-0 truncate text-meta text-muted-foreground">
            {model.emptyStateNotice}
          </span>
          {onRetryHost && (
            <button
              className={composerAgentSegmentClass({ selected: false, disabled: false })}
              onClick={onRetryHost}
              type="button"
            >
              Retry Host
            </button>
          )}
        </>
      )}
    </span>
  );
}
