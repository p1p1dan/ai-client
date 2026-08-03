import { describe, expect, it } from 'vitest';
import { canonicalPathKey } from '../path';

describe('canonicalPathKey', () => {
  it('trims a trailing separator so "/aaa" and "/aaa/" compare equal', () => {
    expect(canonicalPathKey('/aaa/')).toBe(canonicalPathKey('/aaa'));
    expect(canonicalPathKey('/aaa/')).toBe('/aaa');
  });

  it('normalizes backslashes to forward slashes before comparing', () => {
    expect(canonicalPathKey('C:\\Code\\repo')).toBe(canonicalPathKey('C:/Code/repo'));
    expect(canonicalPathKey('C:\\Code\\repo')).toBe('c:/code/repo');
  });

  it('lowercases so case-drifted paths compare equal', () => {
    expect(canonicalPathKey('/Repo/Aaa')).toBe(canonicalPathKey('/repo/aaa'));
  });

  it('does not trim root paths down to an empty key', () => {
    expect(canonicalPathKey('/')).toBe('/');
    expect(canonicalPathKey('C:/')).toBe('c:/');
  });
});
