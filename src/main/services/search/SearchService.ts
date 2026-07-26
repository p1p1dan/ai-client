import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, join, relative } from 'node:path';
import type {
  ContentSearchMatch,
  ContentSearchParams,
  ContentSearchResult,
  FileSearchPage,
  FileSearchParams,
  FileSearchResult,
} from '@shared/types';

// @vscode/ripgrep is CJS; ESM linker cannot resolve named exports from CJS inside ASAR
const { rgPath: originalRgPath } = createRequire(import.meta.url)('@vscode/ripgrep') as {
  rgPath: string;
};

import { killProcessTree } from '../../utils/processUtils';

const MAX_FILE_RESULTS = 100;
const MAX_CONTENT_RESULTS = 500;
const SEARCH_TIMEOUT_MS = 10000;

// 统一的排除规则
const EXCLUDE_GLOBS = [
  '!node_modules/**',
  '!dist/**',
  '!build/**',
  '!.git/**',
  '!*.lock',
  '!package-lock.json',
];

const rgPath = originalRgPath.replace(/\.asar([\\/])/, '.asar.unpacked$1');

/**
 * Relative path with POSIX separators, regardless of host platform.
 *
 * `path.relative` yields backslashes on win32, which breaks three consumers at
 * once: fuzzy queries containing `/` never match the target string, the `@`
 * mention popup's `lastIndexOf('/')` returns -1 so the directory suffix never
 * renders, and the inserted `@path` mention carries backslashes downstream.
 */
export function toPosixRelative(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath).replace(/\\/g, '/');
}

/** Raw entry (file or derived directory) before fuzzy scoring. */
export interface SearchFileEntry {
  path: string;
  name: string;
  relativePath: string;
  isDirectory: boolean;
}

/**
 * T-07①: derive selectable directory entries from a file list.
 *
 * `rg --files` emits files only, so `@src/renderer` could never be picked even
 * though it is a valid reference (CC reads the whole subtree). Every ancestor
 * segment of each file path becomes a directory entry, deduplicated. Derived
 * rather than statted so this stays a pure function over rg's output — no extra
 * syscalls, and unit-testable without a fixture tree.
 */
export function collectDirectoryEntries(
  rootPath: string,
  entries: SearchFileEntry[]
): SearchFileEntry[] {
  const seen = new Set<string>();
  const dirs: SearchFileEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const segments = entry.relativePath.split('/');
    // Last segment is the file itself.
    for (let i = 1; i < segments.length; i += 1) {
      const rel = segments.slice(0, i).join('/');
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      dirs.push({
        path: join(rootPath, rel),
        name: segments[i - 1],
        relativePath: rel,
        isDirectory: true,
      });
    }
  }
  return dirs;
}

/**
 * T-07④: total order over scored results.
 *
 * Equal fuzzy scores previously fell through to ripgrep's emission order, so the
 * popup's top hit could differ between identical queries and no test could pin
 * it. Ties break on path depth (shallower first — `index.ts` beats
 * `src/renderer/deep/index.ts`), then alphabetically for a total order.
 */
export function compareFileResults(a: FileSearchResult, b: FileSearchResult): number {
  if (b.score !== a.score) return b.score - a.score;
  const depthA = a.relativePath.split('/').length;
  const depthB = b.relativePath.split('/').length;
  if (depthA !== depthB) return depthA - depthB;
  return a.relativePath.localeCompare(b.relativePath);
}

/**
 * T-07③: rank entries into a page that reports its own truncation.
 *
 * Searching `chat` in this repo matched 304 files while the popup rendered 10
 * with no hint the rest existed. `total` is the count *before* slicing.
 */
