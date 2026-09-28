import type { DshHostCredentialRequest } from '@shared/types/dshHostProtocol';
import { describe, expect, it, vi } from 'vitest';
import { DshCredentialBroker, type DshCredentialContext } from '../DshCredentialBroker';

/**
 * dsh-rebase P1-5b (decision 034) — Main answers the shared host's per-request
 * key requests: channel, nonce and reference checked first; the key comes from
 * the in-memory catalog, cached until the vault changes; signed out or locked
 * is `unavailable`; no value is ever logged.
 */

const CANARY = 'sk-canary-broker-5f1c2e';
const REF = 'AICLIENT_KEY_GW_1A2B';
const CONTEXT: DshCredentialContext = {
  current: true,
  nonce: 'nonce-1',
  refs: { [REF]: 'gw', AICLIENT_KEY_BARE_9F9F: 'bare' },
};
const request = (extra: Partial<DshHostCredentialRequest> = {}): DshHostCredentialRequest => ({
  host: 'credential',
  id: 3,
  ref: REF,
  nonce: 'nonce-1',
  ...extra,
});

function broker(auth: () => Record<string, unknown> | undefined) {
  const log = vi.fn();
  let vaultListener: (() => void) | undefined;
  const readAuth = vi.fn(auth);
  const instance = new DshCredentialBroker({
    readAuth,
    onVaultChange: (listener) => {
      vaultListener = listener;
      return () => {
        vaultListener = undefined;
      };
    },
    log,
    now: () => 0,
  });
  return { instance, log, readAuth, vaultChanged: () => vaultListener?.() };
}

describe('DshCredentialBroker', () => {
  it('[BR-00] serves the key of the provider the reference names', () => {
    const { instance } = broker(() => ({ gw: { type: 'api_key', key: CANARY } }));
    expect(instance.answer(request(), CONTEXT)).toEqual({
      host: 'credential-result',
      id: 3,
      ok: true,
      value: CANARY,
    });
  });

  it('[BR-01] refuses a wrong nonce, and a request from a host that is not the running one', () => {
    const { instance, readAuth } = broker(() => ({ gw: { key: CANARY } }));
    expect(instance.answer(request({ nonce: 'guess' }), CONTEXT)).toMatchObject({
      ok: false,
      error: 'refused',
    });
    expect(instance.answer(request(), { ...CONTEXT, current: false })).toMatchObject({
      ok: false,
      error: 'refused',
    });
    expect(instance.answer(request({ nonce: '' }), { ...CONTEXT, nonce: '' })).toMatchObject({
      error: 'refused',
    });
    expect(readAuth).not.toHaveBeenCalled();
  });

  it("[BR-02] refuses a reference outside the host's plan, whatever the catalog holds", () => {
    const { instance } = broker(() => ({ gw: { key: CANARY }, other: { key: 'sk-other' } }));
    expect(instance.answer(request({ ref: 'OPENAI_API_KEY' }), CONTEXT)).toMatchObject({
      error: 'refused',
    });
    expect(instance.answer(request({ ref: '__proto__' }), CONTEXT)).toMatchObject({
      error: 'refused',
    });
  });

  it('[BR-03] answers unavailable when signed out or locked, and tries again next time', () => {
    let auth: Record<string, unknown> | undefined;
    const { instance, readAuth } = broker(() => auth);
    expect(instance.answer(request(), CONTEXT)).toMatchObject({ ok: false, error: 'unavailable' });
    auth = { gw: { key: CANARY } };
    expect(instance.answer(request(), CONTEXT)).toMatchObject({ ok: true, value: CANARY });
    expect(readAuth).toHaveBeenCalledTimes(2);
    // A provider without a key, or a reader that throws, is unavailable too.
    expect(instance.answer(request({ ref: 'AICLIENT_KEY_BARE_9F9F' }), CONTEXT)).toMatchObject({
      error: 'unavailable',
    });
    const throwing = broker(() => {
      throw new Error('keyring locked');
    });
    expect(throwing.instance.answer(request(), CONTEXT)).toMatchObject({ error: 'unavailable' });
  });

  it('[BR-04] reads the catalog once until the vault changes, then serves the new key', () => {
    let key = CANARY;
    const { instance, readAuth, vaultChanged } = broker(() => ({ gw: { key } }));
    instance.answer(request(), CONTEXT);
    instance.answer(request(), CONTEXT);
    expect(readAuth).toHaveBeenCalledTimes(1);
    key = 'sk-rotated-key-0001';
    vaultChanged();
    expect(instance.answer(request(), CONTEXT)).toMatchObject({ value: 'sk-rotated-key-0001' });
    expect(readAuth).toHaveBeenCalledTimes(2);
    instance.invalidate();
    instance.answer(request(), CONTEXT);
    expect(readAuth).toHaveBeenCalledTimes(3);
  });

  it('[BR-05] never writes a key to its log, and counts at most once a minute', () => {
    let now = 0;
    const log = vi.fn();
    const instance = new DshCredentialBroker({
      readAuth: () => ({ gw: { key: CANARY } }),
      log,
      now: () => now,
    });
    for (let i = 0; i < 5; i += 1) instance.answer(request(), CONTEXT);
    instance.answer(request({ nonce: 'wrong' }), CONTEXT);
    now = 61_000;
    instance.answer(request(), CONTEXT);
    const lines = log.mock.calls.map((call) => call.map(String).join(' '));
    expect(lines.join('\n')).not.toContain(CANARY);
    expect(lines.filter((line) => line.includes('served'))).toEqual([
      '[dsh-credentials] last 61 s: 6 served, 0 unavailable, 1 refused',
    ]);
  });
});
