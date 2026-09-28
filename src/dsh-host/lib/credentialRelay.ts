/**
 * The host's half of per-request credentials (dsh-rebase P1-5b; decision 034).
 *
 * `llm-pi-ai` resolves a route's `apiKeyEnv` reference once per model request
 * through `ctx.credentials`; the `aiclient-credentials` row answers from here.
 * A reference of the plan becomes one `{host:'credential', id, ref, nonce}`
 * message to Main, answered by `credential-result` within 5 s; anything else,
 * a refusal or a timeout resolves to no key, and DSH fails the request with
 * `MISSING_CREDENTIAL`. Nothing is cached: the value lives only in the request
 * that asked for it.
 *
 * What is kept is a digest of each key served lately, never the key: a
 * provider that echoes the key in its error text would otherwise have it
 * written into the session log. `redact` finds such an echo by digest and
 * masks it before DSH stores the failure.
 *
 * Bundled into host.js (host.ts's own `lib/`); `node:crypto` is its one import.
 */

import { createHash } from 'node:crypto';

/** `DSH_CREDENTIAL_TIMEOUT_MS` in `src/shared/types/dshHostProtocol.ts`. */
export const CREDENTIAL_TIMEOUT_MS = 5_000;

/** What replaces an echoed key. */
export const REDACTED_KEY = '[redacted]';

/** Digests of the keys served most recently, for `redact`. */
const SERVED_DIGESTS_KEPT = 32;

/**
 * Texts longer than this are masked only up to here: one digest per position
 * and key length. A provider's failure message is far shorter.
 */
const REDACT_SCAN_LIMIT = 64 * 1024;

export interface CredentialRequestMessage {
  host: 'credential';
  id: number;
  ref: string;
  nonce: string;
}

export interface CredentialRelayOptions {
  /** The `configure` nonce of this host. */
  nonce: string;
  /** Reference name -> provider id, the plan's `refs`. Only these are ever asked for. */
  refs: Readonly<Record<string, string>>;
  /** Puts one request on the IPC channel; false when it could not be sent. */
  send(message: CredentialRequestMessage): boolean;
  timeoutMs?: number;
  log?: (...args: unknown[]) => void;
}

interface Pending {
  settle(value: string | undefined): void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class CredentialRelay {
  private readonly options: CredentialRelayOptions;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  /** `length:digest` of recently served keys, oldest first. */
  private readonly served: string[] = [];
  private sequence = 0;
  private closed = false;

  constructor(options: CredentialRelayOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? CREDENTIAL_TIMEOUT_MS;
  }

  /** Whether `ref` is a reference of this host's plan. */
  knows(ref: string): boolean {
    return Object.hasOwn(this.options.refs, ref);
  }

  /** The key behind one reference of the plan, from Main, for one request; never cached. */
  resolve(ref: string): Promise<string | undefined> {
    if (this.closed || !this.knows(ref)) return Promise.resolve(undefined);
    const id = ++this.sequence;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.options.log?.(`credential request ${id} for ${ref} timed out`);
        done(undefined);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        settle: (value) => {
          clearTimeout(timer);
          done(value);
        },
        timer,
      });
      let sent = false;
      try {
        sent = this.options.send({ host: 'credential', id, ref, nonce: this.options.nonce });
      } catch {
        sent = false;
      }
      if (!sent) this.take(id)?.settle(undefined);
    });
  }

  /** Handles a `credential-result`; false for anything else. Unknown ids are dropped. */
  receive(message: unknown): boolean {
    if (!isRecord(message) || message.host !== 'credential-result') return false;
    const id = message.id;
    if (typeof id !== 'number') return true;
    const pending = this.take(id);
    if (!pending) return true;
    if (message.ok === true && typeof message.value === 'string' && message.value.length > 0) {
      this.remember(message.value);
      pending.settle(message.value);
    } else {
      this.options.log?.(
        `credential request ${id} answered without a key (${String(message.error ?? 'malformed')})`
      );
      pending.settle(undefined);
    }
    return true;
  }

  /** Every served key that `text` contains, masked. */
  redact(text: string): string {
    if (this.served.length === 0 || text.length === 0) return text;
    const byLength = new Map<number, Set<string>>();
    for (const entry of this.served) {
      const split = entry.indexOf(':');
      const length = Number(entry.slice(0, split));
      const set = byLength.get(length) ?? new Set<string>();
      set.add(entry.slice(split + 1));
      byLength.set(length, set);
    }
    const scanned = text.slice(0, REDACT_SCAN_LIMIT);
    const ranges: Array<[number, number]> = [];
    for (const [length, digests] of byLength) {
      for (let start = 0; start + length <= scanned.length; start += 1) {
        if (digests.has(digestOf(scanned.slice(start, start + length)))) {
          ranges.push([start, start + length]);
          start += length - 1;
        }
      }
    }
    if (ranges.length === 0) return text;
    ranges.sort((a, b) => a[0] - b[0]);
    let out = '';
    let at = 0;
    for (const [start, end] of ranges) {
      if (end <= at) continue;
      out += scanned.slice(at, Math.max(at, start)) + REDACTED_KEY;
      at = end;
    }
    return out + text.slice(at);
  }

  /** Settles every request still waiting with no key; later requests get none either. */
  close(): void {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.take(id)?.settle(undefined);
  }

  private take(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  private remember(value: string): void {
    const entry = `${value.length}:${digestOf(value)}`;
    const index = this.served.indexOf(entry);
    if (index >= 0) this.served.splice(index, 1);
    this.served.push(entry);
    if (this.served.length > SERVED_DIGESTS_KEPT) this.served.shift();
  }
}
