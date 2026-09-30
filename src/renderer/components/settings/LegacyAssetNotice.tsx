/**
 * dsh-rebase P1-16e (decision 104) — "these no longer apply", shown once.
 *
 * Main finds what a 1.0.x user wrote that this build no longer loads (custom
 * sub-agents, prompt templates, the user-layer instruction file, `mcp.json`,
 * skills DSH rejects, an explicit "delegation off"); this file renders it.
 *
 *  - `LegacyAssetList` is the list itself, shared by the startup dialog and the
 *    permanent entry in Settings → Extensions (`LegacyAssetsSettings`).
 *  - `LegacyAssetNoticePrompt` is the startup dialog. It opens by itself only
 *    when there is something to list and the notice was never seen; closing it
 *    in any way records that, because the list is advice with a permanent home
 *    in Settings, not an offer the user still has to answer.
 *
 * Read-only throughout: nothing here changes a user file, and the one write is
 * Main's "seen" settings key.
 */

import {
  type LegacyAssetNoticeState,
  type LegacyAssetReport,
  type LegacySkillIssue,
  shouldShowLegacyAssetNotice,
} from '@shared/legacyAssets';
import { Bot, FileText, FolderOpen, Library, Plug, ScrollText, Split } from 'lucide-react';
import { type ElementType, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
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
import { Ident } from '@/components/ui/ident';
import { useModalQueueSlot } from '@/hooks/useModalQueueSlot';
import { type TFunction, useI18n } from '@/i18n';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Spelled as literal `t()` calls so the catalog coverage scan sees every key. */
function skillIssueLabel(issue: LegacySkillIssue, t: TFunction): string {
  switch (issue) {
    case 'missing-name':
      return t('No name in its frontmatter');
    case 'invalid-name':
      return t('Name is not lowercase letters, digits and dashes');
    case 'nested':
      return t('Too deep inside the folder');
    case 'unscanned-root':
      return t('In a folder this version does not scan');
  }
}

function Category({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: ElementType;
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h4 className="min-w-0 flex-1 truncate text-ui font-semibold">{title}</h4>
      </div>
      <p className="text-meta text-muted-foreground">{hint}</p>
      {children && <ul className="divide-y rounded-md border">{children}</ul>}
    </section>
  );
}

function Item({ label, detail, path }: { label?: string; detail?: string; path: string }) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
      {label && <span className="min-w-0 truncate text-ui font-medium">{label}</span>}
      {detail && <span className="text-meta text-muted-foreground">{detail}</span>}
      <Ident className="min-w-0 break-all text-muted-foreground">{path}</Ident>
    </li>
  );
}

export function LegacyAssetList({ report }: { report: LegacyAssetReport }) {
  const { t } = useI18n();
  return (
    <div className="space-y-5">
      {report.subagents.length > 0 && (
        <Category
          icon={Bot}
          title={t('Custom sub-agents')}
          hint={t(
            'Sub-agent definition files are no longer loaded. Chats use the built-in sub-agents, which are always available.'
          )}
        >
          {report.subagents.map((entry) => (
            <Item key={entry.path} label={entry.name} path={entry.path} />
          ))}
        </Category>
      )}

      {report.promptTemplates.length > 0 && (
        <Category
          icon={FileText}
          title={t('Prompt templates')}
          hint={t(
            'Templates are no longer expanded. To keep one, rewrite it as a skill: save it as {{path}}/<name>/SKILL.md with name and description in its frontmatter, and add disable-model-invocation: true if only you should trigger it. Then type /<name> in a message.',
            { path: report.skillsTarget }
          )}
        >
          {report.promptTemplates.map((entry) => (
            <Item key={entry.path} label={`/${entry.name}`} path={entry.path} />
          ))}
        </Category>
      )}

      {report.instructionFile && (
        <Category
          icon={ScrollText}
          title={t('Personal instruction file')}
          hint={t(
            'The previous version also read this file as your personal rules; this version does not. Put the rules you still want in {{path}}.',
            { path: report.instructionTarget }
          )}
        >
          <Item path={report.instructionFile} />
        </Category>
      )}

      {report.mcpConfigs.length > 0 && (
        <Category
          icon={Plug}
          title={t('MCP servers')}
          hint={t(
            'This version does not support MCP yet, so these servers are not started. The files are left as they are.'
          )}
        >
          {report.mcpConfigs.map((entry) => (
            <Item
              key={entry.path}
              label={
                entry.unreadable
                  ? t('Could not be read')
                  : entry.servers.length > 0
                    ? entry.servers.join(', ')
                    : t('No servers listed')
              }
              path={entry.path}
            />
          ))}
        </Category>
      )}

      {report.skills.length > 0 && (
        <Category
          icon={Library}
          title={t('Skills that will not load')}
          hint={t(
            'A skill loads when it is <name>/SKILL.md or <name>.md directly inside a skills folder, and its frontmatter has a description and a name made of lowercase letters, digits and dashes.'
          )}
        >
          {report.skills.map((entry) => (
            <Item
              key={entry.path}
              label={entry.name}
              detail={entry.issues.map((issue) => skillIssueLabel(issue, t)).join(' · ')}
              path={entry.path}
            />
          ))}
        </Category>
      )}

      {report.delegationSwitchOff && (
        <Category
          icon={Split}
          title={t('Sub-agent delegation')}
          hint={t(
            'You had turned sub-agent delegation off. In this version sub-agents are always available.'
          )}
        />
      )}
    </div>
  );
}

