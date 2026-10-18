import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import type { ChatEngine } from '@shared/claudeSdkEngine';
import {
  DEFAULT_RUNTIME_PERMISSION,
  isPermissionGear,
  PERMISSION_GEAR_LABELS,
  type PermissionPreset,
  permissionPresetLabelsFor,
  presetOf,
  type RuntimePermissionSettings,
  settingsOf,
} from '@shared/types/runtimePermission';
import {
  ClipboardList,
  Shield,
  ShieldAlert,
  ShieldBan,
  ShieldOff,
  ShieldQuestion,
  Target,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Menu, MenuPopup, MenuRadioGroup, MenuSeparator } from '@/components/ui/menu';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useLegacyMigrationStore } from '@/stores/legacyMigration';
import { isTierControlDegraded, usePermissionGateStore } from '@/stores/permissionGate';
import { type HostStatus, isHostUsable } from './hostStatus';
import {
  composerMenuItemClass,
  composerPermissionTriggerClass,
  composerPopupSide,
  type MiddleColumnMode,
} from './middleColumnLayout';
import { permissionModeRefusalText } from './permissionModeRefusal';
import {
  SDK_AUTO_CONFIRMATION,
  SDK_BYPASS_CONFIRMATION,
  SDK_MODE_DESCRIPTIONS,
} from './sdkModeCopy';
import {
  clearStartScreenPermissions,
  holdStartScreenPermissions,
  peekStartScreenPermissions,
  readDefaultPermissions,
  readSessionPermissions,
  writeDefaultPermissions,
  writeSessionPermissions,
} from './sessionPreferenceStore';

function readPermissionsFor(
  sessionId: string | null,
  engine: ChatEngine | undefined
): RuntimePermissionSettings {
  return (
    (sessionId ? readSessionPermissions(sessionId) : peekStartScreenPermissions()) ??
    readDefaultPermissions(engine) ??
    DEFAULT_RUNTIME_PERMISSION
  );
}

/**
 * Decision 166 (GitHub issue #5): one column of five presets, in
 * `PERMISSION_PRESETS` order. `description` is a dictionary key; the menu item
 * translates it.
 */
type PresetOption = {
  id: PermissionPreset;
  description: string;
  icon: typeof Shield;
};

/**
 * Decision 192 (user, 2026-10-18): one short line each, the details left to
 * the confirmation; `auto` and `bypass` read differently when a review model
 * checks what full auto would otherwise ask.
 */
function presetOptions(autoReview: boolean): readonly PresetOption[] {
  return [
    {
      id: 'plan',
      // Plan mode on full auto: reads, searches and read-only commands run
      // without a card; plan mode refuses the rest at call time (gate.ts).
      description: 'Read-only exploration, then the plan comes to you for review',
      icon: ClipboardList,
    },
    { id: 'ask', description: 'Asks before each write, edit and command', icon: Shield },
    {
      id: 'accept-edits',
      description:
        'Workspace edits and commands run without asking; deletes, paths outside it and web access still ask',
      icon: ShieldOff,
    },
    {
      id: 'auto',
      // Decision 191: what full auto still stops to confirm (gate.ts `autoStillAsks`).
      description: autoReview
        ? 'Rarely asks; deletes, force pushes and anything outside the workspace go to the review model first'
        : 'Rarely asks; deletes, force pushes and anything outside the workspace still ask',
      icon: ShieldAlert,
    },
    {
      id: 'bypass',
      description: autoReview
        ? 'Never asks and never reviews; everything runs straight through'
        : 'Never asks; everything runs straight through',
      icon: ShieldBan,
    },
  ];
}

/**
 * Route B, S-2 (rulings 6, 13, 14): a chat on the Claude Agent SDK engine
 * offers Claude's five modes over the same five pairs, in ruling 6's order,
 * described as the engine behaves. The engine keeps no deny list of PiLab's,
 * so nothing here says one applies.
 */
const SDK_PRESET_OPTIONS: readonly PresetOption[] = [
  { id: 'ask', description: SDK_MODE_DESCRIPTIONS.ask, icon: Shield },
  { id: 'accept-edits', description: SDK_MODE_DESCRIPTIONS['accept-edits'], icon: ShieldOff },
  { id: 'plan', description: SDK_MODE_DESCRIPTIONS.plan, icon: ClipboardList },
  { id: 'auto', description: SDK_MODE_DESCRIPTIONS.auto, icon: ShieldAlert },
  { id: 'bypass', description: SDK_MODE_DESCRIPTIONS.bypass, icon: ShieldBan },
];

/**
 * Presets that take effect only after the user confirms a second time.
 *
 * Both hand work to the model that nobody will be asked about again, and both
 * are one keystroke away from the quiet presets in the same radio group.
 */
