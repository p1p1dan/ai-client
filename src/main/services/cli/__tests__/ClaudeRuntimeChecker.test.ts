import { describe, expect, it } from 'vitest';
import { LAST_NODE_CLAUDE_VERSION } from '@shared/types';
import { classifyClaudeCliVersion, compareSemver } from '../ClaudeVersion';

describe('compareSemver', () => {
  it('orders patch versions numerically, not lexicographically', () => {
    expect(compareSemver('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(compareSemver('2.1.112', '2.1.99')).toBeGreaterThan(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareSemver('2.1', '2.1.0')).toBe(0);
    expect(compareSemver('2', '2.0.0')).toBe(0);
  });

  it('returns equality when versions match', () => {
    expect(compareSemver('2.1.112', LAST_NODE_CLAUDE_VERSION)).toBe(0);
  });

  it('tolerates non-numeric segments by treating them as zero', () => {
    expect(compareSemver('2.1.112-rc1', '2.1.112')).toBe(0);
    expect(compareSemver('1.0.0-beta', '0.9.99')).toBeGreaterThan(0);
  });
});

describe('classifyClaudeCliVersion', () => {
  it('marks the last Node release as compatible', () => {
    expect(classifyClaudeCliVersion('2.1.112')).toBe('node-compatible');
  });

  it('marks earlier Node releases as compatible', () => {
    expect(classifyClaudeCliVersion('2.1.0')).toBe('node-compatible');
    expect(classifyClaudeCliVersion('1.5.42')).toBe('node-compatible');
  });

  it('marks Bun releases (> 2.1.112) as incompatible', () => {
    expect(classifyClaudeCliVersion('2.1.113')).toBe('bun-incompatible');
    expect(classifyClaudeCliVersion('2.2.0')).toBe('bun-incompatible');
    expect(classifyClaudeCliVersion('3.0.0')).toBe('bun-incompatible');
  });
});
