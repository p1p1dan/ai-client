import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import {
  DEFAULT_SESSION_PERMISSION_TIER,
  type SessionPermissionTier,
} from '@shared/types/sessionPermissionTier';
import { Shield, ShieldAlert, ShieldCheck, ShieldOff, ShieldQuestion } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu, MenuPopup, MenuRadioGroup, MenuSeparator } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { isTierControlDegraded, usePermissionGateStore } from '@/stores/permissionGate';
import type { HostStatus } from './hostStatus';
import {
  composerMenuItemClass,
  composerPermissionTriggerClass,
  composerPopupSide,
  type MiddleColumnMode,
} from './middleColumnLayout';
import {
  readDefaultTier,
  readSessionTier,
  writeDefaultTier,
  writeSessionTier,
} from './sessionPreferenceStore';

/** Per-chat value when there is a chat, the global default before there is. */
function readTierFor(sessionId: string | null): SessionPermissionTier | null {
  return sessionId ? (readSessionTier(sessionId) ?? readDefaultTier()) : readDefaultTier();
}

interface TierOption {
  id: SessionPermissionTier;
  labelKey: string;
  descriptionKey: string;
  icon: typeof Shield;
  dangerous?: boolean;
}

const TIER_OPTIONS: readonly TierOption[] = [
  {
    id: 'readonly',
    labelKey: 'Read-only',
    descriptionKey: 'Can read and search, cannot edit files or run commands.',
    icon: ShieldCheck,
  },
  {
    id: 'pragmatic',
    labelKey: 'Pragmatic',
    descriptionKey: 'Shipped defaults — reads are free, changes ask for confirmation.',
    icon: Shield,
  },
  {
    id: 'handsoff',
    labelKey: 'Hands-off',
    // Names the workspace boundary on purpose: edits INSIDE it are what this
    // tier clears, and a file outside it still runs the cross-directory gate
    // first — which looked like a broken tier while the copy said only
    // "file edits apply without asking".
    descriptionKey:
      'File edits inside the workspace apply without asking; commands, and anything outside it, still ask.',
    icon: ShieldOff,
  },
  {
    id: 'fullopen',
    labelKey: 'Full access',
    descriptionKey:
      'Approves most actions automatically, including writes outside the workspace. Secret-file protection remains.',
    icon: ShieldAlert,
    dangerous: true,
  },
];

interface ComposerPermissionTriggerProps {
  /**
   * U29: `null` before the conversation exists. The control still renders —
   * pix keeps its access menu live at all times, and a tier picked now is what
   * the first send spawns on. In that state it reads and writes the GLOBAL
   * default (user ruling, 2026-09-06) rather than a per-chat value, because
   * there is no chat yet to attach one to.
   */
  sessionId: string | null;
  hostState: HostStatus['state'];
  mode: MiddleColumnMode;
  disabled?: boolean;
  sending?: boolean;
}