export function rankFileEntries(
  entries: SearchFileEntry[],
  query: string,
  maxResults: number
): FileSearchPage {
  if (!query.trim()) {
    const sorted = entries
      .map((entry) => ({ ...entry, score: 0 }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return {
      items: sorted.slice(0, maxResults),
      total: sorted.length,
      truncated: sorted.length > maxResults,
    };
  }

  const scored = entries
    .map((entry) => {
      const nameScore = fuzzyMatch(query, entry.name);
      const pathScore = fuzzyMatch(query, entry.relativePath) * 0.8;
      return { ...entry, score: Math.max(nameScore, pathScore) };
    })
    .filter((r) => r.score > 0)
    .sort(compareFileResults);

  return {
    items: scored.slice(0, maxResults),
    total: scored.length,
    truncated: scored.length > maxResults,
  };
}

// 模糊匹配分数计算
function fuzzyMatch(query: string, target: string): number {
  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  // 精确匹配
  if (targetLower === queryLower) return 1000;

  // 包含匹配
  if (targetLower.includes(queryLower)) {
    // 前缀匹配得分更高
    if (targetLower.startsWith(queryLower)) return 900;
    return 800 - targetLower.indexOf(queryLower);
  }

  // 模糊匹配（连续字符）
  let score = 0;
  let queryIndex = 0;
  let consecutiveBonus = 0;

  for (let i = 0; i < targetLower.length && queryIndex < queryLower.length; i++) {
    if (targetLower[i] === queryLower[queryIndex]) {
      score += 10 + consecutiveBonus;
      consecutiveBonus += 5;
      queryIndex++;
    } else {
      consecutiveBonus = 0;
    }
  }

  // 所有字符都匹配到才算有效
  if (queryIndex === queryLower.length) {
    return score;
  }

  return 0;
}

// 使用 ripgrep 获取所有文件列表
async function getAllFilesWithRipgrep(rootPath: string): Promise<SearchFileEntry[]> {
  return new Promise((resolve) => {
    // T-07②: `--hidden` so dotfiles are reachable via `@` — without it rg skips
    // every dot-prefixed entry, hiding 55 files in this repo alone (.github/,
    // .claude/, .gitignore, …). EXCLUDE_GLOBS still carries `!.git/**`, which is
    // what keeps the object database out now that hidden entries are walked.
    const args = ['--files', '--hidden', ...EXCLUDE_GLOBS.flatMap((g) => ['--glob', g]), rootPath];

    const files: SearchFileEntry[] = [];
    let buffer = '';

    const rg = spawn(rgPath, args);

    rg.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const filePath = line.trim();
        if (!filePath) continue;

        files.push({
          path: filePath,
          name: basename(filePath),
          relativePath: toPosixRelative(rootPath, filePath),
          isDirectory: false,
        });
      }
    });

    const timeoutId = setTimeout(() => {
      rg.stdout.removeAllListeners('data');
      rg.removeAllListeners('close');
      rg.removeAllListeners('error');
      killProcessTree(rg);
      resolve(files);
    }, SEARCH_TIMEOUT_MS);

    rg.on('close', () => {
      clearTimeout(timeoutId);

      // 处理最后一行
      if (buffer.trim()) {
        const filePath = buffer.trim();
        files.push({
          path: filePath,
          name: basename(filePath),
          relativePath: toPosixRelative(rootPath, filePath),
          isDirectory: false,
        });
      }

      resolve(files);
    });

    rg.on('error', (err) => {
      clearTimeout(timeoutId);
      console.error('[SearchService] ripgrep --files spawn error:', err.message);
      resolve([]);
    });
  });
}

export class SearchService {
  /**
   * 文件名搜索（使用 ripgrep --files）。
   *
   * T-07 补强：包含派生目录条目（① `isDirectory`）、隐藏文件（②）、
   * 报告截断前总数（③）、同分确定性排序（④）。
   */
  async searchFiles(params: FileSearchParams): Promise<FileSearchPage> {
    const { rootPath, query, maxResults = MAX_FILE_RESULTS } = params;

    const files = await getAllFilesWithRipgrep(rootPath);
    const entries = [...files, ...collectDirectoryEntries(rootPath, files)];

    return rankFileEntries(entries, query, maxResults);
  }

