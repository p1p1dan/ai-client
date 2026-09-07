import { type RefObject, useCallback, useEffect, useState } from 'react';
import {
  COMPOSER_POPUP_DESIRED_HEIGHT,
  type ComposerPopupPlacement,
  type PopupSide,
  resolveComposerPopupPlacement,
} from './middleColumnLayout';

/**
 * F11: measure the composer card and hand `resolveComposerPopupPlacement` the
 * numbers it needs.
 *
 * Deliberately thin. Every judgement — which side wins, how tall the popup may
 * be — is in the pure resolver, which the node-env vitest can actually reach;
 * this hook only supplies `getBoundingClientRect` and re-measures when the
 * measurement could have gone stale.
 *
 * ## What it listens to, and why `visualViewport` is not optional
 *
 * `window.resize` covers the window changing size. It does NOT cover a software
 * keyboard opening: the layout viewport is unchanged, so no `resize` fires,
 * while the space actually visible shrinks by the height of the keyboard.
 * `visualViewport` is the only source that reports that, and the field report
 * lists IME popup as one of the cases the popup must survive — so it is a
 * required input, not a progressive enhancement. `visualViewport.height` is
 * likewise used in preference to `innerHeight` for the same reason.
 *
 * Scroll is listened to as well: the anchor is the composer card, which moves
 * within the viewport when the surrounding column scrolls, and a popup measured
 * against last frame's position is exactly the "it was fine until I scrolled"
 * class of bug.
 *
 * Measurement runs only while `open`. A closed popup has nothing to place, and
 * a permanently-attached scroll listener on a chat timeline is not free.
 */
export function useComposerPopupPlacement(input: {
  anchorRef: RefObject<HTMLElement | null>;
  /** The side the composer's mode asks for; used whenever it fits. */
  preferred: PopupSide;
  open: boolean;
  /**
   * Any value the caller changes when the popup's CONTENT changed — a list that
   * grew from 2 rows to 10 needs a fresh verdict even though nothing scrolled
   * or resized. It is folded into `measure`'s identity rather than added to the
   * effect's dependency list, so the re-measure happens through the one path
   * that already re-measures.
   */
  revision?: unknown;
}): ComposerPopupPlacement {
  const { anchorRef, preferred, open, revision } = input;
  // The pre-measurement value is the mode's own preference at full height —
  // i.e. exactly the pre-F11 behaviour. The first frame of an opening popup
  // therefore looks like it always did, and the measurement can only correct
  // it; starting from a collapsed or flipped guess would make every open flash.
  const [placement, setPlacement] = useState<ComposerPopupPlacement>({
    side: preferred,
    maxHeight: COMPOSER_POPUP_DESIRED_HEIGHT,
  });

  // `revision` is an opaque re-measure trigger the caller owns, not a value
  // this callback reads. Folding it into `measure`'s identity is what makes a
  // content change re-run the one effect that already re-measures.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const next = resolveComposerPopupPlacement({
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      viewportHeight,
      preferred,
    });
    // Compared field by field rather than stored blindly: this runs on every
    // scroll frame, and an equal-but-new object would re-render the composer
    // (and with it the textarea) for the entire duration of a scroll.
    setPlacement((current) =>
      current.side === next.side && current.maxHeight === next.maxHeight ? current : next
    );
  }, [anchorRef, preferred, revision]);

  useEffect(() => {
    if (!open) return;
    measure();
    const viewport = window.visualViewport;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
    };
  }, [open, measure]);

  return placement;
}
