export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
  ignored?: boolean;
}

export interface FileChangeEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
}

export interface FileReadResult {
  content: string;
  encoding: string;
  detectedEncoding: string;
  confidence: number;
  isBinary?: boolean;
  /** Refused before allocating the full file buffer. */
  tooLarge?: boolean;
  byteLength?: number;
  maxPreviewBytes?: number;
}

/**
 * T5 — outcome of `file:openWithSystemViewer`.
 *
 * `rejected` means Main refused before touching the OS (not a previewable
 * existing file); `failed` means the OS was asked and said no. `error` is
 * diagnostic text only, never shown as-is.
 */
export type SystemViewerOpenResult =
  | { ok: true }
  | { ok: false; reason: 'rejected' | 'failed'; error?: string };
