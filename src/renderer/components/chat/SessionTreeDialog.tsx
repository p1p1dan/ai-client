import type { SessionTreeNode, SessionTreeSnapshot } from '@shared/types/sessionHistory';
import { GitBranch, RefreshCw, RotateCcw, Split } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { cn } from '@/lib/utils';
import { materializeForkedChatSession } from '@/stores/chatSessionActions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { resetSessionScopedRendererState } from '@/stores/sessionLifecycle';
import { capSessionTreeForDisplay, sessionTreeNodeTitle } from './sessionTree';

interface SessionTreeDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idle: boolean;
}

export function SessionTreeDialog({ sessionId, open, onOpenChange, idle }: SessionTreeDialogProps) {
  const [snapshot, setSnapshot] = useState<SessionTreeSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [rewindTarget, setRewindTarget] = useState<SessionTreeNode | null>(null);
  const [mutatingEntryId, setMutatingEntryId] = useState<string | null>(null);
  const branchRevision = useChatSessionsStore(
    (state) => state.historyBranchRevisions?.[sessionId] ?? 0
  );
  const requestSequence = useRef(0);
  const latestBranchRevision = useRef(branchRevision);

  useEffect(() => {
    // Reading the nonce makes the explicit Refresh button a real generation
    // input rather than a dependency-only trigger hidden from the hook body.
    void refreshNonce;
    latestBranchRevision.current = branchRevision;
    if (!open) {
      requestSequence.current += 1;
      setLoading(false);
      return;
    }
    const sequence = ++requestSequence.current;
    setSnapshot(null);
    setRewindTarget(null);
    setMutatingEntryId(null);
    setLoading(true);
    setError(null);
    void window.electronAPI.chat
      .getSessionTree({ sessionId, requestSequence: sequence })
      .then((result) => {
        if (
          requestSequence.current !== sequence ||
          result.requestSequence !== sequence ||
          !result.sessionKey.startsWith(`${sessionId}:`) ||
          result.branchRevision < latestBranchRevision.current
        ) {
          return;
        }
        setSnapshot(result.snapshot);
      })
      .catch((cause) => {
        if (requestSequence.current !== sequence) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (requestSequence.current === sequence) setLoading(false);
      });
  }, [branchRevision, open, refreshNonce, sessionId]);

  const display = useMemo(
    () => (snapshot ? capSessionTreeForDisplay(snapshot) : { nodes: [], hiddenCount: 0 }),
    [snapshot]
  );

  const handleRewind = async () => {
    const target = rewindTarget;
    if (!target || !idle || mutatingEntryId) return;
    setMutatingEntryId(target.id);
    setError(null);
    requestSequence.current += 1;
    try {
      const result = await window.electronAPI.chat.rewindSession({
        sessionId,
        entryId: target.id,
        confirmed: true,
      });
      resetSessionScopedRendererState(sessionId);
      setSnapshot(result.tree);
      setRewindTarget(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingEntryId(null);
    }
  };

  const handleFork = async (node: SessionTreeNode) => {
    if (!idle || mutatingEntryId) return;
    setMutatingEntryId(node.id);
    setError(null);
    requestSequence.current += 1;
    try {
      const result = await window.electronAPI.chat.forkSession({
        sessionId,
        entryId: node.id,
      });
      if (!materializeForkedChatSession(result.session)) {
        throw new Error(
          'Fork was created, but its workspace could not be materialized in this window'
        );
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutatingEntryId(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranch className="size-4.5 text-primary" />
              Session branches
            </DialogTitle>
            <DialogDescription>
              Rewinding changes the active path. Later messages stay in this tree and are not
              deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="min-h-64">
            <div className="mb-2 flex items-center justify-between gap-2 text-meta text-muted-foreground">
              <span>
                {snapshot
                  ? `${snapshot.returnedNodes} of ${snapshot.totalNodes} nodes`
                  : 'Load the Pi-native session tree'}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={loading || mutatingEntryId !== null || !idle}
                onClick={() => setRefreshNonce((value) => value + 1)}
              >
                <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
                Refresh
              </Button>
            </div>
            {error && (
              <p className="mb-2 rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-meta text-destructive">
                {error}
              </p>
            )}
            {display.hiddenCount > 0 && (
              <p className="mb-2 text-meta text-muted-foreground">
                Showing a bounded window; {display.hiddenCount} nodes are hidden.
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
                  <span className="min-w-0 flex-1 truncate" title={sessionTreeNodeTitle(node)}>
                    {sessionTreeNodeTitle(node)}
                  </span>
                  <span className="shrink-0 text-meta text-muted-foreground">
                    {node.role ?? node.entryType}
                  </span>
                  {node.leaf && <Badge variant="info">active</Badge>}
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    title="Rewind here"
                    aria-label="Rewind here"
                    disabled={!idle || mutatingEntryId !== null || node.leaf}
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
                        ? 'Fork from here'
                        : 'Fork becomes available after the first assistant response'
                    }
                    aria-label="Fork from here"
                    disabled={!idle || mutatingEntryId !== null || !node.forkable}
                    onClick={() => void handleFork(node)}
                  >
                    <Split className="size-3.5" />
                  </Button>
                </div>
              ))}
              {!loading && display.nodes.length === 0 && !error && (
                <p className="py-8 text-center text-ui text-muted-foreground">
                  This session has no persisted tree nodes yet.
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
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
            <AlertDialogTitle>Rewind this session?</AlertDialogTitle>
            <AlertDialogDescription>
              The active conversation will move to “
              {rewindTarget ? sessionTreeNodeTitle(rewindTarget) : ''}”. Later messages remain
              available as another branch and the Pi session file is not truncated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" onClick={() => setRewindTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!idle || mutatingEntryId !== null}
              onClick={() => void handleRewind()}
            >
              <RotateCcw />
              Rewind
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
