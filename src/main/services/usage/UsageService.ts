import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UsageStatsResult, WeeklyQuota } from '@shared/types';
import { parseWeeklyQuota } from '@shared/weeklyQuota';
import { net } from 'electron';
import { getAuthProbeScheduler, getAuthStateService, getCredentialVault } from '../auth';
import { classifyAuthLoginResponse } from '../auth/AuthProbeScheduler';
import { resolveManagedCredentialsEnabled } from '../auth/credentialMode';
import { onboardingService } from '../onboarding';

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number') {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function extractErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }
  return null;
}

function readActionData(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || payload.ok !== true) {
    return null;
  }
  return isRecord(payload.data) ? payload.data : null;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function extractCookieValue(setCookieHeader: string, cookieName: string): string | null {
  const lower = setCookieHeader.toLowerCase();
  const needle = `${cookieName.toLowerCase()}=`;
  const index = lower.indexOf(needle);
  if (index === -1) {
    return null;
  }

  const start = index + needle.length;
  const end = setCookieHeader.indexOf(';', start);
  const rawValue = (
    end === -1 ? setCookieHeader.slice(start) : setCookieHeader.slice(start, end)
  ).trim();
  return rawValue || null;
}

function readCodexApiKeyLegacy(): string | null {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(authPath)) {
      return null;
    }
    const raw = fs.readFileSync(authPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const apiKey = (parsed as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY;
    return typeof apiKey === 'string' && apiKey.trim() ? apiKey : null;
  } catch {
    return null;
  }
}

/**
 * D47 S6 §3 (A-M3 + B-M4) — the single-authority credential source for
 * `getStats()`. Flag-on: the admission gate migrates from legacy
 * `onboardingService.checkRegistration()` to `AuthState` (mirrors
 * `main/ipc/auth.ts`'s `hasRefreshed()`-guard-then-`getState()` idiom), and
 * `{serverUrl, apiKey}` come out of ONE vault snapshot
 * (`cchBaseUrl`/`codex.apiKey`) — the legacy `~/.codex/auth.json` reader
 * never participates (call count 0, asserted in tests). A vault status other
 * than `'ok'` (absent/cleared/rejected/locked/invalid/unsupported) is
 * `unavailable` and NEVER falls back to the legacy reader — stop-dual-write
 * (S6 §2) means `~/.codex/auth.json` can be stale or hold a since-rejected
 * key, and falling back to it would let old credentials silently come back
 * to life. Flag-off: unchanged legacy status quo (vault read count 0).
 */
export type UsageAuthTarget =
  | { status: 'ok'; serverUrl: string; apiKey: string }
  | { status: 'unavailable'; reason: string };

function resolveUsageAuthTarget(): UsageAuthTarget {
  if (resolveManagedCredentialsEnabled()) {
    const authStateService = getAuthStateService();
    if (!authStateService.hasRefreshed()) {
      authStateService.refresh();
    }
    if (authStateService.getState().status !== 'authenticated') {
      return { status: 'unavailable', reason: 'Not registered' };
    }

    const vaultResult = getCredentialVault().read();
    if (vaultResult.status !== 'ok') {
      return { status: 'unavailable', reason: 'Credentials not available' };
    }
    return {
      status: 'ok',
      serverUrl: vaultResult.doc.payload.cchBaseUrl,
      apiKey: vaultResult.doc.payload.codex.apiKey,
    };
  }

  const onboarding = onboardingService.checkRegistration();
  if (!onboarding.registered || !onboarding.serverUrl) {
    return { status: 'unavailable', reason: 'Not registered' };
  }
  const apiKey = readCodexApiKeyLegacy();
  if (!apiKey) {
    return { status: 'unavailable', reason: 'Credentials not available' };
  }
  return { status: 'ok', serverUrl: onboarding.serverUrl, apiKey };
}

/**
 * D47 S5 §0-1/§2 — the `/api/auth/login` login attempt for an opaque Actions
 * session. Returns a discriminated union (B-track m4: the old boolean-ish
 * shape dropped `status`/`errorCode`, leaving no way for `getStats()` to tell
 * "key is definitively dead" from "some other transient failure"). Also
 * reports its raw response into `AuthProbeScheduler` as an ADDITIONAL
 * rejection-trigger source (S5 §2) — never runs its own extra probe, just
 * classifies the response it already fetched for its own purposes.
 */
