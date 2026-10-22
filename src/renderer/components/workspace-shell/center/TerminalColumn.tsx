/**
 * dsh-rebase P1-11 (decisions 109, 126, 128; prototype scene G): the shell
 * terminal of the conversation's folder.
 *
 * Layout 5d: the 终端 pane. Its card's header names it, shows the
 * conversation's folder and holds the button that ends the shell; the column
 * itself draws no title row.
 *
 * Every running column shell stays mounted here, one layer per folder, so a
 * conversation switch never tears one down (`useXterm`'s unmount detaches the
 * pty, and a local shell dies on its last detach). Only the layer of the folder
 * on screen is visible. Hidden layers keep their layout box — `invisible`,
 * never `display: none` — or xterm's FitAddon measures nothing and shrinks the
 * pty to two columns; the same rule `TerminalSurfaceView` documents.
 */
import { getDisplayPath } from '@shared/utils/path';
import { Power } from 'lucide-react';
import { useMemo } from 'react';
import { ShellTerminal } from '@/components/terminal/ShellTerminal';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import { defaultDarkTheme, getXtermTheme } from '@/lib/ghosttyTheme';
import { cn } from '@/lib/utils';
import { useColumnTerminalStore } from '@/stores/columnTerminal';
import { useSettingsStore } from '@/stores/settings';
import { PaneHeaderPortal } from '../panes/paneSlots';
import { SURFACE_ESCAPE_HOLD_ATTR } from '../shellLayoutModel';

/** Computed key so a rename of the constant cannot leave a dead attribute behind. */
const ESCAPE_HOLD_PROPS = { [SURFACE_ESCAPE_HOLD_ATTR]: '' };

interface TerminalColumnProps {
  /** `columnTerminalKey` of the folder on screen; null when it has none. */
  currentKey: string | null;
  /** The terminal pane is on screen (it has focus rights). */
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
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={t('Terminal')}
      data-testid="terminal-column"
      {...ESCAPE_HOLD_PROPS}
    >
      {/* Layout 5d: the pane card's header says 「终端」; the folder goes
          next to it and the button that ends the shell among its actions —
          no row of its own. The card's ✕ only hides the pane. */}
      {current && (
        <>
          <PaneHeaderPortal slot="context">
            <Ident
              className="min-w-0 truncate text-small text-foreground-faint"
              title={`${t('Session directory')}: ${getDisplayPath(current.cwd)}`}
            >
              {getDisplayPath(current.cwd)}
            </Ident>
          </PaneHeaderPortal>
          <PaneHeaderPortal slot="actions">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => close(current.key)}
              aria-label={t('Close terminal')}
              title={t('Close terminal')}
            >
              <Power className="size-4" />
            </Button>
          </PaneHeaderPortal>
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
