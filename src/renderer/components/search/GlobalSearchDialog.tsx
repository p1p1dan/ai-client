import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import type { ContentSearchMatch, FileSearchResult } from '@shared/types';
import {
  CaseSensitive,
  FileCode,
  FileText,
  Filter,
  MessageCircle,
  Regex,
  Search,
  WholeWord,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogBackdrop, DialogPortal, DialogViewport } from '@/components/ui/dialog';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { ChatSearchResultList } from './ChatSearchResultList';
import { SearchPreviewPanel } from './SearchPreviewPanel';
import { SearchResultList } from './SearchResultList';
import { type ChatSearchRow, type ChatSearchScopeKind, useChatSearch } from './useChatSearch';
import { type SearchMode, useGlobalSearch } from './useGlobalSearch';

interface GlobalSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The current workspace. Without one only the 「对话」 tab works: the file
   * and content tabs search a workspace's files.
   */
  rootPath: string | null | undefined;
  initialMode?: SearchMode;
  onOpenFile: (path: string, line?: number, column?: number, matchLength?: number) => void;
  /** Chat search: open a chat at its matches (`query` is the text as typed, trimmed). */
  onOpenChat?: (row: ChatSearchRow, query: string) => void;
}

/** One mode tab: the v2 selection fill, no frame of its own. */
function ModeTab({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      title={title}
      className={cn(
        'flex items-center gap-1 rounded-sm px-2 py-1 disabled:pointer-events-none disabled:opacity-50',
        active
          ? 'bg-fill-ghost-selected text-foreground'
          : 'text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function GlobalSearchDialog({
  open,
  onOpenChange,
  rootPath,
  initialMode = 'chat',
  onOpenFile,
  onOpenChat,
}: GlobalSearchDialogProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dividerY, setDividerY] = useState(50);
  const [scope, setScope] = useState<ChatSearchScopeKind>('all');
  const hasRoot = Boolean(rootPath);

  const {
    mode,
    query,
    options,
    fileResults,
    contentResults,
    selectedIndex,
    isLoading,
    setQuery,
    setMode,
    setOptions,
    setSelectedIndex,
    moveSelection,
    getSelectedItem,
    reset,
  } = useGlobalSearch(rootPath ?? undefined);

  const chat = useChatSearch({
    query,
    scope,
    currentRoot: rootPath ?? null,
    active: open && mode === 'chat',
  });

  const openChat = useCallback(
    (row: ChatSearchRow) => {
      onOpenChange(false);
      onOpenChat?.(row, query.trim());
    },
    [onOpenChange, onOpenChat, query]
  );

  // Set initial mode when opening
  useEffect(() => {
    if (open) {
      // The file tabs need a workspace; without one the dialog opens on chats.
      setMode(initialMode !== 'chat' && !hasRoot ? 'chat' : initialMode);
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      reset();
    }
  }, [open, initialMode, hasRoot, setMode, reset]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 中文输入法正在输入时不处理
      if (e.nativeEvent.isComposing) return;

      if (mode === 'chat') {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          chat.moveSelection(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (chat.selectedRow) openChat(chat.selectedRow);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onOpenChange(false);
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveSelection(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveSelection(-1);
          break;
        case 'Enter': {
          e.preventDefault();
          const item = getSelectedItem();
          if (item) {
            if ('line' in item) {
              // ContentSearchMatch
              onOpenFile(item.path, item.line, item.column, item.matchLength);
            } else {
              // FileSearchResult
              onOpenFile(item.path);
            }
            onOpenChange(false);
          }
          break;
        }
        case 'Escape':
          e.preventDefault();
          onOpenChange(false);
          break;
      }
    },
    [mode, chat, openChat, moveSelection, getSelectedItem, onOpenFile, onOpenChange]
  );

  // Resizer handling
  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startDividerY = dividerY;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const container = (e.target as HTMLElement).closest('[data-search-container]');
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const deltaY = moveEvent.clientY - startY;
        const deltaPercent = (deltaY / rect.height) * 100;
        const newY = Math.max(20, Math.min(80, startDividerY + deltaPercent));
        setDividerY(newY);
      };

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [dividerY]
  );

  const handleItemSelect = useCallback(
    (item: FileSearchResult | ContentSearchMatch) => {
      if ('line' in item) {
        onOpenFile(item.path, item.line, item.column, item.matchLength);
      } else {
        onOpenFile(item.path);
      }
      onOpenChange(false);
    },
    [onOpenFile, onOpenChange]
  );

  const selectedItem = getSelectedItem();
  const previewPath = selectedItem?.path ?? null;
  const previewLine = selectedItem && 'line' in selectedItem ? selectedItem.line : undefined;

  const totalMatches = mode === 'files' ? fileResults.length : (contentResults?.totalMatches ?? 0);
  const totalFiles = mode === 'files' ? fileResults.length : (contentResults?.totalFiles ?? 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop style={{ zIndex: Z_INDEX.MODAL_BACKDROP }} />
        <DialogViewport
          className="grid-rows-[1fr_auto_1fr]"
          style={{ zIndex: Z_INDEX.MODAL_CONTENT }}
        >
          <DialogPrimitive.Popup
            className="no-drag pointer-events-auto relative row-start-2 flex min-h-0 w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
            style={{ height: '70vh' }}
            data-search-container
            onKeyDown={handleKeyDown}
          >
            {/* Search Header */}
            <div className="flex shrink-0 flex-col border-b">
              {/* Search Input Row */}
              <div className="flex h-12 items-center gap-2 px-3">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  ref={inputRef}
                  type="text"
                  className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-muted-foreground"
                  placeholder={
                    mode === 'chat'
                      ? t('Search chat titles and messages')
                      : mode === 'files'
                        ? t('Search file name...')
                        : t('Search in files...')
                  }
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query && (
                  <button
                    type="button"
                    className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground"
                    onClick={() => setQuery('')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {mode !== 'chat' && (
                  <>
                    <div className="mx-1 h-4 w-px bg-border" />
                    {/* Search Options */}
                    <button
                      type="button"
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground',
                        options.caseSensitive && 'bg-primary/20 text-primary'
                      )}
                      onClick={() => setOptions({ caseSensitive: !options.caseSensitive })}
                      title={t('Match case')}
                    >
                      <CaseSensitive className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground',
                        options.wholeWord && 'bg-primary/20 text-primary'
                      )}
                      onClick={() => setOptions({ wholeWord: !options.wholeWord })}
                      title={t('Match whole word')}
                    >
                      <WholeWord className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground',
                        options.regex && 'bg-primary/20 text-primary'
                      )}
                      onClick={() => setOptions({ regex: !options.regex })}
                      title={t('Use regular expression')}
                    >
                      <Regex className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground',
                        options.useGitignore && 'bg-primary/20 text-primary'
                      )}
                      onClick={() => setOptions({ useGitignore: !options.useGitignore })}
                      title={t('Use .gitignore')}
                    >
                      <Filter className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>

              {/* Mode Tabs + Stats */}
              <div className="flex h-9 items-center gap-1 px-3 text-small" role="tablist">
                <ModeTab active={mode === 'chat'} onClick={() => setMode('chat')}>
                  <MessageCircle className="size-3.5" />
                  {t('Chats')}
                </ModeTab>
                <ModeTab
                  active={mode === 'files'}
                  disabled={!hasRoot}
                  title={hasRoot ? undefined : t('Open a chat in a repository to search it')}
                  onClick={() => setMode('files')}
                >
                  <FileText className="size-3.5" />
                  {t('Files')} (P)
                </ModeTab>
                <ModeTab
                  active={mode === 'content'}
                  disabled={!hasRoot}
                  title={hasRoot ? undefined : t('Open a chat in a repository to search it')}
                  onClick={() => setMode('content')}
                >
                  <FileCode className="size-3.5" />
                  {t('Content')} (F)
                </ModeTab>
                <div className="flex-1" />
                {mode === 'chat' && (
                  <ToggleGroup
                    size="sm"
                    value={[hasRoot ? scope : 'all']}
                    onValueChange={(value) => {
                      const next = (value as string[])[0];
                      if (next === 'all' || next === 'workspace') setScope(next);
                    }}
                    aria-label={t('Which chats')}
                  >
                    <ToggleGroupItem value="all">{t('All repositories')}</ToggleGroupItem>
                    <ToggleGroupItem value="workspace" disabled={!hasRoot}>
                      {t('Current repository')}
                    </ToggleGroupItem>
                  </ToggleGroup>
                )}
                {mode !== 'chat' && query && !isLoading && (
                  <span className="text-muted-foreground">
                    {mode === 'content'
                      ? t('{{count}} matches in {{files}} files', {
                          count: totalMatches,
                          files: totalFiles,
                        })
                      : t('{{count}} files', { count: totalMatches })}
                  </span>
                )}
              </div>
            </div>

            {/* Results Area */}
            {mode === 'chat' ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <ChatSearchResultList
                  rows={chat.rows}
                  query={query}
                  recent={chat.recent}
                  indexing={chat.indexing}
                  loading={chat.loading}
                  failed={chat.failed}
                  selectedIndex={chat.selectedIndex}
                  onSelect={chat.setSelectedIndex}
                  onOpen={openChat}
                />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                {/* Result List */}
                <div style={{ height: `${dividerY}%` }} className="min-h-0 overflow-hidden">
                  <SearchResultList
                    mode={mode}
                    fileResults={fileResults}
                    contentResults={contentResults}
                    selectedIndex={selectedIndex}
                    onSelect={setSelectedIndex}
                    onOpen={handleItemSelect}
                    query={query}
                  />
                </div>

                {/* Resizer */}
                <div
                  className="group relative h-1 shrink-0 cursor-row-resize bg-border hover:bg-primary/50 transition-colors"
                  onMouseDown={handleDividerMouseDown}
                >
                  <div className="absolute inset-x-0 -top-1 -bottom-1" />
                </div>

                {/* Preview Panel */}
                <div style={{ height: `${100 - dividerY}%` }} className="min-h-0 overflow-hidden">
                  <SearchPreviewPanel path={previewPath} line={previewLine} query={query} />
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="flex h-8 shrink-0 items-center justify-between border-t px-3 text-small text-muted-foreground">
              <div className="flex items-center gap-2">
                <span>↑↓ {t('Navigate')}</span>
                <span>↵ {t('Open')}</span>
                <span>Esc {t('Close')}</span>
              </div>
              {mode === 'content' && (
                <div className="flex items-center gap-1">
                  <span>{t('File mask')}:</span>
                  <input
                    type="text"
                    className="h-5 w-20 rounded border bg-background px-1 text-small outline-none focus:border-primary"
                    placeholder="*.ts"
                    value={options.filePattern}
                    onChange={(e) => setOptions({ filePattern: e.target.value })}
                  />
                </div>
              )}
            </div>
          </DialogPrimitive.Popup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