async function loginForActionsSession(
  serverUrl: string,
  apiKey: string
): Promise<
  | { ok: true; sessionId: string | null }
  | { ok: false; rejection: 'key_invalid' | 'unknown'; error: string }
> {
  const loginUrl = `${serverUrl}/api/auth/login`;
  const response = await net.fetch(loginUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ key: apiKey }),
    // D47 S5 §0-2 — never rely on the cookie jar, not even for the login
    // call itself: `set-cookie` is read directly off the response headers
    // below, and `credentials:'omit'` keeps a stale 7-day-old jar cookie
    // from ever silently substituting for this request's own outcome.
    credentials: 'omit',
  });
  const bodyText = await response.text();

  if (resolveManagedCredentialsEnabled()) {
    getAuthProbeScheduler().reportExternalLoginResponse(response.status, bodyText);
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    // Non-JSON body (e.g. an HTML 404) — payloadOk stays false below.
  }
  const payloadRecord = isRecord(payload) ? payload : null;
  const payloadOk = payloadRecord?.ok === true;

  if (!response.ok || !payloadOk) {
    const classification = classifyAuthLoginResponse(response.status, bodyText);
    const message = extractErrorMessage(payload) ?? `Usage API request failed (${response.status})`;
    return {
      ok: false,
      rejection: classification === 'rejected' ? 'key_invalid' : 'unknown',
      error: message,
    };
  }

  const setCookie = response.headers.get('set-cookie');
  const sessionId =
    typeof setCookie === 'string' ? extractCookieValue(setCookie, 'auth-token') : null;
  return { ok: true, sessionId };
}

/** D47 S5 §0-1 — the retry auth carrier: a `set-cookie`-extracted session value goes back out as a `Cookie` header, never as a Bearer token (the pre-S5 bug — a cookie value is not a bearer credential and the cch gateway rejects it every time, E5 real-gateway verification). */
type ActionAuth = { type: 'bearer'; token: string } | { type: 'cookie'; value: string };

async function postAction(
  url: string,
  body: Record<string, unknown>,
  auth?: ActionAuth
): Promise<{ ok: true; payload: unknown } | { ok: false; error: string; status: number }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (auth?.type === 'bearer') {
    headers.Authorization = `Bearer ${auth.token}`;
  } else if (auth?.type === 'cookie') {
    headers.Cookie = `auth-token=${auth.value}`;
  }

  const response = await net.fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    // D47 S5 §0-2 — the direct (bearer) attempt must be allowed to genuinely
    // 401 so the 401->login branch actually runs; `credentials:'include'`
    // let a stale 7-day login cookie from a PRIOR session silently
    // authenticate every direct call, masking that branch forever (E5
    // real-gateway finding: the actions endpoint ONLY accepts the cookie
    // session, never a bare key bearer — so this branch always needs to run
    // in practice). The cookie-carrying retry sends its own explicit
    // `Cookie` header above instead of relying on the jar either.
    credentials: 'omit',
  });

  const payload = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    const message = extractErrorMessage(payload) ?? `Usage API request failed (${response.status})`;
    return { ok: false, error: message, status: response.status };
  }

  return { ok: true, payload };
}

/**
 * F10-b — the Actions session this process already established.
 *
 * ## Why caching it is the whole cost fix
 *
 * `getStats()` used to spend FIVE requests per refresh against this gateway: a
 * bearer attempt that 401s, a login, then the three real calls. Measured, not
 * assumed — a valid key presented as a bearer token to
 * `my-usage/getMyTodayStats` answers `401 {"ok":false,"error":"认证无效或已过期"}`
 * (2026-09-07, live gateway), so the first two were pure overhead on every
 * single poll, forever.
 *
 * With the session cached, a refresh costs three requests and no login. The
 * bearer-first path is NOT deleted, because a gateway that does accept bearer
 * (the legacy/dual-session deployments the original comment names) still gets
 * it — it is simply not paid for again once a cookie is in hand.
 *
 * ## Why it is memory-only, and keyed
 *
 * Never persisted: a session cookie is a bearer credential in its own right,
 * and the vault is the only thing in this app allowed to hold one at rest.
 * Losing it on restart costs exactly one login.
 *
 * Keyed by `serverUrl` + apiKey so that a re-login, a key rotation, or a
 * gateway switch cannot serve the previous account's session — the failure
 * that would produce is another user's numbers on this user's card, which is
 * worse than any number of extra requests.
 *
 * The TTL is our own, deliberately far shorter than the cookie's real
 * `Max-Age` (observed: 7 days). We do not control when the server invalidates
 * a session, so the cache is a cost optimisation with a short leash, not a
 * claim about validity — and `getStats` re-logs in on a 401 anyway.
 */
