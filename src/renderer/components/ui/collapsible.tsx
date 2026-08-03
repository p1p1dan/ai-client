'use client';

import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';

import { cn } from '@/lib/utils';

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ className, ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      className={cn('cursor-pointer', className)}
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

/**
 * The panel's measured-height animation classes.
 *
 * Exported because a consumer that must opt OUT of the height measurement
 * (`chat/chatTimelineLayout.ts`'s `turnProcessPanelClass`) can only prove it
 * actually did so by evaluating the real `cn()` merge of the two — asserting
 * the override string alone proves nothing, since the base it overrides lives
 * here. Importing the constant instead of copying it is what keeps that
 * assertion honest when this line is edited.
 */
export const COLLAPSIBLE_PANEL_BASE_CLASS =
  'h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 data-ending-style:h-0 data-starting-style:h-0';

function CollapsiblePanel({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      className={cn(COLLAPSIBLE_PANEL_BASE_CLASS, className)}
      data-slot="collapsible-panel"
      {...props}
    />
  );
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
  CollapsiblePanel as CollapsibleContent,
};
