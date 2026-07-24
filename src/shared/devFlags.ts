/**
 * Temporary flags for OpenChamber chat-refactor team-track testing.
 *
 * SKIP_ONBOARDING_GATE: bypass onboarding/login gate.
 * - Dev phase default: TRUE — bypass (point-checks use test gateway tokens,
 *   never real onboarding creds).
 * - ONLY flip to false when explicitly validating the onboarding/login
 *   feature itself, or right before a CP gate that needs real onboarding.
 */
export const SKIP_ONBOARDING_GATE = true;
