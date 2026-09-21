import {
  ArrowRightLeft,
  Blocks,
  FileCode,
  GitBranch,
  Globe,
  Keyboard,
  Palette,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { type ElementType, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { AdvancedSettings } from './AdvancedSettings';
import { AgentMigrationSettings } from './AgentMigrationSettings';
import { AISettings } from './AISettings';
import { AppearanceSettings } from './AppearanceSettings';
import { ConversationImportSettings } from './ConversationImportSettings';
import type { SettingsCategory } from './constants';
import { EditorSettings } from './EditorSettings';
import { GeneralSettings } from './GeneralSettings';
import { GitSettings } from './GitSettings';
import { KeybindingsSettings } from './KeybindingsSettings';
import { NetworkSettings } from './NetworkSettings';
import { PermissionPolicySettings } from './PermissionPolicySettings';
import { PiModelManagementSettings } from './PiModelManagementSettings';
import { PiPluginsSettings } from './PiPluginsSettings';
import { PiResourcesSettings } from './PiResourcesSettings';
import { PiSubagentsSettings } from './PiSubagentsSettings';
import { RemoteSettings } from './RemoteSettings';
import { SettingsPageShell } from './SettingsPrimitives';
import { TerminalAppearanceSettings } from './TerminalAppearanceSettings';
import { TerminalSettings } from './TerminalSettings';
import { UserProvidersSettings } from './UserProvidersSettings';
import { WebInspectorSettings } from './WebInspectorSettings';

interface SettingsContentProps {
  activeCategory?: SettingsCategory;
  onCategoryChange?: (category: SettingsCategory) => void;
  repoPath?: string;
  /** H/21 C3 — see `SettingsDialog`'s prop of the same name. */
  onRegisterRepository?: (path: string) => boolean;
}

export function SettingsContent({
  activeCategory: controlledCategory,
  onCategoryChange,
  repoPath,
  onRegisterRepository,
}: SettingsContentProps) {
  const { t } = useI18n();
  const [internalCategory, setInternalCategory] = useState<SettingsCategory>('general');
  const activeCategory = controlledCategory ?? internalCategory;
  /**
   * The Pi page used to stack eight sections — models, providers, permission
   * policy, plugins, resources, subagents, agent-directory migration and
   * conversation import — on one scroll. Three of them are about extending the
   * agent and two are one-off "bring data in" operations, so they are their own
   * pages now; `pi` keeps what a user changes to make a chat work at all.
   *
   * The permission policy moved to `advanced` instead: it stays fully editable
   * (it writes the global scope file every chat reads at start-up), but it is an
   * expert surface next to the per-turn permission gear in the composer, and on
   * the Pi page it was the single largest thing between a user and their models.
   */
  const categories: Array<{ id: SettingsCategory; icon: ElementType; label: string }> = [
    { id: 'general', icon: Settings, label: t('General') },
    { id: 'appearance', icon: Palette, label: t('Appearance') },
    { id: 'terminal', icon: Terminal, label: t('Terminal') },
    { id: 'editor', icon: FileCode, label: t('Editor') },
    { id: 'git', icon: GitBranch, label: t('Git') },
    { id: 'pi', icon: Sparkles, label: t('Pi') },
    { id: 'extensions', icon: Blocks, label: t('Extensions') },
    { id: 'migration', icon: ArrowRightLeft, label: t('Data migration') },
    { id: 'keybindings', icon: Keyboard, label: t('Keybindings') },
    { id: 'network', icon: Globe, label: t('Network') },
    { id: 'advanced', icon: SlidersHorizontal, label: t('Advanced') },
  ];
  return (
    <div className="flex h-full min-w-0 flex-col sm:flex-row">
      <nav
        aria-label={t('Settings')}
        className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-40 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r"
      >
        {categories.map((category) => (
          <button
            type="button"
            key={category.id}
            aria-current={activeCategory === category.id ? 'page' : undefined}
            onClick={() => {
              setInternalCategory(category.id);
              onCategoryChange?.(category.id);
            }}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors sm:w-full',
              activeCategory === category.id
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            <category.icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 whitespace-nowrap text-left">{category.label}</span>
          </button>
        ))}
      </nav>
      <div key={activeCategory} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <SettingsPageShell
          title={categories.find((category) => category.id === activeCategory)!.label}
        >
          {activeCategory === 'general' && <GeneralSettings />}
          {activeCategory === 'appearance' && <AppearanceSettings />}
          {activeCategory === 'terminal' && (
            <>
              <TerminalSettings />
              <TerminalAppearanceSettings />
            </>
          )}
          {activeCategory === 'editor' && <EditorSettings />}
          {activeCategory === 'git' && (
            <>
              <GitSettings />
              <AISettings />
            </>
          )}
          {activeCategory === 'pi' && (
            <>
              <UserProvidersSettings />
              <PiModelManagementSettings />
            </>
          )}
          {activeCategory === 'extensions' && (
            <>
              <PiPluginsSettings />
              <PiResourcesSettings />
              <PiSubagentsSettings />
            </>
          )}
          {activeCategory === 'migration' && (
            <>
              <AgentMigrationSettings />
              <ConversationImportSettings onRegisterRepository={onRegisterRepository} />
            </>
          )}
          {activeCategory === 'keybindings' && <KeybindingsSettings />}
          {activeCategory === 'network' && (
            <>
              <NetworkSettings />
              <RemoteSettings />
            </>
          )}
          {activeCategory === 'advanced' && (
            <>
              <AdvancedSettings />
              <PermissionPolicySettings repoPath={repoPath} />
              <WebInspectorSettings />
            </>
          )}
        </SettingsPageShell>
      </div>
    </div>
  );
}
