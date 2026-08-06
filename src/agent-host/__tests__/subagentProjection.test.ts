import { describe, expect, it } from 'vitest';

import {
  clampSubagentText,
  projectSubagentToolInput,
  SUBAGENT_ERROR_TEXT_MAX_CHARS,
  SUBAGENT_INPUT_FIELD_MAX_CHARS,
  SUBAGENT_TEXT_MAX_CHARS,
  SUBAGENT_TRUNCATION_MARKER,
  subagentErrorText,
} from '../subagentProjection.ts';

/**
 * T-34: the size/privacy gate for subagent facts. The assertions that matter
 * most here are the NEGATIVE ones — a whitelist is only worth anything if the
 * fields it must never pass are pinned by name.
 */

describe('projectSubagentToolInput — whitelist', () => {
  it('keeps the arg-bearing fields a tool row actually renders', () => {
    expect(
      projectSubagentToolInput({
        file_path: '/home/dan/projects/ai-client/package.json',
        offset: 10,
        limit: 40,
      })
    ).toEqual({
      file_path: '/home/dan/projects/ai-client/package.json',
      offset: 10,
      limit: 40,
    });

    expect(projectSubagentToolInput({ command: 'echo hi', description: 'Say hi' })).toEqual({
      command: 'echo hi',
      description: 'Say hi',
    });
  });

  it('drops file bodies by name — Write/Edit content never crosses IPC', () => {
    const projected = projectSubagentToolInput({
      file_path: '/tmp/a.ts',
      content: 'x'.repeat(50_000),
      old_string: 'before',
      new_string: 'after',
    });

    expect(projected).toEqual({ file_path: '/tmp/a.ts' });
    expect(JSON.stringify(projected)).not.toContain('x'.repeat(10));
  });

  it('drops a delegation prompt and any other unlisted field', () => {
    const projected = projectSubagentToolInput({
      description: 'shape probe',
      subagent_type: 'general-purpose',
      prompt: 'Read package.json and report the name field',
      run_in_background: false,
      model: 'claude-opus-4-8',
      todos: [{ content: 'a' }],
    });

    expect(projected).toEqual({ description: 'shape probe', subagent_type: 'general-purpose' });
    expect(projected).not.toHaveProperty('prompt');
    // A boolean has no row rendering and is not in the payload's value type.
    expect(projected).not.toHaveProperty('run_in_background');
  });

  it('clamps every projected string field independently', () => {
    const long = 'p'.repeat(SUBAGENT_INPUT_FIELD_MAX_CHARS + 500);
    const projected = projectSubagentToolInput({ command: long, description: long });

    expect(projected?.command).toHaveLength(SUBAGENT_INPUT_FIELD_MAX_CHARS);
    expect(projected?.description).toHaveLength(SUBAGENT_INPUT_FIELD_MAX_CHARS);
    expect(String(projected?.command).endsWith(SUBAGENT_TRUNCATION_MARKER)).toBe(true);
  });

  it('returns undefined rather than an empty husk when nothing survives', () => {
    expect(projectSubagentToolInput({ content: 'only a body' })).toBeUndefined();
    expect(projectSubagentToolInput({})).toBeUndefined();
    // Empty strings are absent facts, not short ones.
    expect(projectSubagentToolInput({ file_path: '' })).toBeUndefined();
  });

  it('returns undefined for shapes a tool input is never supposed to be', () => {
    expect(projectSubagentToolInput(undefined)).toBeUndefined();
    expect(projectSubagentToolInput(null)).toBeUndefined();
    expect(projectSubagentToolInput('a string')).toBeUndefined();
    expect(projectSubagentToolInput(42)).toBeUndefined();
    // An array could smuggle positional values past a key whitelist.
    expect(projectSubagentToolInput([{ file_path: '/tmp/a' }])).toBeUndefined();
  });

  it('drops non-finite numbers instead of forwarding NaN/Infinity', () => {
    expect(
      projectSubagentToolInput({ offset: Number.NaN, limit: Number.POSITIVE_INFINITY })
    ).toBeUndefined();
  });
});

describe('clampSubagentText', () => {
  it('passes short text through untouched', () => {
    expect(clampSubagentText('hello', 4000)).toBe('hello');
    expect(clampSubagentText('', 4000)).toBe('');
  });

  it('clamps a subagent text/thinking body at 4000 chars, marker included in the budget', () => {
    const body = 'a'.repeat(SUBAGENT_TEXT_MAX_CHARS + 1_000);
    const clamped = clampSubagentText(body, SUBAGENT_TEXT_MAX_CHARS);

    expect(clamped).toHaveLength(SUBAGENT_TEXT_MAX_CHARS);
    expect(clamped.endsWith(SUBAGENT_TRUNCATION_MARKER)).toBe(true);
    // Never longer than the limit — the marker replaces, not extends.
    expect(clamped.length).toBeLessThanOrEqual(SUBAGENT_TEXT_MAX_CHARS);
  });

  it('treats a non-positive budget as "nothing survives"', () => {
    expect(clampSubagentText('anything', 0)).toBe('');
  });
});

describe('subagentErrorText', () => {
  it('flattens a string or a text-part array', () => {
    expect(subagentErrorText('boom')).toBe('boom');
    expect(
      subagentErrorText([
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ])
    ).toBe('line one\nline two');
  });

  it('clamps at 400 chars', () => {
    const clamped = subagentErrorText('e'.repeat(2_000));
    expect(clamped).toHaveLength(SUBAGENT_ERROR_TEXT_MAX_CHARS);
    expect(clamped?.endsWith(SUBAGENT_TRUNCATION_MARKER)).toBe(true);
  });

  it('returns undefined for nothing to say — a blank row is not a fact', () => {
    expect(subagentErrorText(undefined)).toBeUndefined();
    expect(subagentErrorText('')).toBeUndefined();
    expect(subagentErrorText('   \n  ')).toBeUndefined();
    expect(subagentErrorText([{ type: 'image', source: {} }])).toBeUndefined();
  });
});
