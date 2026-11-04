import { describe, expect, it } from 'vitest';
import { CHAT_MIN_WIDTH } from '../centerLayoutModel';
import {
  BAR_BUTTON_ORDER,
  BAR_TITLE_MIN_WIDTH,
  type BarButton,
  barButtonWidth,
  barFixedWidth,
  resolveBarOverflow,
} from '../sessionBarOverflow';

/**
 * Decision 209 §5: with the window allowed down to 640, title-bar buttons
 * that do not fit move into ⋮ from the right — background tasks, files,
 * changes, terminal, side chat, the rail toggle — and the title keeps 120px.
 */
const ALL: readonly BarButton[] = BAR_BUTTON_ORDER;
const WINDOWS = { expandSidebar: false, windowControls: true };

function needed(buttons: readonly BarButton[], fixed = WINDOWS): number {
  return barFixedWidth(fixed) + buttons.reduce((sum, button) => sum + barButtonWidth(button), 0);
}

describe('resolveBarOverflow', () => {
  it('a wide bar keeps every button, left to right as they sit', () => {
    const result = resolveBarOverflow({ width: 1200, buttons: [...ALL].reverse(), ...WINDOWS });
    expect(result.inline).toEqual(['rail', 'side-chat', 'terminal', 'changes', 'files', 'tasks']);
    expect(result.overflow).toEqual([]);
  });

  it('the exact fit keeps them all; one pixel less sends the rightmost into ⋮', () => {
    const edge = needed(ALL);
    expect(resolveBarOverflow({ width: edge, buttons: ALL, ...WINDOWS }).overflow).toEqual([]);
    expect(resolveBarOverflow({ width: edge - 1, buttons: ALL, ...WINDOWS }).overflow).toEqual([
      'tasks',
    ]);
  });

  it('they leave in the decided order: tasks, files, changes, terminal, side chat, rail', () => {
    const leaving: BarButton[] = [];
    for (let width = needed(ALL); width >= 0; width -= 1) {
      const { overflow } = resolveBarOverflow({ width, buttons: ALL, ...WINDOWS });
      for (const button of [...overflow].reverse()) {
        if (!leaving.includes(button)) leaving.push(button);
      }
    }
    expect(leaving).toEqual(['tasks', 'files', 'changes', 'terminal', 'side-chat', 'rail']);
  });

  it('a button that is not shown takes no room (no running tasks: files leaves first)', () => {
    const buttons = ALL.filter((button) => button !== 'tasks');
    expect(
      resolveBarOverflow({ width: needed(buttons) - 1, buttons, ...WINDOWS }).overflow
    ).toEqual(['files']);
  });

  it('the title keeps 120px on any bar the shell can lay out (the chat floor up)', () => {
    for (let width = CHAT_MIN_WIDTH; width <= 1200; width += 1) {
      const result = resolveBarOverflow({ width, buttons: ALL, ...WINDOWS });
      const used = needed(result.inline) - BAR_TITLE_MIN_WIDTH;
      if (result.overflow.length > 0) {
        expect(width - used).toBeGreaterThanOrEqual(BAR_TITLE_MIN_WIDTH);
      }
    }
  });

  it('the narrowest window (chat floor, sidebar open): the rail and side chat stay', () => {
    const result = resolveBarOverflow({ width: CHAT_MIN_WIDTH, buttons: ALL, ...WINDOWS });
    expect(result.inline).toEqual(['rail', 'side-chat']);
    expect(result.overflow).toEqual(['terminal', 'changes', 'files', 'tasks']);
  });

  it('the expand button and the window buttons count; macOS has no window buttons', () => {
    const collapsed = { expandSidebar: true, windowControls: true };
    const mac = { expandSidebar: false, windowControls: false };
    expect(barFixedWidth(collapsed) - barFixedWidth(WINDOWS)).toBe(32);
    // gap + `ml-1` + three 44px buttons, against `pr-2`.
    expect(barFixedWidth(WINDOWS) - barFixedWidth(mac)).toBe(4 + 4 + 132 - 8);
    const edge = needed(ALL);
    expect(resolveBarOverflow({ width: edge, buttons: ALL, ...collapsed }).overflow).toEqual([
      'tasks',
    ]);
    expect(resolveBarOverflow({ width: edge, buttons: ALL, ...mac }).overflow).toEqual([]);
  });

  it('unmeasured: everything stays on the bar', () => {
    expect(resolveBarOverflow({ width: null, buttons: ALL, ...WINDOWS }).inline).toEqual([...ALL]);
    expect(resolveBarOverflow({ width: Number.NaN, buttons: ALL, ...WINDOWS }).overflow).toEqual(
      []
    );
  });

  it('a bar too narrow even for the title sends every button into ⋮', () => {
    const result = resolveBarOverflow({ width: 100, buttons: ALL, ...WINDOWS });
    expect(result.inline).toEqual([]);
    expect(result.overflow).toEqual([...ALL]);
  });
});
