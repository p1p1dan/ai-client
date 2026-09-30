import { beforeEach, describe, expect, it } from 'vitest';
import type { AttachmentDraft } from '@/components/chat/attachments';
import {
  EMPTY_COMPOSER_DRAFT,
  isEmptyComposerDraft,
  mergeOfferedText,
  resetComposerDraftsForTests,
  START_SCREEN_DRAFT_KEY,
  switchComposerDraft,
  useComposerDraftsStore,
} from '../composerDrafts';

/**
 * dsh-rebase P1-7e (problems 1 and 33, decision 139): the composer's draft is
 * per chat. The store holds the drafts of chats NOT in the composer; the one
 * on screen is the composer's own state, swapped by `switchComposerDraft`.
 */

const IMAGE: AttachmentDraft = {
  id: 'att-1',
  kind: 'image',
  mediaType: 'image/png',
  name: 'shot.png',
  byteLength: 4,
  data: 'AAAA',
};

const store = () => useComposerDraftsStore.getState();

beforeEach(() => resetComposerDraftsForTests());

describe('switchComposerDraft', () => {
  it('parks the outgoing chat and hands the incoming one an empty box', () => {
    const next = switchComposerDraft({
      from: 'a',
      to: 'b',
      carry: false,
      live: { text: 'half a thought', attachments: [IMAGE] },
    });
    expect(next).toEqual(EMPTY_COMPOSER_DRAFT);
    expect(store().parked.a).toEqual({ text: 'half a thought', attachments: [IMAGE] });
  });

  it('gives the text and attachments back when the user returns (problem 33)', () => {
    switchComposerDraft({
      from: 'a',
      to: 'b',
      carry: false,
      live: { text: 'x', attachments: [IMAGE] },
    });
    const back = switchComposerDraft({
      from: 'b',
      to: 'a',
      carry: false,
      live: EMPTY_COMPOSER_DRAFT,
    });
    expect(back).toEqual({ text: 'x', attachments: [IMAGE] });
    // Taken, not copied: it is in the box now, and only there.
    expect(store().parked.a).toBeUndefined();
    // B had nothing worth keeping.
    expect(store().parked.b).toBeUndefined();
  });

  it('does not park whitespace', () => {
    switchComposerDraft({
      from: 'a',
      to: 'b',
      carry: false,
      live: { text: ' \n ', attachments: [] },
    });
    expect(store().parked).toEqual({});
  });

  it('parks the start screen under its own key and prunes never drop it', () => {
    switchComposerDraft({
      from: null,
      to: 'a',
      carry: false,
      live: { text: 'hi', attachments: [] },
    });
    expect(store().parked[START_SCREEN_DRAFT_KEY]).toEqual({ text: 'hi', attachments: [] });
    store().pruneSessions(['a']);
    expect(store().parked[START_SCREEN_DRAFT_KEY]).toBeDefined();
    expect(
      switchComposerDraft({ from: 'a', to: null, carry: false, live: EMPTY_COMPOSER_DRAFT })
    ).toEqual({
      text: 'hi',
      attachments: [],
    });
  });

  it('leaves the box alone for a fork that carries its draft, and parks nothing (T-27)', () => {
    const next = switchComposerDraft({
      from: 'a',
      to: 'fork',
      carry: true,
      live: { text: 'goes with the fork', attachments: [IMAGE] },
    });
    expect(next).toBeNull();
    expect(store().parked).toEqual({});
  });

  it('leaves the box alone on a mount with nothing parked', () => {
    expect(
      switchComposerDraft({ from: 'a', to: 'a', carry: false, live: EMPTY_COMPOSER_DRAFT })
    ).toBeNull();
  });
});

describe('fillIfEmpty (a failed send returning to a chat the user left)', () => {
  it('fills an empty parked draft', () => {
    expect(store().fillIfEmpty('a', { text: 'returned', attachments: [] })).toBe(true);
    expect(store().parked.a?.text).toBe('returned');
  });

  it('never replaces what the user left there', () => {
    store().park('a', { text: 'mine', attachments: [] });
    expect(store().fillIfEmpty('a', { text: 'returned', attachments: [] })).toBe(false);
    expect(store().parked.a?.text).toBe('mine');
  });

  it('counts an attachment as content', () => {
    store().park('a', { text: '', attachments: [IMAGE] });
    expect(store().fillIfEmpty('a', { text: 'returned', attachments: [] })).toBe(false);
  });
});

describe('consumeSent (an interjection that landed after the user left its chat)', () => {
  it('takes exactly what was sent out of the parked draft', () => {
    const other: AttachmentDraft = { ...IMAGE, id: 'att-2' };
    store().park('a', { text: 'steer left', attachments: [IMAGE, other] });
    store().consumeSent('a', 'steer left', ['att-1']);
    expect(store().parked.a).toEqual({ text: '', attachments: [other] });
    store().consumeSent('a', 'steer left', ['att-2']);
    expect(store().parked.a).toBeUndefined();
  });

  it('keeps text the user changed meanwhile', () => {
    store().park('a', { text: 'steer left, then more', attachments: [] });
    store().consumeSent('a', 'steer left', []);
    expect(store().parked.a?.text).toBe('steer left, then more');
  });
});

describe('offered text (problem 1)', () => {
  it('is taken once, by its own chat', () => {
    store().offerText('a', 'the rewound prompt');
    expect(store().takeOffered('b')).toBeUndefined();
    expect(store().takeOffered('a')).toBe('the rewound prompt');
    expect(store().takeOffered('a')).toBeUndefined();
  });

  it('merges a second offer made before the first was taken', () => {
    store().offerText('a', 'first');
    store().offerText('a', 'second');
    expect(store().takeOffered('a')).toBe('first\n\nsecond');
  });

  it('ignores an empty offer', () => {
    store().offerText('a', '');
    expect(store().offered).toEqual({});
  });

  it('is pruned with its chat', () => {
    store().offerText('gone', 'x');
    store().park('gone', { text: 'y', attachments: [] });
    store().pruneSessions(['kept']);
    expect(store().offered).toEqual({});
    expect(store().parked).toEqual({});
  });
});

describe('mergeOfferedText (decision 139 rule 2)', () => {
  it('fills an empty box', () => {
    expect(mergeOfferedText('', 'prompt')).toBe('prompt');
    expect(mergeOfferedText('  \n', 'prompt')).toBe('prompt');
  });

  it('goes after what the user typed, one blank line apart, and replaces none of it', () => {
    expect(mergeOfferedText('my note\n\n', 'prompt')).toBe('my note\n\nprompt');
    expect(mergeOfferedText('my note', 'prompt')).toBe('my note\n\nprompt');
  });
});

it('isEmptyComposerDraft reads whitespace as empty and an attachment as content', () => {
  expect(isEmptyComposerDraft(undefined)).toBe(true);
  expect(isEmptyComposerDraft({ text: '  ', attachments: [] })).toBe(true);
  expect(isEmptyComposerDraft({ text: '', attachments: [IMAGE] })).toBe(false);
});
