/**
 * Protocol-boundary readers for the pi Host's commands.
 *
 * Split out of `piHost.ts` because that file cannot be imported without an
 * Electron `parentPort` — and these three decisions are exactly the ones worth
 * a test. Each of them exists to replace a SILENT behaviour with a loud one:
 *
 *  - `effort` was accepted and never applied.
 *  - `attachments` were accepted and dropped whenever text was present.
 *  - `permissionPreference` was accepted for a backend whose posture it cannot
 *    describe.
 *
 * Accepting a field and ignoring it is the failure mode all three share: the
 * caller is told the request landed, and nothing anywhere says it did not.
 */

import type { SessionAttachment, SessionEffortLevel } from '../shared/types/agentHost.ts';
import { isSessionEffortLevel } from '../shared/types/agentHost.ts';

export const PERMISSION_PREFERENCE_UNSUPPORTED =
  'The pi backend does not accept permissionPreference: its posture is owned by the ' +
  '@gotgenes/pi-permission-system rule files, not by this command. See host.ready ' +
  'capabilities.permissionPolicy === false.';

export type EffortRead = { ok: true; effort?: SessionEffortLevel } | { ok: false };

/**
 * `effort` off untrusted JSON. A value outside the five-word vocabulary is
 * REFUSED rather than dropped: silently ignoring it is how "the Host accepted my
 * effort and did nothing with it" happened in the first place.
 */
export function readEffort(value: unknown): EffortRead {
  if (value === undefined) return { ok: true };
  if (!isSessionEffortLevel(value)) return { ok: false };
  return { ok: true, effort: value };
}

export type AttachmentRead =
  | { ok: true; attachments?: SessionAttachment[] }
  | { ok: false; reason: string };

/**
 * Attachments off untrusted JSON.
 *
 * `undefined` means "none"; an array with an entry this Host cannot describe is
 * an error, because the alternative is a send that quietly leaves the user's
 * file out of the message it was attached to.
 */
export function readAttachments(value: unknown): AttachmentRead {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, reason: 'attachments must be an array' };
  const attachments: SessionAttachment[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, reason: 'each attachment must be an object' };
    }
    const raw = entry as Record<string, unknown>;
    if (raw.kind !== 'image' && raw.kind !== 'text') {
      return { ok: false, reason: `unsupported attachment kind: ${String(raw.kind)}` };
    }
    if (typeof raw.data !== 'string' || !raw.data) {
      return { ok: false, reason: 'each attachment needs non-empty string data' };
    }
    attachments.push({
      kind: raw.kind,
      mediaType: typeof raw.mediaType === 'string' ? raw.mediaType : '',
      data: raw.data,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    });
  }
  return { ok: true, attachments };
}

/**
 * `permissionPreference` is a CLAUDE/CODEX vocabulary (see
 * `SessionPermissionPreference` — the union has no pi arm), and pi's posture is
 * owned by `@gotgenes/pi-permission-system`'s own rule files, which this Host
 * does not write. Accepting the field and ignoring it would report a posture
 * nobody applied, so a pi session refuses it outright and says why.
 */
export function rejectsPermissionPreference(payload: Record<string, unknown> | undefined): boolean {
  return payload?.permissionPreference !== undefined;
}

/**
 * Is there anything to send?
 *
 * Text MAY be empty when attachments carry the message — that is the protocol
 * ("May be empty when attachments are present"), and requiring text rejected
 * every attachment-only send.
 */
export function hasSendableContent(text: string, attachments: SessionAttachment[] | undefined) {
  return Boolean(text) || (attachments?.length ?? 0) > 0;
}
