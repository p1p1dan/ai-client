/**
 * Record parser for `git status --porcelain=v2 --branch -z`, shared by the
 * streaming reader in `GitService` and the node-runner fallback that receives
 * the same output in one piece. Pure (no I/O, no imports of `./runtime`), so it
 * is unit-testable without loading node-pty.
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
export class PorcelainV2StatusAccumulator {
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

/**
 * Parse a complete `git status --porcelain=v2 --branch -z` stdout. Like the
 * streaming reader, an unterminated trailing fragment is not a record.
 */
export function parsePorcelainV2Status(
  stdout: string,
  maxEntries: number
): { status: PorcelainV2Status; sawBranchHeader: boolean; entries: number } {
  const accumulator = new PorcelainV2StatusAccumulator(maxEntries);
  const records = stdout.split('\0');
  records.pop();
  for (const record of records) {
    accumulator.push(record);
    if (accumulator.truncated) break;
  }
  return {
    status: accumulator.result(),
    sawBranchHeader: accumulator.sawBranchHeader,
    entries: accumulator.entries,
  };
}
