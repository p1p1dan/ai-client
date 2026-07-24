import { SendHorizonal, Square } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { classifyAssistantProgress } from './assistantProgress';
import { ModelSelect } from './ModelSelect';
import { defaultModelId } from './models';
import { useSessionModel } from './useSessionModel';

interface ChatComposerProps {
  disabled?: boolean;
}

function isStoppable(status: string | undefined): boolean {
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'waiting_permission' ||
    status === 'waiting_question'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatRuntimeEvent(event: { type: string; payload?: unknown }): string {
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as { code?: string; message?: string; error?: string; status?: string })
      : null;
  const code = payload?.code;
  const message = payload?.message ?? payload?.error;
  const status = payload?.status;
  if (code || message) {
    return `${event.type}(${code ?? ''}${code && message ? ': ' : ''}${message ?? ''})`;
  }
  if (status) {
    return `${event.type}(${status})`;
  }
  return event.type;
}

function composerPlaceholder(opts: {
  canSend: boolean;
  busy: boolean;
  sending: boolean;
  hasSession: boolean;
  hasWorkspace: boolean;
}): string {
  if (opts.sending) return 'Sending to Agent Host…';
  if (opts.busy) return 'Agent Host is running — use Stop, then send again…';
  if (!opts.hasSession) return 'Select a session in the left nav before sending…';
  if (!opts.hasWorkspace) return 'Active session has no workspace…';
  if (opts.canSend) return 'Message Claude via Agent Host…';
  return 'Cannot send right now…';
}

