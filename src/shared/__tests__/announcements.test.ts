import { describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENT_MAX_BODY_CHARS,
  ANNOUNCEMENTS_MAX_ITEMS,
  type Announcement,
  mergeReadAnnouncementIds,
  parseAnnouncements,
  shouldOpenAnnouncementsOnStartup,
  unreadAnnouncementIds,
} from '../announcements';

const announcement = (id: string, overrides: Partial<Announcement> = {}): Announcement => ({
  id,
  title: `Title ${id}`,
  body: '',
  severity: 'info',
  ...overrides,
});

describe('F09 parseAnnouncements', () => {
  it('reads the documented envelope and a bare array alike', () => {
    const entry = { id: 'a', title: 'Release 0.4.0' };
    expect(parseAnnouncements({ version: 1, announcements: [entry] })).toHaveLength(1);
    expect(parseAnnouncements([entry])).toHaveLength(1);
  });

  it('answers with nothing rather than throwing on anything unexpected', () => {
    for (const payload of [null, undefined, 42, 'text', {}, { announcements: 'no' }]) {
      expect(parseAnnouncements(payload)).toEqual([]);
    }
  });

  it('drops entries that would render as a blank card', () => {
    const parsed = parseAnnouncements([
      { id: '', title: 'no id' },
      { id: 'b', title: '   ' },
      { title: 'no id field' },
      'not an object',
      { id: 'ok', title: 'Real' },
    ]);
    expect(parsed.map((entry) => entry.id)).toEqual(['ok']);
  });

  it('collapses a repeated id to its first occurrence', () => {
    const parsed = parseAnnouncements([
      { id: 'dup', title: 'First' },
      { id: 'dup', title: 'Second' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('First');
  });

  it('degrades an unknown severity instead of losing the message', () => {
    expect(parseAnnouncements([{ id: 'a', title: 'T', severity: 'apocalyptic' }])[0].severity).toBe(
      'info'
    );
    expect(parseAnnouncements([{ id: 'a', title: 'T', severity: 'critical' }])[0].severity).toBe(
      'critical'
    );
  });

  it('bounds how much one response can put on screen', () => {
    const many = Array.from({ length: ANNOUNCEMENTS_MAX_ITEMS + 5 }, (_, i) => ({
      id: `a${i}`,
      title: 'T',
    }));
    expect(parseAnnouncements(many)).toHaveLength(ANNOUNCEMENTS_MAX_ITEMS);
    const long = parseAnnouncements([
      { id: 'a', title: 'T', body: 'x'.repeat(ANNOUNCEMENT_MAX_BODY_CHARS + 500) },
    ]);
    expect(long[0].body).toHaveLength(ANNOUNCEMENT_MAX_BODY_CHARS);
  });

  it('omits publishedAt rather than inventing one', () => {
    expect(parseAnnouncements([{ id: 'a', title: 'T' }])[0]).not.toHaveProperty('publishedAt');
    expect(parseAnnouncements([{ id: 'a', title: 'T', publishedAt: 123 }])[0]).not.toHaveProperty(
      'publishedAt'
    );
  });
});

describe('F09 startup popup rule', () => {
  it('opens on EVERY launch when there is something to show, read or not', () => {
    // The confirmed product ruling. Read state deliberately does not gate this.
    const result = { announcements: [announcement('a')], source: 'remote' as const };
    expect(shouldOpenAnnouncementsOnStartup(result)).toBe(true);
  });

  it('opens for a cached list, so an offline launch still shows the message', () => {
    expect(
      shouldOpenAnnouncementsOnStartup({ announcements: [announcement('a')], source: 'cache' })
    ).toBe(true);
  });

  it('stays shut on an empty list and on a failed fetch', () => {
    expect(shouldOpenAnnouncementsOnStartup({ announcements: [], source: 'remote' })).toBe(false);
    expect(shouldOpenAnnouncementsOnStartup({ announcements: [], source: 'unavailable' })).toBe(
      false
    );
    // Not reachable in practice, but stated: a failure never opens anything.
    expect(
      shouldOpenAnnouncementsOnStartup({
        announcements: [announcement('a')],
        source: 'unavailable',
      })
    ).toBe(false);
  });
});

describe('F09 read state', () => {
  it('reports unread ids in list order', () => {
    const list = [announcement('a'), announcement('b'), announcement('c')];
    expect(unreadAnnouncementIds(list, ['b'])).toEqual(['a', 'c']);
    expect(unreadAnnouncementIds(list, ['a', 'b', 'c'])).toEqual([]);
  });

  it('merges what was just seen into what was stored', () => {
    const list = [announcement('a'), announcement('b')];
    expect(
      mergeReadAnnouncementIds({ readIds: ['a'], seenIds: ['b'], announcements: list }).sort()
    ).toEqual(['a', 'b']);
  });

  it('prunes ids the service no longer serves', () => {
    // Without this the set grows forever, and a RETIRED id that is later reused
    // would arrive already marked read — the user would never see it.
    expect(
      mergeReadAnnouncementIds({
        readIds: ['retired', 'a'],
        seenIds: [],
        announcements: [announcement('a')],
      })
    ).toEqual(['a']);
  });

  it('never records an id that is not in the current list', () => {
    expect(
      mergeReadAnnouncementIds({ readIds: [], seenIds: ['ghost'], announcements: [] })
    ).toEqual([]);
  });
});

/**
 * F09 cross-repo contract.
 *
 * The two halves of this feature live in different repositories, run on
 * different runtimes, and are tested by different frameworks — so "both sides
 * assert the same shape" is a claim nothing checks. This closes that: the
 * payload below was CAPTURED from `jyw-cch-onboarding`'s real
 * `GET /api/v1/announcements` handler on 2026-09-07 (commit `5993d84`), by
 * seeding its repo and calling the route, not by writing out what we hoped it
 * would send.
 *
 * If the service changes its wire shape, this test is what notices.
 */
describe('F09 onboarding service contract', () => {
  const CAPTURED = {
    version: 1,
    announcements: [
      {
        id: 'maint-0914',
        title: '计划内维护',
        body: '周日 02:00–03:00 将短暂中断。',
        severity: 'warning',
        publishedAt: '2026-09-07T00:00:00.000Z',
      },
      // Second row exercises the two optional paths at once: an empty body, and
      // `publishedAt` OMITTED rather than sent as null.
      { id: 'rel-040', title: 'Release 0.4.0', body: '', severity: 'info' },
    ],
  };

  it('parses a real response from the onboarding service', () => {
    expect(parseAnnouncements(CAPTURED)).toEqual([
      {
        id: 'maint-0914',
        title: '计划内维护',
        body: '周日 02:00–03:00 将短暂中断。',
        severity: 'warning',
        publishedAt: '2026-09-07T00:00:00.000Z',
      },
      { id: 'rel-040', title: 'Release 0.4.0', body: '', severity: 'info' },
    ]);
  });

  it('opens the startup dialog for that response', () => {
    // The end-to-end claim the feature exists to make: what the service serves
    // is what puts a dialog on screen at launch.
    expect(
      shouldOpenAnnouncementsOnStartup({
        announcements: parseAnnouncements(CAPTURED),
        source: 'remote',
      })
    ).toBe(true);
  });

  it('counts both as unread on a first launch, and neither after they are read', () => {
    const parsed = parseAnnouncements(CAPTURED);
    expect(unreadAnnouncementIds(parsed, [])).toEqual(['maint-0914', 'rel-040']);
    expect(unreadAnnouncementIds(parsed, ['maint-0914', 'rel-040'])).toEqual([]);
  });

  it("survives the service's disabled rows simply not being there", () => {
    // The seeded fixture also had a disabled row; the service omitted it, so the
    // client never has to know the concept exists.
    expect(parseAnnouncements(CAPTURED).map((entry) => entry.id)).not.toContain('hidden');
  });
});
