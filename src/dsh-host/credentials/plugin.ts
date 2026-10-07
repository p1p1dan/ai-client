/**
 * aiclient-credentials — the host's `ctx.credentials` (dsh-rebase P1-5b;
 * decision 034), in place of dsh-base's `credentials` row, which keeps keys in
 * plain text in `$DSH_HOME/.credentials.yaml` and is composed off.
 *
 * Read-only and cache-free: a key reference of the model plan is resolved per
 * request by asking Main over IPC (`CredentialRelay`, provided by host.ts);
 * any other reference resolves to nothing, and every write is refused. The
 * row also masks keys in provider failure text before DSH stores it
 * (`llm/stream`). The behaviour lives in `port.ts`.
 *
 * Two ways in, like the other rows (decision 011): a source checkout loads
 * `bundle/lib/credentials.js`, a re-export of this file; the packaged host
 * loads the esbuild bundle scripts/build-dsh-host.mjs writes over it.
 */

import type { Context } from '@deepseek-ai/cordis';
import {
  type CredentialKey,
  CredentialProvider,
  type CredentialRecord,
  type CredentialRef,
} from '@deepseek-ai/dsh-credentials';
import { redactCredentials } from '../../shared/stderrRedaction.ts';
import { CREDENTIAL_RELAY_SERVICE, CredentialPort, type CredentialRelayView } from './port.ts';

type StreamListener = (options: unknown, next: () => AsyncIterable<unknown>) => unknown;

/** Stable row name; Cordis loads the default export, the service class. */
export const name = 'aiclient-credentials';

export default class AiclientCredentials extends CredentialProvider {
  private readonly port: CredentialPort;

  constructor(ctx: Context) {
    super(ctx);
    const read = ctx as unknown as {
      get(name: string): unknown;
      on(name: 'llm/stream', listener: StreamListener): () => boolean;
    };
    this.port = new CredentialPort({
      relay: () => read.get(CREDENTIAL_RELAY_SERVICE) as CredentialRelayView | undefined,
      redactShapes: redactCredentials,
    });
    read.on('llm/stream', (_options, next) => this.port.redactStream(next()));
  }

  resolve(ref: CredentialRef) {
    return this.port.resolve(ref);
  }

  describe(ref: CredentialRef) {
    return this.port.describe(ref);
  }

  set(_ref: CredentialRef, _value: string): Promise<void> {
    return this.port.refuse('set');
  }

  unset(_ref: CredentialRef): Promise<void> {
    return this.port.refuse('unset');
  }

  async readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return undefined;
  }

  async describeRecord(_key: CredentialKey) {
    return { configured: false, writable: false };
  }

  async listRecords() {
    return [];
  }

  modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>
  ): Promise<CredentialRecord | undefined> {
    return this.port.refuse('modifyRecord');
  }

  deleteRecord(_key: CredentialKey): Promise<void> {
    return this.port.refuse('deleteRecord');
  }
}