const SESSION_TTL_MS = 30 * 60 * 1_000;

let cachedSession: { key: string; value: string; expiresAt: number } | null = null;

function sessionCacheKey(serverUrl: string, apiKey: string): string {
  return `${serverUrl}\u0000${apiKey}`;
}

function readCachedSession(serverUrl: string, apiKey: string, now: number): string | null {
  if (!cachedSession) return null;
  if (cachedSession.key !== sessionCacheKey(serverUrl, apiKey)) return null;
  if (cachedSession.expiresAt <= now) return null;
  return cachedSession.value;
}

function storeSession(serverUrl: string, apiKey: string, value: string, now: number): void {
  cachedSession = {
    key: sessionCacheKey(serverUrl, apiKey),
    value,
    expiresAt: now + SESSION_TTL_MS,
  };
}

/** Drop the cached session — a 401 on it means the server no longer honours it. */
function clearSession(): void {
  cachedSession = null;
}

/** Test seam. Logout and account switches must not leave a session behind. */
export function resetUsageSessionCache(): void {
  clearSession();
}

class UsageService {
  async getStats(): Promise<UsageStatsResult> {
    try {
      const authTarget = resolveUsageAuthTarget();
      if (authTarget.status !== 'ok') {
        return { error: authTarget.reason };
      }

      const apiKey = authTarget.apiKey;
      const serverUrl = authTarget.serverUrl.trim().replace(/\/+$/, '');

      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startDate = formatLocalDate(startOfMonth);
      const endDate = formatLocalDate(now);

      const todayUrl = `${serverUrl}/api/actions/my-usage/getMyTodayStats`;
      const summaryUrl = `${serverUrl}/api/actions/my-usage/getMyStatsSummary`;
      // F10. cch's OWN allowance action, on the same API as the two above.
      //
      // Discovered rather than invented (2026-09-07 probe against the live
      // gateway): every made-up name under `my-usage/` answers `404` with a
      // `text/plain` body, while a real one answers `401 {"ok":false,...}` in
      // JSON — the same discrimination the D47 S0 E5 auth probe established.
      // `getMyQuota` and `getMyUsageLogs` answer 401; `getMyWeeklyQuota`,
      // `getMyLimits`, `getMyBudget` and the rest are 404. So the allowance is
      // cch's to report, not ours to build, and this is what it is called.
      //
      // Deliberately a separate call rather than extra fields on
      // `getMyStatsSummary`: that call is scoped by an explicit date range THIS
      // client chooses, while the allowance period is the gateway's own
      // (cch models `limitWeeklyUsd` / `costWeekly` / `resetAt` per key).
      // Folding them together would make our month range look like it selected
      // the week too.
      const quotaUrl = `${serverUrl}/api/actions/my-usage/getMyQuota`;

      /**
       * F10: the allowance is fetched with the SAME auth the stats used, and
       * every failure answers `null`.
       *
       * It is a separate, non-fatal call on purpose. The endpoint is new — an
       * onboard deployment that predates it answers 404 — and the account card
       * must keep working against those: a user's own email address and their
       * logout button cannot depend on a quota lookup. `null` is what the card
       * renders as 暂不可用, which is exactly the honest answer for both "not
       * deployed yet" and "no allowance configured".
       */
      const tryFetchQuota = async (auth?: ActionAuth): Promise<WeeklyQuota | null> => {
        const response = await postAction(quotaUrl, {}, auth);
        if (!response.ok) return null;
        return parseWeeklyQuota(readActionData(response.payload));
      };

      const tryFetchStats = async (
        auth?: ActionAuth
      ): Promise<
        | {
            ok: true;
            todayCount: number;
            todayCostUsd: number;
            monthCount: number;
            monthCostUsd: number;
            weeklyQuota: WeeklyQuota | null;
          }
        | { ok: false; error: string; status: number }
      > => {
        const todayResponse = await postAction(todayUrl, {}, auth);
        if (!todayResponse.ok) {
          return { ok: false, error: todayResponse.error, status: todayResponse.status };
        }

        const todayData = readActionData(todayResponse.payload);
        const todayCount = coerceFiniteNumber(todayData?.calls);
        const todayCostUsd = coerceFiniteNumber(todayData?.costUsd);
        if (todayCount === null || todayCostUsd === null) {
          return { ok: false, error: 'Invalid usage stats response', status: 200 };
        }

        const summaryResponse = await postAction(summaryUrl, { startDate, endDate }, auth);
        if (!summaryResponse.ok) {
          return { ok: false, error: summaryResponse.error, status: summaryResponse.status };
        }

        const summaryData = readActionData(summaryResponse.payload);
        const monthCount = coerceFiniteNumber(summaryData?.totalRequests);
        const monthCostUsd = coerceFiniteNumber(
          summaryData?.totalCost ?? summaryData?.totalCostUsd
        );
        if (monthCount === null || monthCostUsd === null) {
          return { ok: false, error: 'Invalid usage stats response', status: 200 };
        }

        // Last, and after both required calls have succeeded: a failure here
        // must not cost the user the figures that DID arrive.
        const weeklyQuota = await tryFetchQuota(auth);

        return { ok: true, todayCount, todayCostUsd, monthCount, monthCostUsd, weeklyQuota };
      };

      // Attempt #0: the session this process already has. Skips both the
      // doomed bearer probe and the login — the two requests that made every
      // poll cost five instead of three.
      const cached = readCachedSession(serverUrl, apiKey, Date.now());
      if (cached) {
        const reused = await tryFetchStats({ type: 'cookie', value: cached });
        if (reused.ok) {
          return {
            todayCount: reused.todayCount,
            todayCostUsd: reused.todayCostUsd,
            monthCount: reused.monthCount,
            monthCostUsd: reused.monthCostUsd,
            weeklyQuota: reused.weeklyQuota,
          };
        }
        // The server stopped honouring it. Fall through to the full handshake
        // rather than reporting an error: an expired session is an expected
        // outcome, not a failure the user should read about.
        clearSession();
      }

      // Attempt #1: call Actions API with apiKey directly (works in legacy/dual session modes).
      const direct = await tryFetchStats({ type: 'bearer', token: apiKey });
      if (direct.ok) {
        return {
          todayCount: direct.todayCount,
          todayCostUsd: direct.todayCostUsd,
          monthCount: direct.monthCount,
          monthCostUsd: direct.monthCostUsd,
          weeklyQuota: direct.weeklyQuota,
        };
      }

      // If the server uses opaque sessions, the Actions API won't accept apiKey as bearer token.
      // Exchange apiKey for an opaque session cookie and retry.
      if (direct.status === 401 || direct.status === 403) {
        const login = await loginForActionsSession(serverUrl, apiKey);
        if (!login.ok) {
          return { error: login.error };
        }
        if (!login.sessionId) {
          return { error: 'Login succeeded but no session cookie was returned' };
        }

        const retry = await tryFetchStats({ type: 'cookie', value: login.sessionId });
        if (retry.ok) {
          // Stored only after it has actually answered a real call: a cookie
          // that logs in but cannot read is not worth reusing.
          storeSession(serverUrl, apiKey, login.sessionId, Date.now());
          return {
            todayCount: retry.todayCount,
            todayCostUsd: retry.todayCostUsd,
            monthCount: retry.monthCount,
            monthCostUsd: retry.monthCostUsd,
            weeklyQuota: retry.weeklyQuota,
          };
        }
        return { error: retry.error };
      }

      return { error: direct.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }
  }
}

export const usageService = new UsageService();
