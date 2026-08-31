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
