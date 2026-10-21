'use client';

import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { ChevronRightIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * 扩展 CSSProperties 以支持 Electron 特有的 WebkitAppRegion 属性
 * 用于无边框窗口中控制拖拽区域
 */
interface ElectronCSSProperties extends React.CSSProperties {
  WebkitAppRegion?: 'drag' | 'no-drag';
}

const Menu = MenuPrimitive.Root;

const MenuPortal = MenuPrimitive.Portal;

function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

function MenuPopup({
  children,
  className,
  sideOffset = 4,
  align = 'center',
  alignOffset,
  side = 'bottom',
  collisionAvoidance,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props['align'];
  sideOffset?: MenuPrimitive.Positioner.Props['sideOffset'];
  alignOffset?: MenuPrimitive.Positioner.Props['alignOffset'];
  side?: MenuPrimitive.Positioner.Props['side'];
  // Left undefined by default so root menus keep Base UI's own collision
  // defaults (top-level popups are allowed to flip top/bottom when the
  // trigger is near a screen edge). `MenuSubPopup` overrides this.
  collisionAvoidance?: MenuPrimitive.Positioner.Props['collisionAvoidance'];
}) {
  return (
    <MenuPrimitive.Portal>
      {/*
        `data-closed:pointer-events-none` on all three layers is load-bearing,
        not defensive polish. Measured on the running app 2026-09-19: after a
        close, Base UI leaves the popup, its positioner AND this backdrop
        mounted with `data-closed` + `data-ending-style` still set and
        `pointer-events: auto`. The popup is invisible by then, so what the user
        sees is a window that has stopped responding to clicks — the composer's
        own centre point resolves to a menu row sitting on top of it.

        Whether Base UI ought to have unmounted them is a separate question
        (open). This rule makes the answer not matter: a layer marked closed
        never eats a click, however long it lingers.
      */}
      <MenuPrimitive.Backdrop className="fixed inset-0 z-40 data-closed:pointer-events-none" />
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="z-50 data-closed:pointer-events-none"
        collisionAvoidance={collisionAvoidance}
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            // Design system v2 §5: a float -- `md` radius, the popover elevation
            // (a hairline ring in light, an inner highlight in dark), no spring.
            "relative flex not-[class*='w-']:min-w-32 origin-(--transform-origin) rounded-md bg-popover text-popover-foreground outline-none elev-popover transition-[scale,opacity] duration-150 ease-out focus:outline-none data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-closed:pointer-events-none",
            className
          )}
          data-slot="menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuItem({
  className,
  inset,
  variant = 'default',
  style,
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "flex min-h-7 cursor-default select-none items-center gap-2 whitespace-nowrap rounded-xs px-2 py-1 text-ui outline-none data-disabled:pointer-events-none data-highlighted:bg-fill-ghost-hover data-inset:ps-8 data-[variant=destructive]:text-destructive data-highlighted:text-foreground data-highlighted:data-[variant=destructive]:bg-destructive/8 data-highlighted:data-[variant=destructive]:text-destructive data-disabled:opacity-50 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      data-inset={inset}
      data-slot="menu-item"
      data-variant={variant}
      style={{ WebkitAppRegion: 'no-drag', ...style } as ElectronCSSProperties}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        "grid min-h-7 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-xs py-1 ps-2 pe-4 text-ui outline-none data-disabled:pointer-events-none data-highlighted:bg-fill-ghost-hover data-highlighted:text-foreground data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      data-slot="menu-checkbox-item"
      {...props}
    >
      <MenuPrimitive.CheckboxItemIndicator className="col-start-1">
        <svg
          aria-hidden="true"
          fill="none"
          height="24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      </MenuPrimitive.CheckboxItemIndicator>
      <span className="col-start-2">{children}</span>
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({ className, children, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        "grid min-h-7 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-xs py-1 ps-2 pe-4 text-ui outline-none data-disabled:pointer-events-none data-highlighted:bg-fill-ghost-hover data-highlighted:text-foreground data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      data-slot="menu-radio-item"
      {...props}
    >
      <MenuPrimitive.RadioItemIndicator className="col-start-1">
        <svg
          aria-hidden="true"
          fill="none"
          height="24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      </MenuPrimitive.RadioItemIndicator>
      <span className="col-start-2">{children}</span>
    </MenuPrimitive.RadioItem>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn(
        'px-2 pt-2 pb-1 font-medium text-foreground-faint text-small data-inset:ps-8',
        className
      )}
      data-inset={inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-border-soft', className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

function MenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('ms-auto text-foreground-faint text-2xs tracking-normal', className)}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />;
}

function MenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        "flex min-h-7 items-center gap-2 rounded-xs px-2 py-1 text-ui outline-none data-disabled:pointer-events-none data-highlighted:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover data-inset:ps-8 data-highlighted:text-foreground data-popup-open:text-foreground data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none",
        className
      )}
      data-inset={inset}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="-me-0.5 ms-auto opacity-80" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuSubPopup({
  className,
  sideOffset = 0,
  alignOffset,
  align = 'start',
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props['align'];
  sideOffset?: MenuPrimitive.Positioner.Props['sideOffset'];
  alignOffset?: MenuPrimitive.Positioner.Props['alignOffset'];
}) {
  const defaultAlignOffset = align !== 'center' ? -5 : undefined;

  return (
    <MenuPopup
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      // Base UI's default collision avoidance for a submenu (nested inside
      // another menu) is "flip" on both axes: when the preferred side/edge
      // runs out of room, it instantly mirrors the popup to the opposite
      // side/edge instead of sliding it. A submenu is re-measured on every
      // item click, so a click near the collision boundary makes it jump
      // sides (or edges) under the pointer. "shift" keeps it on the same
      // side/edge and only slides it to stay on screen, so it never
      // relocates out from under the user.
      collisionAvoidance={{ side: 'shift', align: 'shift' }}
      data-slot="menu-sub-content"
      side="inline-end"
      sideOffset={sideOffset}
      {...props}
    />
  );
}

