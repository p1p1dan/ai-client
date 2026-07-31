import { describe, expect, it } from 'vitest';
import {
  deriveSessionTitleFromFirstMessage,
  fallbackSessionTitle,
  isPlaceholderTitle,
  sessionHasUserMessage,
} from '../sessionTitle';

describe('isPlaceholderTitle', () => {
  it('treats empty/whitespace/nullish as placeholder', () => {
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle('   ')).toBe(true);
    expect(isPlaceholderTitle(null)).toBe(true);
    expect(isPlaceholderTitle(undefined)).toBe(true);
  });

  it('treats the literal seed titles as placeholder', () => {
    expect(isPlaceholderTitle('New chat')).toBe(true);
    expect(isPlaceholderTitle('Live Agent Host')).toBe(true);
  });

  it('treats the "Session xxxxxx" fallback pattern as placeholder', () => {
    expect(isPlaceholderTitle('Session ab12cd')).toBe(true);
    expect(isPlaceholderTitle('Session 123456')).toBe(true);
  });

  it('does not treat a real user/derived title as placeholder', () => {
    expect(isPlaceholderTitle('Fix the login flow')).toBe(false);
    expect(isPlaceholderTitle('New chat about billing')).toBe(false); // superstring, not exact match
    expect(isPlaceholderTitle('Session abcdefg')).toBe(false); // 7-char tail — slice(-6) can never emit this
    expect(isPlaceholderTitle('Session ab cd')).toBe(false); // whitespace in tail — outside the formatter's domain
    // NOTE: a SHORT tail like 'Session ab' IS a placeholder now — slice(-6)
    // of a short id legitimately emits it (see the R4 round-trip tests below).
  });
});

describe('deriveSessionTitleFromFirstMessage', () => {
  it('cuts at the first ASCII sentence terminator', () => {
    expect(deriveSessionTitleFromFirstMessage('Fix the login bug. Also check signup.')).toBe(
      'Fix the login bug'
    );
  });

  it('cuts at the first CJK sentence terminator', () => {
    expect(deriveSessionTitleFromFirstMessage('修复登录页的报错。顺便看看注册页。')).toBe(
      '修复登录页的报错'
    );
  });

  it('cuts at the first line break for multi-line input', () => {
    expect(
      deriveSessionTitleFromFirstMessage('Fix the login bug\n\nDetails:\n- repro steps\n- logs')
    ).toBe('Fix the login bug');
  });

  // R5(c): upgraded from a property assertion ("is a prefix and <=60") to a
  // precise expected value — this mixed text has no sentence terminator and
  // is 52 code points long (under the 60 cap), so it must survive verbatim.
  it('handles CJK/Latin mixed text without a terminator, returning it unchanged (under the 60 code-point cap)', () => {
    const mixed = '帮我 review 一下这个 PR 里的 TypeScript 类型定义是不是有问题 需要详细说明每一处';
    expect(deriveSessionTitleFromFirstMessage(mixed)).toBe(mixed);
  });

  // R5(a): ASCII `.`/`!`/`?` only count as a sentence boundary when followed
  // by whitespace or end-of-string — a `.` inside a file path, version
  // number, or domain name must not be misread as ending the sentence. CJK
  // terminators and line breaks keep splitting immediately (unconditional).
  describe('R5(a): ASCII sentence punctuation requires trailing whitespace/EOS', () => {
    it('does not cut a file-extension dot', () => {
      expect(deriveSessionTitleFromFirstMessage('修复 src/foo.ts 的类型错误')).toBe(
        '修复 src/foo.ts 的类型错误'
      );
    });

    it('does not cut a version-number dot', () => {
      expect(deriveSessionTitleFromFirstMessage('排查 v2.1 升级问题')).toBe('排查 v2.1 升级问题');
    });

    it('does not cut a domain-name dot', () => {
      expect(deriveSessionTitleFromFirstMessage('检查 example.com 登录失败')).toBe(
        '检查 example.com 登录失败'
      );
    });

    it('does not cut a filename dot in package.json', () => {
      expect(deriveSessionTitleFromFirstMessage('更新 package.json 中的脚本')).toBe(
        '更新 package.json 中的脚本'
      );
    });

    it('still cuts an ASCII sentence terminator followed by whitespace', () => {
      expect(deriveSessionTitleFromFirstMessage('Fix the login bug. Also check signup.')).toBe(
        'Fix the login bug'
      );
    });
  });

  // R5(b): the 60-char cap must count Unicode code points (Array.from), not
  // UTF-16 code units — otherwise a surrogate pair (emoji, supplementary
  // plane characters) straddling the cut point gets torn in half.
  it('caps at 60 code points, not UTF-16 units, so a trailing emoji survives the cut whole', () => {
    const prefix = 'a'.repeat(58);
    const text = `${prefix}😀 rest of the sentence that pushes this well past sixty code points total`;
    const out = deriveSessionTitleFromFirstMessage(text);
    expect(out).toBe(`${prefix}😀…`);
    expect(Array.from(out).length).toBe(60);
  });

  it('strips a leading markdown heading', () => {
    expect(deriveSessionTitleFromFirstMessage('# Fix the login flow')).toBe('Fix the login flow');
  });

  it('strips a leading markdown list marker', () => {
    expect(deriveSessionTitleFromFirstMessage('- do the thing first')).toBe('do the thing first');
    expect(deriveSessionTitleFromFirstMessage('1. do the thing first')).toBe('do the thing first');
  });

  it('strips a leading blockquote marker', () => {
    expect(deriveSessionTitleFromFirstMessage('> quoted task description')).toBe(
      'quoted task description'
    );
  });

  it('strips stacked markdown prefixes (blockquote + heading)', () => {
    expect(deriveSessionTitleFromFirstMessage('> # Fix it')).toBe('Fix it');
  });

  it('trims and collapses internal whitespace', () => {
    expect(deriveSessionTitleFromFirstMessage('   fix   the    bug   ')).toBe('fix the bug');
  });

  it('truncates long text to 60 chars with an ellipsis', () => {
    const longText = 'fix the login flow on mobile and add tests for it also please thanks alright'; // > 60 chars, no terminator
    const out = deriveSessionTitleFromFirstMessage(longText);
    expect(out.length).toBe(60);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('fix the login')).toBe(true);
  });

  it('returns empty string for all-whitespace input', () => {
    expect(deriveSessionTitleFromFirstMessage('   \n\t  ')).toBe('');
  });

  it('returns empty string for punctuation-only input', () => {
    expect(deriveSessionTitleFromFirstMessage('!!!')).toBe('');
    expect(deriveSessionTitleFromFirstMessage('-----')).toBe('');
    expect(deriveSessionTitleFromFirstMessage('...')).toBe('');
  });

  it('returns empty string for emoji/symbol-only input', () => {
    expect(deriveSessionTitleFromFirstMessage('😀😀😀')).toBe('');
  });

  it('returns empty string for an empty input', () => {
    expect(deriveSessionTitleFromFirstMessage('')).toBe('');
  });

  it('keeps a short single-word message unchanged', () => {
    expect(deriveSessionTitleFromFirstMessage('hi')).toBe('hi');
  });
});

