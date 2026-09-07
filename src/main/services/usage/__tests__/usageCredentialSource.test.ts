import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVICE = join(process.cwd(), 'src/main/services/usage/UsageService.ts');

function code(): string {
  return readFileSync(SERVICE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The usage calls must use ONLY the gateway address and key issued at LOGIN —
 * never the model-management address or the credentials the model catalog
 * resolves (user ruling, 2026-09-07).
 *
 * The two are easy to confuse because both live under `services/` and both end
 * up talking to something called "the server". They are not the same address:
 * `getOnboardingServiceUrl()` is the onboarding sidecar (which serves the model
 * catalog and the announcements), while `cchBaseUrl` is the cch gateway that
 * actually meters usage. Pointing usage at the sidecar would query a service
 * that has never seen a single request of this user's.
 *
 * `piModelConfig`'s `managedCredential()` is the other trap: it prefers
 * `payload.pi` and falls back to a `${cchBaseUrl}/v1` it synthesises. That is
 * the right resolution for pi's `models.json` and the wrong one here — `/v1` is
 * the proxy path, not the Actions API's origin.
 *
 * Asserted statically because the mistake is an import, and an import is
 * exactly the kind of thing a later edit adds without noticing.
 */
describe('F10 usage credentials come from login, not from model management', () => {
  it('never imports the onboarding service address or the pi model config', () => {
    const source = code();
    expect(source).not.toMatch(/getOnboardingServiceUrl|onboarding\/serviceUrl/);
    expect(source).not.toMatch(/piModelConfig|managedCredential|getPiModelManagementUrl/);
  });

  it('reads the gateway address and key straight off the login vault payload', () => {
    const source = code();
    expect(source).toContain('vaultResult.doc.payload.cchBaseUrl');
    expect(source).toContain('vaultResult.doc.payload.codex.apiKey');
    // Not `payload.pi.baseUrl`, and not a synthesised `/v1` — those belong to
    // the model config's own resolution, which answers a different question.
    expect(source).not.toMatch(/payload\.pi\b/);
    expect(source).not.toMatch(/cchBaseUrl\}\/v1/);
  });

  it('sends every usage call to the login-issued origin', () => {
    // Every URL this file builds hangs off the same `serverUrl` constant, which
    // is the vault's `cchBaseUrl`. A hard-coded host or a second base would be
    // a second answer to "which server meters this user".
    const urls = [...code().matchAll(/`\$\{serverUrl\}([^`]*)`/g)].map((match) => match[1]);
    expect(urls).toEqual(
      expect.arrayContaining([
        '/api/actions/my-usage/getMyTodayStats',
        '/api/actions/my-usage/getMyStatsSummary',
        '/api/actions/my-usage/getMyQuota',
      ])
    );
    expect(code()).not.toMatch(/https?:\/\//);
  });
});
