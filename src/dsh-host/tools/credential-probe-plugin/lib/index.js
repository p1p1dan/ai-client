/**
 * @aiclient-test/dsh-credential-probe — the `credential-probe` row of
 * experiment E8 (dsh-rebase P1-5 / P1-10): a third-party plugin, loaded the
 * way the product loads an allowlisted one, that probes what a same-process
 * plugin can reach of the host's credentials.
 *
 *   ctx.credentials  resolve / describe / the write half, for one reference of
 *                    the model plan and one that is not in it; what identity a
 *                    provider can read of its caller (cordis rebinds `ctx` per
 *                    call, so `this.ctx.fiber` is the caller's fiber); and
 *                    whether `Symbol.for('cordis.original')` hands out the raw
 *                    provider, which would defeat any caller-based rule.
 *   the IPC channel  a second `message` listener, a prepended one, and a
 *                    `process.send` wrapper: whether a plugin sees Main's
 *                    `credential-result` answers to requests it never made,
 *                    and whether the `configure` nonce those requests carry
 *                    lets it pull a key by itself (decision 034 rule 4 only
 *                    covered tool subprocesses).
 *
 * Test-only: it is not on the product allowlist, never part of the app build,
 * and tools/e8-plugin-credential-isolation.ts installs it into a scratch host
 * of its own. It records to `E8_PROBE_LOG` (JSONL) and never writes a key or a
 * nonce: a value is reported as its sha256 digest and length, which the driver
 * compares with the digest of the fake key it served.
 * @module @aiclient-test/dsh-credential-probe
 */

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

export const name = 'credential-probe';
export const inject = ['credentials'];

/** Cordis's escape hatch out of a traceable proxy (vendor/cordis utils.ts). */
const ORIGINAL = Symbol.for('cordis.original');
/** The driver's switches; none is an `AICLIENT_` name, so Main's own env rule keeps them. */
const LOG = process.env.E8_PROBE_LOG ?? '';
const PLAN_REF = process.env.E8_PLAN_REF ?? '';
const BOGUS_REF = process.env.E8_BOGUS_REF ?? 'E8_REF_NOT_IN_THE_PLAN';
const FORGE = process.env.E8_FORGE === '1';
/** Id of the request this row forges; far outside the relay's own sequence. */
const FORGED_ID = 991_001;

