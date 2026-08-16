/**
 * D47 S5 §2 — the independent invalidation-signal probe. Deliberately NOT
 * riding on `UsageService`'s usage-polling cadence (rev.1's "a" 裁定 was
 * overturned in rev.2): the usage link's own cookie-carrier bug (§0-1) made
 * its 401s an unreliable heartbeat, and even after that fix a business 401
 * can legitimately happen with a VALID key (E5's "补测" finding — the actions
 * endpoint only accepts the cookie session, never the bare key bearer). The
 * ONLY authority for "this key is truly dead" is a direct
 * `POST {cchBaseUrl}/api/auth/login` classified by `classifyAuthLoginResponse`.
 *
 * Cadence: one probe right after the state transitions INTO `authenticated`
 * (this covers BOTH "启动 refresh 后一次" and "登录成功后一次" — both are the
 * same transition, entering `authenticated`, observed via
 * `AuthStateService.onChange`), then every `intervalMs` (default 5 min)
 * while still `authenticated`. `UsageService`'s own `/api/auth/login` call
 * (`loginForActionsSession`) reports its result through
 * `reportExternalLoginResponse` as an ADDITIONAL trigger source — it never
 * runs its own network probe, it only classifies a response someone else
 * already fetched.
 */

import type { VaultReadResult } from './CredentialVault';
import { getManagedCchProbeTarget } from './probeTarget';

export type AuthLoginClassification = 'rejected' | 'unknown';

/**
 * D47 S5 §2 pure judgment function (E5 fixture-driven). ONLY the exact shape
 * `401 + JSON body with errorCode === 'KEY_INVALID'` classifies as
 * `'rejected'` — every other observed shape (network/timeout error, 5xx,
 * `404` + HTML, `307` redirect, `200`, `401` with an unrecognized body,
 * including the actions endpoint's own `{ok:false}` with no `errorCode`)
 * classifies as `'unknown'` and must NOT mutate the vault. The E5 pseudocode's
 * `body.ok === false` branch is explicitly retired here — both review tracks
 * independently flagged it as a false-positive risk against the actions
 * endpoint's differently-shaped error body.
 */
export function classifyAuthLoginResponse(
  status: number,
  bodyText: string
): AuthLoginClassification {
  if (status !== 401) {
    return 'unknown';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return 'unknown';
  }
  if (!parsed || typeof parsed !== 'object') {
    return 'unknown';
  }
  const errorCode = (parsed as Record<string, unknown>).errorCode;
  return errorCode === 'KEY_INVALID' ? 'rejected' : 'unknown';
}

export interface AuthProbeVault {
  read(): VaultReadResult;
}

export interface AuthProbeAuthStateService {
  markRejected(): Promise<void>;
  reportRemoteHealthy(): void;
}

export interface AuthProbeFetchResponse {
  status: number;
  text(): Promise<string>;
}

export type AuthProbeFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string }
) => Promise<AuthProbeFetchResponse>;

export interface AuthProbeSchedulerOptions {
  authStateService: AuthProbeAuthStateService;
  vault: AuthProbeVault;
  fetchFn: AuthProbeFetch;
  /** Default 5 minutes. */
  intervalMs?: number;
  /** Default 10 minutes — how long an 'unknown' classification suppresses the NEXT scheduled probe. */
  backoffMs?: number;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BACKOFF_MS = 10 * 60 * 1000;

export class AuthProbeScheduler {
  private readonly authStateService: AuthProbeAuthStateService;
  private readonly vault: AuthProbeVault;
  private readonly fetchFn: AuthProbeFetch;
  private readonly intervalMs: number;
  private readonly backoffMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private timerHandle: unknown = null;
  private inFlight: Promise<void> | null = null;
  private backoffUntil = 0;
  private wasAuthenticated = false;

