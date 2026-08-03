'use client';

import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';

import { cn } from '@/lib/utils';

/**
 * Soft edge fade, per edge. Written as whole literal strings rather than
 * composed at runtime because Tailwind only sees classes that appear verbatim
 * in the source.
 */
const FADE_TOP =
  'mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))]';
const FADE_BOTTOM =
  'mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))]';
const FADE_SIDES =
  'mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))]';
const FADE_SIZE = '[--fade-size:1.5rem]';

/**
 * `true` keeps the original all-edges behavior, so the three existing call
 * sites (combobox / sheet / autocomplete) are untouched.
 *
 * T-31 §5.5-A adds the two single-edge values. The chat timeline pins a user
 * bubble to the top of its viewport (`turnBubbleBandClass`), and a top fade
 * would render that pinned band half-transparent — while the reason the top
 * fade existed at all (Round-2 V-b: a turn taller than the viewport hard-clips
 * its own top row) is dissolved by the same change, because the top of the
 * viewport is now always an opaque band. The bottom fade is unaffected and
 * still wanted.
 */
function scrollFadeClass(scrollFade: boolean | 'top' | 'bottom'): string | false {
  if (scrollFade === true) return `${FADE_TOP} ${FADE_BOTTOM} ${FADE_SIDES} ${FADE_SIZE}`;
  if (scrollFade === 'top') return `${FADE_TOP} ${FADE_SIZE}`;
  if (scrollFade === 'bottom') return `${FADE_BOTTOM} ${FADE_SIZE}`;
  return false;
}

function ScrollArea({
  className,
  children,
  scrollFade = false,
  scrollbarGutter = false,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  scrollFade?: boolean | 'top' | 'bottom';
  scrollbarGutter?: boolean;
}) {
  return (
    <ScrollAreaPrimitive.Root className={cn('size-full min-h-0', className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        className={cn(
          'h-full overscroll-contain rounded-[inherit] outline-none transition-shadows focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          scrollFadeClass(scrollFade),
          scrollbarGutter && 'data-has-overflow-y:pe-2.5 data-has-overflow-x:pb-2.5'
        )}
        data-slot="scroll-area-viewport"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation="vertical" />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        'm-1 flex opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:delay-0 data-scrolling:delay-0 data-hovering:duration-100 data-scrolling:duration-100',
        className
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        className="relative flex-1 rounded-full bg-foreground/20"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
