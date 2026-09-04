import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import {
  DEFAULT_SESSION_PERMISSION_TIER,
  type SessionPermissionTier,
} from '@shared/types/sessionPermissionTier';
import { Shield, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu, MenuPopup, MenuRadioGroup, MenuSeparator } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import type { HostStatus } from './hostStatus';
import {
  composerMenuItemClass,
  composerPermissionTriggerClass,
  composerPopupSide,
  type MiddleColumnMode,
} from './middleColumnLayout';
import { readSessionTier, writeSessionTier } from './sessionPreferenceStore';

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
  sessionId: string;
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
    () => readSessionTier(sessionId) ?? DEFAULT_SESSION_PERMISSION_TIER
  );
  const [confirmingDangerous, setConfirmingDangerous] = useState(false);

  const resolvedSessionRef = useRef(sessionId);
  useEffect(() => {
    if (resolvedSessionRef.current !== sessionId) {
      resolvedSessionRef.current = sessionId;
      setTier(readSessionTier(sessionId) ?? DEFAULT_SESSION_PERMISSION_TIER);
      setConfirmingDangerous(false);
    }
  }, [sessionId]);

  const applyTier = useCallback(
    (newTier: SessionPermissionTier) => {
      setTier(newTier);
      writeSessionTier(sessionId, newTier);
      window.electronAPI.chat
        .setPermissionTier({ sessionId, tier: newTier })
        .catch(() => undefined);
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

  const currentOption = TIER_OPTIONS.find((o) => o.id === tier) ?? TIER_OPTIONS[1];
  const Icon = currentOption.icon;
  const label = t(currentOption.labelKey);

  const isDisabled = disabled || sending || hostState !== 'ready';
  const title = sending
    ? t('A turn is running — the tier is fixed for the turn already in flight.')
    : `${t('Permissions: {{tier}} — click to change ({{scope}})', { tier: label, scope: t('Applies immediately, to this thread.') })}`;

  return (
    <Menu
      onOpenChange={(open) => {
        if (!open) setConfirmingDangerous(false);
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
        {!confirmingDangerous ? (
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
        {!confirmingDangerous && (
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
