import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * D25: tailwind-merge's default config only recognises font-size utilities
 * whose suffix is a themed t-shirt size (`xs`/`sm`/`md`/`lg`/`xl`, optionally
 * digit-prefixed) or an arbitrary value/variable. Our custom size tokens
 * (`text-code`, `text-markdown`, `text-meta`, `text-ui`, `text-title`) don't
 * match that shape, so twMerge falls through to the `text-color` group --
 * which matches ANY bare word via its default `isAny` catch-all -- and
 * silently drops whatever text-color class came before it (e.g.
 * `cn('text-muted-foreground', 'text-ui')` used to emit only `text-ui`,
 * losing the colour). Registering these tokens into the `font-size` class
 * group fixes the classification so they only conflict with other font-size
 * utilities, never with colour.
 *
 * `text-2xs` already happens to match the default t-shirt regex ("2xs") and
 * is registered here too for clarity/robustness rather than relying on that
 * coincidence. `text-tool-arg` is a colour token (not a size), so it is
 * deliberately left unregistered -- it belongs in `text-color`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': ['text-2xs', 'text-code', 'text-markdown', 'text-meta', 'text-ui', 'text-title'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
