/**
 * T-18 Composer attachments — the IO half (clipboard, File reads, state).
 *
 * Every decision lives in the pure modules next door; this hook only moves
 * bytes. One rule is absolute and must survive future edits:
 *
 *   the paste handler NEVER writes the textarea value and NEVER calls
 *   setSelectionRange — doing so shatters the IME composition buffer and
 *   breaks plain-text paste, the single most used path in the Composer.
 */
import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { admitAttachment, planImageAttachment } from './attachmentLimits';
import {
  type AttachmentDraft,
  type AttachmentNotice,
  bytesToBase64,
  decodeTextBytes,
  detectAttachmentKind,
  formatSkipNotice,
  isProbablyBinary,
  totalAttachmentBytes,
} from './attachments';
import { planPaste } from './clipboardAttachments';
import { readImageDimensions } from './imageDimensions';

/** Clipboard bitmaps often arrive without a usable file name. */
const UNNAMED_PASTE = 'Pasted image';

let draftSeq = 0;

function nextDraftId(): string {
  draftSeq += 1;
  return `att-${Date.now().toString(36)}-${draftSeq}`;
}

export interface ComposerAttachments {
  drafts: AttachmentDraft[];
  notice: AttachmentNotice | null;
  /** Files currently being read/encoded — Send stays disabled while > 0. */
  reading: number;
  totalBytes: number;
  handlePaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  removeDraft: (id: string) => void;
  /** T-19: bulk remove by id — the commit-point consumption hook uses this to
   *  drop exactly the drafts a turn just carried off (see ChatComposer's
   *  `runSend`). A no-op id (already gone, e.g. a queued/retried snapshot)
   *  is silently ignored rather than treated as an error. */
  removeDrafts: (ids: readonly string[]) => void;
  /** T-19: bulk add — feeds the chip "edit"/swap affordance (batch 3), which
   *  hands a queued entry's attachments back into the live draft list. */
  addDrafts: (drafts: readonly AttachmentDraft[]) => void;
  clearDrafts: () => void;
  dismissNotice: () => void;
}

