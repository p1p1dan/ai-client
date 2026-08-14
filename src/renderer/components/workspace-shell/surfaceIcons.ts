/**
 * D34: the surface icon → lucide component lookup, split out of the retired
 * `ContextPanelRail.tsx` so both its heirs can use it —
 * `MainHeader.tsx` (now home to the surface switcher) and
 * `SurfacePlaceholder.tsx` (the "not wired yet" empty state).
 *
 * Deliberately its own module rather than folded into either consumer:
 * `deadControlsStatic.test.ts` pins `MainHeader.tsx`'s own source text clean
 * of `Globe`/`AppWindow` (browser/preview stay rail-entered registry slots,
 * never a header entry) — importing the full icon set directly into
 * `MainHeader.tsx` would trip that fence even though neither icon is ever
 * rendered there (only the four always-available surfaces are).
 */
import {
  AppWindow,
  ArrowLeftRight,
  FileCode,
  FileText,
  Gauge,
  GitBranch,
  GitPullRequest,
  Globe,
  type LucideIcon,
  MessageSquare,
  SquareTerminal,
  StickyNote,
} from 'lucide-react';
import type { SurfaceIconName } from './surfaceRegistry';

export const SURFACE_ICON_MAP: Record<SurfaceIconName, LucideIcon> = {
  'file-code': FileCode,
  'git-branch': GitBranch,
  'git-pull-request': GitPullRequest,
  'arrow-left-right': ArrowLeftRight,
  'square-terminal': SquareTerminal,
  'file-text': FileText,
  'sticky-note': StickyNote,
  gauge: Gauge,
  globe: Globe,
  'app-window': AppWindow,
  'message-square': MessageSquare,
};