// R3: pure gate — a session that already has a user message must never be
// re-titled from a later follow-up (a resumed session's replayed history is
// the realistic trigger; its title may still be a placeholder even though
// it already has real content).
describe('sessionHasUserMessage', () => {
  it('is false for an empty message list', () => {
    expect(sessionHasUserMessage([])).toBe(false);
  });

  it('is false when only non-user roles are present', () => {
    expect(
      sessionHasUserMessage([{ role: 'assistant' }, { role: 'system' }, { role: 'error' }])
    ).toBe(false);
  });

  it('is true when at least one user message is present', () => {
    expect(sessionHasUserMessage([{ role: 'assistant' }, { role: 'user' }])).toBe(true);
  });

  it('is true for a resumed session’s replayed history, even with a still-placeholder title in play', () => {
    // Simulates the exact bug this gate closes: a session restored from
    // session-index.json already has real user turns in its timeline, but
    // its title was never auto-derived (predates this feature, or the first
    // message had no derivable title). ChatComposer captures this BEFORE
    // calling runSend for a follow-up, so the follow-up must not be mistaken
    // for "the first message".
    const restoredHistory = [
      { role: 'user' },
      { role: 'assistant' },
      { role: 'user' },
      { role: 'assistant' },
    ];
    expect(sessionHasUserMessage(restoredHistory)).toBe(true);
  });
});

// R4: the `Session xxxxxx` fallback title FORMATTER (`fallbackSessionTitle`,
// moved here from sessionIndexMerge.ts) and RECOGNIZER (`isPlaceholderTitle`
// above) must derive from the same id-suffix shape — a UUID session id's
// `slice(-6)` can itself contain a `-`, which the old
// `[0-9a-zA-Z]{6}`-only regex failed to recognize.
describe('fallbackSessionTitle / isPlaceholderTitle unify (R4)', () => {
  it('recognizes its own output when the id tail crosses a hyphen (UUID-shaped id)', () => {
    // 'sess-ab-c12'.slice(-6) === 'ab-c12' — mirrors the exact "Session
    // ab-c12" example from the point-check.
    const title = fallbackSessionTitle('sess-ab-c12');
    expect(title).toBe('Session ab-c12');
    expect(isPlaceholderTitle(title)).toBe(true);
  });

  it('recognizes its own output for a Date.now()-numeric tail and an underscore tail', () => {
    expect(isPlaceholderTitle(fallbackSessionTitle('session-1732000000000'))).toBe(true);
    expect(isPlaceholderTitle(fallbackSessionTitle('sess_abc_123'))).toBe(true);
  });

  it('recognizes its own output for ANY whitespace-free id tail, not just an allowlisted alphabet', () => {
    // The formatter slices whatever the id ends with — the recognizer must
    // accept the formatter's whole output domain, or the contract drifts.
    expect(isPlaceholderTitle(fallbackSessionTitle('session-x.abcd'))).toBe(true);
    expect(isPlaceholderTitle(fallbackSessionTitle('id@v2#7+'))).toBe(true);
  });

  it('recognizes its own output for an id shorter than 6 characters (slice(-6) yields fewer)', () => {
    expect(fallbackSessionTitle('ab1')).toBe('Session ab1');
    expect(isPlaceholderTitle('Session ab1')).toBe(true);
  });

  // Accepted residual (R4): the recognizer cannot distinguish an
  // app-generated fallback title from a user manually typing the identical
  // shape by coincidence (e.g. renaming a session to literally "Session
  // ab-c1d") — it is over-inclusive by construction, not under-inclusive.
  // R3's `sessionHasUserMessage` gate caps the real-world blast radius to a
  // zero-message session the user deliberately renamed to look like the
  // fallback shape; no assertion is made that such a title is "correctly"
  // recognized as non-placeholder, because that would not be true.
});
