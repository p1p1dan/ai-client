import { FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

// Parse shell arguments string, supporting single/double quotes for paths with spaces

export function GitSettings() {
  const {
    gitAutoFetchEnabled,
    setGitAutoFetchEnabled,
    defaultWorktreePath,
    setDefaultWorktreePath,

    autoCreateSessionOnActivate,
    setAutoCreateSessionOnActivate,

    gitClone,
    setGitClone,
    addHostMapping,
    removeHostMapping,
    updateHostMapping,
  } = useSettingsStore();
  const { t } = useI18n();

  const [hostMappingDialogOpen, setHostMappingDialogOpen] = React.useState(false);
  const [editingMapping, setEditingMapping] = React.useState<{
    pattern: string;
    dirname: string;
  } | null>(null);
  const [mappingPattern, setMappingPattern] = React.useState('');
  const [mappingDirname, setMappingDirname] = React.useState('');
  const [mappingError, setMappingError] = React.useState('');

  const handleEditHostMapping = React.useCallback(
    (mapping: { pattern: string; dirname: string }) => {
      setEditingMapping(mapping);
      setMappingPattern(mapping.pattern);
      setMappingDirname(mapping.dirname);
      setMappingError('');
      setHostMappingDialogOpen(true);
    },
    []
  );
  const handleDeleteHostMapping = React.useCallback(
    (pattern: string) => {
      removeHostMapping(pattern);
    },
    [removeHostMapping]
  );
  const handleSaveHostMapping = React.useCallback(() => {
    setMappingError('');

    // Validate
    if (!mappingPattern.trim()) {
      setMappingError(t('Pattern is required'));
      return;
    }
    if (!mappingDirname.trim()) {
      setMappingError(t('Directory name is required'));
      return;
    }

    // Check for duplicate pattern
    const existing = gitClone.hostMappings.find(
      (m) => m.pattern === mappingPattern.trim() && m.pattern !== editingMapping?.pattern
    );
    if (existing) {
      setMappingError(t('Pattern already exists'));
      return;
    }

    const newMapping = {
      pattern: mappingPattern.trim(),
      dirname: mappingDirname.trim(),
    };

    if (editingMapping) {
      updateHostMapping(editingMapping.pattern, newMapping);
    } else {
      addHostMapping(newMapping);
    }

    setHostMappingDialogOpen(false);
    setEditingMapping(null);
    setMappingPattern('');
    setMappingDirname('');
  }, [
    mappingPattern,
    mappingDirname,
    editingMapping,
    gitClone.hostMappings,
    t,
    addHostMapping,
    updateHostMapping,
  ]);

  return (
    <div className="space-y-6">
      <SettingsSectionBlock
        title={t('Worktree')}
        description={t('Git worktree save location settings')}
      >
        <SettingsRow>
          <span className="text-sm font-medium">{t('Auto-create session')}</span>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('Automatically create Agent/Terminal session when activating a worktree')}
            </p>
            <Switch
              checked={autoCreateSessionOnActivate}
              onCheckedChange={setAutoCreateSessionOnActivate}
            />
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium mt-2">{t('Save location')}</span>
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <Input
                value={defaultWorktreePath}
                onChange={(e) => setDefaultWorktreePath(e.target.value)}
                placeholder="~/JYWAI/workspaces"
                className="flex-1"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={async () => {
                  const result = await window.electronAPI.dialog.openDirectory();
                  if (result) {
                    setDefaultWorktreePath(result);
                  }
                }}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('Default directory for new worktrees. Leave empty to use ~/JYWAI/workspaces')}
            </p>
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Git auto refresh')}</span>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('Automatically fetch and refresh git status')}
            </p>
            <Switch checked={gitAutoFetchEnabled} onCheckedChange={setGitAutoFetchEnabled} />
          </div>
        </SettingsRow>
      </SettingsSectionBlock>
      <SettingsSectionBlock
        title={t('Git Clone')}
        description={t('Settings for cloning remote Git repositories')}
      >
        <SettingsRow>
          <span className="text-sm font-medium mt-2">{t('Base directory')}</span>
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <Input
                value={gitClone.baseDir}
                onChange={(e) => setGitClone({ baseDir: e.target.value })}
                placeholder="~/JYWAI/repos"
                className="flex-1"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={async () => {
                  const result = await window.electronAPI.dialog.openDirectory();
                  if (result) {
                    setGitClone({ baseDir: result });
                  }
                }}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('Base directory for cloned repositories. Leave empty to use ~/JYWAI/repos')}
            </p>
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Organized structure')}</span>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('Clone to organized structure (baseDir/host/owner/repo) or flat (baseDir/repo)')}
            </p>
            <Switch
              checked={gitClone.useOrganizedStructure}
              onCheckedChange={(checked) => setGitClone({ useOrganizedStructure: checked })}
            />
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium mt-2">{t('Repository domains')}</span>
          <div className="space-y-1.5">
            <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium">{t('Repository domains')}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setHostMappingDialogOpen(true)}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  {t('Add')}
                </Button>
              </div>
              <div className="space-y-1">
                {gitClone.hostMappings.length === 0 ? (
                  <div className="text-xs text-muted-foreground py-1">
                    {t('No mappings configured')}
                  </div>
                ) : (
                  gitClone.hostMappings.map((mapping) => (
                    <div key={mapping.pattern} className="flex items-center gap-2 group py-1">
                      <span className="font-mono text-xs flex-1 truncate">{mapping.pattern}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="font-mono text-xs flex-1 truncate">{mapping.dirname}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleEditHostMapping(mapping)}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
                        onClick={() => handleDeleteHostMapping(mapping.pattern)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('Host-to-directory mappings for organizing cloned repositories')}
            </p>
          </div>
        </SettingsRow>
        <Dialog open={hostMappingDialogOpen} onOpenChange={setHostMappingDialogOpen}>
          <DialogPopup zIndexLevel="nested">
            <DialogHeader>
              <DialogTitle>
                {editingMapping ? t('Edit repository domain') : t('Add repository domain')}
              </DialogTitle>
              <DialogDescription>
                {t(
                  'Map a Git repository domain to a directory name for organizing cloned repositories'
                )}
              </DialogDescription>
            </DialogHeader>

            <DialogPanel className="space-y-4">
              <Field>
                <FieldLabel>{t('Domain pattern')}</FieldLabel>
                <Input
                  value={mappingPattern}
                  onChange={(e) => setMappingPattern(e.target.value)}
                  placeholder="gitlab.example.com"
                  className="font-mono"
                />
                <FieldDescription>
                  {t('Git host domain (e.g., gitlab.example.com or *.example.com)')}
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel>{t('Directory name')}</FieldLabel>
                <Input
                  value={mappingDirname}
                  onChange={(e) => setMappingDirname(e.target.value)}
                  placeholder="gitlab"
                  className="font-mono"
                />
                <FieldDescription>
                  {t('Directory name for this host (e.g., gitlab, company-gitlab)')}
                </FieldDescription>
              </Field>

              {mappingError && <div className="text-sm text-destructive">{mappingError}</div>}
            </DialogPanel>

            <DialogFooter variant="bare">
              <Button variant="outline" onClick={() => setHostMappingDialogOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button onClick={handleSaveHostMapping}>{t('Save')}</Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      </SettingsSectionBlock>
    </div>
  );
}
