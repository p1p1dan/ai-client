// 文件名搜索参数
export interface FileSearchParams {
  rootPath: string;
  query: string;
  maxResults?: number;
  useGitignore?: boolean; // 是否跳过 .gitignore 中的文件，默认 true
}

// 内容搜索参数
export interface ContentSearchParams {
  rootPath: string;
  query: string;
  maxResults?: number;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  filePattern?: string; // glob pattern, e.g. "*.ts"
  useGitignore?: boolean; // 是否跳过 .gitignore 中的文件，默认 true
}

// 文件名搜索结果
export interface FileSearchResult {
  path: string;
  name: string;
  relativePath: string;
  score: number;
  /**
   * True for derived directory entries (T-07①). `rg --files` lists files only,
   * so directories are reconstructed from file paths — `@src/renderer` is a
   * valid reference because CC reads the whole subtree. Absent/false = file.
   */
  isDirectory?: boolean;
}

/**
 * `searchFiles` result page (T-07③). Searching `chat` in this repo matched 304
 * files while the popup rendered 10 and gave no hint the rest existed, so the
 * pre-truncation count now rides along with the page.
 *
 * This is an explicit wrapper rather than extra properties on the array: only
 * own *enumerable* properties survive structured clone across the IPC bridge,
 * and relying on that for a bolted-on `total` is a silent-data-loss trap. A
 * named field is checked by `tsc` at every consumer instead.
 */
export interface FileSearchPage {
  items: FileSearchResult[];
  /** Match count before `maxResults` truncation. */
  total: number;
  truncated: boolean;
}

// 内容搜索匹配项
export interface ContentSearchMatch {
  path: string;
  relativePath: string;
  line: number;
  column: number; // 0-based column position
  matchLength: number; // length of matched text
  content: string;
  beforeContext?: string[];
  afterContext?: string[];
}

// 内容搜索结果
export interface ContentSearchResult {
  matches: ContentSearchMatch[];
  totalMatches: number;
  totalFiles: number;
  truncated: boolean;
}
