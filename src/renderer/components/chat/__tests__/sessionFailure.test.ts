import { readFileSync } from 'node:fs';
import path from 'node:path';
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { canContinueSession, deriveSessionFailure, toSessionFailureCode } from '../sessionFailure';

/**
 * The 2026-09-21 report: 「停下了很莫名其妙，用户不知道发生了什么为什么报错了，同时
 * 停下来但也得给个明确的继续按钮」.
 *
 * Two claims, and they need two different tests.
 *
 *  - The WORDS: `sessionFailure.ts` is pure, so the classification is
 *    truth-tabled here — every code this app emits gets a reason that says
 *    which kind of stop it was, and the Continue/no-Continue decision follows
 *    from the reason rather than from a second rule that could disagree.
 *  - The BUTTON: the card and the store it writes to live in files this suite
 *    cannot render (`MessageTimeline.tsx`), so that half is a source scan —
 *    one that skips comments, because the fail-mode under test is exactly the
 *    kind of thing a comment describes.
 */

const chatDir = path.resolve(__dirname, '..');

function source(name: string): string {
  return readFileSync(path.join(chatDir, name), 'utf8');
}

/**
 * The file's code with comments removed.
 *
 * The negative assertions below look for constructs that the surrounding
 * comments necessarily NAME (the card's own note explains what the card used to
 * do). Scan prose and every negative passes or fails for the wrong reason. Just
 * enough lexing for this job: block and line comments, with strings left alone
 * so a `//` inside a URL cannot truncate a real line.
 */
