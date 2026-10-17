/**
 * Route B S-6 feedback 7: where a chat's conversation record lives on disk, for the
 * Context panel's Workspace group.
 *
 * A chat names its identity stub (`runtimeIdentity`); the record is found from it:
 * - Agent SDK chat: `<sdkConfigDir>/aiclient-sessions/<ccSessionId>.ccsdk.json` → the CLI's own
 *   transcript `<sdkConfigDir>/projects/<cwd dir>/<ccSessionId>.jsonl`;
 * - DSH chat: `<dshHome>/aiclient-sessions/<logical id>.dsh.json`, whose `dshSessionId` names
 *   `<dshHome>/sessions/<cwd dir>/<dshSessionId>/session.v4.jsonl.zstd` (compressed).
 *
 * Only a stub directly inside one of the two stub directories is read: the renderer passes
 * the path, and nothing outside the app's own state is ever looked at.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CLAUDE_SDK_STUB_SUFFIX } from '@shared/claudeSdkEngine';

export const DSH_STUB_SUFFIX = '.dsh.json';
const STUB_DIR = 'aiclient-sessions';
const DSH_RECORD_FILE = 'session.v4.jsonl.zstd';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface TranscriptRoots {
  dshHome: string;
  claudeSdkConfigDir: string;
}

export interface TranscriptLocation {
  path: string;
  /** A DSH session whose record file is not there yet is shown as its directory. */
  kind: 'file' | 'directory';
  engine: 'dsh' | 'claude-sdk';
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The record of the chat whose identity stub is `stubFile`, or null when there is none (yet). */
export function locateTranscript(
  stubFile: string,
  roots: TranscriptRoots
): TranscriptLocation | null {
  if (!stubFile || !path.isAbsolute(stubFile)) return null;
  const name = path.basename(stubFile);
  const dir = path.dirname(stubFile);

  if (name.endsWith(CLAUDE_SDK_STUB_SUFFIX)) {
    if (!samePath(dir, path.join(roots.claudeSdkConfigDir, STUB_DIR))) return null;
    const ccSessionId = name.slice(0, -CLAUDE_SDK_STUB_SUFFIX.length);
    if (!SAFE_ID.test(ccSessionId)) return null;
    for (const project of childDirs(path.join(roots.claudeSdkConfigDir, 'projects'))) {
      const file = path.join(project, `${ccSessionId}.jsonl`);
      if (isFile(file)) return { path: file, kind: 'file', engine: 'claude-sdk' };
    }
    return null;
  }

  if (name.endsWith(DSH_STUB_SUFFIX)) {
    if (!samePath(dir, path.join(roots.dshHome, STUB_DIR))) return null;
    let dshSessionId: unknown;
    try {
      dshSessionId = (JSON.parse(readFileSync(stubFile, 'utf8')) as { dshSessionId?: unknown })
        .dshSessionId;
    } catch {
      return null;
    }
    if (typeof dshSessionId !== 'string' || !SAFE_ID.test(dshSessionId)) return null;
    for (const cwdDir of childDirs(path.join(roots.dshHome, 'sessions'))) {
      const sessionDir = path.join(cwdDir, dshSessionId);
      if (!existsSync(sessionDir)) continue;
      const file = path.join(sessionDir, DSH_RECORD_FILE);
      return isFile(file)
        ? { path: file, kind: 'file', engine: 'dsh' }
        : { path: sessionDir, kind: 'directory', engine: 'dsh' };
    }
    return null;
  }

  return null;
}
