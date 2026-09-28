import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDshHostCredentialRequest } from '../../../shared/types/dshHostProtocol.ts';
import {
  CREDENTIAL_TIMEOUT_MS,
  CredentialRelay,
  type CredentialRequestMessage,
  REDACTED_KEY,
} from '../credentialRelay.ts';

/**
 * dsh-rebase P1-5b (decision 034) — the host asks Main for a key per request:
 * only references of its plan, with its nonce, no cache, 5 s at most; and a
 * key echoed in provider text is masked by digest.
 */

const REFS = { AICLIENT_KEY_GW_1A2B: 'gw', AICLIENT_KEY_OTHER_3C4D: 'other' };

function relay(send: (message: CredentialRequestMessage) => boolean = () => true) {
  const sent: CredentialRequestMessage[] = [];
  const log = vi.fn();
  const instance = new CredentialRelay({
    nonce: 'nonce-1',
    refs: REFS,
    send: (message) => {
      sent.push(message);
      return send(message);
    },
    log,
  });
  return { instance, sent, log };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CredentialRelay.resolve', () => {
  it('[CP-01] sends nothing for a reference outside the plan', async () => {
    const { instance, sent } = relay();
    await expect(instance.resolve('OPENAI_API_KEY')).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(instance.knows('OPENAI_API_KEY')).toBe(false);
  });

  it('[CP-02] asks Main with the nonce and returns the key it answers', async () => {
    const { instance, sent } = relay();
    const pending = instance.resolve('AICLIENT_KEY_GW_1A2B');
    expect(sent).toEqual([
      { host: 'credential', id: 1, ref: 'AICLIENT_KEY_GW_1A2B', nonce: 'nonce-1' },
    ]);
    expect(isDshHostCredentialRequest(sent[0])).toBe(true);
    expect(
      instance.receive({ host: 'credential-result', id: 1, ok: true, value: 'sk-test-1' })
    ).toBe(true);
    await expect(pending).resolves.toBe('sk-test-1');
  });

  it('[CP-02] keeps nothing: every request asks again', async () => {
    const { instance, sent } = relay();
    const first = instance.resolve('AICLIENT_KEY_GW_1A2B');
    instance.receive({ host: 'credential-result', id: 1, ok: true, value: 'sk-old' });
    await first;
    const second = instance.resolve('AICLIENT_KEY_GW_1A2B');
    instance.receive({ host: 'credential-result', id: 2, ok: true, value: 'sk-new' });
    await expect(second).resolves.toBe('sk-new');
    expect(sent).toHaveLength(2);
  });

  it('[CP-03] gives up after 5 s and ignores a late answer', async () => {
    const { instance } = relay();
    const pending = instance.resolve('AICLIENT_KEY_GW_1A2B');
    await vi.advanceTimersByTimeAsync(CREDENTIAL_TIMEOUT_MS);
    await expect(pending).resolves.toBeUndefined();
    expect(instance.receive({ host: 'credential-result', id: 1, ok: true, value: 'late' })).toBe(
      true
    );
  });

  it('resolves no key for a refusal, an unsent request or a closed relay', async () => {
    const { instance, log } = relay();
    const refused = instance.resolve('AICLIENT_KEY_GW_1A2B');
    instance.receive({ host: 'credential-result', id: 1, ok: false, error: 'unavailable' });
    await expect(refused).resolves.toBeUndefined();
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('unavailable');
    const unsent = relay(() => false);
    await expect(unsent.instance.resolve('AICLIENT_KEY_GW_1A2B')).resolves.toBeUndefined();
    const waiting = instance.resolve('AICLIENT_KEY_OTHER_3C4D');
    instance.close();
    await expect(waiting).resolves.toBeUndefined();
    await expect(instance.resolve('AICLIENT_KEY_GW_1A2B')).resolves.toBeUndefined();
  });

  it('claims credential-result messages only', () => {
    const { instance } = relay();
    expect(instance.receive({ host: 'ping', id: 1 })).toBe(false);
    expect(instance.receive({ ch: 'c1-1', rpc: {} })).toBe(false);
    expect(instance.receive({ host: 'credential-result', id: 99, ok: true, value: 'x' })).toBe(
      true
    );
  });
});

describe('CredentialRelay.redact', () => {
  async function served(instance: CredentialRelay, value: string, id: number) {
    const pending = instance.resolve('AICLIENT_KEY_GW_1A2B');
    instance.receive({ host: 'credential-result', id, ok: true, value });
    await pending;
  }

  it('masks every served key wherever it appears, whatever its shape', async () => {
    const { instance } = relay();
    const key = 'zz9:plural/Z-alpha';
    await served(instance, key, 1);
    expect(instance.redact(`401 {"message":"bad key ${key}, again ${key}."}`)).toBe(
      `401 {"message":"bad key ${REDACTED_KEY}, again ${REDACTED_KEY}."}`
    );
    expect(instance.redact('nothing here')).toBe('nothing here');
  });

  it('masks nothing before a key was served, and keeps no key itself', async () => {
    const { instance } = relay();
    expect(instance.redact('sk-canary-abcdef')).toBe('sk-canary-abcdef');
    await served(instance, 'sk-canary-abcdef', 1);
    expect(JSON.stringify(instance)).not.toContain('sk-canary-abcdef');
  });
});
