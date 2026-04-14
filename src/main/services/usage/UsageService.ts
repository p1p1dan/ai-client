import type { UsageStatsResult } from '@shared/types';
import { net } from 'electron';
import { getLiveCredentials, onboardingService } from '../onboarding';

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number') {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function readLegacyUsageStats(value: unknown): {
  todayCount: number;
  todayCostUsd: number;
  monthCount: number;
  monthCostUsd: number;
} | null {
  if (!isRecord(value)) {
    return null;
  }

  const todayCount = coerceFiniteNumber(value.todayCount);
  const monthCount = coerceFiniteNumber(value.monthCount);

  // Keep the stable endpoint flexible: accept both dedicated keys (todayCostUsd/monthCostUsd)
  // and legacy keys used by Actions responses (costUsd/totalCost).
  const todayCostUsd = coerceFiniteNumber(value.todayCostUsd ?? value.costUsd);
  const monthCostUsd = coerceFiniteNumber(value.monthCostUsd ?? value.totalCost ?? value.totalCostUsd);

  if (todayCount === null || monthCount === null || todayCostUsd === null || monthCostUsd === null) {
    return null;
  }

  return { todayCount, todayCostUsd, monthCount, monthCostUsd };
}

function parseLegacyUsageStatsResponse(
  payload: unknown
): { todayCount: number; todayCostUsd: number; monthCount: number; monthCostUsd: number } | null {
  const direct = readLegacyUsageStats(payload);
  if (direct) {
    return direct;
  }
  if (!isRecord(payload)) {
    return null;
  }
  return readLegacyUsageStats(payload.data);
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
  const rawValue = (end === -1 ? setCookieHeader.slice(start) : setCookieHeader.slice(start, end)).trim();
  return rawValue || null;
}

async function loginForActionsSession(
  serverUrl: string,
  apiKey: string
): Promise<{ ok: true; sessionId: string | null } | { ok: false; error: string }> {
  const loginUrl = `${serverUrl}/api/auth/login`;
  const response = await net.fetch(loginUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ key: apiKey }),
    credentials: 'include',
  });

  const payload = (await response.json().catch(() => null)) as unknown;
  const payloadRecord = isRecord(payload) ? payload : null;
  const payloadOk = payloadRecord?.ok === true;

  if (!response.ok || !payloadOk) {
    const message = extractErrorMessage(payload) ?? `Usage API request failed (${response.status})`;
    return { ok: false, error: message };
  }

  const setCookie = response.headers.get('set-cookie');
  const sessionId = typeof setCookie === 'string' ? extractCookieValue(setCookie, 'auth-token') : null;
  return { ok: true, sessionId };
}

async function postAction(
  url: string,
  body: Record<string, unknown>,
  token?: string
): Promise<{ ok: true; payload: unknown } | { ok: false; error: string; status: number }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await net.fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    credentials: 'include',
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
      const onboarding = onboardingService.checkRegistration();
      if (!onboarding.registered || !onboarding.serverUrl) {
        return { error: 'Not registered' };
      }

      const liveCredentials = getLiveCredentials();
      if (!liveCredentials?.codexApiKey) {
        return { error: 'Credentials not available' };
      }

      const serverUrl = onboarding.serverUrl.trim().replace(/\/+$/, '');
      const apiKey = liveCredentials.codexApiKey;

      // Preferred: dedicated API endpoint for usage stats (stable contract for desktop clients).
      // If the server does not implement it, fallback to the Actions API below.
      const legacyUrl = `${serverUrl}/api/usage/stats`;
      const legacyResponse = await net.fetch(legacyUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        credentials: 'include',
      });
      const legacyPayload = (await legacyResponse.json().catch(() => null)) as unknown;
      if (legacyResponse.ok) {
        const legacyStats = parseLegacyUsageStatsResponse(legacyPayload);
        if (legacyStats) {
          return legacyStats;
        }
      }

      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startDate = formatLocalDate(startOfMonth);
      const endDate = formatLocalDate(now);

      const todayUrl = `${serverUrl}/api/actions/my-usage/getMyTodayStats`;
      const summaryUrl = `${serverUrl}/api/actions/my-usage/getMyStatsSummary`;

      const tryFetchStats = async (
        authToken?: string
      ): Promise<
        | { ok: true; todayCount: number; todayCostUsd: number; monthCount: number; monthCostUsd: number }
        | { ok: false; error: string; status: number }
      > => {
        const todayResponse = await postAction(todayUrl, {}, authToken);
        if (!todayResponse.ok) {
          return { ok: false, error: todayResponse.error, status: todayResponse.status };
        }

        const todayData = readActionData(todayResponse.payload);
        const todayCount = coerceFiniteNumber(todayData?.calls);
        const todayCostUsd = coerceFiniteNumber(todayData?.costUsd);
        if (todayCount === null || todayCostUsd === null) {
          return { ok: false, error: 'Invalid usage stats response', status: 200 };
        }

        const summaryResponse = await postAction(summaryUrl, { startDate, endDate }, authToken);
        if (!summaryResponse.ok) {
          return { ok: false, error: summaryResponse.error, status: summaryResponse.status };
        }

        const summaryData = readActionData(summaryResponse.payload);
        const monthCount = coerceFiniteNumber(summaryData?.totalRequests);
        const monthCostUsd = coerceFiniteNumber(summaryData?.totalCost ?? summaryData?.totalCostUsd);
        if (monthCount === null || monthCostUsd === null) {
          return { ok: false, error: 'Invalid usage stats response', status: 200 };
        }

        return { ok: true, todayCount, todayCostUsd, monthCount, monthCostUsd };
      };

      // Attempt #1: call Actions API with apiKey directly (works in legacy/dual session modes).
      const direct = await tryFetchStats(apiKey);
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

        const retry = await tryFetchStats(login.sessionId ?? undefined);
        if (retry.ok) {
          return {
            todayCount: retry.todayCount,
            todayCostUsd: retry.todayCostUsd,
            monthCount: retry.monthCount,
            monthCostUsd: retry.monthCostUsd,
          };
        }

        // Some fetch implementations don't expose Set-Cookie; rely on cookie jar as a best-effort fallback.
        if (!login.sessionId) {
          const cookieRetry = await tryFetchStats(undefined);
          if (cookieRetry.ok) {
            return {
              todayCount: cookieRetry.todayCount,
              todayCostUsd: cookieRetry.todayCostUsd,
              monthCount: cookieRetry.monthCount,
              monthCostUsd: cookieRetry.monthCostUsd,
            };
          }
          return { error: cookieRetry.error };
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