function needsConfirmation(gear: PermissionPreset): gear is 'auto' | 'bypass' {
  return gear === 'auto' || gear === 'bypass';
}

/**
 * Decision 166: 「设定目标…」 below the presets. The composer owns what it
 * does (prefill `/goal `) and when it is off (`goalEntryState`).
 */
export interface ComposerGoalEntry {
  disabled: boolean;
  /** Dictionary key of the reason it is off. */
  hint: string | null;
  onSelect: () => void;
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
  goalEntry?: ComposerGoalEntry;
  /**
   * Route B, S-2: the engine whose modes the menu shows (`chatEngineForDisplay`).
   * The Claude Agent SDK engine switches mode at any time, plan mode included.
   */
  engine?: ChatEngine;
  /** Decision 192: a review model checks what full auto would otherwise ask (DSH only). */
  autoReview?: boolean;
}

export function ComposerPermissionTrigger({
  sessionId,
  hostState,
  mode,
  disabled,
  turnActive,
  goalEntry,
  engine,
  autoReview = false,
}: ComposerPermissionTriggerProps) {
  const { t } = useI18n();
  const sdk = engine === 'claude-sdk';
  const options = sdk ? SDK_PRESET_OPTIONS : presetOptions(autoReview);
  const presetLabels = permissionPresetLabelsFor(engine);
  const [settings, setSettings] = useState(() => readPermissionsFor(sessionId, engine));
  /** Which dangerous gear is waiting on its confirmation, if any. */
  const [confirming, setConfirming] = useState<'auto' | 'bypass' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep Base UI's own close bookkeeping: never drive its open prop manually.
  const menuActions = useRef<MenuPrimitive.Root.Actions | null>(null);
  // Set by 「设定目标…」: focus goes to the message box, not back to the chip.
  const goalPicked = useRef(false);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  // dsh-rebase P1-9e (decision 121, 122 rule 13): a chat from the previous
  // version came up on the posture its 1.0.x file recorded, and the migration
  // wrote it to this chat's storage; the revision is what makes the chip read
  // it again without a session switch.
  const postureRevision = useLegacyMigrationStore((state) =>
    sessionId ? (state.postureRevisions[sessionId] ?? 0) : 0
  );
  useEffect(() => {
    void postureRevision;
    setSettings(readPermissionsFor(sessionId, engine));
    setConfirming(null);
    setError(null);
  }, [sessionId, postureRevision, engine]);

  const apply = async (next: RuntimePermissionSettings) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (sessionId) {
        await window.electronAPI.chat.setPermissions({ sessionId, permissions: next });
        writeSessionPermissions(sessionId, next);
      } else if (next.gear === 'bypass') {
        // User ruling 2026-10-16: bypass can be turned on before the first message,
        // for the chat that message starts only; never as the new-chat default.
        holdStartScreenPermissions(next);
      } else {
        clearStartScreenPermissions();
        // S-2: remembered with the engine whose wording it was picked under.
        writeDefaultPermissions(next, sdk ? 'claude-sdk' : 'dsh');
      }
      if (currentSession.current === sessionId) {
        setSettings(next);
        setConfirming(null);
        menuActions.current?.close();
      }
    } catch (failure) {
      if (currentSession.current === sessionId) {
        // Route B, S-2 (A-5): a mode the SDK engine refused says why, in our words.
        const refusal = permissionModeRefusalText(failure);
        const message = refusal
          ? t(refusal)
          : failure instanceof Error
            ? failure.message
            : String(failure);
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
  const preset = presetOf(settings);
  const current =
    options.find((option) => option.id === preset) ??
    (options.find((option) => option.id === 'ask') as (typeof options)[number]);
  const Icon = degraded ? ShieldQuestion : current.icon;
  const label = degraded ? t('Your own policy') : t(presetLabels[preset]);
  // A plan-mode pair on another gear (1.0.x `readonly` migrates to plan + ask)
  // shows as 「计划模式」 and is left as stored; the tooltip names its gear.
  // Not on the SDK engine, whose plan mode has no gear.
  const legacyNote =
    !degraded && !sdk && settings.mode === 'plan' && settings.gear !== 'auto'
      ? t('Read-only tools keep the earlier approval level: {{gear}}.', {
          gear: t(PERMISSION_GEAR_LABELS[settings.gear]),
        })
      : null;
  const scope = sessionId
    ? t('Applies immediately, to this thread.')
    : settings.gear === 'bypass'
      ? t('Applies only to the chat your next message starts.')
      : t('Applies to new chats.');
  /** Bypass picked here, before any chat exists: it is never the new-chat default. */
  const bypassScope = sessionId ? null : (
    <span className="mt-1 block">{t('Applies only to the chat your next message starts.')}</span>
  );
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
   *
   * With presets (decision 166): 「计划模式」 is off while a turn runs, and so
   * is every other preset while the chat is in plan mode, since each of them
   * leaves it. In execute mode the four gear presets stay pickable.
   */
  // Route B, S-2 (A-4): the SDK engine takes a mode change mid-turn, plan mode included.
  const modeLocked = turnActive === true && !sdk;
  const lockedByTurn = (id: PermissionPreset) =>
    modeLocked && (id === 'plan' || settings.mode === 'plan');
  const turnNote = t('Plan mode cannot be turned on or off while this turn runs.');
  const isDisabled = disabled || pending || (sessionId !== null && !isHostUsable(hostState));
  // While bypass is on, the chip is the only thing on screen that says so — no
  // card will ever appear again to remind anyone. So it stops being quiet
  // chrome and carries the destructive tone for as long as the gear is live.
  const bypassing = !degraded && settings.gear === 'bypass';
  const head = legacyNote ? `${label} · ${legacyNote}` : label;
  const title = modeLocked ? `${head} — ${turnNote}` : `${head} — ${scope}`;

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
        className="min-w-52 max-w-xl rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
        side={composerPopupSide(mode)}
        finalFocus={() => {
          const picked = goalPicked.current;
          goalPicked.current = false;
          return !picked;
        }}
      >
        {degraded ? (
          <DegradedGateNotice />
        ) : confirming ? (
          <div className="flex max-w-72 flex-col gap-2 p-3">
            <p className="text-ui font-medium text-destructive">
              {confirming === 'bypass'
                ? t(sdk ? 'Turn on Bypass permissions?' : 'Turn off every approval prompt?')
                : t(sdk ? 'Turn on Auto mode?' : 'Turn on full auto?')}
            </p>
            <p className="text-meta text-muted-foreground">
              {confirming === 'bypass'
                ? t(
                    sdk
                      ? SDK_BYPASS_CONFIRMATION
                      : 'Every tool call runs without asking, including the commands full auto still stops to confirm. Explicit deny rules still apply. This is never saved as the default for new chats.'
                  )
                : t(
                    sdk
                      ? SDK_AUTO_CONFIRMATION
                      : autoReview
                        ? 'Deletes, force pushes and anything outside the workspace go to the review model first; what it does not allow is refused. Explicit deny rules still apply.'
                        : 'Deletes, force pushes and anything outside the workspace ask you first every time. Explicit deny rules still apply.'
                  )}
              {confirming === 'bypass' ? bypassScope : scope}
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
                onClick={() => void apply(settingsOf(confirming))}
              >
                {t('Apply')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <MenuRadioGroup
              value={preset}
              onValueChange={(value) => {
                if (value === 'plan') {
                  // Plan mode on full auto applies at once: it only explores,
                  // and plan mode refuses edits and other commands anyway.
                  void apply(settingsOf('plan'));
                  return;
                }
                if (!isPermissionGear(value)) return;
                if (needsConfirmation(value)) setConfirming(value);
                else void apply(settingsOf(value));
              }}
            >
              {options.map((option) => {
                const OptionIcon = option.icon;
                const locked = lockedByTurn(option.id);
                return (
                  <MenuPrimitive.RadioItem
                    key={option.id}
                    value={option.id}
                    disabled={pending || locked}
                    // U30 rev.3 — closing is Base UI's own press handling, never
                    // a consequence of the worker acknowledging: a slow or failed
                    // `setPermissions` must not leave the popup up with the
                    // trigger disabled underneath. `auto` and `bypass` keep it up
                    // because picking one opens the confirmation panel instead of
                    // applying anything.
                    closeOnClick={!needsConfirmation(option.id)}
                    className={composerMenuItemClass()}
                  >
                    <OptionIcon className="size-3.5 shrink-0" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{t(presetLabels[option.id])}</span>
                      <span className="text-meta text-muted-foreground">
                        {locked ? t('Can be changed once this turn ends.') : t(option.description)}
                      </span>
                    </span>
                    <MenuPrimitive.RadioItemIndicator>
                      <span className="size-1.5 rounded-full bg-foreground" />
                    </MenuPrimitive.RadioItemIndicator>
                  </MenuPrimitive.RadioItem>
                );
              })}
            </MenuRadioGroup>
            {goalEntry && (
              <>
                <MenuSeparator />
                <MenuPrimitive.Item
                  disabled={goalEntry.disabled}
                  className={composerMenuItemClass()}
                  onClick={() => {
                    goalPicked.current = true;
                    goalEntry.onSelect();
                  }}
                >
                  <Target className="size-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>{t('Set a goal…')}</span>
                    <span className="text-meta text-muted-foreground">
                      {goalEntry.hint
                        ? t(goalEntry.hint)
                        : t(
                            'Fills in /goal. Once sent, the goal runs round after round, switching to Full auto if needed.'
                          )}
                    </span>
                  </span>
                </MenuPrimitive.Item>
              </>
            )}
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