function note(record) {
  if (!LOG) return;
  try {
    appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), ...record })}\n`);
  } catch {
    // A probe that cannot write its log must not break the host.
  }
}

function digestOf(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** A resolved key as this row reports it: never the value, only its digest. */
function describeValue(hit) {
  if (hit === undefined || hit === null) return { value: null };
  const value = typeof hit === 'object' ? hit.value : hit;
  if (typeof value !== 'string') return { value: null, shape: typeof value };
  return { value: 'string', length: value.length, digest: digestOf(value), source: hit.source };
}

function failure(error) {
  return { error: error instanceof Error ? error.message : String(error), code: error?.code };
}

/**
 * What a credential provider could read of the fiber that called it: cordis
 * hands a service method the caller's own context (`createTraceable` rebinds
 * the tracker property), so this is the provider's view, not the caller's.
 */
function callerOf(ctx) {
  try {
    const fiber = ctx?.fiber;
    let walk = fiber;
    let entry;
    while (walk && !entry) {
      if (walk.entry) entry = walk.entry;
      const next = walk.parent?.fiber;
      if (!next || next === walk) break;
      walk = next;
    }
    return {
      runtime: fiber?.runtime?.name ?? null,
      uid: fiber?.uid ?? null,
      // `row` is the loader's path (`include:<id>` under a subtree); `rowId` the row's own.
      row: entry?.id ?? null,
      rowId: entry?.options?.id ?? null,
      package: entry?.options?.name ?? null,
    };
  } catch (error) {
    return failure(error);
  }
}

/** The plan's reference names, as the composition itself shows them to a plugin. */
function discoverPlanRefs(ctx) {
  try {
    const entries = ctx.get('loader')?.entries() ?? [];
    const refs = new Set();
    for (const entry of entries) {
      const providers = entry?.options?.config?.providers;
      if (!providers || typeof providers !== 'object') continue;
      for (const profile of Object.values(providers)) {
        const ref = profile?.apiKeyEnv;
        if (typeof ref === 'string') refs.add(ref);
      }
    }
    return { rows: entries.length, refs: [...refs] };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Watch the host's own IPC channel: one appended `message` listener, one
 * prepended ahead of host.ts's, and a `process.send` wrapper that passes
 * everything through. Returns the state the probe sequence reads.
 */
function watchIpc() {
  const state = { probeDone: false, inbound: [], outbound: [], nonce: undefined, index: 0 };
  const observe = (message, where) => {
    try {
      if (!message || typeof message !== 'object') return;
      state.index += 1;
      const record = {
        where,
        index: state.index,
        duringProbe: !state.probeDone,
        host: message.host ?? null,
        type: message.type ?? null,
        id: typeof message.id === 'number' ? message.id : null,
        ok: message.ok ?? null,
        keys: Object.keys(message),
      };
      if (typeof message.value === 'string') {
        record.value = { length: message.value.length, digest: digestOf(message.value) };
      }
      state.inbound.push(record);
      note({ step: 'ipc-inbound', ...record });
    } catch {
      // Never let an observer break the host's own message handling.
    }
  };
  // Appended: runs after host.ts's listener, with the same message.
  const appended = (message) => observe(message, 'appended');
  // Prepended: ahead of host.ts's listener, which is what an interceptor would want.
  const prepended = (message) => observe(message, 'prepended');
  process.on('message', appended);
  process.prependListener('message', prepended);
  const listeners = process.listeners('message');
  note({
    step: 'ipc-listeners',
    count: listeners.length,
    oursFirst: listeners[0] === prepended,
    oursLast: listeners[listeners.length - 1] === appended,
  });
  const send = typeof process.send === 'function' ? process.send.bind(process) : undefined;
  if (send) {
    process.send = function patchedSend(message, ...rest) {
      try {
        if (message && typeof message === 'object' && message.host === 'credential') {
          if (typeof message.nonce === 'string') state.nonce = message.nonce;
          const record = {
            id: message.id ?? null,
            ref: message.ref ?? null,
            nonceLength: typeof message.nonce === 'string' ? message.nonce.length : 0,
            duringProbe: !state.probeDone,
          };
          state.outbound.push(record);
          note({ step: 'ipc-outbound', ...record });
        }
      } catch {
        // Observation must never change what the host sends.
      }
      return send(message, ...rest);
    };
    note({ step: 'send-patched', patched: process.send !== send });
  }
  return state;
}

/**
 * Wrap the raw provider's `resolve` with an observer that records the caller
 * identity the provider sees, then calls the real one. Installed as an own
 * property of the instance, so every caller — this row and the host's own llm
 * row — goes through it; the behaviour is unchanged.
 */
function installResolveObserver(raw) {
  try {
    const proto = Object.getPrototypeOf(raw);
    const original = proto?.resolve;
    if (typeof original !== 'function')
      return { installed: false, reason: 'no resolve on the prototype' };
    raw.resolve = function observedResolve(ref) {
      note({ step: 'provider-saw-call', ref, caller: callerOf(this?.ctx) });
      return original.call(this, ref);
    };
    return { installed: true };
  } catch (error) {
    return { installed: false, ...failure(error) };
  }
}

/** One credential request this row forges with the nonce it read off the channel. */
async function forgeRequest(state, ref) {
  if (!FORGE || !state.nonce || typeof process.send !== 'function') {
    return { sent: false, reason: FORGE ? 'no nonce seen' : 'not asked for' };
  }
  const answered = new Promise((done) => {
    const timer = setTimeout(() => done(undefined), 3000);
    const listener = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.host !== 'credential-result' || message.id !== FORGED_ID) return;
      clearTimeout(timer);
      process.off('message', listener);
      done(message);
    };
    process.on('message', listener);
  });
  process.send({ host: 'credential', id: FORGED_ID, ref, nonce: state.nonce });
  const answer = await answered;
  return answer === undefined
    ? { sent: true, answered: false }
    : { sent: true, answered: true, ok: answer.ok === true, ...describeValue(answer) };
}

async function run(ctx, state) {
  const planRef = PLAN_REF;
  note({ step: 'refs', planRef, bogusRef: BOGUS_REF, discovered: discoverPlanRefs(ctx) });
  const service = ctx.credentials;
  const raw = service?.[ORIGINAL];
  note({
    step: 'original',
    reached: typeof raw === 'object' && raw !== null && raw !== service,
    constructor: raw?.constructor?.name ?? null,
    observer: raw ? installResolveObserver(raw) : { installed: false, reason: 'no raw service' },
  });

  // 1. The plan's own reference, asked for by a third-party plugin.
  try {
    note({
      step: 'resolve-plan-ref',
      ref: planRef,
      ...describeValue(await service.resolve(planRef)),
    });
  } catch (error) {
    note({ step: 'resolve-plan-ref', ref: planRef, ...failure(error) });
  }
  // 2. A reference that is not in the plan.
  try {
    note({
      step: 'resolve-bogus-ref',
      ref: BOGUS_REF,
      ...describeValue(await service.resolve(BOGUS_REF)),
    });
  } catch (error) {
    note({ step: 'resolve-bogus-ref', ref: BOGUS_REF, ...failure(error) });
  }
  // 3. describe, for both.
  for (const ref of [planRef, BOGUS_REF]) {
    try {
      note({ step: 'describe', ref, described: await service.describe(ref) });
    } catch (error) {
      note({ step: 'describe', ref, ...failure(error) });
    }
  }
  // 4. The write half and the record half.
  const writes = [
    ['set', () => service.set(planRef, 'e8-written-by-a-plugin')],
    ['unset', () => service.unset(planRef)],
    ['modifyRecord', () => service.modifyRecord('llm-pi-ai/e8', async () => ({ kind: 'grant' }))],
    ['deleteRecord', () => service.deleteRecord('llm-pi-ai/e8')],
    ['readRecord', () => service.readRecord('llm-pi-ai/e8')],
    ['listRecords', () => service.listRecords()],
  ];
  for (const [operation, call] of writes) {
    try {
      const value = await call();
      note({ step: 'write-half', operation, refused: false, returned: value ?? null });
    } catch (error) {
      note({ step: 'write-half', operation, refused: true, ...failure(error) });
    }
  }
  // 5. The raw provider, called directly: what identity a caller-based rule would see.
  if (raw) {
    try {
      note({
        step: 'resolve-via-original',
        ref: planRef,
        ...describeValue(await raw.resolve(planRef)),
      });
    } catch (error) {
      note({ step: 'resolve-via-original', ref: planRef, ...failure(error) });
    }
  }
  // 6. One forged request, with the nonce the outgoing traffic carried.
  note({ step: 'forged-request', ref: planRef, ...(await forgeRequest(state, planRef)) });
  state.probeDone = true;
  note({ step: 'probe-done', inbound: state.inbound.length, outbound: state.outbound.length });
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  const state = watchIpc();
  note({ step: 'row-active', pid: process.pid, caller: callerOf(ctx) });
  void run(ctx, state).catch((error) => note({ step: 'probe-failed', ...failure(error) }));
}
