import type { LegacyImportItemResult, LegacyImportWorkspaceOutcome } from '@shared/types';
import { describe, expect, it } from 'vitest';
import {
  describeConversationImport,
  summarizeConversationImport,
} from '../conversationImportReport';

/**
 * The 2026-09-20 complaint, at the layer that decides what it says.
 *
 * 「这个目录不在本应用的项目列表里，所以这些对话会作为临时对话导入」 — the pane
 * told the user their project would not come along, and then did exactly that.
 * The distinction that was missing is the one every test here is built on: a
 * folder that is a real directory but not a registered project must be counted
 * as a project that came along, not as a temporary chat.
 */

function imported(id: string, outcome: LegacyImportItemResult['outcome']): LegacyImportItemResult {
  return {
    source: { sourceKind: 'claude-code', projectId: 'p', sourceSessionId: id },
    status: 'imported',
    outcome,
  };
}

function kept(path: string): LegacyImportItemResult['outcome'] {
  return { workspace: 'kept', recordedWorkspacePath: path, workspacePath: path };
}

function outcomeOf(workspace: LegacyImportWorkspaceOutcome): LegacyImportItemResult['outcome'] {
  // Deliberately NOT the same string: the report must name where the
  // conversation actually runs, not the directory that went missing, or the
  // line reads like the folder is still there.
  return { workspace, recordedWorkspacePath: '/gone/away', workspacePath: '/tmp/unbound/x' };
}

const NEVER = () => false;
const ALWAYS = () => true;

describe('summarizeConversationImport', () => {
  it('calls a kept folder that was never registered a new project', () => {
    // The exact case: the directory exists on disk, no project points at it.
    const report = summarizeConversationImport(
      [
        imported('s1', kept('/home/u/code/never-opened')),
        imported('s2', kept('/home/u/code/never-opened')),
      ],
      NEVER
    );
    expect(report.newProjects).toEqual([{ path: '/home/u/code/never-opened', count: 2 }]);
    expect(report.existingProjects).toEqual([]);
    expect(report.detached).toEqual([]);
  });

  it('calls a kept folder that was already registered an existing project', () => {
    const report = summarizeConversationImport(
      [imported('s1', kept('/home/u/code/known'))],
      ALWAYS
    );
    expect(report.newProjects).toEqual([]);
    expect(report.existingProjects).toEqual([{ path: '/home/u/code/known', count: 1 }]);
  });

  it('splits one batch across new, existing and gone folders at once', () => {
    const report = summarizeConversationImport(
      [
        imported('s1', kept('/home/u/code/known')),
        imported('s2', kept('/home/u/code/never-opened')),
        imported('s3', outcomeOf('missing')),
      ],
      (path) => path === '/home/u/code/known'
    );
    expect(report.existingProjects).toEqual([{ path: '/home/u/code/known', count: 1 }]);
    expect(report.newProjects).toEqual([{ path: '/home/u/code/never-opened', count: 1 }]);
    expect(report.detached).toEqual([{ path: '/gone/away', count: 1 }]);
    expect(report.imported).toBe(3);
  });

  it('counts a conversation with no recorded folder as detached, under a path that exists', () => {
    // `none` means the source never recorded a working directory — the round
    // this feature was built for had one such conversation. It is still a
    // conversation that did not come with a project, so it counts as detached,
    // and it falls back to the scratch directory it runs in because there is
    // no recorded path to name.
    const report = summarizeConversationImport(
      [imported('s1', { workspace: 'none', workspacePath: '/tmp/unbound/s1' })],
      NEVER
    );
    expect(report.detached).toEqual([{ path: '/tmp/unbound/s1', count: 1 }]);
    expect(report.imported).toBe(1);
  });

  it('ignores the folder verdict of a failed import', () => {
    const report = summarizeConversationImport(
      [
        { ...imported('s1', kept('/home/u/code/known')), status: 'failed', error: 'boom' },
        { ...imported('s2', kept('/home/u/code/known')), status: 'already-imported' },
      ],
      NEVER
    );
    expect(report.newProjects).toEqual([]);
    expect(report.failed).toBe(1);
    expect(report.alreadyImported).toBe(1);
    expect(report.imported).toBe(0);
  });

  it('sorts paths so one batch reads the same way twice', () => {
    const report = summarizeConversationImport(
      [imported('s1', kept('/b')), imported('s2', kept('/a'))],
      NEVER
    );
    expect(report.newProjects.map((row) => row.path)).toEqual(['/a', '/b']);
  });
});

describe('describeConversationImport', () => {
  // The identity translator: the assertion is about which sentence is chosen
  // and what it is given, not about the Chinese wording (the catalog test
  // covers that).
  const t = ((key: string, params?: Record<string, unknown>) =>
    params ? `${key}|${JSON.stringify(params)}` : key) as never;

  it('prints one line per group, in order, and always the counts', () => {
    const report = summarizeConversationImport(
      [imported('s1', kept('/home/u/code/known')), imported('s2', kept('/home/u/code/new'))],
      (path) => path === '/home/u/code/known'
    );
    const lines = describeConversationImport(report, t);
    expect(lines[0]).toContain('Added {{path}} as a project and imported {{count}} conversations');
    expect(lines[0]).toContain('/home/u/code/new');
    expect(lines[1]).toContain('Imported {{count}} conversations into the project {{path}}');
    expect(lines[1]).toContain('/home/u/code/known');
    expect(lines.at(-1)).toBe(
      'Imported {{imported}}, already here {{skipped}}, failed {{failed}}.|{"imported":2,"skipped":0,"failed":0}'
    );
  });

  it('omits the groups that have nothing in them', () => {
    const report = summarizeConversationImport([imported('s1', kept('/only'))], ALWAYS);
    const lines = describeConversationImport(report, t);
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes('temporary chats'))).toBe(false);
  });
});
