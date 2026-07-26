import type { FileSearchResult } from '@shared/types/search';
import { File as FileIcon, Folder, RotateCcw, SendHorizonal, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { classifyAssistantProgress } from './assistantProgress';
import { EffortSelect } from './EffortSelect';
import { toWireEffort } from './efforts';
import { extractMentionQuery, parseMentionChips, replaceMention } from './fileMention';
import { ModelSelect } from './ModelSelect';
import { defaultModelId } from './models';
import { useSessionEffort } from './useSessionEffort';
import { useSessionModel } from './useSessionModel';

interface ChatComposerProps {
  disabled?: boolean;
}

/** T-07③: popup page size. Kept next to the truncation hint that reports it. */
const MENTION_PAGE_SIZE = 10;

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
  const [retryablePrompt, setRetryablePrompt] = useState<string | null>(null);
  // T-07 @ 文件引用：popup 态、搜索结果、选中索引、IME 合成态。delayed 焦点
  // 恢复通过 setTimeout 在 React 提交后再 setSelectionRange。
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<FileSearchResult[]>([]);
  /** T-07③ pre-truncation match count, so the popup can say "10 / 304". */
  const [mentionTotal, setMentionTotal] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const stopActiveSession = useChatSessionsStore((state) => state.stopActiveSession);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const lastError = useChatSessionsStore((state) => state.lastError);
  const activeMessages = useChatSessionsStore((state) =>
    state.activeSessionId ? state.messages[state.activeSessionId] : undefined
  );

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  const cwd = activeWorkspace?.path;
  const mentionChips = useMemo(() => parseMentionChips(value), [value]);
  const mentionOpen = mentionQuery !== null && mentionResults.length > 0;
  const busy = isStoppable(activeSession?.status);
  // A Send in flight must also be abortable: the SDK stream can hang (e.g.
  // gateway revoked key) without ever flipping session.status to running, and
  // the user needs Stop during the 45s wait, not just when store says busy.
  const canStop = busy || sending;
  const canSend = Boolean(activeSessionId && activeWorkspace && !disabled && !canStop);
  const { getSessionModel } = useSessionModel();
  const { getSessionEffort } = useSessionEffort();

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
    await runSend(trimmed);
    setValue('');
  };

  // T-07 @ 文件搜索：150ms 防抖，cwd 缺失或 mention 关闭时清空结果。
  useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setMentionResults([]);
      setMentionTotal(0);
      return;
    }
    const timer = setTimeout(() => {
      window.electronAPI.search
        .files({ rootPath: cwd, query: mentionQuery, maxResults: MENTION_PAGE_SIZE })
        .then((page) => {
          setMentionResults(page.items);
          setMentionTotal(page.total);
        })
        .catch(() => {
          setMentionResults([]);
          setMentionTotal(0);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [mentionQuery, cwd]);

  const handleContentChange = (next: string) => {
    setValue(next);
    if (composingRef.current || !cwd) {
      setMentionQuery(null);
      return;
    }
    // setTimeout 读取 React 提交后的 selectionStart（与 EnhancedInput 同套路）。
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) {
        setMentionQuery(null);
        return;
      }
      setMentionQuery(extractMentionQuery(next, ta.selectionStart));
      setMentionIndex(0);
    }, 0);
  };

  const insertMention = (item: FileSearchResult) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart;
    const out = replaceMention(value, cursor, item);
    if (!out) return;
    setValue(out.text);
    setMentionQuery(null);
    setMentionResults([]);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(out.cursor, out.cursor);
    }, 0);
  };

  const lastUserPrompt = activeSessionId
    ? [...(activeMessages ?? [])].reverse().find((message) => message.role === 'user')
    : undefined;
  // Retry is offered when the last turn ended badly: explicit session.failed
  // (Host emitted it) OR the Composer fallback set retryablePrompt because the
  // SDK stream ended with no assistant progress (e.g. gateway revoked key —
  // Host lands on idle/stopped, not failed, so status check alone misses it).
  const retryText =
    retryablePrompt ??
    (activeSession?.status === 'failed'
      ? lastUserPrompt?.blocks.find((block) => block.type === 'text' && block.text)?.text
      : undefined);
  const canRetry =
    Boolean(retryText) && Boolean(activeSessionId && activeWorkspace) && !busy && !sending;
  const handleRetry = async () => {
    if (!canRetry || !retryText) return;
    setRetryablePrompt(null);
    await runSend(retryText);
  };

  const runSend = async (trimmed: string) => {
    if (!canSend || !activeSessionId || !activeWorkspace) {
      return;
    }

    const sessionId = activeSessionId;
    const workspacePath = activeWorkspace.path;
    const model = getSessionModel(sessionId) ?? defaultModelId(null);
    // T-20: undefined when the user left it on "Default", so the key is dropped
    // from the payload entirely and the model default applies (≠ pinning high).
    const effort = toWireEffort(getSessionEffort(sessionId));

    // Starting a fresh send invalidates any prior failure's retryable prompt:
    // the new prompt is what the user wants now, and a stale ghost Retry would
    // linger if the prior failed stream happened to settle later (see the
    // "Retry 重影" bug — flow aborted without result, retryablePrompt stayed,
    // a late assistant bubble appeared, Retry showed next to Send wrongly).
    setRetryablePrompt(null);
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
      await window.electronAPI.chat.createSession({
        sessionId,
        workspacePath,
        model,
        ...(effort ? { effort } : {}),
      });

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
        const hasAssistant = (state.messages[sessionId] ?? []).some(
          (message) => message.role === 'assistant' && message.blocks.length > 0
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
        // Success — clear any stale failure UI so a ghost Retry can't resurface
        // later (e.g. prior failed stream settled and pushed an assistant bubble).
        setRetryablePrompt(null);
        useChatSessionsStore.setState({ lastError: null });
        return;
      }

      const state = useChatSessionsStore.getState();
      const session = state.sessions.find((item) => item.id === sessionId);
      const hostAfter = await window.electronAPI.chat.getHostStatus().catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }));

      useChatSessionsStore.setState({
        lastError: [
          'No assistant/tool progress after send (status may still show idle/stopped — Host did not emit failed; the SDK stream likely hung or errored without a result event).',
          `status=${session?.status ?? 'n/a'}`,
          `rawEvents=[${seenEvents.join(' ; ') || 'none'}]`,
          `hostAfter=${JSON.stringify(hostAfter)}`,
          `sessionId=${sessionId}`,
          `cwd=${workspacePath}`,
          'Click Retry to resend, or Stop. Check Claude auth / API in your CLAUDE_CONFIG_DIR settings.json.',
        ].join(' | '),
      });
      setRetryablePrompt(trimmed);
    } catch (err) {
      useChatSessionsStore.setState({
        lastError: err instanceof Error ? err.message : String(err),
      });
      setRetryablePrompt(trimmed);
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
      <div className="relative rounded-lg border bg-card/40 p-2">
        {/* T-07 @ 文件搜索 popup——放 textarea 上方，避免被 overflow-hidden 容器裁掉 */}
        {mentionOpen && (
          <div className="absolute bottom-full left-2 mb-1 w-72 overflow-hidden rounded-lg border bg-popover shadow-lg">
            <div className="max-h-[240px] overflow-y-auto py-1">
              {mentionResults.map((item, i) => {
                const lastSep = item.relativePath.lastIndexOf('/');
                const dirPart = lastSep > 0 ? item.relativePath.slice(0, lastSep) : '';
                const fileName =
                  lastSep > 0 ? item.relativePath.slice(lastSep + 1) : item.relativePath;
                return (
                  <button
                    type="button"
                    key={item.path}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insertMention(item);
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                    className={cn(
                      'w-full px-3 py-1.5 text-left text-sm transition-colors',
                      i === mentionIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-accent/50'
                    )}
                  >
                    {/* T-07①: directories are selectable now — mark them so a
                        folder is not mistaken for a same-named file. */}
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {item.isDirectory ? (
                        <Folder className="size-3.5 shrink-0 text-[#dcb67a]" />
                      ) : (
                        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">
                        {fileName}
                        {item.isDirectory ? '/' : ''}
                      </span>
                    </span>
                    {dirPart && (
                      <span className="ml-1.5 text-xs text-muted-foreground">{dirPart}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px] leading-none">
                  ↑↓
                </kbd>
                Navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px] leading-none">
                  Enter
                </kbd>
                Select
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-[10px] leading-none">
                  Esc
                </kbd>
                Close
              </span>
              {/* T-07③: searching `chat` here matches 304 files but only 10
                  render — say so instead of truncating silently. */}
              {mentionTotal > mentionResults.length && (
                <span className="ml-auto shrink-0 tabular-nums">
                  {mentionResults.length}/{mentionTotal}
                </span>
              )}
            </div>
          </div>
        )}
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => handleContentChange(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const ta = textareaRef.current;
            if (!cwd || !ta) {
              setMentionQuery(null);
              return;
            }
            setMentionQuery(extractMentionQuery(event.currentTarget.value, ta.selectionStart));
            setMentionIndex(0);
          }}
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
            // T-07 @ popup：popup 开时拦截方向键 / Enter / Esc，避免误发。
            if (mentionOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setMentionIndex((i) => (i + 1) % mentionResults.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setMentionIndex((i) => (i - 1 + mentionResults.length) % mentionResults.length);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                insertMention(mentionResults[mentionIndex]);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setMentionQuery(null);
                setMentionResults([]);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
        />
        {mentionChips.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {mentionChips.map((chip, idx) => (
              <span
                key={`${chip.path}-${idx}`}
                className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
              >
                {chip.path}
              </span>
            ))}
          </div>
        )}
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
              <>
                <ModelSelect sessionId={activeSessionId} disabled={disabled || busy || sending} />
                {/* T-20: effort sits next to the model — both are per-session
                    generation settings applied at the next createSession. */}
                <EffortSelect sessionId={activeSessionId} disabled={disabled || busy || sending} />
              </>
            )}
            {canStop ? (
              <Button
                size="sm"
                variant="destructive"
                className="h-6"
                disabled={disabled}
                onClick={() => void stopActiveSession()}
              >
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            ) : (
              <>
                {canRetry && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6"
                    disabled={disabled}
                    onClick={() => void handleRetry()}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                )}
                <Button
                  size="sm"
                  className="h-6"
                  disabled={!canSend || !value.trim()}
                  onClick={() => void handleSend()}
                >
                  <SendHorizonal className="h-3.5 w-3.5" />
                  {sending ? 'Sending…' : 'Send'}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
