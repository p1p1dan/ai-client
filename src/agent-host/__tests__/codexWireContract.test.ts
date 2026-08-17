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

/**
 * The binary's own param schema for the turn methods, same provenance as the
 * method inventory above (`codex app-server generate-json-schema`). Loaded HERE,
 * next to the method names, because a field name is exactly as fatal as a method
 * name: `turn/start` with a mis-spelled `effort` is a -32602 at runtime, on a
 * machine we cannot reach, with nothing red on the way in.
 */
const turnSchema = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, 'fixtures', 'codex', 'codex-turn-schema.json'),
    'utf8'
  )
) as { TurnStartParams: { required: string[]; propertyNames: string[] } };

/**
 * D48 S4 — the settings channel's PARAM shapes, same provenance again. Loaded
 * here so the method name and the fields that travel under it are pinned by one
 * suite: this server swallows an unknown field exactly as silently as it would
 * swallow a renamed method, so "the method exists" is only half a contract.
 */
const settingsSchema = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, 'fixtures', 'codex', 'codex-settings-schema.json'),
    'utf8'
  )
) as {
  codexVersion: string;
  ThreadSettingsUpdateParams: { required: string[]; propertyNames: string[] };
  ThreadSettings: { required: string[]; propertyNames: string[] };
};

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

  it('D48 S4 (D14 / L9) — the two under-sampled families are now complete', () => {
    // The snapshot recorded 121 clientRequest and 65 serverNotification against
    // a binary that declares 126 and 70; the gap was pure under-sampling (the
    // 2026-08-10 header says so, 06-probes §0.1 named the five) and it was
    // closed in the same slice that started SENDING a method off this list.
    // Exact counts, not `>`: a re-capture against a different codex build should
    // be a visible decision, and an under-sampled re-capture should be red.
    expect(contract.clientRequest.length).toBe(126);
    expect(contract.serverNotification.length).toBe(70);
    expect(contract.serverRequest.length).toBe(11);
    for (const method of [
      'initialize',
      'fuzzyFileSearch',
      'thread/inject_items',
      'thread/increment_elicitation',
      'thread/decrement_elicitation',
    ]) {
      expect(CLIENT_REQUESTS.has(method)).toBe(true);
    }
    for (const method of [
      'error',
      'warning',
      'configWarning',
      'deprecationNotice',
      'guardianWarning',
    ]) {
      expect(SERVER_NOTIFICATIONS.has(method)).toBe(true);
    }
  });

  it('the settings excerpt came from the same build as the method inventory', () => {
    // Two fixtures generated from different codex versions would make a real
    // difference read as a version difference — the failure the approval-schema
    // cross-check below was added for.
    expect(settingsSchema.codexVersion).toBe(contract.codexVersion);
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
    CODEX_METHOD.threadSettingsUpdate,
  ];
  const SERVER_SENT = [
    CODEX_METHOD.statusChanged,
    CODEX_METHOD.turnCompleted,
    CODEX_METHOD.serverRequestResolved,
    CODEX_METHOD.threadSettingsUpdated,
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

  it('D48 §4.6 — the settings echo is a declared server notification, spelled exactly', () => {
    // The one frame the Codex model write-back reads. A rename upstream would
    // otherwise present as "the model selector silently stops sticking", with
    // every unit test still green because nothing else consumes this name.
    expect(CODEX_METHOD.threadSettingsUpdated).toBe('thread/settings/updated');
    expect(SERVER_NOTIFICATIONS.has('thread/settings/updated')).toBe(true);
    // Its zero-turn sibling, which S4 sends. Pinned so the pair cannot drift
    // apart — they differ by one character, and the wrong one of the two is a
    // method-not-found on the request side or a frame nobody listens for on the
    // notification side.
    expect(CLIENT_REQUESTS.has('thread/settings/update')).toBe(true);
    expect(CODEX_METHOD.threadSettingsUpdate).toBe('thread/settings/update');
    expect(CODEX_METHOD.threadSettingsUpdate).not.toBe(CODEX_METHOD.threadSettingsUpdated);
  });

  it('D14 — CODEX_METHOD spells the settings channel IF AND ONLY IF the fixture declares it', () => {
    // The gate the slice discipline is written against: "fixture first, method
    // table second". Stated as an equivalence rather than as two assertions, so
    // deleting the fixture entry to make a rename go green is red too.
    const spelled = Object.values(CODEX_METHOD).includes('thread/settings/update');
    expect(spelled).toBe(CLIENT_REQUESTS.has('thread/settings/update'));
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
    // Corrected in S3 slice 4: the previous expectation pinned a snapshot that
    // invented `openai/form` and lost the two legacy approvals, so the test that
    // exists to "make the uncovered surface visible" was showing a fake surface.
    const unhandled = contract.serverRequest.filter((m) => !(m in SERVER_REQUEST_KINDS));
    expect(unhandled).toEqual([
      'account/chatgptAuthTokens/refresh',
      'attestation/generate',
      'currentTime/read',
      'item/tool/call',
      'applyPatchApproval',
      'execCommandApproval',
    ]);
  });
});

