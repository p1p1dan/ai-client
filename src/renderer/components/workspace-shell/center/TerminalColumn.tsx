/**
 * dsh-rebase P1-11 (decisions 109, 126, 128; prototype scene G): the shell
 * terminal in the right column, a peer of the file editor.
 *
 * It is not a tab inside `EditorTabs` — the column shows either the files or
 * the terminal, never both — but it wears the same chrome so the two read as
 * the same kind of thing: an h-10 bar holding one h-9 tab with the 2px
 * `bg-primary` top mark, and under it a path row where the editor shows its
 * breadcrumb, here the conversation's folder.
 *
 * Every running column shell stays mounted here, one layer per folder, so a
 * conversation switch never tears one down (`useXterm`'s unmount detaches the
 * pty, and a local shell dies on its last detach). Only the layer of the folder
 * on screen is visible. Hidden layers keep their layout box — `invisible`,
 * never `display: none` — or xterm's FitAddon measures nothing and shrinks the
 * pty to two columns; the same rule `TerminalSurfaceView` documents.
 */
import { getDisplayPath } from '@shared/utils/path';
import { FileCode, Terminal, X } from 'lucide-react';
import { useMemo } from 'react';
import { ShellTerminal } from '@/components/terminal/ShellTerminal';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import { defaultDarkTheme, getXtermTheme } from '@/lib/ghosttyTheme';
import { cn } from '@/lib/utils';
import { useColumnTerminalStore } from '@/stores/columnTerminal';
import { useSettingsStore } from '@/stores/settings';
import { SURFACE_ESCAPE_HOLD_ATTR } from '../shellLayoutModel';

/** Computed key so a rename of the constant cannot leave a dead attribute behind. */
const ESCAPE_HOLD_PROPS = { [SURFACE_ESCAPE_HOLD_ATTR]: '' };

interface TerminalColumnProps {
  /** `columnTerminalKey` of the folder on screen; null when it has none. */
  currentKey: string | null;
  /** The terminal is what the column shows (it has focus rights). */
  visible: boolean;
  /** Files are open underneath: offer the way back to them. */
  filesOpen: boolean;
  onShowFiles: () => void;
}

export function TerminalColumn({
  currentKey,
  visible,
  filesOpen,
  onShowFiles,
}: TerminalColumnProps) {
  const { t } = useI18n();
  const terminals = useColumnTerminalStore((state) => state.terminals);
  const close = useColumnTerminalStore((state) => state.close);
  const current = currentKey ? terminals[currentKey] : undefined;

  // Same backdrop `TerminalPanel` paints around its shells, so the inset
  // around the terminal reads as terminal, not as a frame of app background.
  const terminalTheme = useSettingsStore((state) => state.terminalTheme);
  const backgroundImageEnabled = useSettingsStore((state) => state.backgroundImageEnabled);
  const backdrop = useMemo(
    () =>
      backgroundImageEnabled
        ? 'transparent'
        : (getXtermTheme(terminalTheme)?.background ?? defaultDarkTheme.background),
    [terminalTheme, backgroundImageEnabled]
  );

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col border-l bg-background"
      aria-label={t('Terminal')}
      data-testid="terminal-column"
      {...ESCAPE_HOLD_PROPS}
    >
      {current && (
        <>
          <div className="flex h-10 shrink-0 items-start border-b">
            <div
              className="relative flex h-9 min-w-0 max-w-56 items-center gap-2 border-r px-3 text-ui text-foreground"
              data-testid="terminal-column-tab"
            >
              <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
              <Terminal className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t('Terminal')}</span>
              <button
                type="button"
                onClick={() => close(current.key)}
                aria-label={t('Close terminal')}
                title={t('Close terminal')}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-60 transition-opacity hover:bg-accent hover:text-foreground hover:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="ml-auto flex h-9 shrink-0 items-center gap-0.5 pr-1">
              {filesOpen && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={t('Files')}
                  aria-label={t('Files')}
                  onClick={onShowFiles}
                >
                  <FileCode className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-meta">
            <span className="shrink-0 text-muted-foreground">{t('Session directory')}</span>
            <Ident
              className="min-w-0 flex-1 truncate text-foreground"
              title={getDisplayPath(current.cwd)}
            >
              {getDisplayPath(current.cwd)}
            </Ident>
          </div>
        </>
      )}
      <div className="relative min-h-0 flex-1" style={{ backgroundColor: backdrop }}>
        {Object.values(terminals).map((entry) => {
          const shown = entry.key === currentKey;
          return (
            <div
              key={entry.key}
              className={cn('absolute inset-2', !shown && 'pointer-events-none invisible')}
              inert={!shown}
              aria-hidden={shown ? undefined : true}
              data-column-terminal={entry.key}
            >
              <ShellTerminal
                cwd={entry.cwd}
                isActive={visible && shown}
                // One shell per folder: the column has no second group to
                // split into (the context menu and the split chord both off).
                canSplit={false}
                onExit={() => close(entry.key)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
