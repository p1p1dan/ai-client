import { ANNOUNCEMENTS_PATH } from '@shared/announcements';
import { net } from 'electron';
import { getAppStateRoot } from '../appStatePaths';
import { getOnboardingServiceUrl } from '../onboarding/serviceUrl';
import { AnnouncementService } from './AnnouncementService';

/**
 * The announcement endpoint this build talks to.
 *
 * Derived from the onboarding service address exactly the way
 * `defaultPiModelManagementUrl` is (plan D05), and for the same reason: both
 * endpoints belong to that service, so there is one address to configure and
 * one deployment to point at. There is deliberately no user setting and no
 * environment override — unlike the model catalog URL, nothing about an
 * announcement is per-installation, so a second knob would only be a second
 * thing to get wrong.
 */
export function getAnnouncementsUrl(): string {
  return `${getOnboardingServiceUrl().trim().replace(/\/+$/, '')}${ANNOUNCEMENTS_PATH}`;
}

let service: AnnouncementService | null = null;

/**
 * Lazy for the reason `appStatePaths` documents: `app.setPath('userData', …)`
 * runs during `main/index.ts` module evaluation, so a service constructed at
 * import time would capture the pre-override state root.
 */
export function getAnnouncementService(): AnnouncementService {
  if (!service) {
    service = new AnnouncementService({
      stateDir: getAppStateRoot(),
      endpointUrl: getAnnouncementsUrl(),
      fetchFn: (url, init) => net.fetch(url, init),
      log: (...args) => console.info(...args),
    });
  }
  return service;
}

export { AnnouncementService } from './AnnouncementService';
