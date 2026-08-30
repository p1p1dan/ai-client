import { beforeEach, describe, expect, it } from 'vitest';
import {
  isSessionRetired,
  markSessionsLive,
  markSessionsRetired,
  resetSessionRetirementForTests,
} from '../sessionRetirement';

beforeEach(() => resetSessionRetirementForTests());

describe('session retirement tombstones', () => {
  it('blocks a removed session until the same id is explicitly live again', () => {
    markSessionsRetired(['s1']);
    expect(isSessionRetired('s1')).toBe(true);
    expect(isSessionRetired('s2')).toBe(false);

    markSessionsLive(['s1']);
    expect(isSessionRetired('s1')).toBe(false);
  });

  it('never blocks sessionless initialization events', () => {
    markSessionsRetired(['s1']);
    expect(isSessionRetired(null)).toBe(false);
    expect(isSessionRetired(undefined)).toBe(false);
  });
});
