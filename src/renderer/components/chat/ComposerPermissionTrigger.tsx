import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import type { AgentWireName } from '@shared/types/agentWire';
import type { SessionPermissionPreference } from '@shared/types/runtimeEvents';
import { AlertTriangle, Check, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuSeparator } from '@/components/ui/menu';
import type { TFunction } from '@/i18n';
import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import {
  type ComposerPermissionMenuSection,
  type ComposerPermissionPendingLabel,
  decideLivePermissionAction,
  deriveComposerPermission,
  LIVE_DANGEROUS_CONFIRM_BODY,
  LIVE_DANGEROUS_CONFIRM_TITLE,
  LIVE_DANGEROUS_TIER_WARNING,
  nextLivePreference,
  PERMISSION_TIER_JOINER,
  PERMISSION_UPDATE_FAILED_TITLE,
  type PendingPermissionChange,
  permissionChangeSettled,
  samePermissionPreference,
} from './composerPermissionModel';
import type { HostStatus } from './hostStatus';
import {
  composerMenuGroupLabelClass,
  composerMenuItemClass,
  composerModelBaseClass,
  composerModelSuffixClass,
  composerModelTriggerClass,
  composerPopupSide,
  type MiddleColumnMode,
} from './middleColumnLayout';

/**
 * D48 S4 §6.3 — the Composer's LIVE permission control.
 *
 * Deliberately dumb, the same way `ComposerAgentPicker` is: every branch lives
 * in `composerPermissionModel.ts`, truth-tabled under the node-env vitest that
 * can never render this file. What is left here is the facts subscription, the
 * one IPC call, and the confirmation dialog's local hold.
 *
 * Four things that look like details and are not:
 *
 *  - **The chip shows the ECHO.** `current` comes out of the runtime facts
 *    store, never out of the request that was just sent. Codex answers
 *    `thread/settings/update` with an empty body [实测 06-probes P3], so a
 *    control that painted its own request would state a posture on the strength
 *    of a reply that says nothing (D7). An accepted-but-not-yet-echoed change
 *    shows as a labelled pending marker beside the current tier.
 *  - **A dangerous tier reaches `updatePermission` only through the dialog.**
 *    `request()` is the single entry from the menu and it routes every pick
 *    through `decideLivePermissionAction`; `submit()` is the only caller of the
 *    IPC. Cancelling writes nothing and needs no cleanup — the chip is derived
 *    from the facts, so it is already showing the tier the session is on (D12).
 *    The renderer gate is a courtesy; Main and the Host each refuse an
 *    unconfirmed dangerous tier again (R18, two walls).
 *  - **This file never touches `ChatAgentDefaults`.** Turning one chat up must
 *    not turn every future chat up (D11) — there is no settings-store import
 *    here that could, and the assertion is a scan for exactly that.
 *  - **`agentBindingLocked` is not an input.** The agent binds on first send and
 *    stays bound; the tier is the thing this feature exists to change afterwards
 *    (D13). Reusing that lock would implement the requirement away.
 */

interface ComposerPermissionTriggerProps {
  sessionId: string;
  /** `sessionAgent(session)` — the same value the picker and the model trigger read. */
  agent: AgentWireName;
  /** `hostStatus.capabilities?.permissionPolicy` — absent = a Host without the command. */
  capabilityPermissionPolicy: boolean | undefined;
  hostState: HostStatus['state'];
  /** Which way the popup opens — the docked card has no room below it. */
  mode: MiddleColumnMode;
  busy: boolean;
  sending: boolean;
  disabled?: boolean;
}

/**
 * Tier keys → one localized label. Every part goes through `t()` BEFORE the
 * join, which is the whole reason the view hands over keys instead of a
 * sentence (see `composerPermissionModel`'s copy header).
 */
function tierText(t: TFunction, keys: readonly string[]): string {
  return keys.map((key) => t(key)).join(PERMISSION_TIER_JOINER);
}

function pendingText(t: TFunction, pending: ComposerPermissionPendingLabel): string {
  return t(pending.template, { tier: tierText(t, pending.tierKeys) });
}

