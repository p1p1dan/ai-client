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
  agentId: 'pi';
  label: string;
}

export interface RepositoryContextMenuModel {
  primaryActions: RepositoryMenuAction[];
  agentActions: RepositoryMenuAgentAction[];
  secondaryActions: RepositoryMenuAction[];
  destructiveAction: RepositoryMenuAction;
}

export function getEnabledRepositoryMenuAgents(): RepositoryMenuAgentAction[] {
  return [{ agentId: 'pi', label: 'Pi' }];
}

export function buildRepositoryContextMenuModel(options: {
  t: TranslateFn;
}): RepositoryContextMenuModel {
  return {
    primaryActions: [
      { key: 'open-folder', label: options.t('Open folder') },
      { key: 'copy-path', label: options.t('Copy Path') },
      { key: 'open-terminal', label: options.t('Open terminal') },
    ],
    agentActions: getEnabledRepositoryMenuAgents(),
    secondaryActions: [{ key: 'repository-settings', label: options.t('Repository Settings') }],
    destructiveAction: { key: 'remove-repository', label: options.t('Remove repository') },
  };
}
