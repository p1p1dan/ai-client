import { AUTH_OPEN_ONBOARDING_EVENT } from '@shared/authGate';
import { isRemoteVirtualPath } from '@shared/utils/remotePath';
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TerminalSearchBar,
  type TerminalSearchBarRef,
} from '@/components/terminal/TerminalSearchBar';
import { Button } from '@/components/ui/button';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useTerminalScrollToBottom } from '@/hooks/useTerminalScrollToBottom';
import { useXterm } from '@/hooks/useXterm';
import { useI18n } from '@/i18n';
import { useTerminalWriteStore } from '@/stores/terminalWrite';
import { AUTH_REQUIRED_ERROR_VIEW, isAuthRequiredError } from './authRequiredError';

interface AgentTerminalProps {
  id: string;
  cwd: string;
  /**
   * Q17: the chat session's durable JSONL. When present the terminal continues
   * that conversation (`pi --session <file>`) instead of starting a new one.
   */
  sessionFile?: string;
  initialPrompt?: string;
  isActive?: boolean;
  canMerge?: boolean;
  enhancedInputOpen?: boolean;
  onEnhancedInputOpenChange?: (open: boolean) => void;
  onInitialized?: () => void;
  onActivated?: () => void;
  onExit?: () => void;
  onTerminalTitleChange?: (title: string) => void;
  onSplit?: () => void;
  onMerge?: () => void;
  onFocus?: () => void;
  onRegisterEnhancedInputSender?: (
    sessionId: string,
    sender: (content: string, imagePaths: string[]) => void
  ) => void;
  onUnregisterEnhancedInputSender?: (sessionId: string) => void;
}

export function AgentTerminal({
  id,
  cwd,
  sessionFile,
  initialPrompt,
  isActive = false,
  canMerge = false,
  onInitialized,
  onActivated,
  onExit,
  onTerminalTitleChange,
  onSplit,
  onMerge,
  onFocus,
  onRegisterEnhancedInputSender,
  onUnregisterEnhancedInputSender,
}: AgentTerminalProps) {
  const { t } = useI18n();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchBarRef = useRef<TerminalSearchBarRef>(null);
  const activatedRef = useRef(false);
  const { register, unregister } = useTerminalWriteStore();
  // Pi TUI is a local node-pty launch of the bundled CLI, so a remote virtual
  // cwd has no local directory to spawn in. Keep the terminal dormant and
  // explain why instead of failing on an unusable spawn path.
  const isRemoteWorkspace = isRemoteVirtualPath(cwd);
  const {
    containerRef,
    isLoading,
    startupError,
    runtimeState,
    settings,
    terminal,
    write,
    findNext,
    findPrevious,
    clearSearch,
    clear,
    refreshRenderer,
  } = useXterm({
    piTuiTerminalId: id,
    ...(sessionFile ? { piTuiSessionFile: sessionFile } : {}),
    cwd,
    initialCommand: isRemoteWorkspace ? undefined : initialPrompt,
    isActive: isActive && !isRemoteWorkspace,
    kind: 'agent',
    onInit: onInitialized,
    onExit,
    onData: undefined,
    onTitleChange: onTerminalTitleChange,
    onSplit,
    onMerge,
    canMerge,
    onCustomKey: (event) => {
      if (
        event.type === 'keydown' &&
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing &&
        !activatedRef.current
      ) {
        activatedRef.current = true;
        onActivated?.();
      }
      return true;
    },
  });

  useEffect(() => {
    if (!write) return;
    register(id, write, () => terminal?.focus());
    return () => unregister(id);
  }, [id, register, unregister, terminal, write]);

  const sendEnhancedInput = useCallback(
    (content: string, imagePaths: string[]) => {
      const imageText = imagePaths.length > 0 ? `\n\n${imagePaths.join(' ')}` : '';
      const message = `${content}${imageText}`;
      if (message.includes('\n')) write(`\x1b[200~${message}\x1b[201~`);
      else write(message);
      window.setTimeout(() => write('\r'), imagePaths.length > 0 ? 800 : 30);
      terminal?.focus();
    },
    [terminal, write]
  );

  useEffect(() => {
    onRegisterEnhancedInputSender?.(id, sendEnhancedInput);
    return () => onUnregisterEnhancedInputSender?.(id);
  }, [id, onRegisterEnhancedInputSender, onUnregisterEnhancedInputSender, sendEnhancedInput]);

  const terminalWrapperRef = useFileDrop<HTMLDivElement>({
    cwd,
    onDrop: (paths) => {
      if (paths.length > 0) write(paths.map((path) => `@${path}`).join(' '));
      terminal?.focus();
    },
  });
  const { showScrollToBottom, handleScrollToBottom } = useTerminalScrollToBottom(terminal);

  return (
    <div
      ref={terminalWrapperRef}
      className="relative h-full w-full"
      style={{ backgroundColor: settings.theme.background, contain: 'strict' }}
      onClick={onFocus}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onFocus?.();
      }}
      role="presentation"
    >
      <div ref={containerRef} className="h-full w-full" />
      <TerminalSearchBar
        ref={searchBarRef}
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onFindNext={findNext}
        onFindPrevious={findPrevious}
        onClearSearch={clearSearch}
        theme={settings.theme}
      />
      {showScrollToBottom && (
        <button
          type="button"
          onClick={handleScrollToBottom}
          className="absolute bottom-12 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-primary/80 text-primary-foreground"
          title={t('Scroll to bottom')}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
      {isRemoteWorkspace && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/90 text-sm">
          <strong>{t('Pi terminal is unavailable for remote repositories')}</strong>
          <span className="text-muted-foreground">
            {t('Open a local repository or worktree to start a Pi terminal.')}
          </span>
        </div>
      )}
      {isLoading && !isRemoteWorkspace && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {t('Loading Pi...')}
        </div>
      )}
      {startupError && isAuthRequiredError(startupError) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/90 text-sm">
          <strong>{AUTH_REQUIRED_ERROR_VIEW.title}</strong>
          <span className="text-muted-foreground">{AUTH_REQUIRED_ERROR_VIEW.message}</span>
          <Button
            size="sm"
            onClick={() => window.dispatchEvent(new CustomEvent(AUTH_OPEN_ONBOARDING_EVENT))}
          >
            {AUTH_REQUIRED_ERROR_VIEW.actionLabel}
          </Button>
        </div>
      )}
      {runtimeState === 'dead' && !isLoading && !startupError && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/70 text-sm">
          {t('Pi terminal disconnected')}
        </div>
      )}
      <button
        type="button"
        className="hidden"
        onClick={() => {
          clear();
          refreshRenderer();
          setIsSearchOpen(true);
        }}
        aria-label={t('Search')}
      />
    </div>
  );
}
