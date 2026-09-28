/**
 * Settings → Extensions → Skills: the two skill folders and the rules a skill
 * has to follow to load.
 *
 * dsh-rebase P1-16e (decision 104 rule 3) narrowed this page to what the DSH
 * host actually reads: `<agentDir>/skills` (its `customSkillDirs`, decision
 * 101) and `~/.agents/skills` (a DSH default root). Gone with it: the prompt
 * template folder (templates are not supported, decision 103), the personal
 * `~/.pi/agent` folders (never loaded since H/19; the data-migration page is
 * where they are copied from), and the "Agent features" delegation switch
 * (decision 105: DSH sub-agents are always available). Whatever a 1.0.x user
 * left in those places is listed by the legacy-asset notice instead.
 */

import type { PiResourceSettings } from '@shared/piModelConfig';
import { FolderOpen, Library, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import { SettingsSectionBlock } from './SettingsPrimitives';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function SkillFolder({
  title,
  description,
  path,
  opening,
  onOpen,
}: {
  title: string;
  description: string;
  path: string;
  opening: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex min-w-0 items-center gap-2">
        <Library className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h4 className="min-w-0 flex-1 truncate text-ui font-semibold">{title}</h4>
      </div>
      <p className="text-meta text-muted-foreground">{description}</p>
      <Ident className="block min-w-0 break-all">{path}</Ident>
      <Button variant="outline" size="sm" onClick={onOpen} disabled={opening} className="w-fit">
        <FolderOpen className="h-4 w-4" />
        {opening ? t('Opening...') : t('Open folder')}
      </Button>
    </div>
  );
}

export function PiResourcesSettings() {
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

  const openFolder = async (root: 'app' | 'shared') => {
    setOpening(true);
    setError(null);
    try {
      if (root === 'app') await window.electronAPI.piResources.openAppSkills();
      else await window.electronAPI.piResources.openSkills();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setOpening(false);
    }
  };

  return (
    <SettingsSectionBlock
      title={t('Skills')}
      description={t(
        'Chats load skills from these two folders, and from .dsh/skills and .agents/skills at the root of the project’s repository.'
      )}
    >
      {error && (
        <div
          role="alert"
          className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      {!snapshot ? (
        <p className="text-ui text-muted-foreground">{t('Loading resource settings...')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <SkillFolder
            title={t('This app’s skills')}
            description={t('Your own skills for chats in this app.')}
            path={snapshot.paths.appSkills}
            opening={opening}
            onOpen={() => void openFolder('app')}
          />
          <SkillFolder
            title={t('Shared skills')}
            description={t('Also read by other agents that follow the Agent Skills convention.')}
            path={snapshot.paths.sharedSkills}
            opening={opening}
            onOpen={() => void openFolder('shared')}
          />
        </div>
      )}

      <div className="space-y-1">
        <h4 className="text-ui font-semibold">{t('How a skill is found')}</h4>
        <ul className="list-disc space-y-1 pl-5 text-meta text-muted-foreground">
          <li>
            {t(
              'Each skill is one entry directly inside a skills folder: <name>/SKILL.md, or a single <name>.md. Deeper files are not scanned.'
            )}
          </li>
          <li>
            {t(
              'Its frontmatter needs name and description. The name uses lowercase letters, digits and dashes only, such as code-review.'
            )}
          </li>
          <li>
            {t(
              'Type /<name> anywhere in a message to use a skill. Add disable-model-invocation: true to keep the model from using it on its own.'
            )}
          </li>
        </ul>
      </div>
    </SettingsSectionBlock>
  );
}
