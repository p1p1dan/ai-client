// @vitest-environment happy-dom
//
// 2026-09-18 field report: the startup announcement and the migration offer
// both auto-open on the same launch and both land on the same z-index tier,
// so whichever painted second covered the other's own buttons — the
// announcement's "Got it" ended up permanently undismissable, sitting under
// the migration dialog's list rows. `@/stores/modalQueue` +
// `@/hooks/useModalQueueSlot` fix this by letting at most one self-opening
// dialog hold the screen at a time. This file pins that behavior directly
// against the two real dialogs, not a synthetic stand-in.
//
// It also re-runs the "Not now" close with a REAL (pointerdown -> mousedown ->
// focus -> pointerup -> mouseup -> click) event sequence rather than
// `HTMLElement.click()` (which only synthesizes a bare `click` and never
// exercises Base UI's pointerdown-driven outside-press/focus-trap machinery),
// because that is what field testing uses via CDP. Both dialogs open at once
// reproduces the exact scenario reported; it closes correctly here, which
// means the queue fix removes the stacking without needing any change to
// either dialog's own close handler.

import type { MigrationItemKind, MigrationPlan } from '@shared/agentMigration';
import type { Announcement } from '@shared/announcements';
import { act, createElement, Fragment, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
// This suite is about the modal queue, not A-round — mocked `false` so the
// two dialogs actually open and there is something to queue.
vi.mock('@/lib/aRoundTesting', () => ({
  LOCAL_SETUP_ENTRY_DISABLED: false,
  PI_MIGRATION_DISABLED: false,
}));

import { resetModalQueueForTests } from '@/stores/modalQueue';
import { AnnouncementDialog } from '../../announcements/AnnouncementDialog';
import { AgentMigrationPrompt } from '../AgentMigrationPrompt';

const api = {
  inspect: vi.fn<() => Promise<MigrationPlan>>(),
  apply: vi.fn(),
};

function item(kind: MigrationItemKind, total: number) {
  return {
    kind,
    sourcePath: `/home/u/.pilab/t37c-agent/${kind}`,
    targetPath: `/home/u/.pilab/dev/pi-agent/${kind}`,
    entries: [],
    total,
    conflicts: 0,
    blocked: 0,
  };
}

const PLAN: MigrationPlan = {
  sourceDir: '/home/u/.pilab/t37c-agent',
  targetDir: '/home/u/.pilab/dev/pi-agent',
  sourceExists: true,
  items: [item('providers', 3), item('sessions', 74)],
  nothingToDo: false,
};

const ANNOUNCEMENT: Announcement = { id: 'a1', title: 'Tips', body: 'hello', severity: 'info' };

const ANNOUNCEMENT_MARK = 'Announcements'; // DialogTitle, via the identity `t()` mock.
const MIGRATION_MARK = 'Bring over your personal Pi setup';

let container: HTMLDivElement;
let root: Root;

/** Real React state for the announcement's `open`, so "Got it" (which calls
 * `onOpenChange(false)`) actually re-renders the tree — a plain closure
 * variable mutated by the callback would not. */
function Harness() {
  const [announcementOpen, setAnnouncementOpen] = useState(true);
  return createElement(Fragment, null, [
    createElement(AnnouncementDialog, {
      key: 'ann',
      announcements: [ANNOUNCEMENT],
      open: announcementOpen,
      onOpenChange: setAnnouncementOpen,
    }),
    createElement(AgentMigrationPrompt, { key: 'mig' }),
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetModalQueueForTests();
  api.inspect.mockResolvedValue(PLAN);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    agentMigration: api,
    legacyImport: {
      listProjects: () => Promise.resolve([]),
      listSessions: () => Promise.resolve([]),
      importBatch: () => Promise.resolve({ results: [] }),
    },
    env: { platform: 'linux' },
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderBoth() {
  return act(() => root.render(createElement(Harness)));
}

function shows(mark: string): boolean {
  return document.body.textContent?.includes(mark) ?? false;
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(label)
  );
}

/** A real (pointerdown -> mousedown -> focus -> pointerup -> mouseup -> click)
 * sequence, as CDP's `Input.dispatchMouseEvent` produces. */
function realClick(el: HTMLElement) {
  const opts = { bubbles: true, cancelable: true, composed: true, button: 0 };
  el.dispatchEvent(
    new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' })
  );
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.focus();
  el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

describe('modal queue: announcement + migration prompt open on the same launch', () => {
  it('shows only the announcement first (higher priority), not both stacked', async () => {
    await renderBoth();
    await settle();

    expect(shows(ANNOUNCEMENT_MARK)).toBe(true);
    // Queued, not painted: the migration dialog has decided to open (its own
    // `inspect()` resolved) but must not render while announcement holds the
    // slot — this is the exact state that used to stack two backdrops.
    expect(shows(MIGRATION_MARK)).toBe(false);
    expect(document.body.querySelectorAll('[data-slot="dialog-backdrop"]').length).toBe(1);
  });

  it('hands the slot to the migration prompt the instant the announcement is dismissed', async () => {
    await renderBoth();
    await settle();
    expect(shows(MIGRATION_MARK)).toBe(false);

    await act(async () => {
      button('Got it')?.click();
    });
    await settle();

    expect(shows(ANNOUNCEMENT_MARK)).toBe(false);
    expect(shows(MIGRATION_MARK)).toBe(true);
  });

  it('"Not now" closes the migration prompt via a real event sequence, after it takes its turn', async () => {
    await renderBoth();
    await settle();
    await act(async () => {
      button('Got it')?.click();
    });
    await settle();
    expect(shows(MIGRATION_MARK)).toBe(true);

    const notNow = button('Not now');
    expect(notNow).toBeTruthy();
    await act(async () => {
      realClick(notNow!);
    });
    await settle();

    expect(shows(MIGRATION_MARK)).toBe(false);
    expect(document.body.querySelectorAll('[data-slot="dialog-backdrop"]').length).toBe(0);
  });
});