function PermissionMenuSection({
  section,
  onSelect,
}: {
  section: ComposerPermissionMenuSection;
  onSelect: (sectionId: ComposerPermissionMenuSection['id'], itemId: string) => void;
}) {
  const { t } = useI18n();
  const selectedId = section.items.find((item) => item.selected)?.id ?? null;
  return (
    <MenuGroup>
      <MenuPrimitive.GroupLabel className={composerMenuGroupLabelClass()}>
        {t(section.label)}
      </MenuPrimitive.GroupLabel>
      <MenuRadioGroup
        value={selectedId}
        onValueChange={(value) => {
          if (typeof value === 'string') onSelect(section.id, value);
        }}
      >
        {section.items.map((item) => (
          <MenuPrimitive.RadioItem
            key={item.id}
            value={item.id}
            className={composerMenuItemClass()}
            title={t(item.description)}
          >
            <span
              className={
                item.dangerous
                  ? 'min-w-0 flex-1 truncate text-destructive'
                  : 'min-w-0 flex-1 truncate'
              }
            >
              {t(item.label)}
            </span>
            <MenuPrimitive.RadioItemIndicator className="shrink-0">
              <Check className="size-3.5" />
            </MenuPrimitive.RadioItemIndicator>
          </MenuPrimitive.RadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  );
}

export function ComposerPermissionTrigger({
  sessionId,
  agent,
  capabilityPermissionPolicy,
  hostState,
  mode,
  busy,
  sending,
  disabled,
}: ComposerPermissionTriggerProps) {
  const { t } = useI18n();
  // Scalar selector: this component sits in a composer that re-renders on every
  // keystroke, and the whole map would re-run the derivation for every session.
  const facts = useSessionRuntimeFactsStore((state) => state.factsBySession[sessionId]);
  const [pending, setPending] = useState<PendingPermissionChange | null>(null);
  const [inFlight, setInFlight] = useState(false);
  // The dangerous tier waiting for its second confirmation. Held HERE and
  // nowhere else — in particular not in the chip, which keeps showing the
  // echoed tier until the runtime says otherwise.
  const [held, setHeld] = useState<SessionPermissionPreference | null>(null);

  const view = deriveComposerPermission({
    sessionId,
    agent,
    capabilityPermissionPolicy,
    hostState,
    facts,
    pending,
    inFlight,
    busy,
    sending,
    disabled: Boolean(disabled),
  });

  // This component is never remounted per session (`ChatWorkspace` renders one
  // `ChatComposer` with no `key`), so a session switch has to clear the transient
  // state explicitly — a pending marker or a held dangerous tier carried across
  // would belong to a chat the user has left.
  const sessionRef = useRef(sessionId);
  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    sessionRef.current = sessionId;
    setPending(null);
    setHeld(null);
  }, [sessionId]);

  // The pending marker is dropped when the FACTS agree with it, never when the
  // request returned: that is the same "the echo is the only evidence" rule the
  // chip's value follows.
  useEffect(() => {
    if (permissionChangeSettled(agent, facts, pending)) setPending(null);
  }, [agent, facts, pending]);

  const submit = async (preference: SessionPermissionPreference, dangerousConfirmed: boolean) => {
    setInFlight(true);
    try {
      const result = await window.electronAPI.chat.updatePermission({
        sessionId,
        permissionPreference: preference,
        ...(dangerousConfirmed ? { dangerousConfirmed: true } : {}),
      });
      // The ACK's own echo of the accepted request, not the value we sent: if
      // the two ever differ, the runtime's reading is the one that will run.
      setPending({
        sessionId,
        preference: result.preference,
        effective: result.effective,
      });
    } catch (error) {
      // Failure is final and visible: no retry, no queue, and the chip keeps
      // showing the tier the session is actually on because it never showed
      // anything else (D9).
      //
      // INLINE (§6.3), not a toast: this is the composer's own status line — the
      // same one `AGENT_UNAVAILABLE_SEND_ERROR` writes to two controls away — so
      // the refusal sits next to the control that was refused and stays there
      // until the next action clears it, instead of floating away on a timer
      // while the chip beside it still shows the old tier with no explanation.
      setPending(null);
      const detail = error instanceof Error ? error.message : String(error);
      useChatSessionsStore.setState({
        lastError: `${t(PERMISSION_UPDATE_FAILED_TITLE)} — ${detail}`,
      });
    } finally {
      setInFlight(false);
    }
  };

  const request = (preference: SessionPermissionPreference | undefined) => {
    // A value this build cannot name is refused outright, and re-picking the
    // tier the session is already on is not a change — neither one reaches the
    // gate, and therefore neither one reaches the wire.
    if (!preference || samePermissionPreference(preference, view.current ?? undefined)) return;
    const action = decideLivePermissionAction(preference);
    if (action.kind === 'confirm') {
      setHeld(action.preference);
      return;
    }
    void submit(action.preference, false);
  };

  const handleSelect = (sectionId: ComposerPermissionMenuSection['id'], itemId: string) => {
    if (!view.current) return;
    // Spelled out rather than built from a computed key: the patch keys are the
    // two arms of a discriminated union, and a `{[sectionId]: itemId}` object
    // would widen to a string index that could carry a Claude key at a Codex
    // session (which `nextLivePreference` refuses, but only at runtime).
    const patch =
      sectionId === 'permissionMode'
        ? { permissionMode: itemId }
        : sectionId === 'approvalPolicy'
          ? { approvalPolicy: itemId }
          : { sandboxMode: itemId };
    request(nextLivePreference(view.current, patch));
  };

  if (!view.rendered) return null;

  // Composed HERE and not in the model: the model is locale-blind on purpose, so
  // every part is translated first and only then assembled (D-i18n).
  const tierLabel = tierText(t, view.labelKeys);
  const scopeText = t(view.scopeHint);
  const reasonText = view.disabledReason ? t(view.disabledReason) : '';
  const pendingLabel = view.pendingLabel ? pendingText(t, view.pendingLabel) : null;
  const title = t(view.titleTemplate, {
    tier: tierLabel,
    scope: scopeText,
    reason: reasonText,
  });
  const spokenLabel = t(view.spokenTemplate, {
    tier: tierLabel,
    scope: scopeText,
    pending: pendingLabel ?? '',
  });

  return (
    <>
      <Menu>
        <MenuPrimitive.Trigger
          className={composerModelTriggerClass()}
          disabled={view.disabled}
          aria-label={spokenLabel}
          title={title}
          render={<button type="button" />}
        >
          <ShieldCheck
            className={
              view.dangerousActive
                ? 'size-3.5 shrink-0 text-destructive'
                : 'size-3.5 shrink-0 text-muted-foreground'
            }
          />
          <span className={view.dangerousActive ? 'text-destructive' : composerModelBaseClass()}>
            {tierLabel}
          </span>
          {/* Beside the current tier, never instead of it: a change that has been
              accepted is not yet a fact, and the two must stay tellable apart. */}
          {pendingLabel && <span className={composerModelSuffixClass()}>· {pendingLabel}</span>}
        </MenuPrimitive.Trigger>
        <MenuPopup
          align="start"
          className="min-w-52 rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
          side={composerPopupSide(mode)}
        >
          {view.sections.map((section, index) => (
            <div key={section.id}>
              {index > 0 && <MenuSeparator />}
              <PermissionMenuSection section={section} onSelect={handleSelect} />
            </div>
          ))}
          <MenuSeparator />
          {/* The scope sentence is per axis and the two are different strings on
              purpose: Claude's tier lands on the next turn, codex's on this
              thread right away [实测 06-probes P2/P3]. */}
          <p className="px-2 py-1.5 text-meta text-muted-foreground">{t(view.scopeHint)}</p>
          {/* Permanent, not conditional: the risk has to be readable before
              anything is picked. */}
          <p className="flex items-start gap-1.5 px-2 pb-1.5 text-meta text-destructive">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span className="min-w-0 flex-1">{t(LIVE_DANGEROUS_TIER_WARNING)}</span>
          </p>
        </MenuPopup>
      </Menu>

      <AlertDialog
        open={held !== null}
        onOpenChange={(nextOpen) => {
          // Escape, backdrop, Cancel — all of them are a cancel, and a cancel
          // sends nothing. Nothing has to be undone: the chip was never moved.
          if (!nextOpen) setHeld(null);
        }}
      >
        <AlertDialogPopup className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <span className="min-w-0 flex-1">{t(LIVE_DANGEROUS_CONFIRM_TITLE)}</span>
            </AlertDialogTitle>
            <AlertDialogDescription>{t(LIVE_DANGEROUS_CONFIRM_BODY)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="destructive"
              onClick={() => {
                const confirmed = held;
                setHeld(null);
                if (confirmed) void submit(confirmed, true);
              }}
            >
              {t('Apply to this chat')}
            </Button>
            <Button variant="ghost" onClick={() => setHeld(null)}>
              {t('Cancel')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
