/**
 * T-22 (D19): the extension point for wiring a real view onto a context
 * surface. Each of T-12~T-15 adds exactly one entry below and touches no
 * other file — a lookup table instead of a switch so the four tasks can land
 * in parallel without merge conflicts.
 *
 *   T-12 (git):      git: GitSurfaceView,
 *   T-13 (editor):   editor: EditorSurfaceView,
 *   T-14 (context):  context: ContextSurfaceView,
 *   T-15 (terminal): terminal: TerminalSurfaceView,
 *
 * Empty this round: every rail-visible surface falls back to
 * `SurfacePlaceholder` in `ContextPanel.tsx`.
 */
import type { ComponentType } from 'react';
import type { ContextSurfaceId } from './surfaceRegistry';

export interface SurfaceViewProps {
  surfaceId: ContextSurfaceId;
}

export const SURFACE_VIEWS: Partial<Record<ContextSurfaceId, ComponentType<SurfaceViewProps>>> = {};
