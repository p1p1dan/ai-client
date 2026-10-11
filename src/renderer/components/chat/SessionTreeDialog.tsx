import type { SessionTreeNode, SessionTreeSnapshot } from '@shared/types/sessionHistory';
import { GitBranch, RefreshCw, RotateCcw, Split } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
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
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { materializeForkedChatSession } from '@/stores/chatSessionActions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useComposerDraftsStore } from '@/stores/composerDrafts';
import { resetSessionScopedRendererState } from '@/stores/sessionLifecycle';
import {
  isLegacyMigrationRequiredError,
  LEGACY_MIGRATION_OPERATION_FAILED,
} from './sessionIndex/legacyMigration';
import {
  isSessionNotRunningError,
  runWithSessionStarted,
  SESSION_START_KEYS,
  SESSION_STARTING_LINE,
  SESSION_STOPPED_BEFORE_RUN,
  sessionStartFailureKey,
} from './sessionStart';
import { sessionStartEffects } from './sessionStartDeps';
import { capSessionTreeForDisplay, sessionTreeNodeTag, sessionTreeNodeTitle } from './sessionTree';

interface SessionTreeDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isIdle: boolean;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Decision 176: the conversation an operation needed could not be started,
 * or stopped running before the operation reached it. Carries the dictionary
 * key the dialog shows.
 */
class SessionStartRefusedError extends Error {
  constructor(readonly key: string) {
    super(key);
    this.name = 'SessionStartRefusedError';
  }
}

/** Error lines that are dictionary keys, translated where they are shown. */
const TRANSLATED_FAILURES: ReadonlySet<string> = new Set(SESSION_START_KEYS);

/**
 * The dialog's error line. A start that did not happen, a chat that still
 * could not be moved to the current engine, or one that stopped running gets
 * a dictionary key (translated where it is shown, so the effect below needs no
 * translator), everything else the sentence it came with.
 */
function failureText(cause: unknown): string {
  if (cause instanceof SessionStartRefusedError) return cause.key;
  if (isLegacyMigrationRequiredError(cause)) return LEGACY_MIGRATION_OPERATION_FAILED;
  if (isSessionNotRunningError(cause)) return SESSION_STOPPED_BEFORE_RUN;
  return errorMessage(cause);
}

/**
 * dsh-rebase P1-4b: a DSH rewind retires the agent a background job runs
 * under, so the worker refuses while one runs (`WORKER_REWIND_JOBS_RUNNING`).
 */
const REWIND_JOBS_RUNNING = 'WORKER_REWIND_JOBS_RUNNING';

