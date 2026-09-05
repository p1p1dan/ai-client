/**
 * T-22 (D19): the extension point for wiring a real view onto a context
 * surface. Each of T-12~T-15 adds exactly one entry below and touches no
 * other file — a lookup table instead of a switch so the four tasks can land
 * in parallel without merge conflicts. S0 only widened the value from a bare
 * component to `{ component, mountPolicy }`; the one-line-per-task contract is
 * unchanged.
 *
 *   T-12 (git):      git:      { component: GitSurfaceView,      mountPolicy: 'active' },
 *   T-13 (editor):   editor:   { component: EditorSurfaceView,   mountPolicy: 'active' },
 *   T-14 (context):  context:  { component: ContextSurfaceView,  mountPolicy: 'active' },
 *   T-15 (terminal): terminal: { component: TerminalSurfaceView, mountPolicy: 'keep-alive' },
 *
 * `mountPolicy` is read by `deriveMountedSurfaceIds` (shellLayoutModel.ts) and
 * decides lifetime, not looks: 'active' mounts only while the panel shows the
 * surface, 'keep-alive' stays mounted from its first activation onwards so a
 * live child process (T-15's pty) is never torn down by a surface switch.
 * Default to 'active'; pick 'keep-alive' only for a view that owns state the
 * renderer cannot rebuild.
 *
 * A surface without an entry falls back to `SurfacePlaceholder` in
 * `ContextPanel.tsx` (all four rail surfaces are wired as of T-12~T-15).
 */
import type { ComponentType } from 'react';
import type { SurfaceMountPolicy } from './shellLayoutModel';
import type { ContextSurfaceId } from './surfaceRegistry';
import { ContextSurfaceView } from './surfaces/ContextSurfaceView';
import { FilesSurfaceView } from './surfaces/FilesSurfaceView';
import { GitSurfaceView } from './surfaces/GitSurfaceView';
import { RunSurfaceView } from './surfaces/RunSurfaceView';
import { TerminalSurfaceView } from './surfaces/TerminalSurfaceView';

export interface SurfaceViewProps {
  surfaceId: ContextSurfaceId;
}

export interface SurfaceViewRegistration {
  component: ComponentType<SurfaceViewProps>;
  mountPolicy: SurfaceMountPolicy;
}

export const SURFACE_VIEWS: Partial<Record<ContextSurfaceId, SurfaceViewRegistration>> = {
  context: { component: ContextSurfaceView, mountPolicy: 'active' },
  // T-32 (D27): the `editor` slot renders the file TREE now — the editor moved
  // to the center column (`center/EditorColumn.tsx`), which is mounted by
  // WorkspaceShell, not by this registry.
  editor: { component: FilesSurfaceView, mountPolicy: 'active' },
  git: { component: GitSurfaceView, mountPolicy: 'active' },
  // U06-a: 'active' — the panel is a pure projection of stores that keep
  // updating whether it is mounted or not, so there is nothing to keep alive.
  run: { component: RunSurfaceView, mountPolicy: 'active' },
  // keep-alive: a surface switch must never tear down the pty (spec §5, R2).
  terminal: { component: TerminalSurfaceView, mountPolicy: 'keep-alive' },
};
