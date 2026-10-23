import {
  DEFAULT_RUNTIME_PERMISSION,
  permissionPresetLabelsFor,
  presetOf,
} from '@shared/types/runtimePermission';
import { useQuery } from '@tanstack/react-query';
import { Cpu, FileText, Folder, GitBranch, Monitor, Server, Shield } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { resolveRuntimeRepoPath, runLocationLabel } from '@/components/chat/composerTarget';
import { catalogModels } from '@/components/chat/piModelCatalog';
import {
  readDefaultPermissions,
  readSessionPermissions,
  SESSION_PERMISSIONS_CHANGED_EVENT,
} from '@/components/chat/sessionPreferenceStore';
import { useHostStatus } from '@/components/chat/useHostStatus';
import { useMessageMetadata } from '@/components/chat/useMessageMetadata';
import { usePiModelCatalog } from '@/components/chat/usePiModelCatalog';
import { useRepositoryRuntimeContext } from '@/hooks/useRepositoryRuntimeContext';
import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useLegacyMigrationStore } from '@/stores/legacyMigration';
import { CopyPathButton, RevealPathButton, useTranscriptPath } from '../surfaces/pathActions';
import { RailCard, RailRow } from './RailCard';
import {
  deriveEnvironmentRows,
  type EnvironmentRow,
  resolveKnownEngine,
  truncateMiddle,
} from './sessionRailModel';

/** Characters of a path the folder row keeps (both ends survive). */
const PATH_CHARS = 26;

/**
 * The run location the composer's indicator showed (T-27: a repository
 * property — the project's main or remote checkout decides it).
 */
function useRunLocation(workspaceId: string | null) {
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const repoPath = resolveRuntimeRepoPath(workspaceId, workspaces);
  const { data: runtimeContext } = useRepositoryRuntimeContext(repoPath ?? undefined);
  const { data: profiles } = useQuery({
    queryKey: ['remote', 'profiles'],
    queryFn: () => window.electronAPI.remote.listProfiles(),
    enabled: runtimeContext?.kind === 'remote',
    staleTime: 60_000,
  });
  return runLocationLabel({ context: runtimeContext, profiles, repoPath });
}

/** The chat's posture as the composer's chip names it; re-read when it is written. */
function usePermissionLabel(sessionId: string, engine: 'dsh' | 'claude-sdk' | null): string | null {
  const postureRevision = useLegacyMigrationStore(
    (state) => state.postureRevisions[sessionId] ?? 0
  );
  const [writes, setWrites] = useState(0);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown }>).detail;
      if (detail?.sessionId === sessionId) setWrites((count) => count + 1);
    };
    window.addEventListener(SESSION_PERMISSIONS_CHANGED_EVENT, listener);
    return () => window.removeEventListener(SESSION_PERMISSIONS_CHANGED_EVENT, listener);
  }, [sessionId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `writes` and `postureRevision` are re-read TRIGGERS
  return useMemo(() => {
    const settings =
      readSessionPermissions(sessionId) ??
      readDefaultPermissions(engine ?? undefined) ??
      DEFAULT_RUNTIME_PERMISSION;
    return permissionPresetLabelsFor(engine ?? undefined)[presetOf(settings)] ?? null;
  }, [sessionId, engine, writes, postureRevision]);
}

/** The model that actually answered last (`reportedModel`), by its catalog name. */
function useReportedModel(sessionId: string): string | null {
  const lastAssistantId = useChatSessionsStore((state) => {
    const messages = state.messages[sessionId];
    if (!messages) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'assistant') return messages[index]?.id ?? null;
    }
    return null;
  });
  const { get } = useMessageMetadata(sessionId);
  const { status: hostStatus } = useHostStatus();
  const { catalog } = usePiModelCatalog(hostStatus.state);
  const reported = lastAssistantId ? (get(lastAssistantId)?.reportedModel ?? null) : null;
  if (!reported) return null;
  return catalogModels(catalog).find((option) => option.id === reported)?.label ?? reported;
}

