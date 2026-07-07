import { describe, expect, it } from 'vitest';
import { ensureValidBranchName, normalizeBranchName, validateBranchName } from '../branchName';

describe('normalizeBranchName', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeBranchName('fix\\recentBug')).toBe('fix/recentBug');
    expect(normalizeBranchName('a\\b\\c')).toBe('a/b/c');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeBranchName('  fix/bug  ')).toBe('fix/bug');
  });

  it('keeps valid names unchanged', () => {
    expect(normalizeBranchName('feature/my-feature')).toBe('feature/my-feature');
    expect(normalizeBranchName('main')).toBe('main');
  });
});

describe('validateBranchName', () => {
  it.each([
    'main',
    'feature/my-feature',
    'fix-123',
    'v1.2.3',
    'feat@v2',
    'hotfix/a.b',
    '中文分支',
  ])('accepts valid name %j', (name) => {
    expect(validateBranchName(name)).toEqual({ valid: true });
  });

  it.each([
    ['', 'empty name'],
    ['@', 'a single "@"'],
    ['-foo', 'leading dash'],
    ['fix bug', 'space'],
    ['fix\tbug', 'tab'],
    [`a${String.fromCharCode(1)}b`, 'control character'],
    ['a~b', 'tilde'],
    ['a^b', 'caret'],
    ['a:b', 'colon'],
    ['a?b', 'question mark'],
    ['a*b', 'asterisk'],
    ['a[b', 'open bracket'],
    ['a\\b', 'backslash'],
    ['a..b', 'double dot'],
    ['a@{b', 'at-brace'],
    ['/a', 'leading slash'],
    ['a/', 'trailing slash'],
    ['a//b', 'consecutive slashes'],
    ['a.', 'trailing dot'],
    ['.a', 'segment starting with dot'],
    ['a/.b', 'nested segment starting with dot'],
    ['a.lock', 'ending with .lock'],
    ['x/a.lock', 'segment ending with .lock'],
  ])('rejects %j (%s)', (name) => {
    const check = validateBranchName(name);
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.error.length).toBeGreaterThan(0);
    }
  });
});

describe('ensureValidBranchName', () => {
  it('returns the normalized name for backslash input', () => {
    expect(ensureValidBranchName('fix\\recentBug')).toBe('fix/recentBug');
  });

  it('trims whitespace before validating', () => {
    expect(ensureValidBranchName('  main  ')).toBe('main');
  });

  it('keeps valid names unchanged', () => {
    expect(ensureValidBranchName('feature/my-feature')).toBe('feature/my-feature');
  });

  it('throws a Chinese error for invalid names', () => {
    expect(() => ensureValidBranchName('fix bug')).toThrow(/无效的分支名 "fix bug"/);
    expect(() => ensureValidBranchName('fix bug')).toThrow(/空格/);
    expect(() => ensureValidBranchName('-foo')).toThrow(/无效的分支名/);
    expect(() => ensureValidBranchName('   ')).toThrow(/分支名不能为空/);
  });
});