export function SessionTreeDialog({
  sessionId,
  open,
  onOpenChange,
  isIdle,
}: SessionTreeDialogProps) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<SessionTreeSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [rewindTarget, setRewindTarget] = useState<SessionTreeNode | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const branchRevision = useChatSessionsStore(
    (state) => state.historyBranchRevisions?.[sessionId] ?? 0
  );
  const requestSequence = useRef(0);
  const [starting, setStarting] = useState(false);
  // Decision 176: the tree, a rewind and a fork need the conversation
  // running. One the engine is not running (reopened after a restart,
  // reclaimed when idle) is started the way a send starts it first — which
  // also moves a chat from the previous version (decision 122 rule 14) — and a
  // start that fails puts its card in the conversation. `sessionStartEffects`
  // is a module constant, so this changes with the session only.
  const afterStart = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T> => {
      try {
        const result = await runWithSessionStarted({
          sessionId,
          operation,
          ...sessionStartEffects,
          onPhase: (phase) => setStarting(phase === 'starting'),
        });
        if (result.kind === 'not-started') {
          throw new SessionStartRefusedError(sessionStartFailureKey(result.start));
        }
        if (result.kind === 'cancelled')
          throw new SessionStartRefusedError(SESSION_STOPPED_BEFORE_RUN);
        return result.value;
      } finally {
        setStarting(false);
      }
    },
    [sessionId]
  );

  useEffect(() => {
    // The explicit Refresh action advances this request generation.
    void refreshNonce;
    if (!open) {
      requestSequence.current += 1;
      setLoading(false);
      return;
    }
    const sequence = ++requestSequence.current;
    setSnapshot(null);
    setRewindTarget(null);
    setMutationPending(false);
    setLoading(true);
    setError(null);
    void afterStart(() =>
      window.electronAPI.chat.getSessionTree({ sessionId, requestSequence: sequence })
    )
      .then((result) => {
        if (
          requestSequence.current !== sequence ||
          result.requestSequence !== sequence ||
          !result.sessionKey.startsWith(`${sessionId}:`) ||
          result.branchRevision < branchRevision
        ) {
          return;
        }
        setSnapshot(result.snapshot);
      })
      .catch((cause) => {
        if (requestSequence.current !== sequence) return;
        setError(failureText(cause));
      })
      .finally(() => {
        if (requestSequence.current === sequence) setLoading(false);
      });
  }, [afterStart, branchRevision, open, refreshNonce, sessionId]);

  const display = useMemo(
    () => (snapshot ? capSessionTreeForDisplay(snapshot) : { nodes: [], hiddenCount: 0 }),
    [snapshot]
  );

  const handleRewind = async () => {
    const target = rewindTarget;
    if (!target || !isIdle || mutationPending) return;
    setMutationPending(true);
    setError(null);
    requestSequence.current += 1;
    try {
      const result = await afterStart(() =>
        window.electronAPI.chat.rewindSession({
          sessionId,
          entryId: target.id,
          confirmed: true,
        })
      );
      resetSessionScopedRendererState(sessionId);
      // P1-7e (problem 1, decision 139): a rewind to a prompt hands that
      // prompt back — into THIS chat's composer, merged after anything the
      // user already typed there (`mergeOfferedText`), never over it.
      if (result.editorText) {
        useComposerDraftsStore.getState().offerText(sessionId, result.editorText);
      }
      setSnapshot(result.tree);
      setRewindTarget(null);
    } catch (cause) {
      const message = failureText(cause);
      setError(
        message.includes(REWIND_JOBS_RUNNING)
          ? t(
              'A background task of this session is still running. Wait for it to finish, or stop it, before rewinding.'
            )
          : message
      );
    } finally {
      setMutationPending(false);
    }
  };

  const handleFork = async (node: SessionTreeNode) => {
    if (!isIdle || mutationPending) return;
    setMutationPending(true);
    setError(null);
    requestSequence.current += 1;
    try {
      const result = await afterStart(() =>
        window.electronAPI.chat.forkSession({
          sessionId,
          entryId: node.id,
        })
      );
      if (!materializeForkedChatSession(result.session)) {
        // Thrown, then caught two lines down and painted into this dialog's own
        // error line — so it is user copy, not a log message.
        throw new Error(
          t('Fork was created, but its workspace could not be materialized in this window')
        );
      }
      onOpenChange(false);
    } catch (cause) {
      setError(failureText(cause));
    } finally {
      setMutationPending(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranch className="size-4.5 text-primary" />
              {t('Session branches')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'Rewinding changes the active path. Later messages stay in this tree and are not deleted.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="min-h-64">
            <div className="mb-2 flex items-center justify-between gap-2 text-meta text-muted-foreground">
              <span>
                {starting
                  ? t(SESSION_STARTING_LINE)
                  : snapshot
                    ? t('{{shown}} of {{total}} nodes', {
                        shown: snapshot.returnedNodes,
                        total: snapshot.totalNodes,
                      })
                    : t('Load the session tree')}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={loading || mutationPending || !isIdle}
                onClick={() => setRefreshNonce((value) => value + 1)}
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                {t('Refresh')}
              </Button>
            </div>
            {error && (
              <p className="mb-2 rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-meta text-destructive">
                {TRANSLATED_FAILURES.has(error) ? t(error) : error}
              </p>
            )}
            {display.hiddenCount > 0 && (
              <p className="mb-2 text-meta text-muted-foreground">
                {t('Showing a bounded window; {{count}} nodes are hidden.', {
                  count: display.hiddenCount,
                })}
              </p>
            )}
            <div className="flex flex-col gap-1">
              {display.nodes.map((node) => (
                <div
                  key={node.id}
                  className={cn(
                    'flex min-h-7 items-center gap-2 rounded-sm px-2 text-ui hover:bg-accent/50',
                    node.active && 'bg-selection'
                  )}
                  style={{ paddingLeft: `${node.depth * 12 + 8}px` }}
                >
                  <span className="min-w-0 flex-1 truncate" title={sessionTreeNodeTitle(node, t)}>
                    {sessionTreeNodeTitle(node, t)}
                  </span>
                  <span className="shrink-0 text-meta text-muted-foreground">
                    {sessionTreeNodeTag(node, t)}
                  </span>
                  {node.leaf && <Badge variant="info">{t('active')}</Badge>}
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    title={t('Rewind here')}
                    aria-label={t('Rewind here')}
                    disabled={!isIdle || mutationPending || node.leaf}
                    onClick={() => setRewindTarget(node)}
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    title={
                      node.forkable
                        ? t('Fork from here')
                        : t('Fork becomes available after the first assistant response')
                    }
                    aria-label={t('Fork from here')}
                    disabled={!isIdle || mutationPending || !node.forkable}
                    onClick={() => void handleFork(node)}
                  >
                    <Split className="size-3.5" />
                  </Button>
                </div>
              ))}
              {!loading && display.nodes.length === 0 && !error && (
                <p className="py-8 text-center text-ui text-muted-foreground">
                  {t('This session has no persisted tree nodes yet.')}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('Close')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={rewindTarget !== null}
        onOpenChange={(next) => !next && setRewindTarget(null)}
      >
        <AlertDialogPopup zIndexLevel="nested">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Rewind this session?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'The active conversation will move to “{{node}}”. Later messages remain available as another branch; nothing is deleted.',
                { node: rewindTarget ? sessionTreeNodeTitle(rewindTarget, t) : '' }
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={() => setRewindTarget(null)}>
              {t('Cancel')}
            </Button>
            <Button
              type="button"
              disabled={!isIdle || mutationPending}
              onClick={() => void handleRewind()}
            >
              <RotateCcw />
              {t('Rewind')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
