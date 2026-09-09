import type { AgentMessage, CompactResult } from '@earendil-works/pi-agent-core';
import { type Context, Service } from 'cordis';
import { DEFAULT_RUNTIME_PERMISSION } from '../../../shared/types/runtimePermission.ts';
import { type RuntimeSessionService, SESSION_SERVICE } from '../../contracts.ts';
import type { JsonlSessionStore, NewSessionEntry } from './store.ts';

export class SessionPlugin extends Service implements RuntimeSessionService {
  private readonly store: JsonlSessionStore;
  constructor(ctx: Context, store: JsonlSessionStore) {
    super(ctx, SESSION_SERVICE);
    this.store = store;
  }
  get file() {
    return this.store.file;
  }
  snapshot() {
    return this.store.snapshot();
  }
  appendMessage(message: AgentMessage) {
    return this.store.appendMessage(message);
  }
  appendCompaction(result: CompactResult) {
    return this.store.appendCompaction(result);
  }
  async appendEntry(entry: NewSessionEntry) {
    const stored = await this.store.appendEntry(entry);
    if (stored.type === 'custom')
      this.ctx.runtimeEvents.emit({
        type: 'custom.entry',
        sessionId: this.store.metadata().id,
        payload: {
          messageId: `entry-${stored.id}`,
          customType: stored.customType,
          content: JSON.stringify(stored.data ?? '').slice(0, 16_000),
        },
      });
    return stored;
  }
  metadata() {
    return this.store.metadata();
  }
  tree(logicalSessionId?: string) {
    return this.store.tree(logicalSessionId);
  }
  history() {
    return this.store.history();
  }
  async navigate(entryId: string | null) {
    const snapshot = await this.store.navigate(entryId);
    this.ctx
      .get('runtimePermissions')
      ?.configure(snapshot.permissions ?? DEFAULT_RUNTIME_PERMISSION);
    return snapshot;
  }
  async rewind(entryId: string, confirmed: boolean) {
    const result = await this.store.rewind(entryId, confirmed);
    this.ctx
      .get('runtimePermissions')
      ?.configure(result.snapshot.permissions ?? DEFAULT_RUNTIME_PERMISSION);
    return result;
  }
  fork(file: string, entryId: string) {
    return this.store.fork(file, entryId);
  }
  discardFork(file: string, id: string) {
    return this.store.discardFork(file, id);
  }
  acceptFork(file: string) {
    this.store.acceptFork(file);
  }
  rename(name: string | undefined) {
    return this.store.rename(name);
  }
  label(entryId: string, label: string | undefined) {
    return this.store.label(entryId, label);
  }
  flush() {
    return this.store.flush();
  }
}
