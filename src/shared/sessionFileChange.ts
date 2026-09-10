import { z } from 'zod';

export const REVIEW_PATCH_BYTES = 64 * 1024;

const schema = z.object({
  version: z.literal(1),
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'unknown']),
  patch: z.string().max(REVIEW_PATCH_BYTES).optional(),
  unavailable: z.enum(['too-large', 'binary', 'unreadable']).optional(),
});

export type SessionFileChange = z.infer<typeof schema>;

export function parseSessionFileChange(value: unknown): SessionFileChange | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function reviewFromToolResult(value: unknown): SessionFileChange | undefined {
  if (!value || typeof value !== 'object' || !('details' in value)) return undefined;
  const details = value.details;
  return details && typeof details === 'object' && 'review' in details
    ? parseSessionFileChange(details.review)
    : undefined;
}