/**
 * TitleBarMenuPopup - 专门用于标题栏的菜单弹出层
 * 使用透明 Backdrop 支持点击关闭，同时保持 no-drag
 */
function TitleBarMenuPopup({
  children,
  className,
  sideOffset = 4,
  align = 'start',
  alignOffset = -4,
  side = 'bottom',
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props['align'];
  sideOffset?: MenuPrimitive.Positioner.Props['sideOffset'];
  alignOffset?: MenuPrimitive.Positioner.Props['alignOffset'];
  side?: MenuPrimitive.Positioner.Props['side'];
}) {
  return (
    <MenuPrimitive.Portal>
      {/* 透明 Backdrop，支持点击关闭，设置 no-drag 避免拖拽冲突 */}
      <MenuPrimitive.Backdrop
        className="fixed inset-0 z-[99] data-closed:pointer-events-none"
        style={{ WebkitAppRegion: 'no-drag' } as ElectronCSSProperties}
      />
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="z-[100] data-closed:pointer-events-none"
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
        style={{ WebkitAppRegion: 'no-drag' } as ElectronCSSProperties}
      >
        <MenuPrimitive.Popup
          className={cn(
            // Design system v2: the same float as MenuPopup.
            "relative flex not-[class*='w-']:min-w-32 rounded-md bg-popover text-popover-foreground outline-none elev-popover",
            'origin-(--transform-origin) transition-[scale,opacity] duration-150 ease-out',
            'data-starting-style:scale-[0.98] data-starting-style:opacity-0',
            'data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-closed:pointer-events-none',
            className
          )}
          data-slot="menu-popup"
          style={{ WebkitAppRegion: 'no-drag' } as ElectronCSSProperties}
          {...props}
        >
          <div
            className="max-h-(--available-height) w-full overflow-y-auto p-1"
            style={{ WebkitAppRegion: 'no-drag' } as ElectronCSSProperties}
          >
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export {
  Menu,
  Menu as DropdownMenu,
  MenuPortal,
  MenuPortal as DropdownMenuPortal,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopup,
  MenuPopup as DropdownMenuContent,
  TitleBarMenuPopup,
  MenuGroup,
  MenuGroup as DropdownMenuGroup,
  MenuItem,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuGroupLabel,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator,
  MenuSeparator as DropdownMenuSeparator,
  MenuShortcut,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub,
  MenuSub as DropdownMenuSub,
  MenuSubTrigger,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuSubPopup,
  MenuSubPopup as DropdownMenuSubContent,
};
