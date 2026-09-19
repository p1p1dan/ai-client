import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  PROVIDER_IDLE_TIMEOUT_DISABLED,
  PROVIDER_TIMEOUT_DISABLED_SENTINEL,
  providerRequestTimeoutMs,
  readProviderIdleTimeoutMs,
} from '../../shared/types/providerTimeout.ts';
import {
  configureProviderHttpDispatcher,
  installedProviderIdleTimeoutMs,
  resetProviderHttpDispatcher,
  type UndiciModule,
} from '../host/httpDispatcher.ts';
import { classifyProviderFailure } from '../plugins/agent-loop/providerErrors.ts';
import {
  createProviderRetryBudget,
  isTransientProviderRetryCode,
} from '../plugins/agent-loop/providerRetry.ts';

/**
 * T093 / decision 029 clauses 1 and 2 — the two silences a turn can die of.
 *
 * Before this the main chat path sent no per-request timeout at all, so every
 * request fell through to the provider SDK's 600-second wall clock, and nothing
 * anywhere bounded "the connection is open and no bytes are arriving". The
 * 2026-09-19 field report measured the result as seven to eight minutes for one
 * message with nothing on screen.
 *
 * These cases exercise the real mechanism rather than a stub of it: a local
 * server that withholds headers, and a second that sends headers and then goes
 * quiet. Both are cut by undici, both surface as the network class, and the
 * network class is what the existing retry budget already covers.
 */

let silent: Server;
let idle: Server;

function origin(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  // Accepts the connection and never answers: the headers-timeout case.
  silent = createServer(() => {});
  // Answers, then stops producing bytes without closing: the body-timeout case.
  idle = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: hello\n\n');
  });
  await Promise.all([
    new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => idle.listen(0, '127.0.0.1', resolve)),
  ]);
});

afterAll(async () => {
  silent.closeAllConnections?.();
  idle.closeAllConnections?.();
  await Promise.all([
    new Promise<void>((resolve) => silent.close(() => resolve())),
    new Promise<void>((resolve) => idle.close(() => resolve())),
  ]);
});

afterEach(() => {
  resetProviderHttpDispatcher();
});

/** What the provider adapter would report, for a fetch that did not survive. */
async function failureText(request: Promise<unknown>): Promise<string> {
  try {
    await request;
    return '';
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return `${(error as Error).message}: ${cause?.code ?? cause?.message ?? ''}`;
  }
}

describe('the provider idle timeout', () => {
  it('cuts a request that never returns headers, and counts it against the network budget', async () => {
    await configureProviderHttpDispatcher(400);
    const started = Date.now();
    const text = await failureText(fetch(`${origin(silent)}/v1/messages`));
    // Cut by us, not by the SDK's ten-minute default and not by the OS.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(text).toContain('UND_ERR_HEADERS_TIMEOUT');

    const classified = classifyProviderFailure(text);
    expect(classified.code).toBe('NETWORK_ERROR');
    expect(classified.retriable).toBe(true);
    // Same budget a dropped socket draws on — no new counter, no new ladder.
    expect(isTransientProviderRetryCode(classified.code)).toBe(true);
    expect(createProviderRetryBudget().controller.claim(classified)).toBe(1);
  }, 20_000);

  it('cuts an idle stream by the body timeout, and counts it against the same budget', async () => {
    await configureProviderHttpDispatcher(400);
    const response = await fetch(`${origin(idle)}/v1/messages`);
    expect(response.status).toBe(200);
    // Headers arrived, so only the BODY timeout can end this one.
    const text = await failureText(response.text());
    expect(text).toContain('UND_ERR_BODY_TIMEOUT');

    const classified = classifyProviderFailure(text);
    expect(classified.code).toBe('NETWORK_ERROR');
    expect(classified.retriable).toBe(true);
  }, 20_000);

  it('reports nothing installed when nothing asked for one', () => {
    // `createRuntime` only calls the installer when a host actually named a
    // timeout — absent is not zero — so this is the state a probe lane, the
    // fixed suite and every unit test are meant to be in: no process-wide
    // dispatcher acquired as a side effect of building a graph.
    expect(installedProviderIdleTimeoutMs()).toBeUndefined();
  });

  it('survives a missing undici instead of refusing to boot', async () => {
    const log = vi.fn();
    const installed = await configureProviderHttpDispatcher(1_000, {
      load: () => Promise.reject(new Error('Cannot find package undici')),
      log,
    });
    expect(installed).toBe(false);
    expect(log).toHaveBeenCalled();
    expect(installedProviderIdleTimeoutMs()).toBeUndefined();
  });

  it('gives undici a literal 0 for "off" and never builds a second pool for the same value', async () => {
    const setGlobalDispatcher = vi.fn();
    const seen: Record<string, unknown>[] = [];
    const load = async (): Promise<UndiciModule> =>
      ({
        Agent: class {
          constructor(options: Record<string, unknown>) {
            seen.push(options);
          }
        },
        Client: class {},
        Pool: class {},
        setGlobalDispatcher,
      }) as unknown as UndiciModule;

    await configureProviderHttpDispatcher(PROVIDER_IDLE_TIMEOUT_DISABLED, { load });
    await configureProviderHttpDispatcher(PROVIDER_IDLE_TIMEOUT_DISABLED, { load });
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    // undici's own spelling of "disabled" IS 0; the SDK's is not (see below).
    expect(seen[0]).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
  });
});

describe('the number the SDK is given', () => {
  it('passes the sentinel when the timeout is disabled, never zero', () => {
    // Every SDK we talk through reads `timeout: 0` as "time out immediately",
    // so the user's "off" has to arrive as something else entirely.
    expect(providerRequestTimeoutMs(PROVIDER_IDLE_TIMEOUT_DISABLED)).toBe(
      PROVIDER_TIMEOUT_DISABLED_SENTINEL
    );
    expect(providerRequestTimeoutMs(PROVIDER_IDLE_TIMEOUT_DISABLED)).not.toBe(0);
    expect(providerRequestTimeoutMs(120_000)).toBe(120_000);
  });

  it('defaults to two minutes and refuses a value it cannot trust', () => {
    // Decision 029: 120s, half of pi's 300s, because the failure being fixed is
    // a gateway that accepts and then goes quiet.
    expect(DEFAULT_PROVIDER_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(readProviderIdleTimeoutMs(undefined)).toBe(120_000);
    expect(readProviderIdleTimeoutMs('nonsense')).toBe(120_000);
    expect(readProviderIdleTimeoutMs(-1)).toBe(120_000);
    // 0 is a CHOICE, not a missing value, and must survive the read.
    expect(readProviderIdleTimeoutMs(0)).toBe(0);
    expect(readProviderIdleTimeoutMs('30000')).toBe(30_000);
  });
});
