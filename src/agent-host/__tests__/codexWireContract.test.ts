import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_REQUEST_KINDS } from '../codexPending.ts';
import { CODEX_METHOD } from '../codexWire.ts';

/**
 * Pins every method name this Host spells against the contract the codex binary
 * generates for itself (`codex app-server generate-json-schema --experimental`).
 *
 * The failure this prevents is specific and expensive: a misspelled or renamed
 * method does not fail to compile and does not fail any unit test — it fails at
 * runtime, on a user's machine, as a JSON-RPC error that surfaces as "the turn
 * will not stop" or "approval never arrives". Codex is marked [experimental]
 * upstream, so renames are expected rather than hypothetical.
 *
 * The snapshot is committed, so a codex upgrade shows up as a diff on a fixture
 * plus a red test here, which is the cheap moment to notice it.
 */
interface MethodContract {
  codexVersion: string;
  capturedAt: string;
  clientRequest: string[];
  serverRequest: string[];
  serverNotification: string[];
  threadItemTypes: string[];
}

const contract = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, 'fixtures', 'codex', 'codex-method-contract.json'),
    'utf8'
  )
) as MethodContract;

const CLIENT_REQUESTS = new Set(contract.clientRequest);
const SERVER_REQUESTS = new Set(contract.serverRequest);
const SERVER_NOTIFICATIONS = new Set(contract.serverNotification);

describe('the generated contract snapshot is usable at all', () => {
  // A snapshot that silently became empty would make every assertion below pass
  // vacuously — the classic way a pinning test stops pinning anything.
  it('carries the three method families and the item list', () => {
    expect(contract.clientRequest.length).toBeGreaterThan(100);
    expect(contract.serverRequest.length).toBeGreaterThan(5);
    expect(contract.serverNotification.length).toBeGreaterThan(50);
    expect(contract.threadItemTypes.length).toBe(18);
  });

  it('records which codex build it came from', () => {
    // Without this, a stale snapshot from an older codex is indistinguishable
    // from a current one, and "pinned" would mean "pinned to something unknown".
    expect(contract.codexVersion).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('CODEX_METHOD spells only methods the binary declares', () => {
  const CLIENT_SENT = [
    CODEX_METHOD.initialize,
    CODEX_METHOD.initialized,
    CODEX_METHOD.threadStart,
    CODEX_METHOD.threadResume,
    CODEX_METHOD.turnStart,
    CODEX_METHOD.turnInterrupt,
  ];
  const SERVER_SENT = [
    CODEX_METHOD.statusChanged,
    CODEX_METHOD.turnCompleted,
    CODEX_METHOD.serverRequestResolved,
  ];

  it.each(CLIENT_SENT)('client→server %s exists in the contract', (method) => {
    // `initialize`/`initialized` are handshake methods that predate the request
    // enumeration, so they are allowed to be absent from clientRequest; every
    // other outbound method must be there or we are calling into thin air.
    const isHandshake = method === 'initialize' || method === 'initialized';
    expect(isHandshake || CLIENT_REQUESTS.has(method)).toBe(true);
  });

  it.each(SERVER_SENT)('server→client %s exists in the contract', (method) => {
    expect(SERVER_NOTIFICATIONS.has(method)).toBe(true);
  });

  it('closes U-a and U-b with evidence rather than a guess', () => {
    // These two were deliberately withheld through slice 2a. This is the
    // assertion that earns them a place in the constant.
    expect(CLIENT_REQUESTS.has('turn/interrupt')).toBe(true);
    expect(CLIENT_REQUESTS.has('thread/resume')).toBe(true);
    expect(CODEX_METHOD.turnInterrupt).toBe('turn/interrupt');
    expect(CODEX_METHOD.threadResume).toBe('thread/resume');
  });
});

describe('every registrable server request is a real server request', () => {
  it.each(Object.keys(SERVER_REQUEST_KINDS))('%s is declared server→client', (method) => {
    // Falsifies the failure mode the elicitation entry was held back for: a
    // plausible-looking name that the server never sends, so the kind is dead
    // code and the request it was meant to catch falls through to
    // method_not_found.
    expect(SERVER_REQUESTS.has(method)).toBe(true);
  });

  it('covers half of the declared server requests, and the rest are out of scope by name', () => {
    // Not a completeness claim — a reminder of what we are choosing not to
    // handle, so a future reader sees the gap instead of assuming full coverage.
    const unhandled = contract.serverRequest.filter((m) => !(m in SERVER_REQUEST_KINDS));
    expect(unhandled).toEqual([
      'account/chatgptAuthTokens/refresh',
      'attestation/generate',
      'currentTime/read',
      'item/tool/call',
      'openai/form',
    ]);
  });
});