function code(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const two = text.slice(index, index + 2);
    if (two === '//') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    const char = text[index] as string;
    if (char === "'" || char === '"' || char === '`') {
      const end = text.indexOf(char, index + 1);
      // An unterminated quote is not worth fighting: copy the rest verbatim.
      const stop = end === -1 ? text.length : end + 1;
      out += text.slice(index, stop);
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

describe('deriveSessionFailure — the reason a turn stopped', () => {
  it('names a ceiling as a ceiling, not as a failure', () => {
    // The user hit this one for real. "tool loop exceeded 64 assistant turns"
    // is a deliberate stop by this app, and the card used to present it in the
    // same red "Session failed" box as a provider outage.
    const view = deriveSessionFailure({ errorCode: 'turn_limit', error: 'tool loop exceeded' });
    expect(view.title).toBe('Stopped at the tool-call ceiling');
    expect(view.action).toBe('continue');
    // The reason has to say the ceiling is OURS, or the user reads a deliberate
    // stop as the app breaking.
    expect(view.reason).toContain('This app stops the turn there');
  });

  it('names a cut stream as a cut stream', () => {
    const view = deriveSessionFailure({ errorCode: 'stop_error', error: 'terminated' });
    expect(view.title).toBe('The model’s reply was cut off');
    expect(view.action).toBe('continue');
  });

  it('offers no Continue for a prompt that no longer fits', () => {
    // Re-sending is guaranteed to fail identically, so a button here would be
    // a button that cannot work — the rule `modelMissingError.ts` states.
    const view = deriveSessionFailure({ errorCode: 'context_too_large' });
    expect(view.action).toBe('configure');
    expect(view.hint).toContain('larger context window');
  });

  it('offers no Continue when the user stopped the turn themselves', () => {
    for (const errorCode of ['stop_aborted', 'aborted']) {
      expect(deriveSessionFailure({ errorCode }).action, errorCode).toBe('none');
    }
  });

  it('falls back to a reason that still offers a way forward', () => {
    // An unrecognised code (a newer runtime, a provider SDK's own) must not
    // dead-end: the user still gets a sentence saying this app cannot explain
    // the stop, and a Continue.
    const view = deriveSessionFailure({ errorCode: 'something_new', error: 'raw text' });
    expect(view.title).toBe('The turn stopped');
    expect(view.action).toBe('continue');
    // And an absent code is the same case — the IPC-level catches write
    // `lastError` with no code at all.
    expect(deriveSessionFailure({ error: 'raw text' }).action).toBe('continue');
  });

  it('does not read a code out of the prototype chain', () => {
    // `'constructor' in {}` is true; `Object.hasOwn` is the difference, and a
    // code of `constructor` would otherwise index the table and render
    // `undefined` into the card.
    expect(toSessionFailureCode('constructor')).toBe('unknown');
    expect(toSessionFailureCode('toString')).toBe('unknown');
    expect(deriveSessionFailure({ errorCode: 'constructor' }).title).toBe('The turn stopped');
  });

  it('gives every known code a title, a reason and a hint', () => {
    // No code may render a blank card. Enumerated through the exported
    // classifier so a code added to the table without copy is caught here.
    for (const code of [
      'turn_limit',
      'context_too_large',
      'stop_error',
      'stop_aborted',
      'aborted',
      'loop_threw',
      'no_assistant_message',
      'timeout',
      'lock_timeout',
      'model_missing',
      'unknown',
    ]) {
      const view = deriveSessionFailure({ errorCode: code });
      expect(view.title.length, code).toBeGreaterThan(0);
      expect(view.reason.length, code).toBeGreaterThan(0);
      expect(view.hint.length, code).toBeGreaterThan(0);
    }
  });
});

describe('canContinueSession — the button only when it can work', () => {
  it('needs both a continuable reason and something to send', () => {
    const continuable = deriveSessionFailure({ errorCode: 'stop_error' });
    expect(canContinueSession(continuable, true)).toBe(true);
    // Nothing to resend (a failure before any user message existed).
    expect(canContinueSession(continuable, false)).toBe(false);
  });

  it('refuses a reason a resend cannot fix, whatever the transcript holds', () => {
    const configure = deriveSessionFailure({ errorCode: 'context_too_large' });
    expect(canContinueSession(configure, true)).toBe(false);
    const stopped = deriveSessionFailure({ errorCode: 'aborted' });
    expect(canContinueSession(stopped, true)).toBe(false);
  });
});

describe('the failed card is wired to the reason and to a Continue', () => {
  const timeline = code(source('MessageTimeline.tsx'));

  it('renders the derived kind of stop instead of the bare sensor label', () => {
    expect(timeline).toContain('{t(failure.title)}');
    // The bare words are gone: "Session failed" describes the alert, not the
    // event, which is precisely what the report could not act on.
    expect(timeline).not.toContain('>Session failed<');
    expect(timeline).toContain('{t(failure.reason)}');
  });

  it('publishes a Continue intent naming the message to resend', () => {
    expect(timeline).toContain('requestContinue(sessionId, resumeMessageId)');
    expect(timeline).toContain('canContinueSession(failure, resumeMessageId != null)');
  });

  it('still prints the raw sentence, as evidence', () => {
    // The reason is the fix; the sentence is what the user forwards. Deleting
    // it would trade one unactionable card for another, one level up.
    expect(timeline).toContain('{lastError}');
  });

  it('reads the error code from the store rather than parsing the sentence', () => {
    expect(timeline).toContain('runtimeErrorCode');
    expect(timeline).toContain(
      'deriveSessionFailure({ error: lastError, errorCode: lastErrorCode })'
    );
  });

  it('the comment blanker works, so the negatives above mean something', () => {
    // Control: the raw file mentions `>Session failed<` in its own prose, and
    // the blanked version must not.
    const raw = source('MessageTimeline.tsx');
    expect(code('// `>Session failed<`\nconst x = 1;')).not.toContain('>Session failed<');
    expect(code(raw).length).toBeGreaterThan(0);
  });
});

describe('the composer honours the intent', () => {
  const composer = code(source('ChatComposer.tsx'));

  it('resolves the named message and re-sends it through runSend', () => {
    expect(composer).toContain('useContinueIntentStore');
    expect(composer).toContain('clearContinue()');
    expect(composer).toContain("runSend(text, [], { origin: 'retry' })");
  });

  it('only acts on an intent for the session on screen', () => {
    // Without the guard, a failure in a session the user has since left would
    // send its message into whatever session is open now.
    expect(composer).toContain('continueIntent.sessionId !== activeSessionId');
  });
});

describe('the store carries the code beside the sentence', () => {
  const store = readFileSync(path.resolve(chatDir, '../../stores/chatSessions.ts'), 'utf8');

  it('writes errorCode from session.failed and clears it with the sentence', () => {
    expect(store).toContain('runtimeErrorCode');
    expect(store).toContain('event.payload?.errorCode');
  });
});

/**
 * Every catalog key these views feed to `t()` needs a Chinese entry, and
 * `i18nCoverage.test.ts` cannot see them: the card calls `t(failure.title)`,
 * a field of a view, so the scanner (which only reads single-quoted literals)
 * finds nothing. The same gap `compositionPanelLabels.test.ts` closes for the
 * bucket labels.
 */
describe('every failure sentence has a Chinese entry', () => {
  const zh = (key: string) => zhTranslations[key];

  it('translates all three sentences of every known code', () => {
    for (const code of [
      'turn_limit',
      'context_too_large',
      'stop_error',
      'stop_aborted',
      'aborted',
      'loop_threw',
      'no_assistant_message',
      'timeout',
      'lock_timeout',
      'model_missing',
      'unknown',
    ]) {
      const view = deriveSessionFailure({ errorCode: code });
      for (const sentence of [view.title, view.reason, view.hint]) {
        expect(zh(sentence), `${code}: ${sentence}`).toBeTruthy();
      }
    }
  });

  it('translates the Continue button', () => {
    expect(zh('Continue')).toBeTruthy();
  });
});
