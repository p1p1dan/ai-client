import { describe, expect, it } from 'vitest';
import { UNGROUPED_GROUP_ID } from '@/stores/sidebarArchive';
import {
  currentGroupOf,
  resolveGroupDrop,
  resolveRovingKey,
  resolveSidebarNavKey,
  type SidebarNavItem,
} from '../sidebarNavModel';

/** Issue #26 item 7: the sidebar's drag-to-group and keyboard model, as pure decisions. */

const GROUPS = ['g-work', 'g-home'];

describe('currentGroupOf', () => {
  it('is the assigned group while it exists, else 「未分组」', () => {
    expect(currentGroupOf('a', { a: 'g-work' }, GROUPS)).toBe('g-work');
    expect(currentGroupOf('a', {}, GROUPS)).toBe(UNGROUPED_GROUP_ID);
    // A deleted group's chats are back in the bucket (decision 187).
    expect(currentGroupOf('a', { a: 'g-gone' }, GROUPS)).toBe(UNGROUPED_GROUP_ID);
  });
});

describe('resolveGroupDrop', () => {
  const base = { assignments: { a: 'g-work' }, groupIds: GROUPS };

  it('moves a chat to another group, 「未分组」 included', () => {
    expect(resolveGroupDrop({ ...base, sessionId: 'a', targetGroupId: 'g-home' })).toBe('g-home');
    expect(resolveGroupDrop({ ...base, sessionId: 'a', targetGroupId: UNGROUPED_GROUP_ID })).toBe(
      UNGROUPED_GROUP_ID
    );
    expect(resolveGroupDrop({ ...base, sessionId: 'b', targetGroupId: 'g-work' })).toBe('g-work');
  });

  it('offers no drop on the chat s own group, an unknown group, or with nothing dragged', () => {
    expect(resolveGroupDrop({ ...base, sessionId: 'a', targetGroupId: 'g-work' })).toBeNull();
    expect(
      resolveGroupDrop({ ...base, sessionId: 'b', targetGroupId: UNGROUPED_GROUP_ID })
    ).toBeNull();
    expect(resolveGroupDrop({ ...base, sessionId: 'a', targetGroupId: 'g-gone' })).toBeNull();
    expect(resolveGroupDrop({ ...base, sessionId: null, targetGroupId: 'g-home' })).toBeNull();
  });
});

describe('resolveSidebarNavKey', () => {
  const items: SidebarNavItem[] = [
    { kind: 'header', key: 'header:g1', groupId: 'g1', expanded: true },
    { kind: 'row', key: 'row:a' },
    { kind: 'row', key: 'row:b' },
    { kind: 'aux', key: 'aux:g1' },
    { kind: 'header', key: 'header:g2', groupId: 'g2', expanded: false },
  ];

  it('Up / Down step and wrap; Home / End jump', () => {
    expect(resolveSidebarNavKey(items, 1, 'ArrowDown')).toEqual({ type: 'focus', index: 2 });
    expect(resolveSidebarNavKey(items, 4, 'ArrowDown')).toEqual({ type: 'focus', index: 0 });
    expect(resolveSidebarNavKey(items, 0, 'ArrowUp')).toEqual({ type: 'focus', index: 4 });
    expect(resolveSidebarNavKey(items, 2, 'Home')).toEqual({ type: 'focus', index: 0 });
    expect(resolveSidebarNavKey(items, 2, 'End')).toEqual({ type: 'focus', index: 4 });
  });

  it('Left folds an open header, and from a row or aux line goes to its header', () => {
    expect(resolveSidebarNavKey(items, 0, 'ArrowLeft')).toEqual({
      type: 'toggle',
      groupId: 'g1',
      expanded: false,
    });
    expect(resolveSidebarNavKey(items, 2, 'ArrowLeft')).toEqual({ type: 'focus', index: 0 });
    expect(resolveSidebarNavKey(items, 3, 'ArrowLeft')).toEqual({ type: 'focus', index: 0 });
    expect(resolveSidebarNavKey(items, 4, 'ArrowLeft')).toBeNull();
  });

  it('Right opens a folded header, and steps into an open one', () => {
    expect(resolveSidebarNavKey(items, 4, 'ArrowRight')).toEqual({
      type: 'toggle',
      groupId: 'g2',
      expanded: true,
    });
    expect(resolveSidebarNavKey(items, 0, 'ArrowRight')).toEqual({ type: 'focus', index: 1 });
    expect(resolveSidebarNavKey(items, 1, 'ArrowRight')).toBeNull();
    // An open header with no rows under it has nowhere to step.
    const empty: SidebarNavItem[] = [
      { kind: 'header', key: 'header:g1', groupId: 'g1', expanded: true },
      { kind: 'header', key: 'header:g2', groupId: 'g2', expanded: true },
    ];
    expect(resolveSidebarNavKey(empty, 0, 'ArrowRight')).toBeNull();
  });

  it('leaves every other key (Enter included) to the item itself', () => {
    expect(resolveSidebarNavKey(items, 1, 'Enter')).toBeNull();
    expect(resolveSidebarNavKey(items, 1, 'a')).toBeNull();
    expect(resolveSidebarNavKey([], 0, 'ArrowDown')).toBeNull();
  });
});

describe('resolveRovingKey', () => {
  const keys = ['header:g1', 'row:a', 'row:b'];

  it('keeps the focused item, then the open chat, then the first item', () => {
    expect(resolveRovingKey(keys, 'row:b', 'row:a')).toBe('row:b');
    expect(resolveRovingKey(keys, 'row:gone', 'row:a')).toBe('row:a');
    expect(resolveRovingKey(keys, null, 'row:gone')).toBe('header:g1');
    expect(resolveRovingKey([], 'row:a', 'row:a')).toBeNull();
  });
});
