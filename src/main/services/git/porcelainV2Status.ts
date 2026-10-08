import type { FileChange, FileChangeStatus, FileChangesResult } from '@shared/types';

/**
 * Record parsers for `git status --porcelain=v2 --branch -z`, shared by the
 * streaming reader in `GitService` and the node-runner fallback that receives
 * the same output in one piece. Two consumers read the same records:
 * `PorcelainV2StatusAccumulator` (`getStatus`) and
 * `PorcelainV2FileChangesAccumulator` (`getFileChanges`). Pure (no I/O, no
 * imports of `./runtime`), so it is unit-testable without loading node-pty.
 *
 * With `-z` every record ends in NUL and paths are emitted verbatim: no
 * C-quoting, no octal escapes, spaces kept. The path is therefore everything
 * after a fixed number of space-separated fields, never "the last word":
 * - `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`              -> after 8 fields
 * - `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`   -> after 9 fields,
 *   followed by a separate NUL record holding the original path
 * - `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`    -> after 10 fields
 * - `? <path>` / `! <path>`
 */

export type PorcelainBranchInfo = {
  current: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
};

export type PorcelainV2Status = PorcelainBranchInfo & {
  staged: string[];
  modified: string[];
  deleted: string[];
  untracked: string[];
  conflicted: string[];
  truncated: boolean;
};

/** Text after the `fieldCount`-th space, or '' when the record is shorter. */
function pathAfterFields(record: string, fieldCount: number): string {
  let index = -1;
  for (let i = 0; i < fieldCount; i++) {
    index = record.indexOf(' ', index + 1);
    if (index < 0) return '';
  }
  return record.slice(index + 1);
}

/**
 * Accumulates NUL-separated records one at a time. Truncation semantics match
 * the original streaming reader: once `maxEntries` entries have been counted
 * `truncated` is set and every later record is ignored, so a streaming caller
 * can stop the process as soon as `truncated` flips.
 */
export class PorcelainV2StatusAccumulator implements PorcelainV2RecordSink {
  truncated = false;
  sawBranchHeader = false;
  entries = 0;

  private readonly branch: PorcelainBranchInfo = {
    current: null,
    tracking: null,
    ahead: 0,
    behind: 0,
  };
  private readonly staged: string[] = [];
  private readonly modified: string[] = [];
  private readonly deleted: string[] = [];
  private readonly untracked: string[] = [];
  private readonly conflicted: string[] = [];
  // The record after a type-2 entry is its original path, not a new entry.
  private skipOriginalPath = false;

  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  push(record: string): void {
    if (!record || this.truncated) return;

    if (this.skipOriginalPath) {
      this.skipOriginalPath = false;
      return;
    }

    if (record.startsWith('# ')) {
      this.readHeader(record);
      return;
    }

    if (this.entries >= this.maxEntries) {
      this.truncated = true;
      return;
    }

    const type = record[0];
    if (type === '?') {
      const p = pathAfterFields(record, 1);
      if (p) this.count(() => this.untracked.push(p));
      return;
    }
    if (type !== '1' && type !== '2' && type !== 'u') {
      // `! <path>` (ignored) and anything unknown.
      return;
    }

    const xy = record.slice(2, 4);
    const p = pathAfterFields(record, type === '1' ? 8 : type === '2' ? 9 : 10);
    if (type === '2') this.skipOriginalPath = true;
    if (!p) return;

    this.count(() => {
      if (type === 'u') {
        // Every unmerged pair (UU, AA, DD, AU, UA, DU, UD) is a conflict and
        // nothing else; its X/Y letters describe the two sides, not the index.
        this.conflicted.push(p);
        return;
      }
      const x = xy[0] ?? '.';
      const y = xy[1] ?? '.';
      if (x !== '.') this.staged.push(p);
      if (y === 'D') this.deleted.push(p);
      else if (y !== '.') this.modified.push(p);
    });
  }

  result(): PorcelainV2Status {
    return {
      ...this.branch,
      staged: this.staged,
      modified: this.modified,
      deleted: this.deleted,
      untracked: this.untracked,
      conflicted: this.conflicted,
      truncated: this.truncated,
    };
  }

  private count(file: () => void): void {
    file();
    this.entries++;
    if (this.entries >= this.maxEntries) this.truncated = true;
  }

  private readHeader(record: string): void {
    const parts = record.split(' ');
    const key = parts[1];
    if (key?.startsWith('branch.')) this.sawBranchHeader = true;
    if (key === 'branch.head') {
      const head = parts.slice(2).join(' ');
      this.branch.current = head === '(detached)' ? null : head || null;
    } else if (key === 'branch.upstream') {
      this.branch.tracking = parts.slice(2).join(' ') || null;
    } else if (key === 'branch.ab') {
      const aheadToken = parts[2] || '+0';
      const behindToken = parts[3] || '-0';
      this.branch.ahead = Number.parseInt(aheadToken.replace(/^\+/, ''), 10) || 0;
      this.branch.behind = Number.parseInt(behindToken.replace(/^-/, ''), 10) || 0;
    }
  }
}

/** What the streaming reader and the fallback both feed records into. */
export interface PorcelainV2RecordSink {
  push(record: string): void;
  readonly truncated: boolean;
  readonly sawBranchHeader: boolean;
}