/** Everything the environment card shows, as rows; a row with no data is left out. */
export function useEnvironmentRows(sessionId: string): EnvironmentRow[] {
  const session = useChatSessionsStore((state) =>
    state.sessions.find((item) => item.id === sessionId)
  );
  const workspace = useChatSessionsStore((state) =>
    state.workspaces.find((item) => item.id === session?.workspaceId)
  );
  const projectName = useChatSessionsStore(
    (state) => state.projects.find((item) => item.id === workspace?.projectId)?.name ?? null
  );
  const bound = useChatSessionsStore((state) => state.hostBoundSessionIds.includes(sessionId));
  const runLocation = useRunLocation(workspace?.id ?? null);
  const engine = resolveKnownEngine({
    bound,
    ...(session?.engine ? { engine: session.engine } : {}),
    ...(session?.runtimeIdentity ? { runtimeIdentity: session.runtimeIdentity } : {}),
  });
  const permission = usePermissionLabel(sessionId, engine);
  const model = useReportedModel(sessionId);
  const transcriptPath = useTranscriptPath(session?.runtimeIdentity, session?.status);
  return useMemo(
    () =>
      deriveEnvironmentRows({
        runLocation,
        workspace: workspace ?? null,
        projectName,
        unboundPath: session?.unbound?.workspacePath ?? null,
        engine,
        model,
        permission,
        transcriptPath,
      }),
    [
      runLocation,
      workspace,
      projectName,
      session?.unbound?.workspacePath,
      engine,
      model,
      permission,
      transcriptPath,
    ]
  );
}

/**
 * Layout 5e: where the session runs — this computer or a remote, the project
 * folder, the branch (and whether it is a worktree), the engine and model, the
 * permission mode, and where the chat's record is on disk. The reference's
 * 「Environment」 card.
 */
export function EnvironmentCard({ rows }: { rows: readonly EnvironmentRow[] }) {
  const { t } = useI18n();
  return (
    <RailCard id="environment" title={t('Environment')}>
      {rows.map((row) => {
        switch (row.id) {
          case 'location':
            return (
              <RailRow
                key={row.id}
                icon={
                  row.tone === 'remote' ? (
                    <Server className="size-3.5" />
                  ) : (
                    <Monitor className="size-3.5" />
                  )
                }
                title={t('Run location')}
              >
                {t(row.text)}
              </RailRow>
            );
          case 'folder':
            return (
              <RailRow
                key={row.id}
                icon={<Folder className="size-3.5" />}
                title={row.path ?? row.name}
              >
                {row.name}
                {row.path && (
                  <span className="text-foreground-faint">
                    {' · '}
                    {truncateMiddle(row.path, PATH_CHARS)}
                  </span>
                )}
              </RailRow>
            );
          case 'branch':
            return (
              <RailRow
                key={row.id}
                icon={<GitBranch className="size-3.5" />}
                title={row.text}
                tail={row.worktree ? t('Worktree') : undefined}
              >
                {row.text}
              </RailRow>
            );
          case 'engine':
            return (
              <RailRow key={row.id} icon={<Cpu className="size-3.5" />}>
                {row.engine === 'claude-sdk' ? t('Agent SDK engine') : t('Built-in engine')}
                {row.model && <span className="text-foreground-faint">{` · ${row.model}`}</span>}
              </RailRow>
            );
          case 'model':
            return (
              <RailRow key={row.id} icon={<Cpu className="size-3.5" />} title={t('Model')}>
                {row.model}
              </RailRow>
            );
          case 'permission':
            return (
              <RailRow
                key={row.id}
                icon={<Shield className="size-3.5" />}
                title={t('Permission mode')}
              >
                {t(row.text)}
              </RailRow>
            );
          case 'transcript':
            // User, 2026-10-23: the record's path, with the Context panel's
            // copy and reveal, so it is one click from the rail.
            return (
              <RailRow
                key={row.id}
                icon={<FileText className="size-3.5" />}
                title={row.path}
                tail={
                  <span className="flex items-center">
                    <CopyPathButton value={row.path} />
                    <RevealPathButton value={row.path} />
                  </span>
                }
              >
                {t('Conversation record')}
                <span className="text-foreground-faint">
                  {' · '}
                  {truncateMiddle(row.path, PATH_CHARS)}
                </span>
              </RailRow>
            );
          default:
            return null;
        }
      })}
    </RailCard>
  );
}
