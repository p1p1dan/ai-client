import { describe, expect, it } from 'vitest';
import {
  callDirectory,
  isOutsideCallDirectory,
  workingDirectoryChip,
  workspaceSpelled,
} from '../workingDirectory.ts';

/** Decision 207 §7, §14 D: where the session's current directory sits relative to its workspace. */

describe('the composer chip', () => {
  it('shows nothing in the workspace or without a value', () => {
    expect(workingDirectoryChip('/home/u/proj', '/home/u/proj')).toBeUndefined();
    expect(workingDirectoryChip('/home/u/proj', '/home/u/proj/')).toBeUndefined();
    expect(workingDirectoryChip('/home/u/proj', null)).toBeUndefined();
    expect(workingDirectoryChip(undefined, '/tmp/build')).toBeUndefined();
  });

  it('names a subdirectory relative to the workspace', () => {
    expect(workingDirectoryChip('/home/u/proj', '/home/u/proj/packages/web')).toEqual({
      kind: 'inside',
      text: 'packages/web',
    });
  });

  it('names a directory outside in full, a same-prefix sibling included', () => {
    expect(workingDirectoryChip('/home/u/proj', '/tmp/build')).toEqual({
      kind: 'outside',
      text: '/tmp/build',
    });
    expect(workingDirectoryChip('/home/u/proj', '/home/u/proj-other')).toEqual({
      kind: 'outside',
      text: '/home/u/proj-other',
    });
  });

  it('reads Windows paths case- and separator-blind', () => {
    expect(workingDirectoryChip('E:\\code\\Proj', 'e:/code/proj')).toBeUndefined();
    expect(workingDirectoryChip('E:\\code\\proj', 'E:\\code\\proj\\packages\\web')).toEqual({
      kind: 'inside',
      text: 'packages/web',
    });
    expect(workingDirectoryChip('E:\\code\\proj', 'D:\\build')).toEqual({
      kind: 'outside',
      text: 'D:\\build',
    });
  });
});

describe('the directory a tool row records', () => {
  it('none in the workspace, relative inside, absolute outside', () => {
    expect(callDirectory('/home/u/proj', '/home/u/proj')).toBeUndefined();
    expect(callDirectory('/home/u/proj', '/home/u/proj/packages/web')).toBe('packages/web');
    expect(callDirectory('/home/u/proj', '/tmp/build')).toBe('/tmp/build');
    expect(isOutsideCallDirectory('packages/web')).toBe(false);
    expect(isOutsideCallDirectory('/tmp/build')).toBe(true);
    expect(isOutsideCallDirectory('D:\\build')).toBe(true);
  });
});

describe('a workspace opened through a link (decision 207 §15 item 5)', () => {
  const LINK = '/link/ws';
  const REAL = ['/real/ws'];

  it('a row reads the resolved spelling as the workspace', () => {
    expect(callDirectory(LINK, '/real/ws/packages/web', REAL)).toBe('packages/web');
    expect(callDirectory(LINK, '/real/ws', REAL)).toBeUndefined();
    expect(callDirectory(LINK, '/real/ws/', REAL)).toBeUndefined();
    expect(callDirectory(LINK, '/tmp/build', REAL)).toBe('/tmp/build');
    expect(callDirectory(LINK, '/real/ws-other', REAL)).toBe('/real/ws-other');
    // Its own spelling still counts.
    expect(callDirectory(LINK, '/link/ws/src', REAL)).toBe('src');
  });

  it('the directory forwarded to the window is spelled as the workspace, so its chip reads relative', () => {
    expect(workspaceSpelled(LINK, '/real/ws/packages/web', REAL)).toBe('/link/ws/packages/web');
    expect(workspaceSpelled(LINK, '/real/ws', REAL)).toBe('/link/ws');
    expect(workspaceSpelled(LINK, '/tmp/build', REAL)).toBe('/tmp/build');
    expect(workspaceSpelled(LINK, '/link/ws/src', REAL)).toBe('/link/ws/src');
    expect(workspaceSpelled(LINK, '/real/ws/packages/web', [])).toBe('/real/ws/packages/web');
    expect(
      workingDirectoryChip(LINK, workspaceSpelled(LINK, '/real/ws/packages/web', REAL))
    ).toEqual({ kind: 'inside', text: 'packages/web' });
    expect(workingDirectoryChip(LINK, workspaceSpelled(LINK, '/real/ws', REAL))).toBeUndefined();
  });

  it('a Windows 8.3 spelling keeps its own separators and case', () => {
    expect(
      workspaceSpelled('C:\\Users\\RUNNER~1\\ws', 'C:\\Users\\runneradmin\\ws\\pkg\\Web', [
        'C:\\Users\\runneradmin\\ws',
      ])
    ).toBe('C:\\Users\\RUNNER~1\\ws\\pkg\\Web');
    expect(
      callDirectory('C:\\Users\\RUNNER~1\\ws', 'c:\\users\\runneradmin\\ws\\pkg', [
        'C:\\Users\\runneradmin\\ws',
      ])
    ).toBe('pkg');
  });
});
