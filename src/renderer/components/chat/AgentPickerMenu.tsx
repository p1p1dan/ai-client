import { Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { AGENT_INFO } from '@/utils/agentSession';

interface AgentPickerMenuProps {
  show: boolean;
  onClose: () => void;
  onSelectAgent: (agentId: string, agentCommand: string) => void;
  position?: 'top' | 'bottom';
  align?: 'left' | 'right';
}

export function AgentPickerMenu({
  show,
  onClose,
  onSelectAgent,
  position = 'bottom',
  align = 'right',
}: AgentPickerMenuProps) {
  const { t } = useI18n();
  const { agentSettings, agentDetectionStatus, customAgents, hapiSettings } = useSettingsStore();
  const [installedAgents, setInstalledAgents] = useState<Set<string>>(new Set());

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      const isHapi = agentId.endsWith('-hapi');
      const isHappy = agentId.endsWith('-happy');
      const baseId = isHapi ? agentId.slice(0, -5) : isHappy ? agentId.slice(0, -6) : agentId;

      const customAgent = customAgents.find((a) => a.id === baseId);
      const info = customAgent
        ? { name: customAgent.name, command: customAgent.command }
        : AGENT_INFO[baseId] || { name: 'Claude', command: 'claude' };

      onSelectAgent(agentId, info.command);
      onClose();
    },
    [customAgents, onClose, onSelectAgent]
  );

  const handleOpenSettings = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
      window.dispatchEvent(new CustomEvent('open-settings-agent'));
    },
    [onClose]
  );

  // Build installed agents set from persisted detection status
  useEffect(() => {
    const enabledAgentIds = Object.keys(agentSettings).filter((id) => agentSettings[id]?.enabled);
    const newInstalled = new Set<string>();

    for (const agentId of enabledAgentIds) {
      // Default agent is always considered installed (no detection needed)
      // This ensures the default agent shows in menu even if user never ran detection
      if (agentSettings[agentId]?.isDefault) {
        newInstalled.add(agentId);
        continue;
      }

      // Handle Hapi agents: check if base CLI is detected as installed
      if (agentId.endsWith('-hapi')) {
        if (!hapiSettings.enabled) continue;
        const baseId = agentId.slice(0, -5);
        if (agentDetectionStatus[baseId]?.installed) {
          newInstalled.add(agentId);
        }
        continue;
      }

      // Handle Happy agents: check if base CLI is detected as installed
      if (agentId.endsWith('-happy')) {
        const baseId = agentId.slice(0, -6);
        if (agentDetectionStatus[baseId]?.installed) {
          newInstalled.add(agentId);
        }
        continue;
      }

      // Regular agents: use persisted detection status
      if (agentDetectionStatus[agentId]?.installed) {
        newInstalled.add(agentId);
      }
    }

    setInstalledAgents(newInstalled);
  }, [agentSettings, agentDetectionStatus, hapiSettings.enabled]);

  // Filter to only enabled AND installed agents (includes WSL/Hapi variants)
  // For Hapi agents, also check if hapi is still enabled
  const enabledAgents = useMemo(() => {
    return Object.keys(agentSettings).filter((id) => {
      if (!agentSettings[id]?.enabled || !installedAgents.has(id)) return false;
      if (id.endsWith('-hapi') && !hapiSettings.enabled) return false;
      return true;
    });
  }, [agentSettings, installedAgents, hapiSettings.enabled]);

  if (!show) return null;

  return (
    <div
      className={cn(
        'absolute z-50 min-w-32',
        align === 'left' ? 'left-[-10px]' : 'right-[-10px]',
        position === 'top' ? 'bottom-full pb-1' : 'top-full pt-1'
      )}
    >
      <div className="rounded-lg border bg-popover p-1 shadow-lg">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs text-muted-foreground">{t('Select Agent')}</span>
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <button
                type="button"
                onClick={handleOpenSettings}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipPopup side="right">{t('Manage Agents')}</TooltipPopup>
          </Tooltip>
        </div>

        {[...enabledAgents]
          .sort((a, b) => {
            const aDefault = agentSettings[a]?.isDefault ? 1 : 0;
            const bDefault = agentSettings[b]?.isDefault ? 1 : 0;
            return bDefault - aDefault;
          })
          .map((agentId) => {
            const isHapi = agentId.endsWith('-hapi');
            const isHappy = agentId.endsWith('-happy');
            const baseId = isHapi ? agentId.slice(0, -5) : isHappy ? agentId.slice(0, -6) : agentId;
            const customAgent = customAgents.find((a) => a.id === baseId);

            const baseName = customAgent?.name ?? AGENT_INFO[baseId]?.name ?? baseId;
            const name = isHapi
              ? `${baseName} (Hapi)`
              : isHappy
                ? `${baseName} (Happy)`
                : baseName;

            const isDefault = agentSettings[agentId]?.isDefault;

            return (
              <button
                type="button"
                key={agentId}
                onClick={() => handleSelectAgent(agentId)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground whitespace-nowrap"
              >
                <span>{name}</span>
                {isDefault && (
                  <span className="shrink-0 text-xs text-muted-foreground">{t('(default)')}</span>
                )}
              </button>
            );
          })}
      </div>
    </div>
  );
}
