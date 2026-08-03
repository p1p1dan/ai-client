import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Paperclip, Plus } from 'lucide-react';
import { Menu, MenuPopup } from '@/components/ui/menu';
import {
  composerAttachButtonClass,
  composerMenuItemClass,
  composerPopupSide,
  type MiddleColumnMode,
} from './middleColumnLayout';

/**
 * D4 (round-5): the ⊕ control at the far left of the Composer card.
 *
 * It used to write an `@` into the textarea, because at the time there was no
 * renderer-side "read a file's bytes" IPC and a picker would only have
 * produced a path nothing could send. `file:readAttachment` (D4) closes that
 * gap, so the button now does what its position in every reference UI implies:
 * it opens a menu whose first — currently only — entry attaches real files.
 *
 * Why a menu for one item: the ⊕ slot is the Composer's extension point (the
 * reference bar hangs "add image", "link issue/PR", … off exactly this
 * button), and a control that silently changes from "does the thing" to "opens
 * a list" the first time a second capability lands is a worse surprise than
 * one extra click today. Adding the next capability is one `MenuPrimitive.Item`.
 *
 * Honesty rule (A06): picking the entry MUST open the real system picker, and
 * cancelling it must produce nothing at all — no notice, no state change. The
 * cancel branch is owned by the caller's handler, which returns early on an
 * empty path list.
 *
 * Form is copied from `ComposerModelTrigger` on purpose: same `Menu` +
 * `MenuPrimitive.Trigger render={<button/>}` + `MenuPopup` shape, same
 * `composerPopupSide(mode)` (the docked card has no room below it), and the
 * same shared row class — two menus in one card that look different read as
 * two different apps.
 */

interface ComposerAttachMenuProps {
  /** Which way the popup opens — the docked card has no headroom below it. */
  mode: MiddleColumnMode;
  disabled?: boolean;
  /** Opens the native picker and ingests whatever comes back. */
  onAttachFiles: () => void;
}

export function ComposerAttachMenu({ mode, disabled, onAttachFiles }: ComposerAttachMenuProps) {
  return (
    <Menu>
      <MenuPrimitive.Trigger
        className={composerAttachButtonClass()}
        disabled={disabled}
        // The previous label promised a file REFERENCE and said so explicitly,
        // because that was all the button could honestly do. It can attach
        // real files now, so the label says that instead.
        aria-label="Attach files"
        title="Attach files"
        render={<button type="button" />}
      >
        <Plus className="size-3.5" />
      </MenuPrimitive.Trigger>
      {/* Same paired radius override as the model menu: the shared popup's
          hairline `::before` derives its radius from the popup's own, so
          overriding one without the other leaves a 15px inner stroke inside a
          12px frame — visible as a doubled corner. */}
      <MenuPopup
        align="start"
        className="min-w-40 rounded-md before:rounded-[calc(var(--radius-md)-1px)]"
        side={composerPopupSide(mode)}
      >
        <MenuPrimitive.Item className={composerMenuItemClass()} onClick={onAttachFiles}>
          <Paperclip className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Attach files</span>
        </MenuPrimitive.Item>
      </MenuPopup>
    </Menu>
  );
}