  // 内容搜索（使用 ripgrep）
  async searchContent(params: ContentSearchParams): Promise<ContentSearchResult> {
    const {
      rootPath,
      query,
      maxResults = MAX_CONTENT_RESULTS,
      caseSensitive = false,
      wholeWord = false,
      regex = false,
      filePattern,
      useGitignore = true,
    } = params;

    if (!query.trim()) {
      return { matches: [], totalMatches: 0, totalFiles: 0, truncated: false };
    }

    return new Promise((resolve) => {
      const args = [
        '--json',
        '--line-number',
        '--column',
        '--max-count',
        '100',
        '--max-filesize',
        '1M',
      ];

      // 忽略常见目录
      args.push(...EXCLUDE_GLOBS.flatMap((g) => ['--glob', g]));

      // ripgrep 默认遵循 .gitignore，如果不使用则添加 --no-ignore
      if (!useGitignore) args.push('--no-ignore');

      if (!caseSensitive) args.push('-i');
      if (wholeWord) args.push('-w');
      if (!regex) args.push('-F');
      if (filePattern) args.push('--glob', filePattern);

      args.push('--', query, rootPath);

      const matches: ContentSearchMatch[] = [];
      const fileSet = new Set<string>();
      let totalMatches = 0;
      let truncated = false;
      let stderr = '';

      const rg = spawn(rgPath, args);
      let buffer = '';

      rg.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const json = JSON.parse(line);
            if (json.type === 'match') {
              totalMatches++;
              fileSet.add(json.data.path.text);

              if (matches.length < maxResults) {
                const submatch = json.data.submatches?.[0];
                const match: ContentSearchMatch = {
                  path: json.data.path.text,
                  relativePath: toPosixRelative(rootPath, json.data.path.text),
                  line: json.data.line_number,
                  column: submatch?.start || 0,
                  matchLength: submatch ? submatch.end - submatch.start : 0,
                  content: json.data.lines.text.replace(/\n$/, ''),
                };
                matches.push(match);
              } else {
                truncated = true;
              }
            }
          } catch {
            // 忽略解析错误
          }
        }
      });

      rg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timeoutId = setTimeout(() => {
        rg.stdout.removeAllListeners('data');
        rg.stderr.removeAllListeners('data');
        rg.removeAllListeners('close');
        rg.removeAllListeners('error');
        killProcessTree(rg);
        resolve({
          matches,
          totalMatches,
          totalFiles: fileSet.size,
          truncated: true,
        });
      }, SEARCH_TIMEOUT_MS);

      rg.on('close', (code) => {
        clearTimeout(timeoutId);

        // 处理最后一行
        if (buffer.trim()) {
          try {
            const json = JSON.parse(buffer);
            if (json.type === 'match') {
              totalMatches++;
              fileSet.add(json.data.path.text);
              if (matches.length < maxResults) {
                const submatch = json.data.submatches?.[0];
                const match: ContentSearchMatch = {
                  path: json.data.path.text,
                  relativePath: toPosixRelative(rootPath, json.data.path.text),
                  line: json.data.line_number,
                  column: submatch?.start || 0,
                  matchLength: submatch ? submatch.end - submatch.start : 0,
                  content: json.data.lines.text.replace(/\n$/, ''),
                };
                matches.push(match);
              }
            }
          } catch {
            // ignore
          }
        }

        if (code === 2 && stderr) {
          console.error('[SearchService] ripgrep error:', stderr);
        }

        resolve({
          matches,
          totalMatches,
          totalFiles: fileSet.size,
          truncated,
        });
      });

      rg.on('error', (err) => {
        clearTimeout(timeoutId);
        console.error('[SearchService] ripgrep spawn error:', err.message);
        resolve({
          matches: [],
          totalMatches: 0,
          totalFiles: 0,
          truncated: false,
        });
      });
    });
  }
}

export const searchService = new SearchService();
