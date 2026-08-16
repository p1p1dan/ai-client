import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UsageStatsResult } from '@shared/types';
import { net } from 'electron';
import { getAuthProbeScheduler, getAuthStateService, getCredentialVault } from '../auth';
import { classifyAuthLoginResponse } from '../auth/AuthProbeScheduler';
import { resolveManagedCredentialsEnabled } from '../auth/AuthStateService';
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

      const tryFetchStats = async (
        auth?: ActionAuth
      ): Promise<
        | {
            ok: true;
            todayCount: number;
            todayCostUsd: number;
            monthCount: number;
            monthCostUsd: number;
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

        return { ok: true, todayCount, todayCostUsd, monthCount, monthCostUsd };
      };

      // Attempt #1: call Actions API with apiKey directly (works in legacy/dual session modes).
      const direct = await tryFetchStats({ type: 'bearer', token: apiKey });
      if (direct.ok) {
        return {
          todayCount: direct.todayCount,
          todayCostUsd: direct.todayCostUsd,
          monthCount: direct.monthCount,
          monthCostUsd: direct.monthCostUsd,
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
          return {
            todayCount: retry.todayCount,
            todayCostUsd: retry.todayCostUsd,
            monthCount: retry.monthCount,
            monthCostUsd: retry.monthCostUsd,
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