/** Wait until predicate, or timeout. Returns false on timeout. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  stepMs = 50
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

export function ChatComposer({ disabled }: ChatComposerProps) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const stopActiveSession = useChatSessionsStore((state) => state.stopActiveSession);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const lastError = useChatSessionsStore((state) => state.lastError);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  const busy = isStoppable(activeSession?.status);
  const canSend = Boolean(activeSessionId && activeWorkspace && !disabled && !busy && !sending);
  const { getSessionModel } = useSessionModel();

  const statusHint = !activeSessionId
    ? 'No session selected — pick Live Agent Host in the left nav (or click New).'
    : !activeWorkspace
      ? 'Active session has no workspace — re-open a repository and refresh.'
      : lastError
        ? `Error: ${lastError}`
        : sending
          ? 'Starting Agent Host / sending…'
          : busy
            ? 'Agent Host running — use Stop to abort'
            : `Ready · cwd: ${activeWorkspace.path}`;

  const handleSend = async () => {
    const trimmed = value.trim();
    if (!trimmed || !canSend || !activeSessionId || !activeWorkspace) {
      return;
    }

    const sessionId = activeSessionId;
    const workspacePath = activeWorkspace.path;
    const model = getSessionModel(sessionId) ?? defaultModelId(null);

    useChatSessionsStore.setState((state) => ({
      hostBoundSessionIds: state.hostBoundSessionIds.filter((id) => id !== sessionId),
      lastError: null,
    }));

    setSending(true);
    const seenEvents: string[] = [];
    const assistantMessageIds = new Set<string>();
    let sawSessionCreated = false;
    let sawAssistantProgress = false;
    let fatalHostError: string | null = null;

    const unsubEvents = window.electronAPI.chat.onRuntimeEvent((event) => {
      seenEvents.push(formatRuntimeEvent(event));

      if (event.type === 'session.created' && event.sessionId === sessionId) {
        sawSessionCreated = true;
      }

      if (event.sessionId === sessionId) {
        if (classifyAssistantProgress(event, assistantMessageIds) === 'assistant') {
          sawAssistantProgress = true;
        }
      }

      if (event.type === 'host.error') {
        const message =
          event.payload && typeof event.payload === 'object' && 'message' in event.payload
            ? String((event.payload as { message?: string }).message ?? 'host.error')
            : 'host.error';
        const code =
          event.payload && typeof event.payload === 'object' && 'code' in event.payload
            ? String((event.payload as { code?: string }).code ?? '')
            : '';
        fatalHostError = code ? `${code}: ${message}` : message;
        useChatSessionsStore.setState({ lastError: fatalHostError });
      }
    });

    try {
      await window.electronAPI.chat.ensureHost();

      // Drop Host registry entry so createSession is not "Session already exists".
      await window.electronAPI.chat.closeSession({ sessionId }).catch(() => undefined);
      await sleep(120);

      sawSessionCreated = false;
      await window.electronAPI.chat.createSession({ sessionId, workspacePath, model });

      const created = await waitUntil(() => sawSessionCreated || Boolean(fatalHostError), 5000);
      if (fatalHostError) {
        return;
      }
      if (!created) {
        useChatSessionsStore.setState({
          lastError: [
            'Timed out waiting for session.created after createSession.',
            `rawEvents=[${seenEvents.join(' ; ') || 'none'}]`,
            `sessionId=${sessionId}`,
          ].join(' | '),
        });
        return;
      }

      useChatSessionsStore.setState((state) => ({
        hostBoundSessionIds: state.hostBoundSessionIds.includes(sessionId)
          ? state.hostBoundSessionIds
          : [...state.hostBoundSessionIds, sessionId],
        lastError: null,
      }));

      await window.electronAPI.chat.send({ sessionId, text: trimmed });
      setValue('');

      // Running alone is not success — wait for assistant / tool / permission / terminal.
      const ok = await waitUntil(() => {
        if (fatalHostError) return true;
        if (sawAssistantProgress) return true;
        const state = useChatSessionsStore.getState();
        if (state.lastError) return true;
        const session = state.sessions.find((item) => item.id === sessionId);
        if (session?.status === 'failed') return true;
        if (session?.status === 'waiting_permission' || session?.status === 'waiting_question') {
          return true;
        }
        const hasAssistant = state.messages.some(
          (message) =>
            message.sessionId === sessionId &&
            message.role === 'assistant' &&
            message.blocks.length > 0
        );
        return hasAssistant;
      }, 45000);

      if (fatalHostError || useChatSessionsStore.getState().lastError) {
        return;
      }

      const statusAfter = useChatSessionsStore
        .getState()
        .sessions.find((s) => s.id === sessionId)?.status;
      if (
        ok &&
        (sawAssistantProgress ||
          statusAfter === 'waiting_permission' ||
          statusAfter === 'waiting_question' ||
          statusAfter === 'idle')
      ) {
        return;
      }

      const state = useChatSessionsStore.getState();
      const session = state.sessions.find((item) => item.id === sessionId);
      const hostAfter = await window.electronAPI.chat.getHostStatus().catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));

      useChatSessionsStore.setState({
        lastError: [
          'No assistant/tool progress after send (status may still show Running).',
          `status=${session?.status ?? 'n/a'}`,
          `rawEvents=[${seenEvents.join(' ; ') || 'none'}]`,
          `hostAfter=${JSON.stringify(hostAfter)}`,
          `sessionId=${sessionId}`,
          `cwd=${workspacePath}`,
          'Click Stop, then retry. If still empty, check Claude auth / API in ~/.claude/settings.json.',
        ].join(' | '),
      });
    } catch (err) {
      useChatSessionsStore.setState({
        lastError: err instanceof Error ? err.message : String(err),
      });
    } finally {
      unsubEvents();
      setSending(false);
    }
  };

  return (
    <div className="shrink-0 border-t bg-background/80 p-3">
      {(lastError || !activeSessionId || !activeWorkspace) && (
        <div className="mb-2 max-h-28 overflow-auto rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive whitespace-pre-wrap break-all">
          {statusHint}
        </div>
      )}
      <div className="rounded-lg border bg-card/40 p-2">
        <Textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={composerPlaceholder({
            canSend,
            busy,
            sending,
            hasSession: Boolean(activeSessionId),
            hasWorkspace: Boolean(activeWorkspace),
          })}
          className="min-h-20 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          disabled={disabled || busy || sending || !activeSessionId}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p
            className={`min-w-0 flex-1 truncate text-xs ${
              lastError || !activeSessionId || !activeWorkspace
                ? 'text-destructive'
                : 'text-muted-foreground'
            }`}
            title={statusHint}
          >
            {sending ? 'Waiting for Agent Host reply (up to 45s)…' : statusHint}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {activeSessionId && (
              <ModelSelect sessionId={activeSessionId} disabled={disabled || busy || sending} />
            )}
            {busy ? (
              <Button
                size="sm"
                variant="outline"
                className="h-6"
                disabled={disabled}
                onClick={() => void stopActiveSession()}
              >
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-6"
                disabled={!canSend || !value.trim()}
                onClick={() => void handleSend()}
              >
                <SendHorizonal className="h-3.5 w-3.5" />
                {sending ? 'Sending…' : 'Send'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
