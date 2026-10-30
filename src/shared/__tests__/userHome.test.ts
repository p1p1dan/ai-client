import { describe, expect, it } from 'vitest';
import { resolveUserHome, strayWindowsHome } from '../userHome';

const CADENCE_HOME = 'D:\\cadence\\Cadence\\SPB_Data';
const PROFILE = 'C:\\Users\\eng';

describe('resolveUserHome', () => {
  it('ignores a Cadence-style HOME on Windows', () => {
    expect(
      resolveUserHome({
        platform: 'win32',
        env: { HOME: CADENCE_HOME, USERPROFILE: PROFILE },
        osHome: PROFILE,
      })
    ).toBe(PROFILE);
  });

  it('falls back to the OS answer on Windows when USERPROFILE is missing', () => {
    expect(
      resolveUserHome({ platform: 'win32', env: { HOME: CADENCE_HOME }, osHome: PROFILE })
    ).toBe(PROFILE);
  });

  it('keeps HOME first on POSIX', () => {
    expect(
      resolveUserHome({ platform: 'linux', env: { HOME: '/tmp/fake-home' }, osHome: '/home/eng' })
    ).toBe('/tmp/fake-home');
    expect(resolveUserHome({ platform: 'linux', env: {}, osHome: '/home/eng' })).toBe('/home/eng');
  });
});

describe('strayWindowsHome', () => {
  it('names a Windows HOME that is not the profile', () => {
    expect(
      strayWindowsHome({
        platform: 'win32',
        env: { HOME: CADENCE_HOME, USERPROFILE: PROFILE },
        osHome: PROFILE,
      })
    ).toBe(CADENCE_HOME);
  });

  it('is null when HOME is the profile, spelled differently', () => {
    expect(
      strayWindowsHome({
        platform: 'win32',
        env: { HOME: 'c:/users/eng/', USERPROFILE: PROFILE },
        osHome: PROFILE,
      })
    ).toBeNull();
  });

  it('is null without HOME, and off Windows', () => {
    expect(
      strayWindowsHome({ platform: 'win32', env: { USERPROFILE: PROFILE }, osHome: PROFILE })
    ).toBeNull();
    expect(
      strayWindowsHome({ platform: 'linux', env: { HOME: '/x', USERPROFILE: '/y' }, osHome: '/y' })
    ).toBeNull();
  });
});
