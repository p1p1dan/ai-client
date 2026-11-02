// @vitest-environment happy-dom
import type { AttachmentReadResult } from '@shared/types/attachmentIo';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDraft } from '../attachments';

/**
 * PiLab R2 (03.7): a file picked in chat A that finishes reading after the
 * user opened chat B used to land in B's box and go out with B's next send.
 * It now goes back to A; and A's read no longer holds B's Send.
 */

vi.mock('@/i18n', async () => {
  const { englishTranslate } = await import('@shared/i18n');
  return { useI18n: () => ({ t: englishTranslate, locale: 'en' }) };
});

import { type ComposerAttachments, useComposerAttachments } from '../useComposerAttachments';

let root: Root | undefined;
let hook: ComposerAttachments | undefined;
const landed: Array<{ owner: string | null; name: string }> = [];
let release: ((result: AttachmentReadResult) => void) | undefined;

function Harness(props: { owner: string | null }) {
  hook = useComposerAttachments({
    disabled: false,
    owner: props.owner,
    onLandedElsewhere: (owner: string | null, draft: AttachmentDraft) =>
      landed.push({ owner, name: draft.name }),
  });
  return null;
}

async function render(owner: string | null) {
  await act(async () => root?.render(createElement(Harness, { owner })));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  landed.length = 0;
  window.electronAPI = {
    file: {
      readAttachment: () =>
        new Promise<AttachmentReadResult>((resolve) => {
          release = resolve;
        }),
    },
  } as unknown as typeof window.electronAPI;
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('[PILAB-R2-ATTACH-OWNER] a late file stays with the chat it was picked in', () => {
  it('lands in its own chat, not the one on screen, and does not hold its Send', async () => {
    await render('a');
    let done: Promise<void> | undefined;
    await act(async () => {
      done = hook?.ingestPickedPaths(['/repo/notes.txt']);
    });
    expect(hook?.reading).toBe(1);

    await render('b');
    expect(hook?.reading).toBe(0);

    const bytes = new TextEncoder().encode('hello');
    await act(async () => {
      release?.({ ok: true, bytes, byteLength: bytes.length });
      await done;
    });
    expect(hook?.drafts).toEqual([]);
    expect(landed).toEqual([{ owner: 'a', name: 'notes.txt' }]);

    await render('a');
    expect(hook?.reading).toBe(0);
  });

  it('lands in the box when the user stayed', async () => {
    await render('a');
    let done: Promise<void> | undefined;
    await act(async () => {
      done = hook?.ingestPickedPaths(['/repo/notes.txt']);
    });
    const bytes = new TextEncoder().encode('hello');
    await act(async () => {
      release?.({ ok: true, bytes, byteLength: bytes.length });
      await done;
    });
    expect(hook?.drafts.map((draft) => draft.name)).toEqual(['notes.txt']);
    expect(landed).toEqual([]);
  });
});

describe('[PILAB-R2-DROP] files dropped on the composer', () => {
  it('takes the dropped files themselves, and names a dropped folder in the notice', async () => {
    await render('a');
    const notes = new File(['dropped text'], 'notes.txt', { type: 'text/plain' });
    await act(async () => {
      await hook?.ingestDropped([notes], ['docs']);
    });
    expect(hook?.drafts.map((draft) => [draft.name, draft.data])).toEqual([
      ['notes.txt', 'dropped text'],
    ]);
    expect(hook?.notice?.message).toBe('"docs" is not a file — skipped.');
  });

  it('says why a dropped file was skipped, in the same notice', async () => {
    await render('a');
    const archive = new File(['PK'], 'release.zip', { type: 'application/zip' });
    await act(async () => {
      await hook?.ingestDropped([archive]);
    });
    expect(hook?.drafts).toEqual([]);
    expect(hook?.notice?.message).toMatch(/release\.zip/);
  });
});
