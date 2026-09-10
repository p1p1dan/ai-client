import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';

/**
 * H/18 S3, UI half — the sidebar row actually SHOWS the unread marker.
 *
 * The rule itself (who gets marked, who clears it) is covered by
 * `stores/__tests__/unreadSessionMarkers.test.ts`; what a pure store test
 * cannot see is whether the row renders it, and where. Static for the same
 * reason as this directory's other LeftNav tests: nothing here renders LeftNav.
 */
const navPath = path.join(process.cwd(), 'src/renderer/components/workspace-shell/LeftNav.tsx');
const nav = stripComments(readFileSync(navPath, 'utf8'), navPath);
const rowSource = nav.slice(nav.indexOf('function SessionRow('));

describe('S3 unread marker on the session row', () => {
  it('every list the sidebar renders passes it — Recent, folders and temporary chats', () => {
    // Three call sites, three lists. Missing one would leave a whole section
    // silently unable to report a finished run.
    expect(nav.split('unread={unreadSessionIds.includes(row.sessionId)}')).toHaveLength(4);
    expect(nav).toContain(
      'const unreadSessionIds = useChatSessionsStore((state) => state.unreadSessionIds);'
    );
  });

  it('shares the row s one marker slot instead of adding a second dot', () => {
    // The slot is 6px and the row is width-starved (see the `min-w-20` note on
    // the title). A second marker would push the title, so the states share one
    // slot in urgency order: busy, then unread, then merely started.
    const slot = rowSource.slice(
      rowSource.indexOf('{onToggleSelect ? null : row.busy ? ('),
      rowSource.indexOf('<span className="min-w-20 flex-1 truncate">')
    );
    expect(slot).toContain(') : unread ? (');
    expect(slot.indexOf('row.busy')).toBeLessThan(slot.indexOf(') : unread ? ('));
    expect(slot.indexOf(') : unread ? (')).toBeLessThan(slot.indexOf(') : started ? ('));
  });

  it('distinguishes a finished run from a failed one, and says so in words', () => {
    expect(rowSource).toContain("row.failed ? 'bg-destructive' : 'bg-success'");
    expect(rowSource).toContain("t('Failed while you were away')");
    expect(rowSource).toContain("t('Finished while you were away')");
    // Not aria-hidden like the run-state dots beside it: this marker is the
    // only carrier of its fact, so a screen reader has to get it too.
    const marker = rowSource.slice(
      rowSource.indexOf(') : unread ? ('),
      rowSource.indexOf(') : started ? (')
    );
    expect(marker).toContain('aria-label={unreadLabel}');
    expect(marker).not.toContain('aria-hidden');
  });
});