/**
 * Feed a complete stdout into `sink`. Like the streaming reader, an
 * unterminated trailing fragment is not a record.
 */
export function feedPorcelainV2Records(stdout: string, sink: PorcelainV2RecordSink): void {
  const records = stdout.split('\0');
  records.pop();
  for (const record of records) {
    sink.push(record);
    if (sink.truncated) break;
  }
}

/**
 * Parse a complete `git status --porcelain=v2 --branch -z` stdout. Like the
 * streaming reader, an unterminated trailing fragment is not a record.
 */
export function parsePorcelainV2Status(
  stdout: string,
  maxEntries: number
): { status: PorcelainV2Status; sawBranchHeader: boolean; entries: number } {
  const accumulator = new PorcelainV2StatusAccumulator(maxEntries);
  feedPorcelainV2Records(stdout, accumulator);
  return {
    status: accumulator.result(),
    sawBranchHeader: accumulator.sawBranchHeader,
    entries: accumulator.entries,
  };
}

/** Top-level directories the changes list never descends into. */
const SKIPPED_CHANGE_PREFIXES = ['node_modules/', '.pnpm/', 'dist/', 'out/', '.next/', 'build/'];

function indexChangeStatus(x: string): FileChangeStatus {
  if (x === 'A' || x === 'D' || x === 'R' || x === 'C') return x;
  if (x === 'U') return 'X';
  return 'M';
}

function workingChangeStatus(y: string): FileChangeStatus {
  if (y === 'D') return 'D';
  if (y === 'U') return 'X';
  return 'M';
}

/**
 * The `getFileChanges` view of the same records: one `FileChange` per side
 * (index / working tree) that changed, untracked entries as `U`, files under
 * `SKIPPED_CHANGE_PREFIXES` dropped and reported in `skippedDirs`.
 *
 * Paths are taken by field count, exactly like the status accumulator, so a
 * path with spaces stays whole; a rename is recorded under its NEW path with
 * the old one in `originalPath` (`2 ... <path>` then `<origPath>`). The
 * previous inline parser took "the last word" and had the two rename paths
 * the other way round.
 *
 * Cap semantics: at most `maxChanges` entries are kept; `truncated` means a
 * record was dropped because the cap was already reached.
 */
export class PorcelainV2FileChangesAccumulator implements PorcelainV2RecordSink {
  truncated = false;
  sawBranchHeader = false;

  private readonly changes: FileChange[] = [];
  private readonly skippedDirs = new Set<string>();
  // A type-2 record waits for the next record, which is its original path.
  private pendingRename: { xy: string; path: string } | null = null;

  private readonly maxChanges: number;

  constructor(maxChanges: number) {
    this.maxChanges = maxChanges;
  }

  push(record: string): void {
    if (!record || this.truncated) return;

    // Before the header check: an original path may itself start with "# ".
    if (this.pendingRename) {
      const { xy, path } = this.pendingRename;
      this.pendingRename = null;
      if (path) this.addEntry(xy, path, record);
      return;
    }

    if (record.startsWith('# ')) {
      if (record.startsWith('# branch.')) this.sawBranchHeader = true;
      return;
    }

    const type = record[0];
    if (type !== '?' && type !== '1' && type !== '2' && type !== 'u') {
      // `! <path>` (ignored) and anything unknown.
      return;
    }

    if (this.changes.length >= this.maxChanges) {
      this.truncated = true;
      return;
    }

    if (type === '?') {
      const p = pathAfterFields(record, 1);
      if (p && !this.skip(p)) this.add({ path: p, status: 'U', staged: false });
      return;
    }

    const xy = record.slice(2, 4);
    const p = pathAfterFields(record, type === '1' ? 8 : type === '2' ? 9 : 10);
    if (type === '2') {
      this.pendingRename = { xy, path: p };
      return;
    }
    if (p) this.addEntry(xy, p);
  }

  result(): FileChangesResult {
    return {
      changes: this.changes,
      skippedDirs: this.skippedDirs.size > 0 ? Array.from(this.skippedDirs) : undefined,
      truncated: this.truncated,
      truncatedLimit: this.truncated ? this.maxChanges : undefined,
    };
  }

  private addEntry(xy: string, path: string, originalPath?: string): void {
    if (this.skip(path)) return;
    const x = xy[0] ?? '.';
    const y = xy[1] ?? '.';
    if (x !== '.' && x !== '?' && x !== '!') {
      const change: FileChange = { path, status: indexChangeStatus(x), staged: true };
      if (originalPath) change.originalPath = originalPath;
      this.add(change);
    }
    if (y !== '.' && y !== ' ') {
      this.add({ path, status: workingChangeStatus(y), staged: false });
    }
  }

  private add(change: FileChange): void {
    if (this.changes.length >= this.maxChanges) {
      this.truncated = true;
      return;
    }
    this.changes.push(change);
  }

  private skip(p: string): boolean {
    for (const prefix of SKIPPED_CHANGE_PREFIXES) {
      if (p.startsWith(prefix)) {
        this.skippedDirs.add(prefix.slice(0, -1));
        return true;
      }
    }
    return false;
  }
}
