import { describe, expect, it, vi } from 'vitest';
import { redactCredentials } from '../../../shared/stderrRedaction.ts';
import {
  CREDENTIAL_SOURCE,
  CREDENTIALS_READ_ONLY,
  CredentialPort,
  type CredentialRelayView,
} from '../port.ts';

/**
 * dsh-rebase P1-5b (decision 034) — the aiclient-credentials row: read-only,
 * plan references only, no cache, and provider failure text masked before
 * DSH stores it. The Cordis class in plugin.ts only delegates here.
 */

function port(relay?: Partial<CredentialRelayView>) {
  const view: CredentialRelayView = {
    knows: (ref) => ref === 'AICLIENT_KEY_GW_1A2B',
    resolve: vi.fn(async () => 'sk-test-1'),
    redact: (text) => text.split('opaque-key-42').join('[redacted]'),
    ...relay,
  };
  return { port: new CredentialPort({ relay: () => view, redactShapes: redactCredentials }), view };
}

describe('CredentialPort', () => {
  it('[CP-01] answers nothing, and asks nothing, for a reference outside the plan', async () => {
    const { port: row, view } = port();
    await expect(row.resolve('OPENAI_API_KEY')).resolves.toBeUndefined();
    expect(view.resolve).not.toHaveBeenCalled();
  });

  it('[CP-02] resolves a plan reference through Main, per call', async () => {
    const { port: row, view } = port();
    await expect(row.resolve('AICLIENT_KEY_GW_1A2B')).resolves.toEqual({
      value: 'sk-test-1',
      source: CREDENTIAL_SOURCE,
    });
    await row.resolve('AICLIENT_KEY_GW_1A2B');
    expect(view.resolve).toHaveBeenCalledTimes(2);
  });

  it('[CP-03] resolves nothing when Main gave nothing, or there is no relay', async () => {
    const { port: row } = port({ resolve: async () => undefined });
    await expect(row.resolve('AICLIENT_KEY_GW_1A2B')).resolves.toBeUndefined();
    const lone = new CredentialPort({ relay: () => undefined, redactShapes: redactCredentials });
    await expect(lone.resolve('AICLIENT_KEY_GW_1A2B')).resolves.toBeUndefined();
    await expect(lone.describe('AICLIENT_KEY_GW_1A2B')).resolves.toEqual({
      configured: false,
      writable: false,
    });
  });

  it('[CP-04] refuses every write', async () => {
    const { port: row } = port();
    for (const operation of ['set', 'unset', 'modifyRecord', 'deleteRecord']) {
      await expect(row.refuse(operation)).rejects.toMatchObject({ code: CREDENTIALS_READ_ONLY });
    }
  });

  it('[CP-05] describes a reference without any value', async () => {
    const { port: row, view } = port();
    await expect(row.describe('AICLIENT_KEY_GW_1A2B')).resolves.toEqual({
      configured: true,
      source: CREDENTIAL_SOURCE,
      writable: false,
    });
    await expect(row.describe('OTHER')).resolves.toEqual({ configured: false, writable: false });
    expect(view.resolve).not.toHaveBeenCalled();
  });
});

describe('CredentialPort — provider failure text (KEY-CANARY)', () => {
  const finish = (message: string) => ({
    type: 'finish',
    reason: { kind: 'error', failure: { message, code: 'AUTH', status: 401 } },
  });

  it('masks a served key and every key shape in a terminal failure', () => {
    const { port: row } = port();
    const chunk = row.redactChunk(
      finish('401 invalid x-api-key opaque-key-42; also sk-ant-api03-abcdefghijklmnop')
    ) as ReturnType<typeof finish>;
    expect(chunk.reason.failure.message).not.toContain('opaque-key-42');
    expect(chunk.reason.failure.message).not.toContain('sk-ant-api03');
    expect(chunk.reason.failure).toMatchObject({ code: 'AUTH', status: 401 });
  });

  it('passes every other chunk through untouched', async () => {
    const { port: row } = port();
    const text = { type: 'text-delta', index: 0, text: 'opaque-key-42 is just words here' };
    const clean = finish('500 overloaded');
    expect(row.redactChunk(text)).toBe(text);
    expect(row.redactChunk(clean)).toBe(clean);
    async function* source() {
      yield text;
      yield finish('bad opaque-key-42');
    }
    const out: unknown[] = [];
    for await (const chunk of row.redactStream(source())) out.push(chunk);
    expect(out[0]).toBe(text);
    expect(JSON.stringify(out[1])).not.toContain('opaque-key-42');
  });
});
