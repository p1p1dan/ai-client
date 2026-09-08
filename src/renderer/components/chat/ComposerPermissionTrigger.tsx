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
import { Shield, ShieldAlert, ShieldOff, ShieldQuestion } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Menu, MenuPopup, MenuRadioGroup, MenuSeparator } from '@/components/ui/menu';
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

const GEAR_OPTIONS: readonly { id: PermissionGear; description: string; icon: typeof Shield }[] = [
  { id: 'ask', description: '写入、编辑和命令逐条询问。', icon: Shield },
  {
    id: 'accept-edits',
    description: '工作区内写入、编辑和命令自动执行；外部路径仍询问。',
    icon: ShieldOff,
  },
  { id: 'auto', description: '自动执行可用工具；显式拒绝规则仍生效。', icon: ShieldAlert },
];

interface ComposerPermissionTriggerProps {
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
  const [settings, setSettings] = useState(() => readPermissionsFor(sessionId));
  const [confirmingAuto, setConfirmingAuto] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep Base UI's own close bookkeeping: never drive its open prop manually.
  const menuActions = useRef<MenuPrimitive.Root.Actions | null>(null);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  useEffect(() => {
    setSettings(readPermissionsFor(sessionId));
    setConfirmingAuto(false);
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
        setConfirmingAuto(false);
        menuActions.current?.close();
      }
    } catch (failure) {
      if (currentSession.current === sessionId)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };
  const degraded = usePermissionGateStore((state) => isTierControlDegraded(state.gates, sessionId));
  const current = GEAR_OPTIONS.find((option) => option.id === settings.gear) ?? GEAR_OPTIONS[0];
  const Icon = degraded ? ShieldQuestion : current.icon;
  const label = degraded
    ? t('Your own policy')
    : `${RUNTIME_MODE_LABELS[settings.mode]} · ${PERMISSION_GEAR_LABELS[settings.gear]}`;
  const scope = sessionId ? t('Applies immediately, to this thread.') : t('Applies to new chats.');
  const isDisabled =
    disabled || sending || pending || (sessionId !== null && !isHostUsable(hostState));
  const title = sending ? '当前轮次结束后可修改模式和权限。' : `${label} — ${scope}`;

  return (
    <Menu
      actionsRef={menuActions}
      onOpenChange={(open) => {
        if (!open) setConfirmingAuto(false);
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
        ) : confirmingAuto ? (
          <div className="flex max-w-72 flex-col gap-2 p-3">
            <p className="text-ui font-medium text-destructive">启用全自动？</p>
            <p className="text-meta text-muted-foreground">
              自动执行当前模式下的可用工具，包括工作区外操作；显式拒绝规则仍生效。{scope}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={pending}
                className="rounded-sm px-2 py-1 text-ui hover:bg-hover"
                onClick={() => setConfirmingAuto(false)}
              >
                {t('Cancel')}
              </button>
              <button
                type="button"
                disabled={pending}
                className="rounded-sm bg-destructive/10 px-2 py-1 text-ui text-destructive hover:bg-destructive/20"
                onClick={() => void apply({ ...settings, gear: 'auto' })}
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
                  disabled={pending}
                  closeOnClick={false}
                  className={composerMenuItemClass()}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>{RUNTIME_MODE_LABELS[runtimeMode]}</span>
                    <span className="text-meta text-muted-foreground">
                      {runtimeMode === 'plan'
                        ? '勘察并提交实现计划，等待批准。'
                        : '执行已批准的工作。'}
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
                if (value === 'auto') setConfirmingAuto(true);
                else void apply({ ...settings, gear: value });
              }}
            >
              {GEAR_OPTIONS.map((option) => {
                const OptionIcon = option.icon;
                return (
                  <MenuPrimitive.RadioItem
                    key={option.id}
                    value={option.id}
                    disabled={pending}
                    closeOnClick={false}
                    className={composerMenuItemClass()}
                  >
                    <OptionIcon className="size-3.5 shrink-0" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{PERMISSION_GEAR_LABELS[option.id]}</span>
                      <span className="text-meta text-muted-foreground">{option.description}</span>
                    </span>
                    <MenuPrimitive.RadioItemIndicator>
                      <span className="size-1.5 rounded-full bg-foreground" />
                    </MenuPrimitive.RadioItemIndicator>
                  </MenuPrimitive.RadioItem>
                );
              })}
            </MenuRadioGroup>
            <MenuSeparator />
            <div className="px-2 py-1.5 text-meta text-muted-foreground">{scope}</div>
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
