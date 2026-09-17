/**
 * H/21 C5 — "bring your Claude Code / Codex conversations over".
 *
 * Sits next to the Pi-directory migration because it answers the same question
 * for a different user: the one whose history is in `~/.claude` or `~/.codex`
 * and whom that section has nothing to say to.
 *
 * The flow is deliberately the same two steps as the migration pane: pick a
 * project, pick the conversations, press once, read what happened. Everything
 * underneath already existed (scan / convert / write a native Pi session /
 * dedupe); what was missing was a way for a user to reach it.
 *
 * One thing this pane decides on its own: whether a conversation's recorded
 * working directory matches a folder this app has registered. Only the renderer
 * holds that list. An unmatched conversation still imports — as a temporary
 * chat — and the row says so before the user presses the button, because the
 * alternative (importing it against a folder the sidebar cannot group) would
 * drop it out of the sidebar entirely.
 */

import type {
  LegacyImportItemResult,
  LegacyImportProject,
  LegacyImportSourceKind,
} from '@shared/types';
import { canonicalPathKey, getDisplayPathBasename } from '@shared/utils/path';
import { AlertTriangle, ArrowLeft, Folder, RefreshCcw, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { refreshSessionIndexNow } from '@/components/chat/sessionIndex/useSessionIndex';
import { SessionItem } from '@/components/sessions/SessionItem';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useLegacyImportMutation,
  useLegacyImportProjects,
  useLegacyImportSessions,
} from '@/hooks/useLegacyImport';
import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { describeLegacyImportFailure } from './legacyImportFailure';
import { SettingsSectionBlock } from './SettingsPrimitives';

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sourceLabel(kind: LegacyImportSourceKind | undefined): string {
  return kind === 'codex' ? 'Codex' : 'Claude Code';
}

/** Project ids are only unique within one source, so the key carries both. */
function projectKey(project: LegacyImportProject): string {
  return `${project.sourceKind ?? 'claude-code'}:${project.id}`;
}

