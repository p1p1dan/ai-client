/**
 * dsh-rebase P1-11 (decisions 109, 126, 128; prototype scene G): the shell
 * terminal of the conversation's folder.
 *
 * Layout 5a (ruling L4): the work panel's 终端 tab. The panel's tab strip
 * names it, so the column's own h-10 tab bar (and its Files button — the
 * strip's 编辑器 tab does that now) went; what stays is one row with the
 * conversation's folder and the button that ends the shell.
 *
 * Every running column shell stays mounted here, one layer per folder, so a
 * conversation switch never tears one down (`useXterm`'s unmount detaches the
 * pty, and a local shell dies on its last detach). Only the layer of the folder
 * on screen is visible. Hidden layers keep their layout box — `invisible`,
 * never `display: none` — or xterm's FitAddon measures nothing and shrinks the
 * pty to two columns; the same rule `TerminalSurfaceView` documents.
 */
import { getDisplayPath } from '@shared/utils/path';
import { X } from 'lucide-react';
import { useMemo } from 'react';
import { ShellTerminal } from '@/components/terminal/ShellTerminal';
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
  /** The work panel shows the terminal tab (it has focus rights). */
  visible: boolean;
}

export function TerminalColumn({ currentKey, visible }: TerminalColumnProps) {
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
      className="flex h-full min-h-0 min-w-0 flex-col bg-surface-1"
      aria-label={t('Terminal')}
      data-testid="terminal-column"
      {...ESCAPE_HOLD_PROPS}
    >
      {current && (
        // Design system v2 §4.2: the one strip header height (h-8), one
        // hairline below.
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-soft px-3 text-small">
          <span className="shrink-0 text-muted-foreground">{t('Session directory')}</span>
          <Ident
            className="min-w-0 flex-1 truncate text-foreground"
            title={getDisplayPath(current.cwd)}
          >
            {getDisplayPath(current.cwd)}
          </Ident>
          <button
            type="button"
            onClick={() => close(current.key)}
            aria-label={t('Close terminal')}
            title={t('Close terminal')}
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
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
