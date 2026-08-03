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
import {
  type PickedBatchOutcome,
  readPickedBatch,
  toArrayBuffer,
  unreadableMessage,
  unsupportedKindMessage,
} from './pickedAttachments';

/** Clipboard bitmaps often arrive without a usable file name. */
const UNNAMED_PASTE = 'Pasted image';

/**
 * D4: the structural minimum `ingestFiles` needs.
 *
 * A DOM `File` satisfies this by construction, so the paste path is unchanged
 * — the widening exists so bytes that arrived over IPC (a picked path) can
 * enter the SAME pipeline instead of a parallel one. Everything downstream of
 * this interface (budgets, image-header parse, base64, the folded notice) is
 * therefore shared by both entry points rather than reimplemented for one.
 */
export interface AttachmentSource {
  name: string;
  /** Media type, or '' when unknown — `detectAttachmentKind` falls back to the name. */
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

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
  /**
   * D4: ingest files the user picked in the native dialog (⊕ → Attach files).
   * Same pipeline, same budgets and same notice as a paste — only the bytes
   * arrive over IPC instead of off the clipboard.
   */
  ingestPickedPaths: (paths: readonly string[]) => Promise<void>;
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
  /**
   * F4 (round-4 Codex NEEDS-FIX #3): synchronous read of the CURRENT draft
   * count off `draftsRef` (the same live ref `applyDrafts` already keeps in
   * sync on every mutation), not the `drafts` state array — which lags a
   * render behind an in-flight paste/removal. Exists so a caller holding a
   * stale render closure (e.g. `ChatComposer`'s committed-outcome
   * draft-restore, which can fire long after the render that captured it)
   * can check "is the composer currently empty" without needing its own
   * separate, effect-synced mirror ref (the exact staleness class that used
   * to cause it to either clobber a new draft or skip a restore it owed).
   */
  getLiveDraftCount: () => number;
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
    /**
     * @param preSkipped D4: reasons produced BEFORE the bytes existed (a
     * picked path that could never be read). They join this batch's own skips
     * so the user still gets ONE folded notice for one gesture, rather than a
     * second Alert replacing the first.
     */
    async (files: AttachmentSource[], preSkipped: readonly string[] = []) => {
      setReading((count) => count + files.length);
      const skipped: string[] = [...preSkipped];
      try {
        for (const file of files) {
          const label = file.name || UNNAMED_PASTE;
          const detected = detectAttachmentKind(file.name, file.type);
          if (!detected) {
            skipped.push(unsupportedKindMessage(label));
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
            skipped.push(unreadableMessage(label));
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
        // In `finally` (round-5 C2), not after the block: the notice is the
        // only report this batch ever makes, so an unexpected throw halfway
        // through must still publish the skips collected so far instead of
        // leaving the user with a gesture that silently produced nothing.
        // null on a clean paste, which also clears the previous notice.
        setNotice(formatSkipNotice(skipped));
      }
    },
    [applyDrafts]
  );

  /**
   * D4: the ⊕ menu's entry point — paths the user just picked in the native
   * dialog, read one at a time through `file:readAttachment`.
   *
   * The loop itself lives in `readPickedBatch` (pure, with the read injected),
   * which is where the serial ordering, the pre-read count budget and the
   * per-file failure isolation are specified and tested. What is left here is
   * the two things only a hook can do:
   *
   *  - **`reading` covers the IPC leg.** Send is gated on `reading > 0`, so the
   *    counter goes up before the first `invoke` and only comes down as the
   *    bytes are handed to `ingestFiles`, which immediately re-raises it for
   *    its own encode leg — the count never dips to zero mid-gesture, which is
   *    what would let a half-read batch be sent.
   *  - **The live draft count.** Passed as a getter, not a number, so the
   *    budget sees drafts that landed (a paste, a removal) while the batch was
   *    still reading rather than the count at the moment the dialog closed.
   *
   * No budgets and no sentences are decided here; everything that survives the
   * read is wrapped as an `AttachmentSource` and goes through the exact same
   * `ingestFiles` the clipboard uses.
   */
  const ingestPickedPaths = useCallback(
    async (paths: readonly string[]) => {
      // Same gate as `handlePaste`: the menu is already disabled in this state,
      // but the native dialog can outlive the state that opened it.
      if (options.disabled) return;
      // Cancelling the dialog must be a no-op — no notice, no state change.
      if (paths.length === 0) return;

      setReading((count) => count + paths.length);
      let outcome: PickedBatchOutcome = { reads: [], skipped: [] };

      try {
        outcome = await readPickedBatch({
          paths,
          liveCount: () => draftsRef.current.length,
          read: (filePath, maxBytes) =>
            window.electronAPI.file.readAttachment(filePath, { maxBytes }),
        });
      } catch (error) {
        // Round-5 C2: `readPickedBatch` isolates every per-file failure, so
        // reaching here means something unforeseen broke. The handover below
        // still runs — it is what turns this gesture into the one folded
        // notice it owes the user, and swallowing it would leave the ⊕ menu
        // looking like it did nothing at all.
        console.error('[attachments] picked-path read aborted', error);
      } finally {
        // Handed over to `ingestFiles` below in the same synchronous run, so
        // the two updates batch and `reading` never renders a false 0.
        setReading((count) => Math.max(0, count - paths.length));
      }

      const sources: AttachmentSource[] = outcome.reads.map((read) => ({
        name: read.name,
        type: read.mediaType,
        size: read.byteLength,
        arrayBuffer: async () => toArrayBuffer(read.bytes),
      }));
      await ingestFiles(sources, outcome.skipped);
    },
    [ingestFiles, options.disabled]
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

  const getLiveDraftCount = useCallback(() => draftsRef.current.length, []);

  const totalBytes = useMemo(() => totalAttachmentBytes(drafts), [drafts]);

  return {
    drafts,
    notice,
    reading,
    totalBytes,
    handlePaste,
    ingestPickedPaths,
    removeDraft,
    removeDrafts,
    addDrafts,
    clearDrafts,
    dismissNotice,
    getLiveDraftCount,
  };
}
