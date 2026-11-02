import { describe, expect, it } from 'vitest';
import {
  callDirectory,
  isOutsideCallDirectory,
  workingDirectoryChip,
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
