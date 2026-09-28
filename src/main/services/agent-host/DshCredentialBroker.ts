/**
 * Main's half of per-request credentials (dsh-rebase P1-5b; decision 034).
 *
 * The shared DSH host holds no key: its `aiclient-credentials` row asks for the
 * key behind one reference of its model plan each time a model request needs
 * it (`{host:'credential', id, ref, nonce}`), and this broker answers. Before
 * answering it checks, in order:
 *
 *   channel   the request came from the host Main runs now, not one on its
 *             way out (the supervisor says which);
 *   nonce     it carries the nonce of the `configure` that host received;
 *   ref       it names a reference of that host's plan.
 *
 * A failed check is `refused`. The key itself comes from the in-memory catalog
 * (`resolveNativeModelCatalog()?.auth`), by the plan's own reference table, so
 * the existing ownership rules decide which key a provider gets (login key,
 * administrator key, the user's own). Signed out, a locked or unreadable
 * keyring, or no key for the provider: `unavailable`. There is no fallback to
 * the plain-text `auth.json`.
 *
 * The catalog's keys are kept in memory until the vault next changes (or the
 * model plan is rebuilt), which spares a keyring decryption per request. No
 * key value is ever logged: only counts, once a minute at most.
 */

import type {
  DshHostCredentialRequest,
  DshHostCredentialResult,
} from '@shared/types/dshHostProtocol';

/** What the supervisor knows about the host a request came from. */
export interface DshCredentialContext {
  /** The request arrived from the host the supervisor runs now. */
  current: boolean;
  /** The nonce of the `configure` that host received. */
  nonce: string;
  /** That host's plan: reference name -> provider id. */
  refs: Readonly<Record<string, string>>;
}

export interface DshCredentialBrokerOptions {
  /**
   * The `auth.json`-shaped half of the in-memory catalog, or `undefined` when
   * none could be assembled (signed out, keyring locked or unreadable).
   */
  readAuth: () => Record<string, unknown> | undefined;
  /** Registers a vault-change listener; returns its disposer. */
  onVaultChange?: (listener: () => void) => () => void;
  log?: (...args: unknown[]) => void;
  /** Wall-clock milliseconds, for the per-minute counts. */
  now?: () => number;
}

type Outcome = 'served' | 'refused' | 'unavailable';

const COUNT_INTERVAL_MS = 60_000;

function keyOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const key = (entry as { key?: unknown }).key;
  return typeof key === 'string' && key.trim() !== '' ? key : undefined;
}

export class DshCredentialBroker {
  private readonly options: DshCredentialBrokerOptions;
  private readonly now: () => number;
  /** Provider id -> key, until the vault changes; `null` when no catalog could be assembled. */
  private keys: Map<string, string> | null | undefined;
  private readonly counts: Record<Outcome, number> = { served: 0, refused: 0, unavailable: 0 };
  private countsSince: number;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(options: DshCredentialBrokerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.countsSince = this.now();
    this.unsubscribe = options.onVaultChange?.(() => this.invalidate());
  }

  /** Forget every key held: the next request reads the catalog again. */
  invalidate(): void {
    this.keys = undefined;
  }

  dispose(): void {
    this.invalidate();
    this.unsubscribe?.();
  }

  /** The answer to one request; never throws, never logs a value. */
  answer(
    request: DshHostCredentialRequest,
    context: DshCredentialContext
  ): DshHostCredentialResult {
    const refusal = this.check(request, context);
    if (refusal) {
      this.options.log?.(`[dsh-credentials] refused request ${request.id}: ${refusal}`);
      return this.result(request.id, 'refused');
    }
    const providerId = context.refs[request.ref] as string;
    const key = this.keysNow()?.get(providerId);
    if (!key) return this.result(request.id, 'unavailable');
    this.count('served');
    return { host: 'credential-result', id: request.id, ok: true, value: key };
  }

  private check(request: DshHostCredentialRequest, context: DshCredentialContext): string | null {
    if (!context.current) return 'not the running host';
    if (context.nonce === '' || request.nonce !== context.nonce) return 'wrong nonce';
    if (!Object.hasOwn(context.refs, request.ref))
      return `reference ${request.ref} is not in the plan`;
    return null;
  }

  private keysNow(): Map<string, string> | null {
    if (this.keys !== undefined) return this.keys;
    let auth: Record<string, unknown> | undefined;
    try {
      auth = this.options.readAuth();
    } catch (error) {
      this.options.log?.(
        '[dsh-credentials] the model catalog could not be read:',
        error instanceof Error ? error.message : String(error)
      );
      auth = undefined;
    }
    if (!auth) {
      // Not cached: a keyring unlocked a moment later must work on the next request.
      return null;
    }
    const keys = new Map<string, string>();
    for (const [providerId, entry] of Object.entries(auth)) {
      const key = keyOf(entry);
      if (key) keys.set(providerId, key);
    }
    this.keys = keys;
    return keys;
  }

  private result(id: number, error: 'refused' | 'unavailable'): DshHostCredentialResult {
    this.count(error);
    return { host: 'credential-result', id, ok: false, error };
  }

  private count(outcome: Outcome): void {
    this.counts[outcome] += 1;
    const now = this.now();
    if (now - this.countsSince < COUNT_INTERVAL_MS) return;
    const { served, refused, unavailable } = this.counts;
    this.options.log?.(
      `[dsh-credentials] last ${Math.round((now - this.countsSince) / 1000)} s: ` +
        `${served} served, ${unavailable} unavailable, ${refused} refused`
    );
    this.counts.served = 0;
    this.counts.refused = 0;
    this.counts.unavailable = 0;
    this.countsSince = now;
  }
}
