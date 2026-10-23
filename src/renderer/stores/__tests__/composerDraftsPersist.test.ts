// @vitest-environment happy-dom
/**
 * Issue #26 item 3: unsent drafts (typed text, and a failed send's message,
 * which the composer puts back as text) survive a restart. Saved to
 * localStorage through a debounced write; read back as parked drafts that the
 * composer takes on mount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DraftsModule = typeof import('../composerDrafts');

async function loadModule(): Promise<DraftsModule> {
  vi.resetModules();
  return import('../composerDrafts');
}

function storedSaved(mod: DraftsModule): Record<string, { text: string; at: number }> {
  const raw = localStorage.getItem(mod.COMPOSER_DRAFTS_STORAGE_KEY);
  return raw ? (JSON.parse(raw).state.saved as Record<string, { text: string; at: number }>) : {};
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('drafts across a restart', () => {
  it('gives a parked draft and the box on screen back after the module reloads', async () => {
    const first = await loadModule();
    const store = first.useComposerDraftsStore.getState();
    store.park('chat-a', { text: 'half a thought', attachments: [] });
    store.noteLive('chat-b', 'the box on screen');
    first.flushComposerDraftsForTests();

    const second = await loadModule();
    const back = second.useComposerDraftsStore.getState();
    expect(back.parked['chat-a']?.text).toBe('half a thought');
    expect(back.parked['chat-b']?.text).toBe('the box on screen');
    // The composer's mount takes its chat's draft back (from === to).
    expect(
      second.switchComposerDraft({
        from: 'chat-b',
        to: 'chat-b',
        carry: false,
        live: second.EMPTY_COMPOSER_DRAFT,
      })
    ).toEqual({ text: 'the box on screen', attachments: [] });
  });

  it('keeps the text and drops the attachments (file bytes stay out of localStorage)', async () => {
    const mod = await loadModule();
    mod.useComposerDraftsStore.getState().park('chat-a', {
      text: 'see the screenshot',
      attachments: [
        {
          id: 'x',
          kind: 'image',
          mediaType: 'image/png',
          name: 'a.png',
          byteLength: 4,
          data: 'AAAA',
        },
      ],
    });
    mod.flushComposerDraftsForTests();
    const raw = localStorage.getItem(mod.COMPOSER_DRAFTS_STORAGE_KEY) ?? '';
    expect(raw).toContain('see the screenshot');
    expect(raw).not.toContain('AAAA');
  });

  it('forgets a draft once it is sent (the box empties)', async () => {
    const mod = await loadModule();
    const store = mod.useComposerDraftsStore.getState();
    store.noteLive('chat-a', 'about to send');
    mod.flushComposerDraftsForTests();
    expect(storedSaved(mod)['chat-a']?.text).toBe('about to send');
    store.noteLive('chat-a', '');
    mod.flushComposerDraftsForTests();
    expect(storedSaved(mod)['chat-a']).toBeUndefined();
  });
});

describe('debounced write', () => {
  it('writes once, after typing pauses, with the latest text', async () => {
    const mod = await loadModule();
    const store = mod.useComposerDraftsStore.getState();
    for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
      store.noteLive('chat-a', text);
      vi.advanceTimersByTime(100);
    }
    expect(storedSaved(mod)['chat-a']).toBeUndefined();
    vi.advanceTimersByTime(mod.DRAFT_SAVE_DELAY_MS);
    expect(storedSaved(mod)['chat-a']?.text).toBe('hello');
  });

  it('the storage coalesces a burst into one setItem, serialized at flush time', async () => {
    const mod = await loadModule();
    const writes: string[] = [];
    const fake = {
      getItem: () => null,
      setItem: (_name: string, value: string) => writes.push(value),
      removeItem: () => undefined,
    } as unknown as Storage;
    const storage = mod.createDebouncedDraftStorage(500, () => fake);
    for (let i = 1; i <= 5; i++) {
      storage.setItem('k', { state: { saved: { a: { text: `v${i}`, at: i } } }, version: 1 });
      vi.advanceTimersByTime(499);
    }
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? '').state.saved.a.text).toBe('v5');
  });

  it('flushes a pending write on unload', async () => {
    const mod = await loadModule();
    mod.useComposerDraftsStore.getState().noteLive('chat-a', 'typed just before quitting');
    expect(storedSaved(mod)['chat-a']).toBeUndefined();
    window.dispatchEvent(new Event('beforeunload'));
    expect(storedSaved(mod)['chat-a']?.text).toBe('typed just before quitting');
  });
});

describe('what is kept', () => {
  it('caps the saved drafts at the most recently written ones', async () => {
    const mod = await loadModule();
    const store = mod.useComposerDraftsStore.getState();
    const count = mod.MAX_SAVED_DRAFTS + 10;
    for (let i = 0; i < count; i++) {
      vi.advanceTimersByTime(1);
      store.park(`chat-${i}`, { text: `draft ${i}`, attachments: [] });
    }
    mod.flushComposerDraftsForTests();
    const saved = storedSaved(mod);
    expect(Object.keys(saved)).toHaveLength(mod.MAX_SAVED_DRAFTS);
    expect(saved['chat-0']).toBeUndefined();
    expect(saved[`chat-${count - 1}`]?.text).toBe(`draft ${count - 1}`);
  });

  it('does not prune restored drafts against the empty session list of startup', async () => {
    const first = await loadModule();
    first.useComposerDraftsStore.getState().park('chat-a', { text: 'keep me', attachments: [] });
    first.flushComposerDraftsForTests();

    const second = await loadModule();
    const store = () => second.useComposerDraftsStore.getState();
    store().pruneSessions([]);
    store().pruneSessions(['chat-other']);
    expect(store().parked['chat-a']?.text).toBe('keep me');
    // Seen alive, then gone: the chat was deleted, so its draft goes.
    store().pruneSessions(['chat-a']);
    store().pruneSessions([]);
    expect(store().parked['chat-a']).toBeUndefined();
  });

  it('ignores an unreadable stored payload', async () => {
    const mod = await loadModule();
    expect(mod.sanitizeSavedDrafts(null)).toEqual({});
    expect(mod.sanitizeSavedDrafts({ saved: { a: { text: 3 }, b: { text: ' ' } } })).toEqual({});
    expect(mod.sanitizeSavedDrafts({ saved: { a: { text: 'x' } } })).toEqual({
      a: { text: 'x', at: 0 },
    });
  });
});
