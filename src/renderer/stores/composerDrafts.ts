import { create } from 'zustand';
import type { AttachmentDraft } from '@/components/chat/attachments';

/**
 * dsh-rebase P1-7e (problem 33, decision 139): the composer's draft belongs to
 * the chat it was typed in.
 *
 * One `ChatComposer` is mounted for the whole run and serves whichever chat is
 * active, so its text used to follow the user from chat to chat: a message a
 * failed migration handed back to chat A was still in the box over chat B, and
 * one Enter sent it there. The composer now parks what it holds when it leaves
 * a chat and takes back what was parked when it returns (`switchComposerDraft`).
 *
 * Only drafts of chats NOT in the composer live here; the one on screen is the
 * composer's own state. Memory only: a draft does not survive a restart, like
 * the chats that were never sent.
 *
 * `offered` is text handed to a chat's composer from outside it — a rewind
 * puts the prompt it rewound to back (problem 1). The composer takes it when
 * that chat is (or next becomes) the one on screen, so an offer never lands in
 * another chat's box. `offeredAttachments` rides beside it for an offer that
 * carries attachments too: a withdrawn Ctrl+Enter message (issue #8).
 */
export interface ComposerDraft {
  text: string;
  attachments: readonly AttachmentDraft[];
}

/** The start screen's draft: the composer with no chat selected. No session id is ever empty. */
export const START_SCREEN_DRAFT_KEY = '';

export function draftKey(sessionId: string | null): string {
  return sessionId ?? START_SCREEN_DRAFT_KEY;
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: '', attachments: [] };

/** Nothing worth keeping: whitespace is not something the user typed for this chat. */
export function isEmptyComposerDraft(draft: ComposerDraft | undefined): boolean {
  return !draft || (draft.text.trim().length === 0 && draft.attachments.length === 0);
}

/**
 * Decision 139 rule 2: text offered to a composer that already holds something
 * goes AFTER it, one blank line apart. The user's own text is never replaced
 * and nothing offered is dropped; they delete whichever half they do not want.
 */
export function mergeOfferedText(current: string, offered: string): string {
  if (current.trim().length === 0) return offered;
  return `${current.replace(/\s+$/, '')}\n\n${offered}`;
}

