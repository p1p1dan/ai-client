/**
 * T-15: the terminal context surface — `TerminalPanel` hosted in the right
 * panel, registered with `mountPolicy: 'keep-alive'`.
 *
 * Three things here are load bearing, and all three are about lifetime:
 *
 * 1. `TerminalPanel` is rendered UNCONDITIONALLY. Its per-worktree group/tab
 *    map (`WorktreeGroupStates`) is component state keyed by
 *    `normalizePath(cwd)`, so switching Workspace A → B → A only restores A's
 *    groups while this component stays mounted. An unmount also unmounts every
 *    `ShellTerminal`, and `useXterm`'s teardown detaches the pty — a local
 *    session created with `persistOnDisconnect: false` is destroyed on its last
 *    detach (`SessionManager.detach` → `localPtyManager.destroy`). So "render
 *    the empty state instead" would silently kill running shells; the empty
 *    state is layered OVER a still-mounted panel instead.
 * 2. Hiding uses `invisible` (visibility), never `display: none` — a hidden
 *    layer must keep its layout box or xterm's FitAddon measures zero and
 *    resizes the pty to `cols: 2`. Same rule as the keep-alive stack in
 *    `ContextPanel`.
 * 3. `isActive` tracks the ACTIVE SURFACE, not "the panel is open". Under
 *    keep-alive this view stays mounted while the panel shows git/editor, and
 *    `isActive` is what makes `useXterm` call `terminal.focus()` — binding it
 *    to anything wider would steal focus from whatever surface the user is
 *    actually looking at.
 *
 * The terminal container carries `data-surface-holds-escape` so the panel's
 * capture-phase Escape (S0 / F-c) does not swallow Escape on its way to vim,
 * less, the tab rename input or the terminal search bar. The attribute sits on
 * the panel layer only: with the empty state showing, focus is outside it and
 * Escape closes the panel as usual.
 */
import { SquareTerminal } from 'lucide-react';
import { TEMP_REPO_ID } from '@/App/constants';
import { TerminalPanel } from '@/components/terminal';
import { deriveTerminalPresentation } from '@/components/terminal/terminalSurfaceModel';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { SURFACE_ESCAPE_HOLD_ATTR } from '../shellLayoutModel';
import type { SurfaceViewProps } from '../surfaceViews';
import {
  resolveTerminalWorkspace,
  type TerminalWorkspaceUnavailableReason,
} from './terminalWorkspace';

/** A06: one honest sentence per real reason, no shared "nothing here" blur. */
const UNAVAILABLE_DESCRIPTION: Record<TerminalWorkspaceUnavailableReason, string> = {
  'no-session': 'Select a session to open a terminal',
  'no-workspace': 'This session has no workspace',
  'no-path': 'This workspace has no local path',
};

/** Computed key so a rename of the constant cannot leave a dead attribute behind. */
const ESCAPE_HOLD_PROPS = { [SURFACE_ESCAPE_HOLD_ATTR]: '' };

export function TerminalSurfaceView({ surfaceId }: SurfaceViewProps) {
  const { t } = useI18n();

  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);

  const activeSurfaceId = useShellLayoutStore((state) => state.activeSurfaceId);
  const expanded = useShellLayoutStore((state) => state.expanded);

  const resolution = resolveTerminalWorkspace({ activeSessionId, sessions, workspaces });
  const ready = resolution.status === 'ready';

  return (
    <div className="relative h-full w-full">
      <div
        {...ESCAPE_HOLD_PROPS}
        className={cn('absolute inset-0', !ready && 'invisible pointer-events-none')}
        inert={!ready}
      >
        <TerminalPanel
          cwd={resolution.status === 'ready' ? resolution.path : undefined}
          // Only used to pick between autoCreateSessionOnActivate and
          // autoCreateSessionOnTempActivate; a temp workspace is the new
          // shell's equivalent of the legacy TEMP_REPO_ID selection.
          repoPath={resolution.status === 'ready' && resolution.isTemp ? TEMP_REPO_ID : undefined}
          // Narrower than "this surface is active" by `ready` on purpose:
          // without a cwd the panel's own Cmd+T/Cmd+W handlers preventDefault
          // and then do nothing, so the chords would vanish over an empty state.
          isActive={activeSurfaceId === surfaceId && ready}
          presentation={deriveTerminalPresentation({ expanded })}
        />
      </div>
      {resolution.status === 'unavailable' && (
        <Empty className="absolute inset-0 h-full gap-3 border-0 p-2 md:p-2">
          <EmptyMedia variant="icon">
            <SquareTerminal className="h-4.5 w-4.5" />
          </EmptyMedia>
          <EmptyHeader>
            {/* D25 §3.3: cancel EmptyTitle's 18px-sized negative tracking when
                overriding to 14px, same as SurfacePlaceholder. */}
            <EmptyTitle className="text-ui tracking-normal">{t('Terminal')}</EmptyTitle>
            <EmptyDescription className="text-meta">
              {t(UNAVAILABLE_DESCRIPTION[resolution.reason])}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
