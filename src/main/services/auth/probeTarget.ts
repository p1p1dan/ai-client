/**
 * D47 S5 §2 — the `{cchBaseUrl, apiKey}` pair both `AuthProbeScheduler` (its
 * own independent probe) and `UsageService` (flag-on key source, §2 "key 来源
 * flag-on 走 vault") need to hit `/api/auth/login`. Pulled out to a tiny
 * shared helper so the two callers can never derive it differently — same
 * vault fields (`cchBaseUrl`, `codex.apiKey`), same "only `status === 'ok'`
 * has a usable target" rule.
 */
import type { VaultReadResult } from './CredentialVault';

export interface ManagedCchProbeTarget {
  cchBaseUrl: string;
  apiKey: string;
}

export function getManagedCchProbeTarget(result: VaultReadResult): ManagedCchProbeTarget | null {
  if (result.status !== 'ok') {
    return null;
  }
  const { cchBaseUrl, codex } = result.doc.payload;
  if (!cchBaseUrl || !codex.apiKey) {
    return null;
  }
  return { cchBaseUrl, apiKey: codex.apiKey };
}