describe('the serverRequest family matches the generated ServerRequest.json (A24)', () => {
  // Second, independently generated excerpt of the SAME codex build. Two
  // fixtures disagreeing is exactly how the ten-vs-eleven defect stayed
  // invisible: one file was wrong and nothing compared it to anything.
  const approvalSchema = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, 'fixtures', 'codex', 'codex-approval-schema.json'),
      'utf8'
    )
  ) as { codexVersion: string; serverRequestMethods: { methods: string[] } };

  it('was excerpted from the same build', () => {
    // A cross-fixture assertion is worthless if the two came from different
    // codex versions — then a real difference reads as a version difference.
    expect(approvalSchema.codexVersion).toBe(contract.codexVersion);
  });

  it('lists the same eleven methods as the approval snapshot', () => {
    expect(approvalSchema.serverRequestMethods.methods.length).toBe(11);
    expect([...contract.serverRequest].sort()).toEqual(
      [...approvalSchema.serverRequestMethods.methods].sort()
    );
  });

  it('drops the phantom method and carries the two legacy approvals', () => {
    // `openai/form` is the `mode` enum inside McpServerElicitationRequestParams,
    // never a method: the Host would have waited forever for a request that
    // cannot arrive, and the coverage list claimed a gap that did not exist.
    expect(contract.serverRequest).not.toContain('openai/form');
    expect(contract.serverRequest).toContain('applyPatchApproval');
    expect(contract.serverRequest).toContain('execCommandApproval');
  });

  it('does NOT register the two legacy approvals (slice 4 L5)', () => {
    // They are real methods, so the fix above makes the previous expectation
    // red — and the cheap way to green is to register them. That would be a
    // bug: the legacy params (callId / conversationId / fileChanges / parsedCmd)
    // and the legacy ReviewDecision dialect are both unimplemented, so a
    // registered kind would park a request nothing can answer. Unregistered,
    // it still gets a method_not_found and the turn cannot hang.
    expect(SERVER_REQUEST_KINDS).not.toHaveProperty('applyPatchApproval');
    expect(SERVER_REQUEST_KINDS).not.toHaveProperty('execCommandApproval');
  });
});

describe('D48 §4.8-B7 — turn/start carries only field names the binary declares', () => {
  it('model and effort are real TurnStartParams properties', () => {
    // The D40 half of D48 puts both on the wire. If codex renames either, this
    // is the cheap red; the expensive one is a -32602 that reads to the user as
    // "the model I picked did nothing".
    for (const field of ['model', 'effort']) {
      expect(turnSchema.TurnStartParams.propertyNames).toContain(field);
    }
  });

  it('neither is required, so omitting them is a legal frame', () => {
    // The `Automatic` / `Default` path omits the key entirely; that has to stay
    // valid rather than merely tolerated.
    for (const field of ['model', 'effort']) {
      expect(turnSchema.TurnStartParams.required).not.toContain(field);
    }
    expect(turnSchema.TurnStartParams.required).toEqual(['input', 'threadId']);
  });

  it('D48 S4 — the settings channel declares the two posture fields we DO send there', () => {
    // The mirror image of the negative control below: the posture is excluded
    // from `turn/start` because it has its own zero-turn channel, and this is
    // the assertion that the channel really carries it.
    for (const field of ['approvalPolicy', 'sandboxPolicy']) {
      expect(settingsSchema.ThreadSettingsUpdateParams.propertyNames).toContain(field);
    }
    expect(settingsSchema.ThreadSettingsUpdateParams.required).toEqual(['threadId']);
    // And the echo carries them back — the only frame that does [实测 §0.4].
    for (const field of ['approvalPolicy', 'sandboxPolicy', 'model']) {
      expect(settingsSchema.ThreadSettings.propertyNames).toContain(field);
    }
  });

  it('the posture fields we deliberately never send are declared too (negative control)', () => {
    // Proof that excluding `approvalPolicy` / `sandboxPolicy` / `cwd` from
    // `buildTurnStartParams` is a CHOICE, not a schema limitation — which is what
    // makes the exclusion assertion in codexRuntime.test.ts meaningful.
    for (const field of ['approvalPolicy', 'sandboxPolicy', 'cwd']) {
      expect(turnSchema.TurnStartParams.propertyNames).toContain(field);
    }
  });
});
