import { APP_STATE_DIR, LEGACY_APP_STATE_DIR } from '@shared/defaultPaths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      ({ home: 'C:/Users/eng', userData: 'C:/Users/eng/AppData/Roaming/PiLabAi' })[name] ?? '',
  },
}));

import { getAppStateRoot, getStrayHomeEnvRoots } from '../appStatePaths';

const CADENCE = 'D:/cadence/Cadence/SPB_Data';
const PROFILE = 'C:/Users/eng';

describe('getStrayHomeEnvRoots', () => {
  const platform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('USERPROFILE', PROFILE);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.unstubAllEnvs();
  });

  it('lists this profile first, then former names and .aiclient, each paired with its profile place', () => {
    vi.stubEnv('HOME', CADENCE);
    expect(getStrayHomeEnvRoots({ includePriorInstalls: true })).toEqual([
      {
        strayRoot: `${CADENCE}/${APP_STATE_DIR}/PiLabAi`,
        newRoot: `${PROFILE}/${APP_STATE_DIR}/PiLabAi`,
        isProfileRoot: true,
      },
      {
        strayRoot: `${CADENCE}/${APP_STATE_DIR}/AiClient`,
        newRoot: `${PROFILE}/${APP_STATE_DIR}/AiClient`,
        isProfileRoot: false,
      },
      {
        strayRoot: `${CADENCE}/${APP_STATE_DIR}/jyw-ai-client`,
        newRoot: `${PROFILE}/${APP_STATE_DIR}/jyw-ai-client`,
        isProfileRoot: false,
      },
      {
        strayRoot: `${CADENCE}/${LEGACY_APP_STATE_DIR}`,
        newRoot: `${PROFILE}/${LEGACY_APP_STATE_DIR}`,
        isProfileRoot: false,
      },
    ]);
    expect(getAppStateRoot()).toBe(`${PROFILE}/${APP_STATE_DIR}/PiLabAi`);
  });

  it('leaves out former names for a dev build', () => {
    vi.stubEnv('HOME', CADENCE);
    expect(
      getStrayHomeEnvRoots({ includePriorInstalls: false }).map((root) => root.isProfileRoot)
    ).toEqual([true, false]);
  });

  it('is empty without a HOME, or with one that is the profile', () => {
    vi.stubEnv('HOME', undefined);
    expect(getStrayHomeEnvRoots({ includePriorInstalls: true })).toEqual([]);
    vi.stubEnv('HOME', 'c:\\users\\eng\\');
    expect(getStrayHomeEnvRoots({ includePriorInstalls: true })).toEqual([]);
  });
});
