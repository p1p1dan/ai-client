/**
 * U07: what the current conversation is MADE OF — one segment per loaded
 * message, plus a per-role composition summary.
 *
 * ## What this is, and what it deliberately is not
 *
 * pi-app's context panel lists the session FILE's context entries (system
 * prompt, compaction summaries, every tool result) behind its own
 * `context.preview` IPC. This repo has no such channel, and inventing one means
 * changing the runtime — outside this plan's boundary (Q04 取证). So the source
 * here is the message bucket this window has already loaded, and every label
 * says so. It is an honest description of the transcript, NOT a reading of the
 * model's context window: a compacted-away turn or a system prompt this window
 * never received simply is not here.
 *
 * Sizes are in CHARACTERS, not tokens. A chars→tokens estimate is a second
 * number derived from this one, and it belongs with the real usage figures that
 * the Pi plan's T38 unlocks (U06-b) — printing `~1.2k tok` from a divide-by-four
 * would look like it came from the runtime when it did not.
 *
 * React/electronAPI-free so it runs under the repo's node-env vitest.
 */

import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';

/** Longest body this panel will ever render for one segment. */
export const SEGMENT_BODY_MAX_CHARS = 2000;
/** Longest collapsed preview line. */
export const SEGMENT_PREVIEW_MAX_CHARS = 140;

export type ConversationRole = ChatMessage['role'];

export interface ConversationSegment {
  /** Message id — the React key AND the expansion key. */
  id: string;
  role: ConversationRole;
  /** Short qualifier for what else is in this message ('2 tools', 'thinking'). */
  detail: string | null;
  /** Size of everything this message carries, in characters. */
  chars: number;
  /** Single-line collapsed preview; empty when the message is all tool traffic. */
  preview: string;
  /** Expanded body, capped at `SEGMENT_BODY_MAX_CHARS`. */
  body: string;
  /** True when `body` was cut — the view says so rather than lying by omission. */
  truncated: boolean;
}

export interface ConversationRoleShare {
  role: ConversationRole;
  messages: number;
  chars: number;
  /** 0..1 of total characters; 0 when the conversation is empty. */
  share: number;
}

export interface ConversationComposition {
  segments: ConversationSegment[];
  /** Roles that actually occur, largest share first. */
  roles: ConversationRoleShare[];
  totalMessages: number;
  totalChars: number;
}

/**
 * Per-block size cache.
 *
 * Keyed on the block object, not the message: the store rebuilds a message's
 * `blocks` array on every streaming delta but REUSES the objects it did not
 * touch, so this makes a turn carrying a megabyte of tool output cost one
 * measurement instead of one per token. A WeakMap so a closed session's blocks
 * are collectable.
 */
const blockCharsCache = new WeakMap<ChatBlock, number>();

function stringifyLength(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Circular or otherwise unserializable tool payload: unknown size is
    // reported as 0 rather than guessed, and the segment still lists.
    return 0;
  }
}

function measureBlock(block: ChatBlock): number {
  const cached = blockCharsCache.get(block);
  if (cached !== undefined) return cached;
  const chars =
    (block.text?.length ?? 0) +
    (block.toolName?.length ?? 0) +
    stringifyLength(block.toolInput) +
    stringifyLength(block.toolOutput);
  blockCharsCache.set(block, chars);
  return chars;
}

function firstLine(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > SEGMENT_PREVIEW_MAX_CHARS
    ? `${trimmed.slice(0, SEGMENT_PREVIEW_MAX_CHARS - 1)}…`
    : trimmed;
}

function segmentDetail(toolCalls: number, hasThinking: boolean): string | null {
  const parts: string[] = [];
  if (toolCalls > 0) parts.push(`${toolCalls} ⚒`);
  if (hasThinking) parts.push('…');
  return parts.length > 0 ? parts.join(' ') : null;
}

function toSegment(message: ChatMessage): ConversationSegment {
  let chars = 0;
  let toolCalls = 0;
  let hasThinking = false;
  const texts: string[] = [];

  for (const block of message.blocks) {
    chars += measureBlock(block);
    if (block.type === 'tool_call') toolCalls += 1;
    if (block.type === 'thinking') hasThinking = true;
    if (block.type === 'text' && block.text) texts.push(block.text);
  }

  const text = texts.join('\n\n');
  return {
    id: message.id,
    role: message.role,
    detail: segmentDetail(toolCalls, hasThinking),
    chars,
    preview: firstLine(text),
    body: text.slice(0, SEGMENT_BODY_MAX_CHARS),
    truncated: text.length > SEGMENT_BODY_MAX_CHARS,
  };
}

