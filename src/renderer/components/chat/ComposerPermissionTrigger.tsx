import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import {
  DEFAULT_RUNTIME_PERMISSION,
  isPermissionGear,
  isRuntimeMode,
  PERMISSION_GEAR_LABELS,
  type PermissionGear,
  RUNTIME_MODE_LABELS,
  type RuntimePermissionSettings,
} from '@shared/types/runtimePermission';
import { Shield, ShieldAlert, ShieldBan, ShieldOff, ShieldQuestion } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Menu, MenuPopup, MenuRadioGroup, MenuSeparator } from '@/components/ui/menu';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { isTierControlDegraded, usePermissionGateStore } from '@/stores/permissionGate';
import { type HostStatus, isHostUsable } from './hostStatus';
import {
  composerMenuItemClass,
  composerPermissionTriggerClass,
  composerPopupSide,
  type MiddleColumnMode,
} from './middleColumnLayout';
import {
  readDefaultPermissions,
  readSessionPermissions,
  writeDefaultPermissions,
  writeSessionPermissions,
} from './sessionPreferenceStore';

function readPermissionsFor(sessionId: string | null): RuntimePermissionSettings {
  return (
    (sessionId ? readSessionPermissions(sessionId) : null) ??
    readDefaultPermissions() ??
    DEFAULT_RUNTIME_PERMISSION
  );
}

/** `description` is a dictionary key; the menu item translates it. */
const GEAR_OPTIONS: readonly { id: PermissionGear; description: string; icon: typeof Shield }[] = [
  { id: 'ask', description: 'Asks before each write, edit and command.', icon: Shield },
  {
    id: 'accept-edits',
    description:
      'Writes, edits and commands inside the workspace run automatically; paths outside it still ask.',
    icon: ShieldOff,
  },
  {
    id: 'auto',
    description: 'Runs the available tools automatically; explicit deny rules still apply.',
    icon: ShieldAlert,
  },
  {
    id: 'bypass',
    description:
      'Never asks. Even commands full auto would stop to confirm run straight through; explicit deny rules still apply.',
    icon: ShieldBan,
  },
];

/**
 * Gears that take effect only after the user confirms a second time.
 *
 * Both hand work to the model that nobody will be asked about again, and both
 * are one keystroke away from the quiet gears in the same radio group.
 */
function needsConfirmation(gear: PermissionGear): gear is 'auto' | 'bypass' {
  return gear === 'auto' || gear === 'bypass';
}

interface ComposerPermissionTriggerProps {
  sessionId: string | null;
  hostState: HostStatus['state'];
  mode: MiddleColumnMode;
  disabled?: boolean;
  /**
   * True while the current turn is running: the caller's `busy || sending`
   * union (session status is stoppable, OR a send request is in flight), not
   * merely "a send request is in flight". The narrower flag used to leave
   * every option clickable for almost the whole turn, because the send-only
   * latch falls back to false long before an approval card can appear.
   */
  turnActive?: boolean;
}

