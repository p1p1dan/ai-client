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
  it('every list the sidebar renders passes it — the repository groups and Temporary chats', () => {
    // Decision 183 retired 「正在活动」 (decision 170 had retired Recent): two
    // lists are left, and both render their rows through ONE renderer, so
    // neither can silently lose the marker the way a third copy of the props
    // once could.
    expect(nav.split('unread={unreadSessionIds.includes(row.sessionId)}')).toHaveLength(2);
    expect(nav.split('<SessionRow\n').length - 1).toBe(1);
    expect(nav).toContain('{limited.rows.map((row) => renderSessionRow(row))}');
    expect(nav).toContain('return renderSessionRow(');
    expect(nav).toContain(
      'const unreadSessionIds = useChatSessionsStore((state) => state.unreadSessionIds);'
    );
  });

  it('shares the row s one marker instead of adding a second dot (layout 5b: trailing)', () => {
    // The row is width-starved (see the `min-w-20` note on the title). A second
    // marker would push the title, so the states share ONE trailing mark in
    // urgency order: waiting, running, failed, unread, then merely started.
    const markStart = rowSource.indexOf('(rowWaiting ? (');
    expect(markStart).toBeGreaterThan(
      rowSource.indexOf('<span className="min-w-20 flex-1 truncate">')
    );
    const mark = rowSource.slice(markStart, rowSource.indexOf(') : null)}', markStart));
    expect(mark).toContain(') : unread ? (');
    expect(mark.indexOf('row.busy')).toBeLessThan(mark.indexOf(') : unread ? ('));
    expect(mark.indexOf(') : unread ? (')).toBeLessThan(mark.indexOf(') : started ? ('));
  });

  it('distinguishes a finished run from a failed one, and says so in words', () => {
    // Layout 5b: an unseen failure is the red warning icon, an unseen result
    // the green dot.
    expect(rowSource).toContain("unread ? 'text-destructive' : 'text-muted-foreground'");
    expect(rowSource).toContain('<span className="size-1.5 rounded-full bg-success" />');
    expect(rowSource).toContain("aria-label={unread ? unreadLabel : t('Failed')}");
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
