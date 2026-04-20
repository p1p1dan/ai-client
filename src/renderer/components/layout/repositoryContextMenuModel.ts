import type { CustomAgent } from '@shared/types';
import { BUILTIN_AGENTS } from '@/components/settings/constants';
import type { AgentDetectionStatus, AgentSettings } from '@/stores/settings/types';
import { AGENT_INFO } from '@/utils/agentSession';

type TranslateFn = (key: string) => string;

export type RepositoryMenuActionKey =
  | 'open-folder'
  | 'copy-path'
  | 'open-terminal'
  | 'repository-settings'
  | 'remove-repository';

export interface RepositoryMenuAction {
  key: RepositoryMenuActionKey;
  label: string;
}

export interface RepositoryMenuAgentAction {
  agentId: string;
  label: string;
}

export interface RepositoryContextMenuModel {
  primaryActions: RepositoryMenuAction[];
  agentActions: RepositoryMenuAgentAction[];
  secondaryActions: RepositoryMenuAction[];
  destructiveAction: RepositoryMenuAction;
}

interface BuildRepositoryContextMenuModelOptions {
  t: TranslateFn;
  agentSettings: AgentSettings;
  customAgents: CustomAgent[];
  agentDetectionStatus: AgentDetectionStatus;
  hapiEnabled: boolean;
}

function getBaseAgentId(agentId: string): string {
  if (agentId.endsWith('-hapi')) return agentId.slice(0, -5);
  if (agentId.endsWith('-happy')) return agentId.slice(0, -6);
  return agentId;
}

function getAgentEnvironmentRank(agentId: string): number {
  if (agentId.endsWith('-hapi')) return 1;
  if (agentId.endsWith('-happy')) return 2;
  return 0;
}

export function getEnabledRepositoryMenuAgents({
  agentSettings,
  customAgents,
  agentDetectionStatus,
  hapiEnabled,
}: Omit<BuildRepositoryContextMenuModelOptions, 't'>): RepositoryMenuAgentAction[] {
  const enabledAgentIds = Object.keys(agentSettings).filter((id) => agentSettings[id]?.enabled);
  const builtinAgentOrder = new Map<string, number>();
  const customAgentIds = new Set(customAgents.map((agent) => agent.id));

  for (let i = 0; i < BUILTIN_AGENTS.length; i++) {
    builtinAgentOrder.set(BUILTIN_AGENTS[i], i);
  }

  const candidates = enabledAgentIds.filter((agentId) => {
    if (agentSettings[agentId]?.isDefault) return true;

    if (agentId.endsWith('-hapi')) {
      if (!hapiEnabled) return false;
      return agentDetectionStatus[getBaseAgentId(agentId)]?.installed ?? false;
    }

    if (agentId.endsWith('-happy')) {
      return agentDetectionStatus[getBaseAgentId(agentId)]?.installed ?? false;
    }

    return agentDetectionStatus[agentId]?.installed ?? false;
  });

  return candidates
    .sort((a, b) => {
      const aIsDefault = agentSettings[a]?.isDefault ?? false;
      const bIsDefault = agentSettings[b]?.isDefault ?? false;
      if (aIsDefault !== bIsDefault) return aIsDefault ? -1 : 1;

      const aBaseId = getBaseAgentId(a);
      const bBaseId = getBaseAgentId(b);
      const aIsCustom = customAgentIds.has(aBaseId);
      const bIsCustom = customAgentIds.has(bBaseId);
      if (aIsCustom !== bIsCustom) return aIsCustom ? 1 : -1;

      const aBuiltinIndex = builtinAgentOrder.get(aBaseId) ?? Number.MAX_SAFE_INTEGER;
      const bBuiltinIndex = builtinAgentOrder.get(bBaseId) ?? Number.MAX_SAFE_INTEGER;
      if (aBuiltinIndex !== bBuiltinIndex) return aBuiltinIndex - bBuiltinIndex;

      const aEnvironmentRank = getAgentEnvironmentRank(a);
      const bEnvironmentRank = getAgentEnvironmentRank(b);
      if (aEnvironmentRank !== bEnvironmentRank) return aEnvironmentRank - bEnvironmentRank;

      return a.localeCompare(b);
    })
    .map((agentId) => {
      const isHapi = agentId.endsWith('-hapi');
      const isHappy = agentId.endsWith('-happy');
      const baseId = getBaseAgentId(agentId);
      const customAgent = customAgents.find((agent) => agent.id === baseId);
      const baseName = customAgent?.name ?? AGENT_INFO[baseId]?.name ?? baseId;
      const label = isHapi ? `${baseName} (Hapi)` : isHappy ? `${baseName} (Happy)` : baseName;

      return {
        agentId,
        label,
      };
    });
}

export function buildRepositoryContextMenuModel(
  options: BuildRepositoryContextMenuModelOptions
): RepositoryContextMenuModel {
  const { t, ...agentOptions } = options;

  return {
    primaryActions: [
      { key: 'open-folder', label: t('Open folder') },
      { key: 'copy-path', label: t('Copy Path') },
      { key: 'open-terminal', label: t('Open terminal') },
    ],
    agentActions: getEnabledRepositoryMenuAgents(agentOptions),
    secondaryActions: [{ key: 'repository-settings', label: t('Repository Settings') }],
    destructiveAction: { key: 'remove-repository', label: t('Remove repository') },
  };
}