/**
 * Newest segment first — the panel is read top-down while a turn is running,
 * and the message the user just sent is the one they are looking for.
 */
export function deriveConversationComposition(
  messages: readonly ChatMessage[]
): ConversationComposition {
  const segments = messages.map(toSegment);
  const byRole = new Map<ConversationRole, { messages: number; chars: number }>();
  let totalChars = 0;

  for (const segment of segments) {
    totalChars += segment.chars;
    const bucket = byRole.get(segment.role);
    if (bucket) {
      bucket.messages += 1;
      bucket.chars += segment.chars;
    } else {
      byRole.set(segment.role, { messages: 1, chars: segment.chars });
    }
  }

  const roles: ConversationRoleShare[] = [...byRole.entries()]
    .map(([role, bucket]) => ({
      role,
      messages: bucket.messages,
      chars: bucket.chars,
      share: totalChars > 0 ? bucket.chars / totalChars : 0,
    }))
    .sort((a, b) => b.chars - a.chars);

  return {
    segments: [...segments].reverse(),
    roles,
    totalMessages: segments.length,
    totalChars,
  };
}

/**
 * U16: how many segments the list shows before the "show more" row.
 *
 * The user's concern, verbatim: 「用户超长上下文，我担心这个页面展开后会爆炸，
 * 或者限制展示条数」. Collapsing the section only defers the problem — a 300-turn
 * session expanded once still renders 300 rows, each measuring its own blocks.
 * So the section is collapsed by default AND paged when opened; the two are not
 * alternatives.
 */
export const SEGMENT_PAGE_SIZE = 20;

export interface SegmentPage {
  visible: ConversationSegment[];
  /** How many more exist past `visible`; 0 when everything is shown. */
  hiddenCount: number;
}

/** `showAll` bypasses the cap — the user asked for the whole list explicitly. */
export function deriveSegmentPage(
  segments: readonly ConversationSegment[],
  showAll: boolean,
  limit: number = SEGMENT_PAGE_SIZE
): SegmentPage {
  if (showAll || segments.length <= limit) {
    return { visible: [...segments], hiddenCount: 0 };
  }
  return { visible: segments.slice(0, limit), hiddenCount: segments.length - limit };
}

export interface CompositionArc {
  role: ConversationRole;
  share: number;
  /** `stroke-dasharray` length on a circle whose circumference is normalized to 100. */
  dash: number;
  /** `stroke-dashoffset`; negative, as SVG walks the dash pattern backwards. */
  offset: number;
}

/**
 * U16: the donut's arcs, in one pass so the segments cannot leave a gap.
 *
 * The circle is drawn with `pathLength=100`, which lets every arc be expressed
 * as a plain percentage — no 2πr arithmetic, and no rounding drift between the
 * ring and the legend beside it, which read the same `share` value.
 *
 * Arcs are laid end to end from the accumulated share rather than from each
 * arc's index, so a role contributing 0 characters occupies no ring and shifts
 * nothing after it.
 */
export function deriveCompositionArcs(roles: readonly ConversationRoleShare[]): CompositionArc[] {
  const arcs: CompositionArc[] = [];
  let consumed = 0;
  for (const role of roles) {
    const dash = Math.max(0, role.share * 100);
    arcs.push({ role: role.role, share: role.share, dash, offset: -consumed });
    consumed += dash;
  }
  return arcs;
}

/** Compact size label — `840` / `12.3k` / `1.2M` characters. */
export function formatCharCount(chars: number): string {
  if (chars < 1000) return String(chars);
  if (chars < 1_000_000) return `${(chars / 1000).toFixed(1)}k`;
  return `${(chars / 1_000_000).toFixed(1)}M`;
}

/** Whole-percent share, floored — `0%` is a real answer for a tiny slice. */
export function formatShare(share: number): string {
  return `${Math.floor(share * 100)}%`;
}