export function ComposerPermissionTrigger({
  sessionId,
  hostState,
  mode,
  disabled,
  sending,
}: ComposerPermissionTriggerProps) {
  const { t } = useI18n();

  const [tier, setTier] = useState<SessionPermissionTier>(
    () => readTierFor(sessionId) ?? DEFAULT_SESSION_PERMISSION_TIER
  );
  const [confirmingDangerous, setConfirmingDangerous] = useState(false);
  /**
   * U30: controlled so applying a tier can close the menu.
   *
   * `MenuPrimitive.RadioItem` deliberately does not close on select — radio
   * semantics are "keep flipping between these" — which is right for a filter
   * and wrong here: picking a tier is a decision, and the menu sitting open
   * afterwards reads as "that did not take". Only `applyTier` closes it, so the
   * dangerous tier's confirmation step still gets to keep the popup up.
   */
  const [open, setOpen] = useState(false);

  const resolvedSessionRef = useRef(sessionId);
  useEffect(() => {
    if (resolvedSessionRef.current !== sessionId) {
      resolvedSessionRef.current = sessionId;
      setTier(readTierFor(sessionId) ?? DEFAULT_SESSION_PERMISSION_TIER);
      setConfirmingDangerous(false);
    }
  }, [sessionId]);

  const applyTier = useCallback(
    (newTier: SessionPermissionTier) => {
      setTier(newTier);
      setOpen(false);
      if (sessionId) {
        writeSessionTier(sessionId, newTier);
        // Only a live chat has a worker to tell. Without one the choice is a
        // preference; `runSend` reads it back when it spawns.
        window.electronAPI.chat
          .setPermissionTier({ sessionId, tier: newTier })
          .catch(() => undefined);
        return;
      }
      writeDefaultTier(newTier);
    },
    [sessionId]
  );

  const handleSelect = useCallback(
    (value: string | number | null) => {
      if (typeof value !== 'string') return;
      const selected = value as SessionPermissionTier;
      const option = TIER_OPTIONS.find((o) => o.id === selected);
      if (!option) return;
      if (option.dangerous) {
        setConfirmingDangerous(true);
        return;
      }
      applyTier(selected);
      setConfirmingDangerous(false);
    },
    [applyTier]
  );

  const handleConfirm = useCallback(() => {
    applyTier('fullopen');
    setConfirmingDangerous(false);
  }, [applyTier]);

  // D10: the tiers only exist as an `authorizerChain` link in the config.json we
  // ship beside our bundled plugin copy. On the `user_configured` path we do not
  // inject that copy, so the link is registered and never consulted — every tier
  // resolves to whatever the user's own config says. The control stops offering
  // a choice it cannot deliver.
  const degraded = usePermissionGateStore((state) => isTierControlDegraded(state.gates, sessionId));

  const currentOption = TIER_OPTIONS.find((o) => o.id === tier) ?? TIER_OPTIONS[1];
  const Icon = degraded ? ShieldQuestion : currentOption.icon;
  // Not the tier name: naming one would be the precise lie this state exists to
  // remove. It is also NOT safe to say "same as Pragmatic" — the effective
  // policy is the user's, which may be laxer than any tier here (a `yoloMode`
  // config disables the checks outright).
  const label = degraded ? t('Your own policy') : t(currentOption.labelKey);

  // U29: the host gate stands down before a chat exists. `hostState` describes
  // a runtime this control is not talking to yet — leaving it in would grey out
  // the menu on the start screen for a reason that does not apply to it.
  const isDisabled = disabled || sending || (sessionId !== null && hostState !== 'ready');
  const title = degraded
    ? t(
        'This chat runs on the permission system in your own agent directory; the tiers here do not apply.'
      )
    : sending
      ? t('A turn is running — the tier is fixed for the turn already in flight.')
      : `${t('Permissions: {{tier}} — click to change ({{scope}})', { tier: label, scope: sessionId ? t('Applies immediately, to this thread.') : t('Applies to new chats.') })}`;

  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirmingDangerous(false);
      }}
    >
      <MenuPrimitive.Trigger
        className={composerPermissionTriggerClass()}
        disabled={isDisabled}
        aria-label={title}
        title={title}
        render={<button type="button" />}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="text-muted-foreground">{label}</span>
      </MenuPrimitive.Trigger>
      <MenuPopup
        align="start"
        className="min-w-52 rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
        side={composerPopupSide(mode)}
      >
        {degraded ? (
          <DegradedGateNotice />
        ) : !confirmingDangerous ? (
          <MenuRadioGroup value={tier} onValueChange={handleSelect}>
            {TIER_OPTIONS.map((option) => {
              const OptionIcon = option.icon;
              return (
                <MenuPrimitive.RadioItem
                  key={option.id}
                  value={option.id}
                  className={composerMenuItemClass()}
                >
                  <OptionIcon className="size-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{t(option.labelKey)}</span>
                    <span className="text-meta text-muted-foreground">
                      {t(option.descriptionKey)}
                    </span>
                  </span>
                  <MenuPrimitive.RadioItemIndicator className="shrink-0">
                    <span className="size-1.5 rounded-full bg-foreground" />
                  </MenuPrimitive.RadioItemIndicator>
                </MenuPrimitive.RadioItem>
              );
            })}
          </MenuRadioGroup>
        ) : (
          <div className="flex flex-col gap-2 p-3">
            <p className="text-ui font-medium text-destructive">
              {t('Remove limits on this chat?')}
            </p>
            <p className="text-meta text-muted-foreground">
              {t(
                'Full access approves most tool calls automatically, including reads and writes outside this workspace. Only secret-file protection remains. This applies to this chat only.'
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-sm px-2 py-1 text-ui text-muted-foreground hover:bg-hover"
                onClick={() => setConfirmingDangerous(false)}
              >
                {t('Cancel')}
              </button>
              <button
                type="button"
                className="rounded-sm bg-destructive/10 px-2 py-1 text-ui text-destructive hover:bg-destructive/20"
                onClick={handleConfirm}
              >
                {t('Apply')}
              </button>
            </div>
          </div>
        )}
        {!degraded && !confirmingDangerous && (
          <>
            <MenuSeparator />
            <div className="px-2 py-1.5 text-meta text-muted-foreground">
              {t('Applies immediately, to this thread.')}
            </div>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

/**
 * What the menu shows instead of four tiers when the runtime came up on the
 * user's own permission system (D10).
 *
 * Deliberately two lines: state that the tiers are off, and where the policy
 * actually comes from. It names no tier — the effective policy is the user's
 * config, which a `yoloMode: true` file makes laxer than every tier listed here,
 * so "same as Pragmatic" would be a new false claim replacing the old one. The
 * remedy (adding `authorizerChain` to their own config) lives in D10, not here:
 * the user asked for the panel to say the one thing and stop.
 */
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
