import { describe, expect, it } from 'vitest';
import {
  AUTH_REQUIRED_CODE_TOKEN,
  AUTH_REQUIRED_ERROR_VIEW,
  isAuthRequiredError,
} from '../authRequiredError';

describe('isAuthRequiredError (D47 S5 §3 — spawn-gate rejection detection)', () => {
  it('[ARE-01] matches the raw auth_required code token', () => {
    expect(isAuthRequiredError('auth_required: Sign-in required.')).toBe(true);
    expect(isAuthRequiredError(AUTH_REQUIRED_CODE_TOKEN)).toBe(true);
  });

  it('[ARE-02] matches when the code token survives IPC/Error wrapping as a substring', () => {
    // Electron's ipcRenderer.invoke rejection format, e.g.
    // "Error invoking remote method 'chat:createSession': Error: auth_required: ..."
    const wrapped =
      "Error invoking remote method 'chat:createSession': Error: auth_required: Sign-in required before starting an agent session.";
    expect(isAuthRequiredError(wrapped)).toBe(true);
  });

  it('[ARE-03] matches resolveSpawnGateDecision\'s fixed "sign-in required" message even with no code token', () => {
    expect(isAuthRequiredError('Sign-in required before starting an agent session.')).toBe(true);
  });

  it('[ARE-04] matches resolveSpawnGateDecision\'s fixed "locked" message even with no code token', () => {
    expect(isAuthRequiredError('Credentials are still unlocking — try again in a moment.')).toBe(
      true
    );
  });

  it('[ARE-05] does not match an unrelated failure (negative control)', () => {
    expect(isAuthRequiredError('Session is busy — stop it first or wait for idle')).toBe(false);
    expect(isAuthRequiredError('ECONNREFUSED 127.0.0.1:1234')).toBe(false);
  });

  it('[ARE-06] handles null/undefined/empty without throwing', () => {
    expect(isAuthRequiredError(null)).toBe(false);
    expect(isAuthRequiredError(undefined)).toBe(false);
    expect(isAuthRequiredError('')).toBe(false);
  });

  it('[ARE-07] the mapped view carries non-empty Chinese copy and an action label', () => {
    expect(AUTH_REQUIRED_ERROR_VIEW.title.length).toBeGreaterThan(0);
    expect(AUTH_REQUIRED_ERROR_VIEW.message.length).toBeGreaterThan(0);
    expect(AUTH_REQUIRED_ERROR_VIEW.actionLabel.length).toBeGreaterThan(0);
  });
});
