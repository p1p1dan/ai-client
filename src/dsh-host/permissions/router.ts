/**
 * Which chat session a DSH call belongs to (dsh-rebase decision 042 rule 1;
 * design shard 03 §4).
 *
 * The bridge attaches one gate per chat session under the session's root DSH
 * id. Subagent and workflow children are registered from `session/created`
 * (their header names the delegating parent, which DSH announces before the
 * child's first tool call — P1-6b experiment E1) and share the root's gate,
 * grants and queue (decisions 003, 022). A call whose session has no root is
 * refused by the plugin.
 */

import type { DshSessionHeaderView } from './dshTypes.ts';

/** What a channel attaches: the root DSH session and the gate its calls answer to. */
export interface RouteTarget<G> {
  channelId: string;
  dshSessionId: string;
  gate: G;
}

export interface ResolvedRoute<G> extends RouteTarget<G> {
  /** The session the call ran in: the root itself, or a delegate of it. */
  sessionId: string;
  /** Present when `sessionId` is not the root. */
  delegate?: { sessionId: string; agentPreset?: string };
}

export class PermissionRouter<G> {
  /** channelId -> its attached root. */
  private readonly channels = new Map<string, RouteTarget<G>>();
  /** root dshSessionId -> the channel that attached it. */
  private readonly roots = new Map<string, RouteTarget<G>>();
  /** delegate or former-root dshSessionId -> root dshSessionId. */
  private readonly rootOf = new Map<string, string>();
  private readonly presets = new Map<string, string>();
  /** Former roots of a channel that moved to a new DSH id: same chat, no delegate label. */
  private readonly aliases = new Set<string>();

  /**
   * Attach (or re-point) a channel's root. Re-attaching the same channel with
   * a new DSH id (a rewind's seeded session) moves the channel: the old id and
   * its delegates keep resolving to it, so nothing in flight loses its gate.
   * An explicit root always wins over a lineage-derived entry for the same id.
   */
  attach(target: RouteTarget<G>): void {
    const holder = this.roots.get(target.dshSessionId);
    if (holder && holder.channelId !== target.channelId) {
      throw new Error(
        `DSH session ${target.dshSessionId} is already attached to channel ${holder.channelId}`
      );
    }
    const previous = this.channels.get(target.channelId);
    if (previous && previous.dshSessionId !== target.dshSessionId) {
      this.roots.delete(previous.dshSessionId);
      for (const [child, root] of this.rootOf) {
        if (root === previous.dshSessionId) this.rootOf.set(child, target.dshSessionId);
      }
      this.rootOf.set(previous.dshSessionId, target.dshSessionId);
      this.aliases.add(previous.dshSessionId);
    }
    this.rootOf.delete(target.dshSessionId);
    this.aliases.delete(target.dshSessionId);
    this.presets.delete(target.dshSessionId);
    this.channels.set(target.channelId, target);
    this.roots.set(target.dshSessionId, target);
  }

  /** Detach a channel; its delegates stop resolving. */
  detach(channelId: string): RouteTarget<G> | undefined {
    const target = this.channels.get(channelId);
    if (!target) return undefined;
    this.channels.delete(channelId);
    this.roots.delete(target.dshSessionId);
    for (const [child, root] of [...this.rootOf]) {
      if (root !== target.dshSessionId) continue;
      this.rootOf.delete(child);
      this.presets.delete(child);
      this.aliases.delete(child);
    }
    return target;
  }

  /** `session/created`: a child whose parent resolves joins the parent's root. */
  noteSession(header: DshSessionHeaderView | undefined): void {
    if (!header || this.roots.has(header.id)) return;
    const parent = header.parentSession;
    if (!parent) return;
    const root = this.roots.has(parent) ? parent : this.rootOf.get(parent);
    if (!root) return;
    this.rootOf.set(header.id, root);
    if (header.agentPreset) this.presets.set(header.id, header.agentPreset);
  }

  /** `session/disposed`: forget a delegate (roots leave through `detach`). */
  forgetSession(sessionId: string): void {
    if (this.aliases.has(sessionId)) return;
    this.rootOf.delete(sessionId);
    this.presets.delete(sessionId);
  }

  /**
   * The route of a call made by `sessionId`, or undefined when nothing
   * attached owns it. `header` is the calling session's own header: a child
   * DSH announced before this row started still resolves through it.
   */
  resolve(
    sessionId: string | undefined,
    header?: DshSessionHeaderView
  ): ResolvedRoute<G> | undefined {
    if (!sessionId) return undefined;
    const root = this.roots.get(sessionId);
    if (root) return { ...root, sessionId };
    if (header && header.id === sessionId && !this.rootOf.has(sessionId)) this.noteSession(header);
    const rootId = this.rootOf.get(sessionId);
    const target = rootId ? this.roots.get(rootId) : undefined;
    if (!target) return undefined;
    if (this.aliases.has(sessionId)) return { ...target, sessionId };
    const agentPreset = this.presets.get(sessionId) ?? header?.agentPreset;
    return {
      ...target,
      sessionId,
      delegate: { sessionId, ...(agentPreset ? { agentPreset } : {}) },
    };
  }

  /** The attached target of a channel, if any. */
  channel(channelId: string): RouteTarget<G> | undefined {
    return this.channels.get(channelId);
  }

  get size(): number {
    return this.channels.size;
  }
}