export function ComposerPermissionTrigger({
  sessionId,
  hostState,
  mode,
  disabled,
  turnActive,
}: ComposerPermissionTriggerProps) {
  const { t } = useI18n();
  const [settings, setSettings] = useState(() => readPermissionsFor(sessionId));
  /** Which dangerous gear is waiting on its confirmation, if any. */
  const [confirming, setConfirming] = useState<'auto' | 'bypass' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep Base UI's own close bookkeeping: never drive its open prop manually.
  const menuActions = useRef<MenuPrimitive.Root.Actions | null>(null);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  useEffect(() => {
    setSettings(readPermissionsFor(sessionId));
    setConfirming(null);
    setError(null);
  }, [sessionId]);

  const apply = async (next: RuntimePermissionSettings) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (sessionId) {
        await window.electronAPI.chat.setPermissions({ sessionId, permissions: next });
        writeSessionPermissions(sessionId, next);
      } else {
        writeDefaultPermissions(next);
      }
      if (currentSession.current === sessionId) {
        setSettings(next);
        setConfirming(null);
        menuActions.current?.close();
      }
    } catch (failure) {
      if (currentSession.current === sessionId) {
        const message = failure instanceof Error ? failure.message : String(failure);
        // The popup has usually closed by the time this lands (the press closes
        // it), so an in-popup alert would report the failure to nobody. Keep
        // both surfaces: the alert for the confirmation panel, which is still
        // up, and a toast for everything else.
        setError(message);
        addToast({
          type: 'error',
          title: t('Permission change did not take'),
          description: message,
        });
      }
    } finally {
      setPending(false);
    }
  };
  const degraded = usePermissionGateStore((state) => isTierControlDegraded(state.gates, sessionId));
  const current = GEAR_OPTIONS.find((option) => option.id === settings.gear) ?? GEAR_OPTIONS[0];
  const Icon = degraded ? ShieldQuestion : current.icon;
  const label = degraded
    ? t('Your own policy')
    : `${t(RUNTIME_MODE_LABELS[settings.mode])} · ${t(PERMISSION_GEAR_LABELS[settings.gear])}`;
  const scope = sessionId ? t('Applies immediately, to this thread.') : t('Applies to new chats.');
  /**
   * A running turn locks the MODE and leaves the gear open.
   *
   * Plan mode decides which tools the turn was handed when it started, so
   * switching it halfway leaves the turn running on a tool set its own posture
   * no longer matches. The gear only decides how often the user is asked — and
   * the moment they most want it is while an approval card is sitting there,
   * which is precisely when the whole control used to go grey. A gear widened
   * now also releases the card that is already waiting (the runtime re-judges
   * it), so this is not merely a setting for next time.
   */
  const modeLocked = turnActive === true;
  const turnNote = t('While this turn runs, only the permission level can change.');
  const isDisabled = disabled || pending || (sessionId !== null && !isHostUsable(hostState));
  // While bypass is on, the chip is the only thing on screen that says so — no
  // card will ever appear again to remind anyone. So it stops being quiet
  // chrome and carries the destructive tone for as long as the gear is live.
  const bypassing = !degraded && settings.gear === 'bypass';
  const title = modeLocked ? `${label} — ${turnNote}` : `${label} — ${scope}`;

  return (
    <Menu
      actionsRef={menuActions}
      onOpenChange={(open) => {
        if (!open) setConfirming(null);
      }}
    >
      <MenuPrimitive.Trigger
        className={`${composerPermissionTriggerClass()}${
          bypassing ? ' bg-destructive/10 text-destructive hover:bg-destructive/20' : ''
        }`}
        disabled={isDisabled}
        aria-label={title}
        title={title}
        render={<button type="button" />}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className={bypassing ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
      </MenuPrimitive.Trigger>
      <MenuPopup
        align="start"
        className="min-w-52 rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
        side={composerPopupSide(mode)}
      >
        {degraded ? (
          <DegradedGateNotice />
        ) : confirming ? (
          <div className="flex max-w-72 flex-col gap-2 p-3">
            <p className="text-ui font-medium text-destructive">
              {confirming === 'bypass'
                ? t('Turn off every approval prompt?')
                : t('Turn on full auto?')}
            </p>
            <p className="text-meta text-muted-foreground">
              {confirming === 'bypass'
                ? t(
                    'Every tool call runs without asking, including the commands full auto still stops to confirm. Explicit deny rules still apply. This is never saved as the default for new chats.'
                  )
                : t(
                    'Runs the tools available in the current mode automatically, including operations outside the workspace; explicit deny rules still apply.'
                  )}
              {confirming === 'bypass' ? '' : scope}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                className="rounded-sm px-2 py-1 text-ui hover:bg-hover"
                onClick={() => setConfirming(null)}
              >
                {t('Cancel')}
              </button>
              <button
                type="button"
                disabled={pending}
                className="rounded-sm bg-destructive/10 px-2 py-1 text-ui text-destructive hover:bg-destructive/20"
                onClick={() => void apply({ ...settings, gear: confirming })}
              >
                {t('Apply')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <MenuRadioGroup
              value={settings.mode}
              onValueChange={(value) => {
                if (isRuntimeMode(value)) void apply({ ...settings, mode: value });
              }}
            >
              {(['plan', 'agent'] as const).map((runtimeMode) => (
                <MenuPrimitive.RadioItem
                  key={runtimeMode}
                  value={runtimeMode}
                  disabled={pending || modeLocked}
                  // U30 rev.3 — closing is Base UI's own press handling, never a
                  // consequence of the worker acknowledging. `closeOnClick={false}`
                  // (D14's rework) made the popup's fate depend on an await: a
                  // slow or failed `setPermissions` left it up with the trigger
                  // disabled underneath, which is the "菜单关不掉" the field pass
                  // reported for a second time. A picked mode is a finished
                  // decision; failures are reported by toast, not by a popup
                  // that refuses to leave.
                  closeOnClick
                  className={composerMenuItemClass()}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>{t(RUNTIME_MODE_LABELS[runtimeMode])}</span>
                    <span className="text-meta text-muted-foreground">
                      {modeLocked
                        ? t('Can be changed once this turn ends.')
                        : runtimeMode === 'plan'
                          ? t('Investigates and submits a plan, then waits for approval.')
                          : t('Carries out approved work.')}
                    </span>
                  </span>
                  <MenuPrimitive.RadioItemIndicator>
                    <span className="size-1.5 rounded-full bg-foreground" />
                  </MenuPrimitive.RadioItemIndicator>
                </MenuPrimitive.RadioItem>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuRadioGroup
              value={settings.gear}
              onValueChange={(value) => {
                if (!isPermissionGear(value)) return;
                if (needsConfirmation(value)) setConfirming(value);
                else void apply({ ...settings, gear: value });
              }}
            >
              {GEAR_OPTIONS.map((option) => {
                const OptionIcon = option.icon;
                // `bypass` never becomes a new-chat default, so offering it on
                // the start screen would show a chip the next session would not
                // honour. It is a live-thread decision, taken in the thread.
                const unavailable = option.id === 'bypass' && !sessionId;
                return (
                  <MenuPrimitive.RadioItem
                    key={option.id}
                    value={option.id}
                    disabled={pending || unavailable}
                    // `auto` and `bypass` keep the popup up because picking one
                    // opens the confirmation panel instead of applying anything.
                    closeOnClick={!needsConfirmation(option.id)}
                    className={composerMenuItemClass()}
                  >
                    <OptionIcon className="size-3.5 shrink-0" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{t(PERMISSION_GEAR_LABELS[option.id])}</span>
                      <span className="text-meta text-muted-foreground">
                        {unavailable
                          ? t('Can be turned on once this chat exists.')
                          : t(option.description)}
                      </span>
                    </span>
                    <MenuPrimitive.RadioItemIndicator>
                      <span className="size-1.5 rounded-full bg-foreground" />
                    </MenuPrimitive.RadioItemIndicator>
                  </MenuPrimitive.RadioItem>
                );
              })}
            </MenuRadioGroup>
            <MenuSeparator />
            <div className="px-2 py-1.5 text-meta text-muted-foreground">
              {modeLocked ? turnNote : scope}
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="max-w-72 px-3 py-2 text-meta text-destructive">
            {error}
          </p>
        )}
      </MenuPopup>
    </Menu>
  );
}

function DegradedGateNotice() {
  const { t } = useI18n();
  return (
    <div className="max-w-64 p-3">
      <p className="text-ui font-medium">{t('Permission tiers are off for this chat')}</p>
      <p className="mt-1 text-meta text-muted-foreground">
        {t('It runs on the permission system in your own agent directory.')}
      </p>
    </div>
  );
}
