const DEFAULT_ONBOARDING_SERVICE_URL = 'https://onboarding-jyw.pipidan.qzz.io';

/**
 * The onboarding service this build talks to.
 *
 * Compile-time injection with a shipped default — there is no user-facing
 * setting for it, and the `onboarding.serverUrl` recorded at login is the CCH
 * gateway address, not this one. Kept in its own module so the model catalog
 * can derive its default endpoint (plan D05) without importing the whole
 * onboarding service.
 */
export function getOnboardingServiceUrl(): string {
  const injected = typeof __ONBOARDING_SERVICE_URL__ === 'string' ? __ONBOARDING_SERVICE_URL__ : '';
  return injected || DEFAULT_ONBOARDING_SERVICE_URL;
}
