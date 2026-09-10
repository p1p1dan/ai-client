import { reviewFromToolResult, type SessionFileChange } from '@shared/sessionFileChange';
import { pairToolBlocks } from '@/components/chat/toolCard';
import { deriveToolDiff, type ToolDiff } from '@/components/chat/toolDiff';
import type { ChatMessage } from '@/stores/chatSessions';

export interface SessionReviewEntry {
  id: string;
  path: string;
  status: SessionFileChange['status'];
  patch?: string;
  unavailable?: SessionFileChange['unavailable'];
  preview?: ToolDiff;
  added: number;
  removed: number;
}

// Keyed by message identity: streaming deltas replace only the message they
// touch, so every other message reuses its entry objects.
const messageEntries = new WeakMap<ChatMessage, SessionReviewEntry[]>();

export function deriveSessionReview(messages: readonly ChatMessage[]): SessionReviewEntry[] {
  const entries: SessionReviewEntry[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    let derived = messageEntries.get(message);
    if (!derived) {
      derived = deriveMessageReview(message);
      messageEntries.set(message, derived);
    }
    for (const entry of derived) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  return entries;
}

function deriveMessageReview(message: ChatMessage): SessionReviewEntry[] {
  const entries: SessionReviewEntry[] = [];
  const seen = new Set<string>();
  for (const run of pairToolBlocks(message.blocks)) {
    const id = `${message.id}:${run.toolCallId}`;
    if (run.status !== 'ok' || seen.has(id)) continue;
    if (!['edit', 'write', 'Edit', 'Write', 'MultiEdit'].includes(run.toolName)) continue;
    seen.add(id);
    const review = reviewFromToolResult(run.result);
    if (review) {
      const patchLines = review.patch?.split('\n') ?? [];
      entries.push({
        id,
        ...review,
        added: patchLines.filter((line) => line.startsWith('+')).length,
        removed: patchLines.filter((line) => line.startsWith('-')).length,
      });
    } else {
      const preview = deriveToolDiff(run);
      if (!preview?.path) continue;
      entries.push({
        id,
        path: preview.path,
        status: 'unknown',
        preview,
        added: preview.added,
        removed: preview.removed,
      });
    }
  }
  return entries;
}
