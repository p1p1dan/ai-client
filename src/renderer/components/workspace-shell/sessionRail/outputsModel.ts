/**
 * Decision 209 §2: the session rail's Outputs card — the documents this
 * conversation's file-writing tools CREATED (`SessionFileChange.status ===
 * 'added'`; DSH's `write` and the Claude engine's `Write` both mark it), kept
 * to the document-like kinds below. Code, configuration and every other
 * extension stay out, as do files a tool only changed (the Changes card's) and
 * files a shell command wrote (nothing says they are new).
 *
 * Derived from the conversation's history alone, so a reopened conversation
 * shows them too and the 「会话改动」 setting has no say. Pure: node tests
 * assert every rule.
 */
import type { SessionReviewEntry } from '../sessionReview';

export type OutputKind = 'document' | 'web' | 'image' | 'sheet' | 'slides';

const KIND_BY_EXTENSION: Readonly<Record<string, OutputKind>> = {
  md: 'document',
  markdown: 'document',
  txt: 'document',
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  rtf: 'document',
  html: 'web',
  htm: 'web',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  csv: 'sheet',
  tsv: 'sheet',
  xls: 'sheet',
  xlsx: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
};

export interface OutputRow {
  /** The path as the tool recorded it (stable across renders). */
  key: string;
  path: string;
  /** The file's name, the row's text. */
  name: string;
  kind: OutputKind;
}

/** The last path segment, either separator. */
export function outputName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Which kind of output a path is, by extension (any case); null = not one. */
export function outputKindOf(path: string): OutputKind | null {
  const name = outputName(path);
  const dot = name.lastIndexOf('.');
  // `.md` alone is a dotfile, not a document called "".
  if (dot <= 0 || dot === name.length - 1) return null;
  return KIND_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Newest first. A path created more than once is listed once, at its last
 * creation. `entries` are the session review's, in conversation order.
 */
export function deriveSessionOutputs(entries: readonly SessionReviewEntry[]): OutputRow[] {
  const rows: OutputRow[] = [];
  const seen = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.status !== 'added' || seen.has(entry.path)) continue;
    const kind = outputKindOf(entry.path);
    if (!kind) continue;
    seen.add(entry.path);
    rows.push({ key: entry.path, path: entry.path, name: outputName(entry.path), kind });
  }
  return rows;
}
