/**
 * T-14: the Context surface — a read-only definition list of the active
 * session's real, already-tracked facts (Workspace / Runtime / Session).
 * Every value below is sourced from an existing store/hook; nothing here
 * invents state (A06). See `contextSurfaceModel.ts` for the field table and
 * "field missing → row omitted, group empty → group omitted" rules this view
 * only renders, never decides.
 */
import { Copy } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { resolveResumeModel } from '@/components/chat/models';
import { useHostStatus } from '@/components/chat/useHostStatus';
import { useMessageMetadata } from '@/components/chat/useMessageMetadata';
import { useSessionEffort } from '@/components/chat/useSessionEffort';
import { useSessionModel } from '@/components/chat/useSessionModel';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import type { SurfaceViewProps } from '../surfaceViews';
import {
  type ContextGroup,
  deriveContextGroups,
  deriveRunState,
  deriveSessionReferences,
} from './contextSurfaceModel';

// Stable snapshot for "session has no bucket yet": zustand v5 reads selectors
// through `useSyncExternalStore`, so a fresh `[]` per call makes React see the
// store as changed on every commit and re-render forever.
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

function CopyRowButton({ value }: { value: string }) {
  const { t } = useI18n();

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      toastManager.add({
        title: t('Copied'),
        description: t('Path copied to clipboard'),
        type: 'success',
        timeout: 2000,
      });
    } catch {
      // Ignore clipboard errors — same as StatusLine's DirItem.
    }
  }, [value, t]);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="h-6 w-6 shrink-0"
      aria-label={t('Copy Path')}
      title={t('Copy Path')}
      onClick={() => void handleCopy()}
    >
      <Copy className="h-3.5 w-3.5" />
    </Button>
  );
}

function ContextRowLine({ row }: { row: ContextGroup['rows'][number] }) {
  const { t } = useI18n();
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 px-1">
      <span className="text-meta text-muted-foreground shrink-0">{t(row.label)}</span>
      <span className="min-w-0 flex-1 truncate text-ui" title={row.title ?? row.value}>
        {row.value}
      </span>
      {row.copyable && <CopyRowButton value={row.value} />}
    </div>
  );
}

export function ContextSurfaceView(_props: SurfaceViewProps) {
  const { t } = useI18n();

  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const pendingPermissions = useChatSessionsStore((state) => state.pendingPermissions);
  const messageBucket = useChatSessionsStore((state) =>
    activeSessionId ? state.messages[activeSessionId] : undefined
  );
  const messages = messageBucket ?? EMPTY_MESSAGES;

  const { status: hostStatus } = useHostStatus();
  const { getSessionModel } = useSessionModel();
  const { getSessionEffort } = useSessionEffort();
  const { get: getMeta } = useMessageMetadata(activeSessionId);

  // Session-scoped, same filter useTurnSendStatusStore's other readers use
  // (MessageTimeline.tsx) — a session switch mid-send must not show this
  // surface another session's clock.
  const turnSendStatus = useTurnSendStatusStore((state) =>
    state.status && activeSessionId && state.status.sessionId === activeSessionId
      ? state.status
      : null
  );

  const permissionMode = useSessionRuntimeFactsStore((state) =>
    activeSessionId ? (state.factsBySession[activeSessionId]?.permissionMode ?? null) : undefined
  );
  // T-35: the stored facts object is returned as-is (reducer replaces it per
  // event) — stable across unrelated commits, per storeSelectorStability.
  const stderrFacts = useSessionRuntimeFactsStore((state) =>
    activeSessionId ? (state.factsBySession[activeSessionId]?.stderr ?? null) : null
  );

  const session = useMemo(
    () => sessions.find((item) => item.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );
  const workspace = useMemo(
    () => workspaces.find((item) => item.id === session?.workspaceId) ?? null,
    [workspaces, session]
  );

  const lastAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [messages]);
  // A06: `reportedModel` only — NEVER `.model`, which silently falls back to
  // the session's configured selection (messageMetadata.ts) and would make
  // an unconfirmed guess masquerade as "what actually answered".
  const actualModel = lastAssistantMessageId
    ? (getMeta(lastAssistantMessageId)?.reportedModel ?? null)
    : null;

  const configuredModel = activeSessionId
    ? resolveResumeModel(getSessionModel, activeSessionId, hostStatus.settings?.model)
    : null;
  const effortSelection = activeSessionId ? getSessionEffort(activeSessionId) : undefined;

  const groups = useMemo(() => {
    const runState = session
      ? deriveRunState({
          status: session.status,
          retry: session.retry ?? null,
          turnSend: turnSendStatus
            ? { phase: turnSendStatus.phase, elapsedSeconds: turnSendStatus.elapsedSeconds }
            : null,
        })
      : null;
    const references = activeSessionId
      ? deriveSessionReferences({ sessionId: activeSessionId, messages, pendingPermissions })
      : null;

    return deriveContextGroups({
      workspace: workspace
        ? {
            path: workspace.path,
            kind: workspace.kind,
            branch: workspace.branch ?? null,
            gitEnabled: workspace.gitEnabled,
          }
        : null,
      runtime: {
        configuredModel,
        actualModel,
        effortSelection,
        permissionMode,
        host: {
          state: hostStatus.state,
          pid: hostStatus.pid,
          driver: hostStatus.driver,
          version: hostStatus.cometixVersion,
          appVersion: window.electronAPI?.env.appVersion ?? null,
          authTokenType: hostStatus.settings?.authTokenType ?? null,
          baseHost: hostStatus.settings?.baseHost ?? null,
        },
      },
      session:
        session && runState && references
          ? {
              status: runState.status,
              retryLabel: runState.retryLabel,
              turnSendLabel: runState.turnSendLabel,
              pendingPermissionsCount: references.pendingPermissionsCount,
              attachments: references.attachments,
              mentions: references.mentions,
              runtimeIdentity: session.runtimeIdentity ?? null,
            }
          : null,
      stderr: stderrFacts,
    });
  }, [
    session,
    turnSendStatus,
    activeSessionId,
    messages,
    pendingPermissions,
    workspace,
    configuredModel,
    actualModel,
    effortSelection,
    permissionMode,
    hostStatus,
    stderrFacts,
  ]);

  return (
    <div className={cn('select-text flex h-full flex-col overflow-y-auto p-2')}>
      {groups.map((group) => (
        <div key={group.id} className="mb-3 flex flex-col">
          <p className="px-1 py-1 text-meta font-medium text-muted-foreground">{t(group.label)}</p>
          <div className="flex flex-col">
            {group.rows.map((row) => (
              <ContextRowLine key={row.id} row={row} />
            ))}
          </div>
        </div>
      ))}
      {groups.length === 0 && (
        <p className="px-1 py-2 text-meta text-muted-foreground">{t('No context reported yet.')}</p>
      )}
    </div>
  );
}
