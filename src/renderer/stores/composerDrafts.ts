import { create } from 'zustand';
import { type PersistStorage, persist, type StorageValue } from 'zustand/middleware';
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
 * composer's own state, mirrored in as `live` so it can be saved too.
 *
 * Issue #26 item 3: the unsent TEXT of every chat survives a restart — what
 * the user typed, and a failed send's message, which the composer puts back
 * into the box (or into the chat's parked draft) as text. It is written to
 * `localStorage` through a debounced storage (`DRAFT_SAVE_DELAY_MS`, flushed
 * on unload) and read back into `parked`, so the composer's ordinary
 * `take()` on mount or on return hands it back. Attachments are not saved:
 * they carry file bytes, and localStorage is a few megabytes.
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

/** One saved draft: its text and when it was last written, for the cap. */
export interface SavedComposerDraft {
  text: string;
  at: number;
}

interface PersistedComposerDrafts {
  saved: Record<string, SavedComposerDraft>;
}

/** How long typing must pause before the drafts are written to disk. */
export const DRAFT_SAVE_DELAY_MS = 500;

/** At most this many chats keep a saved draft; the least recently written go first. */
export const MAX_SAVED_DRAFTS = 50;

/** Longer texts are cut to this many characters when saved (localStorage is small). */
export const MAX_SAVED_DRAFT_CHARS = 100_000;

export const COMPOSER_DRAFTS_STORAGE_KEY = 'aiclient-composer-drafts';

interface ComposerDraftsState {
  parked: Record<string, ComposerDraft>;
  /** The box on screen: whose chat it is and what it holds right now. */
  live: { key: string; text: string } | null;
  /** When each key's draft was last written (ms); feeds the cap. */
  stamps: Record<string, number>;
  /** The composer's own text changed (or the chat on screen did). */
  noteLive: (sessionId: string | null, text: string) => void;
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

/**
 * Keys read back from disk this run, and session ids seen in a live session
 * list. A saved draft is pruned only once its chat was seen alive and then
 * went away: at startup the session list is empty or partial, and pruning
 * against it would delete every saved draft before the index arrives. A chat
 * deleted while the app was closed is never seen; the cap retires it.
 */
const restoredKeys = new Set<string>();
const seenLiveIds = new Set<string>();

/** What goes to disk: parked texts plus the box on screen, newest `MAX_SAVED_DRAFTS`. */
export function selectSavedDrafts(state: {
  parked: Readonly<Record<string, ComposerDraft>>;
  live: { key: string; text: string } | null;
  stamps: Readonly<Record<string, number>>;
}): Record<string, SavedComposerDraft> {
  const texts = new Map<string, string>();
  for (const [key, draft] of Object.entries(state.parked)) {
    if (draft.text.trim().length > 0) texts.set(key, draft.text);
  }
  if (state.live) {
    if (state.live.text.trim().length > 0) texts.set(state.live.key, state.live.text);
    else texts.delete(state.live.key);
  }
  const entries = [...texts].map(([key, text]) => ({
    key,
    text: text.slice(0, MAX_SAVED_DRAFT_CHARS),
    at: state.stamps[key] ?? 0,
  }));
  entries.sort((a, b) => b.at - a.at);
  return Object.fromEntries(
    entries.slice(0, MAX_SAVED_DRAFTS).map(({ key, text, at }) => [key, { text, at }])
  );
}

/** A stored payload this build understands; anything else reads as no drafts. */
export function sanitizeSavedDrafts(value: unknown): Record<string, SavedComposerDraft> {
  const saved = (value as { saved?: unknown } | null | undefined)?.saved;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const out: Record<string, SavedComposerDraft> = {};
  for (const [key, entry] of Object.entries(saved as Record<string, unknown>)) {
    const candidate = entry as { text?: unknown; at?: unknown } | null;
    if (typeof candidate?.text !== 'string' || candidate.text.trim().length === 0) continue;
    out[key] = { text: candidate.text, at: typeof candidate.at === 'number' ? candidate.at : 0 };
  }
  return out;
}

/**
 * localStorage behind a trailing debounce: a burst of keystrokes is one write,
 * serialized at flush time. `flush` also runs on `beforeunload`, so quitting
 * mid-pause keeps the last characters typed.
 */
export function createDebouncedDraftStorage(
  delayMs: number,
  getStorage: () => Storage | undefined = () =>
    typeof localStorage === 'undefined' ? undefined : localStorage
): PersistStorage<PersistedComposerDrafts> & { flush: () => void } {
  let pending: { name: string; serialized: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The last serialised value written or queued: `persist` calls setItem on
  // every store update, and an unchanged snapshot needs no timer at all.
  let lastSerialized: string | null = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const write = pending;
    pending = null;
    if (!write) return;
    try {
      getStorage()?.setItem(write.name, write.serialized);
    } catch {
      // Quota or a locked storage: losing a draft beats breaking the composer.
    }
  };
  return {
    flush,
    getItem: (name) => {
      try {
        const raw = getStorage()?.getItem(name);
        lastSerialized = raw ?? null;
        return raw ? (JSON.parse(raw) as StorageValue<PersistedComposerDrafts>) : null;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      const serialized = JSON.stringify(value);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      pending = { name, serialized };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    removeItem: (name) => {
      pending = null;
      lastSerialized = null;
      getStorage()?.removeItem(name);
    },
  };
}

const draftStorage = createDebouncedDraftStorage(DRAFT_SAVE_DELAY_MS);
if (typeof window !== 'undefined') window.addEventListener('beforeunload', draftStorage.flush);

/** Test-only: write any pending save now. */
export function flushComposerDraftsForTests(): void {
  draftStorage.flush();
}

export const useComposerDraftsStore = create<ComposerDraftsState>()(
  persist(
    (set, get) => ({
      parked: {},
      live: null,
      stamps: {},
      offered: {},
      offeredAttachments: {},

      noteLive: (sessionId, text) => {
        const key = draftKey(sessionId);
        const live = get().live;
        if (live && live.key === key && live.text === text) return;
        set((state) => ({ live: { key, text }, stamps: { ...state.stamps, [key]: Date.now() } }));
      },

      park: (sessionId, draft) => {
        const key = draftKey(sessionId);
        if (isEmptyComposerDraft(draft)) {
          if (key in get().parked) set((state) => ({ parked: without(state.parked, key) }));
          return;
        }
        set((state) => ({
          parked: {
            ...state.parked,
            [key]: { text: draft.text, attachments: [...draft.attachments] },
          },
          stamps: { ...state.stamps, [key]: Date.now() },
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

      pruneSessions: (sessionIds) => {
        for (const id of sessionIds) seenLiveIds.add(id);
        // Nothing to drop is the common case: skip `set`, so the persist
        // middleware does not queue a write for an unchanged snapshot.
        const liveIds = new Set([...sessionIds, START_SCREEN_DRAFT_KEY]);
        const stays = (key: string) =>
          liveIds.has(key) || (restoredKeys.has(key) && !seenLiveIds.has(key));
        const current = get();
        const records = [current.parked, current.offered, current.offeredAttachments];
        if (records.every((record) => Object.keys(record).every(stays))) return;
        set((state) => {
          const live = new Set([...sessionIds, START_SCREEN_DRAFT_KEY]);
          // A draft read back from disk waits until its chat has been seen alive.
          const keep = (key: string) =>
            live.has(key) || (restoredKeys.has(key) && !seenLiveIds.has(key));
          const keys = [state.parked, state.offered, state.offeredAttachments].flatMap((record) =>
            Object.keys(record)
          );
          if (keys.every(keep)) return state;
          const kept = <T>(record: Record<string, T>) =>
            Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)));
          return {
            parked: kept(state.parked),
            offered: kept(state.offered),
            offeredAttachments: kept(state.offeredAttachments),
            live: state.live && keep(state.live.key) ? state.live : null,
          };
        });
      },
    }),
    {
      name: COMPOSER_DRAFTS_STORAGE_KEY,
      version: 1,
      storage: draftStorage,
      partialize: (state): PersistedComposerDrafts => ({ saved: selectSavedDrafts(state) }),
      // Saved texts come back as parked drafts: nothing is on screen yet, and
      // the composer takes its chat's draft on mount (`switchComposerDraft`).
      merge: (persisted, current) => {
        const saved = sanitizeSavedDrafts(persisted);
        const parked = { ...current.parked };
        const stamps = { ...current.stamps };
        for (const [key, entry] of Object.entries(saved)) {
          if (parked[key]) continue;
          parked[key] = { text: entry.text, attachments: [] };
          stamps[key] = entry.at;
          restoredKeys.add(key);
        }
        return { ...current, parked, stamps };
      },
    }
  )
);

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
  restoredKeys.clear();
  seenLiveIds.clear();
  useComposerDraftsStore.setState({
    parked: {},
    live: null,
    stamps: {},
    offered: {},
    offeredAttachments: {},
  });
}