export function ConversationImportSettings() {
  const { t } = useI18n();
  const projectsQuery = useLegacyImportProjects();
  const projects = projectsQuery.data ?? [];
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const [openProjectKey, setOpenProjectKey] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [report, setReport] = useState<LegacyImportItemResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importMutation = useLegacyImportMutation();

  const registeredPaths = useMemo(
    () => new Set(workspaces.map((workspace) => canonicalPathKey(workspace.path))),
    [workspaces]
  );
  const isMatched = (projectPath: string): boolean =>
    !!projectPath.trim() && registeredPaths.has(canonicalPathKey(projectPath));

  const openProject = useMemo(
    () => projects.find((project) => projectKey(project) === openProjectKey) ?? null,
    [projects, openProjectKey]
  );
  const sessionsQuery = useLegacyImportSessions(openProject?.id ?? null, {
    enabled: !!openProject,
    sourceKind: openProject?.sourceKind,
  });
  const sessions = sessionsQuery.data ?? [];
  const allSelected = sessions.length > 0 && selectedIds.size === sessions.length;
  const resultsBySession = useMemo(
    () => new Map((report ?? []).map((item) => [item.source.sourceSessionId, item])),
    [report]
  );

  const chooseProject = (project: LegacyImportProject | null) => {
    setOpenProjectKey(project ? projectKey(project) : null);
    setSelectedIds(new Set());
    setReport(null);
    setError(null);
  };

  const runImport = async () => {
    if (!openProject || selectedIds.size === 0) return;
    const matched = isMatched(openProject.path);
    setError(null);
    try {
      const result = await importMutation.mutateAsync({
        sources: [...selectedIds].map((sessionId) => ({
          sourceKind: openProject.sourceKind ?? 'claude-code',
          projectId: openProject.id,
          sourceSessionId: sessionId,
          workspaceMatched: matched,
        })),
      });
      setReport(result.results);
      setSelectedIds(new Set());
      // The rows land in the session index, which the sidebar only re-reads on
      // its own schedule — without this the import looks like it did nothing.
      await refreshSessionIndexNow();
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const busy = importMutation.isPending;

  return (
    <div className="space-y-4">
      <SettingsSectionBlock
        title={t('Import conversations from Claude Code / Codex')}
        description={t(
          'Copies conversation history off this machine into this app, where you can read it and keep talking. The original files are only read, never changed.'
        )}
      />

      {projectsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : projectsQuery.error ? (
        <p className="flex gap-2 rounded-sm border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {messageOf(projectsQuery.error)}
        </p>
      ) : projects.length === 0 ? (
        <p className="text-meta text-muted-foreground">
          {t('No Claude Code or Codex conversations were found on this machine.')}
        </p>
      ) : openProject ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Button onClick={() => chooseProject(null)} size="sm" variant="secondary">
                <ArrowLeft className="size-4" />
                {t('Back')}
              </Button>
              <span className="min-w-0 truncate text-ui font-medium">
                {getDisplayPathBasename(openProject.path) || sourceLabel(openProject.sourceKind)}
              </span>
              {!isMatched(openProject.path) && (
                <Badge variant="outline">{t('No matching folder')}</Badge>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                disabled={sessionsQuery.isFetching || busy}
                onClick={() => void sessionsQuery.refetch()}
                size="sm"
                variant="secondary"
              >
                <RefreshCcw className="size-4" />
                {t('Rescan')}
              </Button>
              <Button disabled={selectedIds.size === 0 || busy} onClick={() => void runImport()}>
                <Upload className="size-4" />
                {busy
                  ? t('Importing...')
                  : t('Import selected ({{count}})', { count: selectedIds.size })}
              </Button>
            </div>
          </div>

          {!isMatched(openProject.path) && (
            <p className="text-meta text-warning">
              {t(
                'This folder is not one of your projects here, so these conversations import as temporary chats.'
              )}
            </p>
          )}

          {sessionsQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-meta text-muted-foreground">
              {t('This project has no conversations to import.')}
            </p>
          ) : (
            <>
              {/* Not wrapped in a <label>: inside one, the checkbox renders as
                  a span rather than a button and stops being clickable in its
                  own right — the same shape the migration pane settled on. */}
              <div className="flex h-7 items-center gap-2 border-b px-2 text-ui text-muted-foreground">
                <Checkbox
                  aria-label={t('Select all')}
                  checked={allSelected}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setSelectedIds(
                      checked === true ? new Set(sessions.map((item) => item.id)) : new Set()
                    )
                  }
                />
                <span>{t('Select all')}</span>
              </div>
              <ul className="max-h-80 space-y-1 overflow-y-auto">
                {sessions.map((session) => {
                  const outcome = resultsBySession.get(session.id);
                  return (
                    <li key={session.id}>
                      <SessionItem
                        disabled={busy}
                        error={describeLegacyImportFailure(outcome, t)}
                        onSelectedChange={(selected) =>
                          setSelectedIds((current) => {
                            const next = new Set(current);
                            if (selected) next.add(session.id);
                            else next.delete(session.id);
                            return next;
                          })
                        }
                        result={outcome?.status}
                        selected={selectedIds.has(session.id)}
                        session={session}
                      />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      ) : (
        <ul className="divide-y rounded-md border">
          {projects.map((project) => (
            <li key={projectKey(project)}>
              <button
                className="flex w-full min-w-0 items-center gap-3 p-3 text-left transition-colors hover:bg-accent/50"
                onClick={() => chooseProject(project)}
                type="button"
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-ui font-medium">
                      {getDisplayPathBasename(project.path) || sourceLabel(project.sourceKind)}
                    </span>
                    <Badge variant="secondary">{sourceLabel(project.sourceKind)}</Badge>
                    {!isMatched(project.path) && (
                      <Badge variant="outline">{t('No matching folder')}</Badge>
                    )}
                  </div>
                  <p className="truncate text-meta text-muted-foreground" title={project.path}>
                    {project.path || t('No working folder was recorded')}
                  </p>
                </div>
                <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
                  {t('{{count}} conversations', { count: project.sessionCount })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {report && report.length > 0 && (
        <p className="rounded-md border bg-card p-3 text-meta">
          {t('Imported {{imported}}, already here {{skipped}}, failed {{failed}}.', {
            imported: report.filter((item) => item.status === 'imported').length,
            skipped: report.filter((item) => item.status === 'already-imported').length,
            failed: report.filter((item) => item.status === 'failed').length,
          })}{' '}
          {t('Imported conversations appear in the sidebar; open one to keep talking.')}
        </p>
      )}

      {error && (
        <p className="flex gap-2 rounded-sm border border-destructive/30 bg-destructive/8 p-3 text-ui text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