  constructor(options: AuthProbeSchedulerOptions) {
    this.authStateService = options.authStateService;
    this.vault = options.vault;
    this.fetchFn = options.fetchFn;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.now = options.now ?? (() => Date.now());
    this.setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as never));
  }

  /**
   * Wired to `AuthStateService.onChange`. Detects the `-> authenticated`
   * transition (covers both "启动 refresh 后一次" and "登录成功后一次" — see
   * module header) to fire an immediate probe and (re)start the periodic
   * timer; detects leaving `authenticated` to stop the timer (§2: "probe
   * 仅 authenticated 期").
   */
  handleAuthStateChange(status: string): void {
    const isAuthenticated = status === 'authenticated';
    if (isAuthenticated && !this.wasAuthenticated) {
      this.backoffUntil = 0; // a fresh authenticated session ignores any stale backoff
      this.startTimer();
      void this.probeOnce();
    } else if (!isAuthenticated && this.wasAuthenticated) {
      this.stopTimer();
    }
    this.wasAuthenticated = isAuthenticated;
  }

  private startTimer(): void {
    if (this.timerHandle !== null) return;
    this.timerHandle = this.setIntervalFn(() => {
      void this.probeOnce();
    }, this.intervalMs);
  }

  private stopTimer(): void {
    if (this.timerHandle === null) return;
    this.clearIntervalFn(this.timerHandle);
    this.timerHandle = null;
  }

  /** Test/shutdown hook — stops the timer without waiting for a state transition. */
  stop(): void {
    this.stopTimer();
  }

  /**
   * D47 S5 §2 "单飞 + unknown 期退避" — only one network probe in flight at a
   * time; after an 'unknown' result, scheduled callers back off for
   * `backoffMs`. `handleAuthStateChange`'s entry probe always bypasses the
   * backoff check (it resets it first); this method itself has no "who is
   * calling" concept, so a manual/test call during the backoff window is
   * also skipped — matching the scheduled-timer caller's behavior.
   */
  async probeOnce(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    if (this.now() < this.backoffUntil) {
      return;
    }
    const task = this.runProbe();
    this.inFlight = task;
    try {
      await task;
    } finally {
      if (this.inFlight === task) {
        this.inFlight = null;
      }
    }
  }

  private async runProbe(): Promise<void> {
    const target = getManagedCchProbeTarget(this.vault.read());
    if (!target) {
      return;
    }

    let status: number;
    let bodyText: string;
    try {
      const response = await this.fetchFn(`${target.cchBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: target.apiKey }),
      });
      status = response.status;
      bodyText = await response.text();
    } catch {
      // Network/timeout error — 'unknown', never a rejection signal.
      this.backoffUntil = this.now() + this.backoffMs;
      return;
    }

    this.actOnClassification(classifyAuthLoginResponse(status, bodyText), status);
  }

  private actOnClassification(classification: AuthLoginClassification, status: number): void {
    if (classification === 'rejected') {
      void this.authStateService.markRejected();
      return;
    }
    if (status === 200) {
      this.authStateService.reportRemoteHealthy();
      return;
    }
    this.backoffUntil = this.now() + this.backoffMs;
  }

  /**
   * D47 S5 §2 — "usage 链的 KEY_INVALID 报告为附加触发源": `UsageService`'s
   * own `/api/auth/login` call (`loginForActionsSession`) hits the exact same
   * endpoint; rather than duplicate a second network probe, it hands its
   * already-fetched response here. Classified through the SAME judgment
   * function and, on a definitive rejection, routed through the SAME
   * `markRejected()` call as a self-initiated probe — no separate code path,
   * no separate singleflight guard (an in-flight self-probe finishing
   * `'rejected'` at the same moment is harmless: `markRejected()` /
   * `vault.markInvalidated()` are both idempotent-safe to call twice).
   * Deliberately bypasses the backoff window — a definitive rejection is
   * never something to "wait out".
   */
  reportExternalLoginResponse(status: number, bodyText: string): void {
    if (classifyAuthLoginResponse(status, bodyText) === 'rejected') {
      void this.authStateService.markRejected();
    }
  }
}
