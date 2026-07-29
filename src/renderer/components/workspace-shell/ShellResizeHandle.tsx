/**
 * T-22 (D19) batch 3: shared drag handle for the sidebar (right edge) and
 * ContextPanel (left edge). Owns markup/accessibility only — all sizing math
 * lives in `usePanelDragResize`.
 */
import type { RefObject } from 'react';
import { cn } from '@/lib/utils';
import { usePanelDragResize } from './usePanelDragResize';

interface ShellResizeHandleProps {
  /** 'right' = handle on the element's right edge (sidebar); 'left' = left edge (panel). */
  side: 'left' | 'right';
  ariaLabel: string;
  /** Committed width used as the drag baseline. */
  width: number;
  targetRef: RefObject<HTMLElement | null>;
  clamp: (width: number) => number;
  onCommit: (width: number) => void;
  onResizingChange?: (resizing: boolean) => void;
  disabled?: boolean;
}

export function ShellResizeHandle({
  side,
  ariaLabel,
  width,
  targetRef,
  clamp,
  onCommit,
  onResizingChange,
  disabled,
}: ShellResizeHandleProps) {
  const { resizing, handleProps } = usePanelDragResize({
    side,
    width,
    targetRef,
    clamp,
    onCommit,
    onResizingChange,
    disabled,
  });

  return (
    // Pointer-only drag handle (matches the design spec's exact markup): no
    // keyboard-driven resize is in scope for T-22, so this stays a
    // non-focusable separator; `aria-valuenow` satisfies a11y/useAriaPropsForRole.
    // biome-ignore lint/a11y/useFocusableInteractive: pointer-only resize handle, no keyboard resize in scope
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-label={ariaLabel}
      data-resizing={resizing || undefined}
      className={cn(
        'absolute inset-y-0 z-10 w-1 cursor-col-resize touch-none select-none hover:bg-border data-[resizing]:bg-accent-primary',
        side === 'right' ? 'right-0' : 'left-0'
      )}
      {...handleProps}
    />
  );
}
