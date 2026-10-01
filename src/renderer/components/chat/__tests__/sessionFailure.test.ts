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

  it('names a reply the loop guard cut as the model repeating itself', () => {
    // 2026-09-24: one GLM reply dictated the same three Task* calls ~1,900
    // times. Reported as `stop_error` it would read "the provider cut the
    // reply", which is false and sends the user to the wrong fix.
    const view = deriveSessionFailure({
      errorCode: 'tool_call_repetition',
      error: 'The model wrote the same subagent tool call 3 times in one reply (TaskList {}).',
    });
    expect(view.title).toBe('The model repeated the same tool calls, so its reply was stopped');
    expect(view.reason).toContain('ran none of the tool calls');
    expect(view.action).toBe('continue');
    expect(zhTranslations[view.title]).toBe('模型输出出现重复调用，已中断');
    expect(zhTranslations[view.hint]).toContain('可以继续发消息');
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

  it('names the engine going away as the engine, and leaves its process sentence out (P1-3c)', () => {
    // dsh-rebase P1-3c: Main writes these two for a turn the shared engine
    // process took with it. "Worker exited (code=null signal=SIGKILL)" is the
    // raw English the point-check must not show.
    const crashed = deriveSessionFailure({
      errorCode: 'dsh_host_crashed',
      error: 'Worker exited (code=null signal=SIGKILL)',
    });
    expect(crashed.title).toBe('The chat engine stopped unexpectedly');
    expect(crashed.action).toBe('continue');
    expect(crashed.showsDetail).toBe(false);
    expect(zhTranslations[crashed.title]).toBe('对话引擎意外退出');
    const restarted = deriveSessionFailure({ errorCode: 'dsh_engine_restarted' });
    expect(restarted.title).toBe('The chat engine was restarted');
    expect(restarted.reason).toContain('another chat');
    expect(restarted.action).toBe('continue');
    expect(restarted.showsDetail).toBe(false);
    expect(zhTranslations[restarted.title]).toBe('对话引擎已重启');
    // Every other code keeps printing its sentence as evidence.
    expect(deriveSessionFailure({ errorCode: 'stop_error' }).showsDetail).toBe(true);
    expect(deriveSessionFailure({ errorCode: 'something_new' }).showsDetail).toBe(true);
  });

  it('[P1-4d1] a DSH code that means an existing card reads that card', () => {
    // src/shared/dshFailureCodes.ts names DSH failures in the native provider vocabulary.
    expect(toSessionFailureCode('TIMEOUT')).toBe('timeout');
    expect(toSessionFailureCode('CONTEXT_TOO_LARGE')).toBe('context_too_large');
    expect(toSessionFailureCode('MODEL_NOT_CONFIGURED')).toBe('model_missing');
    expect(deriveSessionFailure({ errorCode: 'CONTEXT_TOO_LARGE' }).action).toBe('configure');
    expect(toSessionFailureCode('tool_call_repetition')).toBe('tool_call_repetition');
  });

  // dsh-rebase P1-7c (decision 106 rule 42): the four provider classes that
  // had only the generic card get their own; DSH's sentence stays the detail.
  it.each([
    ['PROVIDER_UNAUTHORIZED', 'The model service refused the key', 'configure'],
    ['PROVIDER_RATE_LIMITED', 'The model service is limiting requests', 'continue'],
    ['NETWORK_ERROR', 'The model service could not be reached', 'continue'],
    ['PROVIDER_ERROR', 'The model service returned an error', 'continue'],
  ] as const)('[P1-7c] %s has a card of its own', (code, title, action) => {
    expect(toSessionFailureCode(code)).toBe(code);
    const view = deriveSessionFailure({ errorCode: code, error: 'DSH sentence' });
    expect(view.title).toBe(title);
    expect(view.action).toBe(action);
    expect(view.showsDetail).toBe(true);
    expect(view.title).not.toBe(deriveSessionFailure({ errorCode: 'unknown' }).title);
  });

  it('[P1-7c] the repetition card names the background-task tools DSH also guards', () => {
    const view = deriveSessionFailure({ errorCode: 'tool_call_repetition' });
    expect(view.reason).toContain('subagent or background-task tool call');
    expect(zhTranslations[view.reason]).toContain('子代理或后台任务工具调用');
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
      'tool_call_repetition',
      'timeout',
      'lock_timeout',
      'model_missing',
      'dsh_host_crashed',
      'dsh_engine_restarted',
      'CREDENTIALS_UNAVAILABLE',
      'PROVIDER_UNAUTHORIZED',
      'PROVIDER_RATE_LIMITED',
      'NETWORK_ERROR',
      'PROVIDER_ERROR',
      'GATEWAY_STREAM_GATE',
      'GATEWAY_NO_UPSTREAM',
      'MODEL_SETTING_UNSUPPORTED',
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
    // dsh-rebase P1-5b: no key until the user signs in or unlocks the keyring.
    const keyless = deriveSessionFailure({ errorCode: 'CREDENTIALS_UNAVAILABLE' });
    expect(keyless.title).toBe('The model service key is not available');
    expect(canContinueSession(keyless, true)).toBe(false);
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

  it("publishes a Continue intent naming the failed turn's prompt", () => {
    expect(timeline).toContain('requestContinue(sessionId, resumeMessageId)');
    expect(timeline).toContain('canContinueSession(failure, resumeMessageId != null)');
    // T135: the button is gated on the failure having settled.
    expect(timeline).toContain('<FailureContinueButton');
  });

  it('still prints the raw sentence, as evidence', () => {
    // The reason is the fix; the sentence is what the user forwards. Deleting
    // it would trade one unactionable card for another, one level up.
    expect(timeline).toContain('{lastError}');
    // Except where the code says the sentence is this app's own about its
    // engine process (P1-3c).
    expect(timeline).toContain('failure.showsDetail');
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

  it('retries the failed turn through runSend instead of re-sending its prompt (T135)', () => {
    expect(composer).toContain('useContinueIntentStore');
    expect(composer).toContain('clearContinue()');
    expect(composer).toContain(
      "runSend('', [], { origin: 'retry', retryLastTurn: { fallbackText } })"
    );
    // The old resend — the prompt as a second user message — is gone.
    expect(composer).not.toContain("runSend(text, [], { origin: 'retry' })");
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
      'tool_call_repetition',
      'timeout',
      'lock_timeout',
      'model_missing',
      'dsh_host_crashed',
      'dsh_engine_restarted',
      'CREDENTIALS_UNAVAILABLE',
      'PROVIDER_UNAUTHORIZED',
      'PROVIDER_RATE_LIMITED',
      'NETWORK_ERROR',
      'PROVIDER_ERROR',
      'GATEWAY_STREAM_GATE',
      'GATEWAY_NO_UPSTREAM',
      'MODEL_SETTING_UNSUPPORTED',
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
    // Decision 140: and every label a view gives it instead.
    expect(zh('Continue anyway')).toBe('仍然继续');
  });
});

/**
 * dsh-rebase P1-7e (decision 140): the two provider failures the bridge reads
 * off their text. Their cards say what the user can do, since retrying
 * the same request does not help.
 */
describe('the gateway stream gate and a refused model setting', () => {
  const zh = (key: string) => zhTranslations[key];

  it('[E2B-CARD-GATE] names the company gateway, keeps its hint beside a Continue that says it is a long shot', () => {
    const view = deriveSessionFailure({
      errorCode: 'GATEWAY_STREAM_GATE',
      error: '{"error":{"type":"stream_gate_precommit","reason":"prebuffer_overflow"}}',
    });
    expect(zh(view.title)).toBe('公司网关中断了这次回复');
    expect(zh(view.reason)).toBe('公司网关在模型开始回答之前中断了这次回复。');
    expect(zh(view.hint)).toBe(
      '重试同一请求通常还会失败。请换一个模型或调低思考档位，并把错误详情转给网关管理员。'
    );
    expect(view.action).toBe('continue');
    expect(canContinueSession(view, true)).toBe(true);
    expect(view.hintWithContinue).toBe(true);
    expect(view.continueLabel).toBe('Continue anyway');
    // The raw text is what the gateway administrator needs.
    expect(view.showsDetail).toBe(true);
  });

  it('[E2B-CARD-SETTING] sends the user to the thinking settings, with no Continue', () => {
    const view = deriveSessionFailure({
      errorCode: 'MODEL_SETTING_UNSUPPORTED',
      error: '"thinking.type.disabled" is not supported for this model',
    });
    expect(zh(view.title)).toBe('模型设置与该模型不兼容');
    expect(zh(view.hint)).toContain('思考相关配置');
    expect(view.action).toBe('configure');
    expect(canContinueSession(view, true)).toBe(false);
    expect(view.showsDetail).toBe(true);
    expect(view).not.toHaveProperty('continueLabel');
    expect(view).not.toHaveProperty('hintWithContinue');
  });

  it('[E2B-CARD-WIRING] the card shows the hint beside the button when the view says so, with its label', () => {
    const timeline = code(source('MessageTimeline.tsx'));
    expect(timeline).toContain('failure.hintWithContinue');
    expect(timeline).toContain('label={failure.continueLabel}');
    expect(code(source('FailureContinueButton.tsx'))).toContain('{t(label)}');
  });

  it('[GW2-CARD] a gateway with no upstream left: says why it was not retried, keeps a long-shot Continue (decision 146)', () => {
    const view = deriveSessionFailure({
      errorCode: 'GATEWAY_NO_UPSTREAM',
      error: '503: {"message":"No available providers","type":"no_available_providers"}',
    });
    expect(zh(view.title)).toBe('公司网关目前没有可用的模型服务');
    expect(zh(view.reason)).toContain('请求没有送到模型');
    expect(zh(view.hint)).toBe(
      '马上重试只会得到同样的答复，所以没有自动重试。请换一个模型或稍后再试；如果一直这样，请把错误详情转给网关管理员。'
    );
    expect(view.action).toBe('continue');
    expect(canContinueSession(view, true)).toBe(true);
    expect(view.hintWithContinue).toBe(true);
    expect(view.continueLabel).toBe('Continue anyway');
    // The gateway's own text, session marker included, is what its administrator needs.
    expect(view.showsDetail).toBe(true);
  });
});
