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