/** `<agentDir>` — where `AGENTS.md` and `skills/` go now. */
export async function openLegacyAgentFolder(): Promise<string | null> {
  try {
    await window.electronAPI.legacyAssets.openAgentDir();
    return null;
  } catch (cause) {
    return messageOf(cause);
  }
}

/**
 * The startup dialog. `repoPath` is the workspace open right now: project
 * files (`.pi/prompts`, `.pi/mcp.json`, project skills) are only looked for
 * there (decision 104 rule 2).
 *
 * The workspace is restored asynchronously, and on a first start it may
 * arrive well after the user level has been found (P1-7e e5, decision 143):
 * the dialog opens on what the first check found, and until the user closes
 * it every workspace that arrives is checked again and its answer replaces
 * the list — the same dialog, now with that workspace's project files. Once
 * it has been closed, or when it was seen on an earlier launch, nothing is
 * checked again this launch (decision 116 rule 13).
 */
export function LegacyAssetNoticePrompt({ repoPath }: { repoPath?: string }) {
  const { t } = useI18n();
  const [report, setReport] = useState<LegacyAssetReport | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Answered for this launch: seen on an earlier one, or closed in this one.
  // Never asks again. Shown but not yet closed is NOT answered: a workspace
  // restored after the first check still adds its project files.
  const answered = useRef(false);

  useEffect(() => {
    if (answered.current) return;
    let cancelled = false;
    void (async () => {
      let state: LegacyAssetNoticeState;
      try {
        state = await window.electronAPI.legacyAssets.inspect(repoPath ? { cwd: repoPath } : {});
      } catch {
        // A scan that failed is not a notice, and it takes nothing off one
        // already open; the next launch asks again.
        return;
      }
      if (cancelled || answered.current) return;
      if (state.seen) {
        answered.current = true;
        return;
      }
      // Nothing here (no user level, and this workspace has nothing either):
      // keep whatever an earlier workspace put in the open dialog.
      if (!shouldShowLegacyAssetNotice(state)) return;
      setReport(state.report);
      setOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const canShow = useModalQueueSlot('legacyAssetNotice', open);

  const close = useCallback(() => {
    answered.current = true;
    setOpen(false);
    // A failed write only means the notice comes back next launch.
    void window.electronAPI.legacyAssets.markSeen().catch(() => undefined);
  }, []);

  if (!report) return null;

  return (
    <Dialog
      open={open && canShow}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup className="sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('Some things from the previous version no longer apply')}</DialogTitle>
          <DialogDescription>
            {t(
              'This version runs chats on a new engine. The items below were found on this computer, but it no longer loads them. Nothing was changed or deleted, and the previous version can still use them.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <LegacyAssetList report={report} />
            <p className="text-meta text-muted-foreground">
              {t('You can see this list again in Settings > Extensions.')}
            </p>
            {error && <p className="text-meta text-destructive">{error}</p>}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          {/* P1-7e problem 35 (decision 144): `normal-case`, because the
              button base lowercases its text and the Chinese label holds the
              word "Agent" (design system: mixed-script button copy). */}
          <Button
            variant="ghost"
            className="mr-auto normal-case"
            onClick={() => void openLegacyAgentFolder().then(setError)}
          >
            <FolderOpen className="h-4 w-4" />
            {t('Open agent folder')}
          </Button>
          <Button onClick={close}>{t('Got it')}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
