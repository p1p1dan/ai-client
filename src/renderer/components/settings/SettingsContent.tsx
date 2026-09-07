import {
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
import { AISettings } from './AISettings';
import { AppearanceSettings } from './AppearanceSettings';
import type { SettingsCategory } from './constants';
import { EditorSettings } from './EditorSettings';
import { GeneralSettings } from './GeneralSettings';
import { GitSettings } from './GitSettings';
import { KeybindingsSettings } from './KeybindingsSettings';
import { NetworkSettings } from './NetworkSettings';
import { PermissionPolicySettings } from './PermissionPolicySettings';
import { PiModelManagementSettings } from './PiModelManagementSettings';
import { PiResourcesSettings } from './PiResourcesSettings';
import { RemoteSettings } from './RemoteSettings';
import { SettingsPageShell } from './SettingsPrimitives';
import { TerminalAppearanceSettings } from './TerminalAppearanceSettings';
import { TerminalSettings } from './TerminalSettings';
import { WebInspectorSettings } from './WebInspectorSettings';

interface SettingsContentProps {
  activeCategory?: SettingsCategory;
  onCategoryChange?: (category: SettingsCategory) => void;
  repoPath?: string;
}

export function SettingsContent({
  activeCategory: controlledCategory,
  onCategoryChange,
  repoPath,
}: SettingsContentProps) {
  const { t } = useI18n();
  const [internalCategory, setInternalCategory] = useState<SettingsCategory>('general');
  const activeCategory = controlledCategory ?? internalCategory;
  const categories: Array<{ id: SettingsCategory; icon: ElementType; label: string }> = [
    { id: 'general', icon: Settings, label: t('General') },
    { id: 'appearance', icon: Palette, label: t('Appearance') },
    { id: 'terminal', icon: Terminal, label: t('Terminal') },
    { id: 'editor', icon: FileCode, label: t('Editor') },
    { id: 'git', icon: GitBranch, label: t('Git') },
    { id: 'pi', icon: Sparkles, label: t('Pi') },
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
              <PiModelManagementSettings />
              <PermissionPolicySettings repoPath={repoPath} />
              <PiResourcesSettings />
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
              <WebInspectorSettings />
            </>
          )}
        </SettingsPageShell>
      </div>
    </div>
  );
}