interface ComposerDraftsState {
  parked: Record<string, ComposerDraft>;
  offered: Record<string, string>;
  offeredAttachments: Record<string, readonly AttachmentDraft[]>;
  /** Keep a chat's draft while the composer is elsewhere; an empty one is dropped. */
  park: (sessionId: string | null, draft: ComposerDraft) => void;
  /** Hand back (and forget) what was parked for a chat. */
  take: (sessionId: string | null) => ComposerDraft | undefined;
  /**
   * Put a payload into a PARKED chat's draft, only when that draft is empty —
   * the parked twin of the composer's "restore if empty". Returns whether it did.
   */
  fillIfEmpty: (sessionId: string | null, draft: ComposerDraft) => boolean;
  /**
   * A message that left while its chat was parked (an interjection whose IPC
   * outlived a chat switch): take exactly what was sent out of that chat's
   * parked draft — the text only if it is still the whole draft, and the
   * attachments by id — so it does not come back to be sent twice.
   */
  consumeSent: (sessionId: string, text: string, attachmentIds: readonly string[]) => void;
  /** Offer text to a chat's composer (merged with any offer not yet taken). */
  offerText: (sessionId: string, text: string) => void;
  /** Take (and forget) the text offered to a chat. */
  takeOffered: (sessionId: string) => string | undefined;
  /**
   * Issue #8 (decision 172 §4): offer a whole draft — its text as `offerText`
   * does, its attachments after any already offered.
   */
  offerDraft: (sessionId: string, draft: ComposerDraft) => void;
  /** Take (and forget) the attachments offered to a chat. */
  takeOfferedAttachments: (sessionId: string) => readonly AttachmentDraft[] | undefined;
  /** Forget the drafts of chats that no longer exist; the start screen's stays. */
  pruneSessions: (sessionIds: readonly string[]) => void;
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export const useComposerDraftsStore = create<ComposerDraftsState>()((set, get) => ({
  parked: {},
  offered: {},
  offeredAttachments: {},

  park: (sessionId, draft) => {
    const key = draftKey(sessionId);
    if (isEmptyComposerDraft(draft)) {
      if (key in get().parked) set((state) => ({ parked: without(state.parked, key) }));
      return;
    }
    set((state) => ({
      parked: { ...state.parked, [key]: { text: draft.text, attachments: [...draft.attachments] } },
    }));
  },

  take: (sessionId) => {
    const key = draftKey(sessionId);
    const draft = get().parked[key];
    if (draft) set((state) => ({ parked: without(state.parked, key) }));
    return draft;
  },

  fillIfEmpty: (sessionId, draft) => {
    const key = draftKey(sessionId);
    if (!isEmptyComposerDraft(get().parked[key])) return false;
    get().park(sessionId, draft);
    return true;
  },

  consumeSent: (sessionId, text, attachmentIds) => {
    const parked = get().parked[sessionId];
    if (!parked) return;
    const sent = new Set(attachmentIds);
    get().park(sessionId, {
      text: parked.text.trim() === text ? '' : parked.text,
      attachments: parked.attachments.filter((draft) => !sent.has(draft.id)),
    });
  },

  offerText: (sessionId, text) => {
    if (text.length === 0) return;
    set((state) => {
      const pending = state.offered[sessionId];
      return {
        offered: {
          ...state.offered,
          [sessionId]: pending === undefined ? text : mergeOfferedText(pending, text),
        },
      };
    });
  },

  takeOffered: (sessionId) => {
    const text = get().offered[sessionId];
    if (text !== undefined) set((state) => ({ offered: without(state.offered, sessionId) }));
    return text;
  },

  offerDraft: (sessionId, draft) => {
    get().offerText(sessionId, draft.text);
    if (draft.attachments.length === 0) return;
    set((state) => ({
      offeredAttachments: {
        ...state.offeredAttachments,
        [sessionId]: [...(state.offeredAttachments[sessionId] ?? []), ...draft.attachments],
      },
    }));
  },

  takeOfferedAttachments: (sessionId) => {
    const drafts = get().offeredAttachments[sessionId];
    if (drafts !== undefined) {
      set((state) => ({ offeredAttachments: without(state.offeredAttachments, sessionId) }));
    }
    return drafts;
  },

  pruneSessions: (sessionIds) =>
    set((state) => {
      const live = new Set([...sessionIds, START_SCREEN_DRAFT_KEY]);
      const keys = [state.parked, state.offered, state.offeredAttachments].flatMap((record) =>
        Object.keys(record)
      );
      if (keys.every((key) => live.has(key))) return state;
      const kept = <T>(record: Record<string, T>) =>
        Object.fromEntries(Object.entries(record).filter(([key]) => live.has(key)));
      return {
        parked: kept(state.parked),
        offered: kept(state.offered),
        offeredAttachments: kept(state.offeredAttachments),
      };
    }),
}));

/**
 * The composer leaving `from` for `to`: park what it holds for `from`, and
 * say what it must hold now — `to`'s parked draft, or an empty one.
 *
 * `null` means "leave the composer as it is": the same chat again (a mount,
 * a re-render), or a fork carrying its draft onto the new chat (T-27,
 * `forkDraftCarry.ts`) — the draft moves with the user and nothing is parked
 * for the chat they forked from.
 */
export function switchComposerDraft(input: {
  from: string | null;
  to: string | null;
  live: ComposerDraft;
  carry: boolean;
}): ComposerDraft | null {
  const store = useComposerDraftsStore.getState();
  if (input.carry) return null;
  if (input.from === input.to) return store.take(input.to) ?? null;
  store.park(input.from, input.live);
  return store.take(input.to) ?? EMPTY_COMPOSER_DRAFT;
}

/** Test-only: module state must not leak between cases. */
export function resetComposerDraftsForTests(): void {
  useComposerDraftsStore.setState({ parked: {}, offered: {}, offeredAttachments: {} });
}
