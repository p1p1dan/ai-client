'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { XIcon } from 'lucide-react';
import { type Ref, useCallback, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTrafficLightsGuard } from '@/hooks/useTrafficLightsGuard';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';

// Traffic lights guard is driven by the controlled `open` prop.
// Uncontrolled Dialogs (without `open`) will not trigger the guard.
function Dialog(props: DialogPrimitive.Root.Props) {
  useTrafficLightsGuard(props.open ?? false);
  return <DialogPrimitive.Root {...props} />;
}

const DialogPortal = DialogPrimitive.Portal;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        // 优化动画：150ms，使用 ease-out 实现快速响应
        // z-index 由 DialogPopup 通过 style prop 统一控制
        'fixed inset-0 no-drag bg-black/32 backdrop-blur-sm transition-opacity duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-closed:pointer-events-none',
        className
      )}
      data-slot="dialog-backdrop"
      {...props}
    />
  );
}

/** A `ScrollArea` viewport: tabbable (`tabIndex=0`) so the keyboard can scroll it. */
const SCROLL_VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'summary',
  '[tabindex]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

function isTabbable(element: HTMLElement): boolean {
  if (element.tabIndex < 0) return false;
  if ((element as HTMLButtonElement).disabled) return false;
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false;
  return element.closest('[hidden],[inert]') === null;
}

/**
 * dsh-rebase decision 156 (decision 145 §18, for every dialog): where focus
 * goes when a dialog opens and its caller did not say.
 *
 * Base UI focuses the popup's first tabbable element. A `DialogPanel` wraps
 * its content in a `ScrollArea` whose viewport is tabbable — and tabbable at
 * that moment even when nothing overflows, because the overflow is measured a
 * microtask after mount — so a dialog whose panel came first opened with focus,
 * and its focus ring, on the scroll region. When the first tabbable element is
 * a scroll region, focus goes to the first one that is not (a field inside the
 * panel, a footer button, the close button), else to the popup itself. The
 * scroll region stays in the Tab order. Every other case keeps Base UI's own
 * choice (`true`), and a touch open focuses the popup as Base UI does.
 */
export function dialogInitialFocus(
  popup: HTMLElement | null,
  interactionType: string
): boolean | HTMLElement {
  if (!popup) return true;
  if (interactionType === 'touch') return popup;
  const tabbable = [...popup.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(isTabbable);
  if (!tabbable[0]?.matches(SCROLL_VIEWPORT_SELECTOR)) return true;
  return tabbable.find((element) => !element.matches(SCROLL_VIEWPORT_SELECTOR)) ?? popup;
}

function DialogViewport({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        // z-index 由 DialogPopup 通过 style prop 统一控制
        'fixed inset-0 grid grid-rows-[1fr_auto_3fr] justify-items-center p-4 pointer-events-none',
        className
      )}
      data-slot="dialog-viewport"
      {...props}
    />
  );
}

function DialogPopup({
  className,
  children,
  showCloseButton = true,
  bottomStickOnMobile = true,
  disableNestedTransform = false,
  showBackdrop = true,
  zIndexLevel = 'base',
  style,
  initialFocus,
  ref,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  bottomStickOnMobile?: boolean;
  disableNestedTransform?: boolean;
  showBackdrop?: boolean;
  zIndexLevel?: 'base' | 'nested';
  ref?: Ref<HTMLDivElement>;
}) {
  const { t } = useI18n();
  // Decision 156: the popup element, for the default initial focus below.
  const popupRef = useRef<HTMLDivElement | null>(null);
  const setPopupRef = useCallback(
    (node: HTMLDivElement | null) => {
      popupRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref]
  );
  const mergedStyle = disableNestedTransform
    ? ({ ...(style ?? {}), '--nested-dialogs': 0 } as React.CSSProperties)
    : style;

  const contentZIndex =
    zIndexLevel === 'base' ? Z_INDEX.MODAL_CONTENT : Z_INDEX.NESTED_MODAL_CONTENT;
  const backdropZIndex =
    zIndexLevel === 'base' ? Z_INDEX.MODAL_BACKDROP : Z_INDEX.NESTED_MODAL_BACKDROP;

  return (
    <DialogPortal>
      {showBackdrop && <DialogBackdrop style={{ zIndex: backdropZIndex }} />}
      <DialogViewport
        className={cn(bottomStickOnMobile && 'max-sm:grid-rows-[1fr_auto] max-sm:pt-12')}
        style={{ zIndex: contentZIndex }}
      >
        <DialogPrimitive.Popup
          className={cn(
            // 优化动画：150ms，使用模拟 Spring 的 cubic-bezier 曲线
            '-translate-y-[calc(1.25rem*var(--nested-dialogs))] no-drag pointer-events-auto relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-lg scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-2xl border bg-popover bg-clip-padding text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] shadow-lg transition-[scale,opacity,translate] duration-150 [transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] will-change-transform before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0 data-closed:pointer-events-none dark:bg-clip-border dark:before:shadow-[0_-1px_--theme(--color-white/8%)]',
            bottomStickOnMobile &&
              'max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))] max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4 max-sm:before:hidden max-sm:before:rounded-none',
            className
          )}
          style={mergedStyle}
          data-slot="dialog-popup"
          {...props}
          ref={setPopupRef}
          initialFocus={
            initialFocus ??
            ((interactionType) => dialogInitialFocus(popupRef.current, interactionType))
          }
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              // P1-7e e6 (decision 145): read aloud, so in the UI language.
              aria-label={t('Close')}
              className="absolute end-3 top-2.5 z-50 flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
            >
              <XIcon className="h-4 w-4" />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DialogViewport>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4',
        className
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogFooter({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & {
  variant?: 'default' | 'bare';
}) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]',
        variant === 'default' && 'border-t bg-muted/50 py-4',
        variant === 'bare' &&
          'in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pt-3 pt-4 pb-6',
        className
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn(
        'font-heading text-title font-semibold leading-none tracking-[-0.01em]',
        className
      )}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn('text-muted-foreground text-sm', className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

function DialogPanel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <ScrollArea>
      <div
        className={cn(
          'px-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:not(:has([data-slot=dialog-header]))]:pt-6 in-[[data-slot=dialog-popup]:not(:has([data-slot=dialog-footer]))]:pb-6! in-[[data-slot=dialog-popup]:not(:has([data-slot=dialog-footer].border-t))]:pb-1 pb-6',
          className
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </ScrollArea>
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogBackdrop,
  DialogBackdrop as DialogOverlay,
  DialogPopup,
  DialogPopup as DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogViewport,
};
