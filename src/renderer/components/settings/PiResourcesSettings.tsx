/**
 * Settings → Extensions → Skills: the folders each engine reads skills from,
 * grouped by engine, with the how-to rules behind a help tip.
 *
 * Pi chats (the DSH host) read `<agentDir>/skills` (its `customSkillDirs`,
 * decision 101), `~/.agents/skills` and the project's `.dsh/skills` and
 * `.agents/skills`. Claude chats (the Claude Agent SDK host) read
 * `CLAUDE_CONFIG_DIR/skills` and the project's `.claude/skills`. Gone since
 * P1-16e (decision 104 rule 3): the prompt template folder (decision 103),
 * the personal `~/.pi/agent` folders, and the delegation switch (decision
 * 105); the legacy-asset notice lists what a 1.0.x user left there.
 */

import type { PiResourceSettings } from '@shared/piModelConfig';
import { FolderOpen, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import {
  SETTINGS_CARD_FRAME_CLASS,
  SettingsHelpTip,
  SettingsSectionBlock,
} from './SettingsPrimitives';

type FolderRoot = 'app' | 'shared' | 'claude';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Project-relative skill folders, joined with the separator the repo path already uses. */
export function projectSkillPaths(repoPath: string, dirs: string[]): string {
  const sep = repoPath.includes('\\') && !repoPath.includes('/') ? '\\' : '/';
  const root = repoPath.replace(/[\\/]+$/, '');
  return dirs
    .map((dir) => dir.replaceAll('/', sep))
    .map((dir, index) => (index === 0 ? `${root}${sep}${dir}` : dir))
    .join('  ');
}

function FolderRow({
  label,
  path,
  opening,
  onOpen,
}: {
  label: string;
  path: string | null;
  opening?: boolean;
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
      <span className="w-16 shrink-0 text-ui text-muted-foreground">{label}</span>
      {path ? (
        <Ident className="min-w-0 flex-1 truncate" title={path}>
          {path}
        </Ident>
      ) : (
        <span className="min-w-0 flex-1 truncate text-small text-muted-foreground">
          {t('Shown once a repository is open')}
        </span>
      )}
      {path && onOpen && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onOpen}
          disabled={opening}
        >
          <FolderOpen />
          {t('Open')}
        </Button>
      )}
    </div>
  );
}

function EngineGroup({ engine, title }: { engine: string; title: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 pt-1">
      <Badge variant="secondary" className="shrink-0">
        {engine}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-small text-muted-foreground">{title}</span>
    </div>
  );
}

export function PiResourcesSettings({ repoPath }: { repoPath?: string }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<PiResourceSettings | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await window.electronAPI.piResources.getSettings());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openFolder = async (root: FolderRoot) => {
    setOpening(true);
    setError(null);
    try {
      if (root === 'app') await window.electronAPI.piResources.openAppSkills();
      else if (root === 'claude') await window.electronAPI.piResources.openClaudeSkills();
      else await window.electronAPI.piResources.openSkills();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setOpening(false);
    }
  };

  return (
    <SettingsSectionBlock
      bare
      title={
        <span className="inline-flex items-center gap-1">
          {t('Skills')}
          <SettingsHelpTip label={t('How to write a skill')}>
            <p>
              {t(
                'Pi chats: <name>/SKILL.md or <name>.md directly inside a skills folder. Its frontmatter needs name and description; the name uses lowercase letters, digits and dashes only. Type /<name> in a message to use it; add disable-model-invocation: true to keep the model from using it on its own.'
              )}
            </p>
            <p>
              {t(
                'Claude chats follow Claude Code’s rules: <name>/SKILL.md, plus the skills Claude comes with.'
              )}
            </p>
          </SettingsHelpTip>
        </span>
      }
    >
      {error && (
        <Alert variant="error">
          <TriangleAlert />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!snapshot ? (
        <p className="text-ui text-muted-foreground">{t('Loading resource settings...')}</p>
      ) : (
        <div className="space-y-2">
          <EngineGroup engine="Pi" title={t('Pi chats read these folders')} />
          <div className={SETTINGS_CARD_FRAME_CLASS}>
            <FolderRow
              label={t('This app')}
              path={snapshot.paths.appSkills}
              opening={opening}
              onOpen={() => void openFolder('app')}
            />
            <FolderRow
              label={t('Shared')}
              path={snapshot.paths.sharedSkills}
              opening={opening}
              onOpen={() => void openFolder('shared')}
            />
            <FolderRow
              label={t('Project')}
              path={
                repoPath ? projectSkillPaths(repoPath, ['.dsh/skills', '.agents/skills']) : null
              }
            />
          </div>
          <EngineGroup engine="Claude" title={t('Claude chats read these folders')} />
          <div className={SETTINGS_CARD_FRAME_CLASS}>
            <FolderRow
              label={t('This app')}
              path={snapshot.paths.claudeSkills}
              opening={opening}
              onOpen={() => void openFolder('claude')}
            />
            <FolderRow
              label={t('Project')}
              path={repoPath ? projectSkillPaths(repoPath, ['.claude/skills']) : null}
            />
          </div>
        </div>
      )}
    </SettingsSectionBlock>
  );
}
