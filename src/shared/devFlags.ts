/**
 * Temporary flags for OpenChamber chat-refactor team-track testing.
 *
 * SKIP_ONBOARDING_GATE: bypass onboarding/login gate.
 * - Shipped release: always false (gate enforced).
 * - Local dev point-checks: set env var VITE_SKIP_ONBOARDING_GATE=1 when
 *   launching `pnpm dev` to bypass without editing source (nightly/CP keep
 *   this false so the gate stays enforced in builds).
 */
const envFlag =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env !== 'undefined'
    ? import.meta.env.VITE_SKIP_ONBOARDING_GATE
    : undefined;

export const SKIP_ONBOARDING_GATE =
  envFlag === true || envFlag === '1' || envFlag === 'true';