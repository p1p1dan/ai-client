/**
 * What the `aiclient-credentials` row does (dsh-rebase P1-5b; decision 034),
 * kept apart from the Cordis service class in `plugin.ts` so it runs in the
 * root Vitest with no DSH package installed.
 *
 *   resolve(ref)   a reference of the plan: the key from Main, for this one
 *                  request (host.ts's `CredentialRelay`); anything else: none,
 *                  and nothing is sent. pi-ai's own environment discovery asks
 *                  here too, and gets nothing.
 *   describe(ref)  configured = a reference of the plan; never the value.
 *   writes         refused, every one: the row is read-only, so pi-ai's OAuth
 *                  sign-in has nowhere to store a grant (we never use it).
 *   failures       a provider failure's text is masked before DSH stores it:
 *                  every key served lately (by digest) and every key shape.
 */

/** The relay host.ts provides, as the row reads it. */
export interface CredentialRelayView {
  knows(ref: string): boolean;
  resolve(ref: string): Promise<string | undefined>;
  redact(text: string): string;
}

/** The service host.ts provides the relay under. */
export const CREDENTIAL_RELAY_SERVICE = 'aiclientCredentialRelay';

/** `source` of every resolved credential. */
export const CREDENTIAL_SOURCE = 'aiclient-main';

/** Code of every refused write. */
export const CREDENTIALS_READ_ONLY = 'CREDENTIALS_READ_ONLY';

/** Placeholder of a masked key shape. */
const SHAPE_PLACEHOLDER = '[redacted]';

export interface CredentialPortOptions {
  /** Looked up per call: a host without IPC has none, and every lookup then finds nothing. */
  relay(): CredentialRelayView | undefined;
  /** The repo's key-shape rules (`redactCredentials` in src/shared/stderrRedaction.ts). */
  redactShapes(text: string, placeholder: string): string;
}

type Chunk = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class CredentialPort {
  private readonly options: CredentialPortOptions;

  constructor(options: CredentialPortOptions) {
    this.options = options;
  }

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const relay = this.options.relay();
    if (!relay?.knows(ref)) return undefined;
    const value = await relay.resolve(ref);
    return value ? { value, source: CREDENTIAL_SOURCE } : undefined;
  }

  async describe(ref: string): Promise<{ configured: boolean; source?: string; writable: false }> {
    const configured = this.options.relay()?.knows(ref) === true;
    return configured
      ? { configured, source: CREDENTIAL_SOURCE, writable: false }
      : { configured, writable: false };
  }

  refuse(operation: string): Promise<never> {
    return Promise.reject(
      Object.assign(
        new Error(`aiclient-credentials is read-only: ${operation} is refused (keys live in Main)`),
        { code: CREDENTIALS_READ_ONLY }
      )
    );
  }

  /** Every key this host was served lately, and every key shape, masked. */
  redact(text: string): string {
    const relay = this.options.relay();
    const byDigest = relay ? relay.redact(text) : text;
    return this.options.redactShapes(byDigest, SHAPE_PLACEHOLDER);
  }

  /** A terminal chunk whose failure text holds a key, rewritten; every other chunk as it is. */
  redactChunk(chunk: unknown): unknown {
    if (!isRecord(chunk) || chunk.type !== 'finish' || !isRecord(chunk.reason)) return chunk;
    const failure = chunk.reason.failure;
    if (!isRecord(failure) || typeof failure.message !== 'string') return chunk;
    const message = this.redact(failure.message);
    if (message === failure.message) return chunk;
    return {
      ...(chunk as Chunk),
      reason: { ...chunk.reason, failure: { ...failure, message } },
    };
  }

  /** `llm/stream` listener body: the stream `next()` produced, with failures masked. */
  async *redactStream(stream: AsyncIterable<unknown>): AsyncIterable<unknown> {
    for await (const chunk of stream) yield this.redactChunk(chunk);
  }
}