export function useComposerAttachments(options: { disabled: boolean }): ComposerAttachments {
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const [notice, setNotice] = useState<AttachmentNotice | null>(null);
  const [reading, setReading] = useState(0);
  // Admission is decided against the live list, not the render closure: a
  // second paste can land while the first one is still being read.
  const draftsRef = useRef<AttachmentDraft[]>([]);

  const applyDrafts = useCallback((update: (prev: AttachmentDraft[]) => AttachmentDraft[]) => {
    const next = update(draftsRef.current);
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  const ingestFiles = useCallback(
    async (files: File[]) => {
      setReading((count) => count + files.length);
      const skipped: string[] = [];
      try {
        for (const file of files) {
          const label = file.name || UNNAMED_PASTE;
          const detected = detectAttachmentKind(file.name, file.type);
          if (!detected) {
            skipped.push(`"${label}" is not an image or text file — skipped.`);
            continue;
          }

          // Cheap pre-check on the size the File already knows. The budget
          // exists to protect the renderer, so it must fire BEFORE a 200 MB
          // paste is materialised into an ArrayBuffer, not after.
          const preVerdict = admitAttachment(draftsRef.current, {
            name: label,
            byteLength: file.size,
            kind: detected.kind,
          });
          if (!preVerdict.ok) {
            skipped.push(preVerdict.message);
            continue;
          }

          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(await file.arrayBuffer());
          } catch {
            skipped.push(`Could not read "${label}" — skipped.`);
            continue;
          }

          if (detected.kind === 'image') {
            // Header parse, never a decode: an oversized bitmap must be
            // rejected without ever allocating the surface it describes.
            const size = readImageDimensions(bytes);
            const plan = planImageAttachment({
              name: label,
              mediaType: detected.mediaType,
              ...(size ?? {}),
            });
            if (plan.action === 'reject') {
              skipped.push(plan.message);
              continue;
            }
          }

          // Authoritative check, now against the bytes actually read.
          const verdict = admitAttachment(draftsRef.current, {
            name: label,
            byteLength: bytes.length,
            kind: detected.kind,
          });
          if (!verdict.ok) {
            skipped.push(verdict.message);
            continue;
          }

          let data: string;
          if (detected.kind === 'image') {
            data = bytesToBase64(bytes);
          } else {
            const text = decodeTextBytes(bytes);
            if (isProbablyBinary(text)) {
              skipped.push(`"${label}" looks like binary data — skipped.`);
              continue;
            }
            if (text.trim().length === 0) {
              skipped.push(`"${label}" is empty — skipped.`);
              continue;
            }
            data = text;
          }
          // Belt and braces: the Host drops the WHOLE send on an empty data
          // field, so nothing empty may ever reach the draft list.
          if (data.length === 0) {
            skipped.push(`"${label}" is empty — skipped.`);
            continue;
          }

          applyDrafts((prev) => [
            ...prev,
            {
              id: nextDraftId(),
              kind: detected.kind,
              mediaType: detected.mediaType,
              name: label,
              byteLength: bytes.length,
              data,
            },
          ]);
        }
      } finally {
        setReading((count) => Math.max(0, count - files.length));
      }
      // null on a clean paste, which also clears the previous notice.
      setNotice(formatSkipNotice(skipped));
    },
    [applyDrafts]
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (options.disabled) return;
      const transfer = event.clipboardData;
      if (!transfer) return;

      const plainText = transfer.getData('text/plain');
      const items = Array.from(transfer.items ?? []);
      const plan = planPaste(
        items.map((item) => ({ kind: item.kind, type: item.type })),
        plainText
      );

      let files: File[] = [];
      for (const index of plan.fileIndices) {
        const file = items[index]?.getAsFile();
        if (file) files.push(file);
      }
      let intercept = plan.preventDefault;

      // Fallback, never a merge: in Chromium `items` and `files` expose the
      // same File objects, so taking the union would count everything twice.
      // It has to sit outside the "no file descriptors" early return, because
      // the case it covers is precisely a DataTransfer that exposes `files`
      // while `items` advertises nothing usable.
      if (files.length === 0) {
        const fallback = Array.from(transfer.files ?? []);
        if (fallback.length > 0) {
          files = fallback;
          intercept = planPaste(
            fallback.map((file) => ({ kind: 'file', type: file.type })),
            plainText
          ).preventDefault;
        }
      }
      if (files.length === 0) return;

      if (intercept) event.preventDefault();
      void ingestFiles(files);
    },
    [ingestFiles, options.disabled]
  );

  const removeDraft = useCallback(
    (id: string) => {
      applyDrafts((prev) => prev.filter((draft) => draft.id !== id));
    },
    [applyDrafts]
  );

  const clearDrafts = useCallback(() => {
    // Guarded so callers can fire it unconditionally (session switch, send
    // success) without forcing a render for an already empty list.
    if (draftsRef.current.length === 0) return;
    applyDrafts(() => []);
  }, [applyDrafts]);

  const removeDrafts = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      // Same no-op guard as clearDrafts: a caller may pass ids that are no
      // longer live (e.g. a Retry snapshot already consumed at commit time)
      // without forcing an extra render.
      if (!draftsRef.current.some((draft) => idSet.has(draft.id))) return;
      applyDrafts((prev) => prev.filter((draft) => !idSet.has(draft.id)));
    },
    [applyDrafts]
  );

  const addDrafts = useCallback(
    (newDrafts: readonly AttachmentDraft[]) => {
      if (newDrafts.length === 0) return;
      applyDrafts((prev) => [...prev, ...newDrafts]);
    },
    [applyDrafts]
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  const totalBytes = useMemo(() => totalAttachmentBytes(drafts), [drafts]);

  return {
    drafts,
    notice,
    reading,
    totalBytes,
    handlePaste,
    removeDraft,
    removeDrafts,
    addDrafts,
    clearDrafts,
    dismissNotice,
  };
}
