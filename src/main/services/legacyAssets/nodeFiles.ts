/**
 * dsh-rebase P1-16e — the file access the legacy-asset detection needs, over
 * `node:fs`.
 *
 * Structurally the union of the two ports the shared loaders already declare
 * (`SkillCatalogFiles` for skills and templates, `McpConfigFiles` for
 * `mcp.json`), so the detection reuses those loaders unchanged. Three calls,
 * none of which writes: a bounded read, a directory listing that does not
 * follow symlinks, and a `stat` that does.
 *
 * Every file this reads is `.md` or `.json`, which the encrypted Windows target
 * serves to node in plaintext (P1-13b's unreadable list is nine other
 * extensions), so Main can read them directly.
 */

import type { Dirent } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import type { SkillFileKind } from '@shared/skills/loader';

export interface LegacyAssetFiles {
  /**
   * Up to `maxBytes`. Past that, `truncate` answers the prefix with
   * `truncated: true` and `error` rejects with `EFBIG`.
   */
  readFile(
    path: string,
    options: { maxBytes: number; overflow: 'truncate' | 'error' }
  ): Promise<{ bytes: Uint8Array; truncated: boolean }>;
  /** Entries of one directory; a symlink is reported as `symlink`, not followed. */
  readDirectory(path: string): AsyncIterable<{ name: string; kind: SkillFileKind }>;
  /** Follows symlinks. */
  stat(path: string): Promise<{ kind: SkillFileKind }>;
}

function direntKind(entry: Dirent): SkillFileKind {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  return 'other';
}

export function nodeLegacyAssetFiles(): LegacyAssetFiles {
  return {
    async readFile(path, { maxBytes, overflow }) {
      const handle = await open(path, 'r');
      try {
        // One byte past the limit tells "exactly maxBytes" from "more".
        const buffer = Buffer.alloc(maxBytes + 1);
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        const truncated = filled > maxBytes;
        if (truncated && overflow === 'error') {
          throw Object.assign(new Error(`${path} is larger than ${maxBytes} bytes`), {
            code: 'EFBIG',
          });
        }
        return { bytes: buffer.subarray(0, Math.min(filled, maxBytes)), truncated };
      } finally {
        await handle.close();
      }
    },
    async *readDirectory(path) {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) yield { name: entry.name, kind: direntKind(entry) };
    },
    async stat(path) {
      const info = await stat(path);
      return { kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other' };
    },
  };
}
