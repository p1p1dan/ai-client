/**
 * Issue #15 phase 2 (decision 187): the grouping store.
 *
 * The store owns two things the sidebar cannot derive — the groups the user
 * made, and which conversation is filed where — and one rule that has to hold
 * across both: a conversation whose group is gone is in 「未分组」, not in
 * limbo. Most of what is asserted here is that rule, at each of the three
 * places it can be broken: deleting a group, renaming nothing into existence,
 * and rehydrating a payload written by a version that knew different groups.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDEBAR_ARCHIVE_MODE,
  orderGroups,
  sanitizeSidebarArchivePreferences,
  UNGROUPED_GROUP_ID,
  useSidebarArchiveStore,
} from '../sidebarArchive';

const store = () => useSidebarArchiveStore.getState();

beforeEach(() => {
  useSidebarArchiveStore.setState({
    archiveMode: DEFAULT_SIDEBAR_ARCHIVE_MODE,
    groups: [],
    assignments: {},
  });
});

describe('sanitizeSidebarArchivePreferences', () => {
  it('falls back to the default mode and no groups for anything unreadable', () => {
    expect(sanitizeSidebarArchivePreferences(undefined)).toEqual({
      archiveMode: DEFAULT_SIDEBAR_ARCHIVE_MODE,
      groups: [],
      assignments: {},
    });
    expect(sanitizeSidebarArchivePreferences({ archiveMode: 'nonsense' }).archiveMode).toBe(
      DEFAULT_SIDEBAR_ARCHIVE_MODE
    );
  });

  it('reads a v1 payload (mode only) as no groups, everything ungrouped', () => {
    // v1 stored `archiveMode` alone; an upgrade must leave the user with the
    // list they had, which is every chat in 「未分组」.
    expect(sanitizeSidebarArchivePreferences({ archiveMode: 'group' })).toEqual({
      archiveMode: 'group',
      groups: [],
      assignments: {},
    });
  });

  it('drops a group with no id or no name rather than keeping something unaddressable', () => {
    const { groups } = sanitizeSidebarArchivePreferences({
      groups: [
        { id: 'g1', name: '  要交的  ', createdAt: 5 },
        { id: '', name: 'no id' },
        { id: 'g2', name: '   ' },
        { id: 'g1', name: 'duplicate id' },
      ],
    });
    expect(groups).toEqual([{ id: 'g1', name: '要交的', createdAt: 5 }]);
  });

  it('layout 5b: keeps the by-status and by-date modes, and the groups beside them', () => {
    for (const mode of ['workspace', 'group', 'status', 'date'] as const) {
      expect(sanitizeSidebarArchivePreferences({ archiveMode: mode }).archiveMode).toBe(mode);
    }
    // Switching to a derived mode files nothing away: the groups stay.
    expect(
      sanitizeSidebarArchivePreferences({
        archiveMode: 'status',
        groups: [{ id: 'g1', name: 'kept', createdAt: 1 }],
        assignments: { s1: 'g1' },
      })
    ).toEqual({
      archiveMode: 'status',
      groups: [{ id: 'g1', name: 'kept', createdAt: 1 }],
      assignments: { s1: 'g1' },
    });
  });

  it('drops assignments pointing at a group that did not survive', () => {
    const { assignments } = sanitizeSidebarArchivePreferences({
      groups: [{ id: 'g1', name: 'kept', createdAt: 1 }],
      assignments: { s1: 'g1', s2: 'dropped', s3: 42 },
    });
    expect(assignments).toEqual({ s1: 'g1' });
  });
});

describe('orderGroups', () => {
  it('puts the newest group first and leaves the input alone', () => {
    const groups = [
      { id: 'a', name: 'a', createdAt: 1 },
      { id: 'b', name: 'b', createdAt: 3 },
      { id: 'c', name: 'c', createdAt: 2 },
    ];
    expect(orderGroups(groups).map((group) => group.id)).toEqual(['b', 'c', 'a']);
    expect(groups.map((group) => group.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the grouping store', () => {
  it('creates a group with a trimmed name and returns it for immediate use', () => {
    const group = store().createGroup('  这个月要交  ');
    expect(group.name).toBe('这个月要交');
    expect(store().groups).toEqual([group]);
  });

  it('files a conversation, and 「未分组」 is the absence of an assignment', () => {
    const group = store().createGroup('g');
    store().assignSession('s1', group.id);
    expect(store().assignments).toEqual({ s1: group.id });
    // Moving it back to the bucket deletes the key rather than storing the
    // bucket id: a chat the user never filed and a chat they unfiled are the
    // same state, and two spellings of it would drift.
    store().assignSession('s1', UNGROUPED_GROUP_ID);
    expect(store().assignments).toEqual({});
    store().assignSession('s1', group.id);
    store().assignSession('s1', null);
    expect(store().assignments).toEqual({});
  });

  it('renames a group, and refuses a name that is empty or whitespace', () => {
    const group = store().createGroup('before');
    store().renameGroup(group.id, '  after  ');
    expect(store().groups[0].name).toBe('after');
    store().renameGroup(group.id, '   ');
    expect(store().groups[0].name).toBe('after');
    // Nothing to create: the group keeps its position and its creation time.
    expect(store().groups[0].createdAt).toBe(group.createdAt);
  });

  it('deleting a group returns its conversations to 「未分组」 instead of deleting them', () => {
    const kept = store().createGroup('kept');
    const dropped = store().createGroup('dropped');
    store().assignSession('s1', kept.id);
    store().assignSession('s2', dropped.id);
    store().deleteGroup(dropped.id);
    expect(store().groups.map((group) => group.id)).toEqual([kept.id]);
    // s2 is still tracked nowhere — which IS 「未分组」 — and s1 is untouched.
    expect(store().assignments).toEqual({ s1: kept.id });
  });
});
