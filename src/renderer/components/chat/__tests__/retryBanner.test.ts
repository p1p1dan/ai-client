import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { deriveRetryBanner, type RetryBannerInput } from '../retryBanner';

/**
 * T-33 acceptance ③: every field-absence combination of `SessionRetryInfo`.
 *
 * Absence arrives in TWO shapes and both matrices below matter: the
 * normalizer's sentinels (`0` / `null` / `'unknown'` — the shape that actually
 * crosses IPC today, see `eventNormalizer.ts`'s `api_retry` branch) and plain
 * `undefined` (the shape the `Partial` input type admits, so a future host
 * that stops filling defaults cannot make the banner print `undefined/10`).
 */

const FULL: RetryBannerInput = {
  retry: {
    attempt: 2,
    maxRetries: 10,
    delayMs: 8000,
    errorStatus: null,
    error: 'unknown',
  },
  inFlight: true,
  outputSinceRetry: false,
};

const TITLE_TAIL = '— the turn is still running';

describe('deriveRetryBanner — gate', () => {
  it('no retry state renders nothing, in every gate position', () => {
    expect(deriveRetryBanner({ ...FULL, retry: null })).toBeNull();
    expect(deriveRetryBanner({ ...FULL, retry: undefined })).toBeNull();
  });

  it('a completed session cannot be mid-retry, whatever the stale field claims', () => {
    expect(deriveRetryBanner({ ...FULL, inFlight: false })).toBeNull();
  });

  it('output arriving AFTER the retry disproves it — and only that', () => {
    // The boolean is defined caller-side as "new blocks since THIS retry
    // payload appeared" (MessageTimeline's blockCountAtRetry snapshot).
    // F1 (Codex review): a pre-retry tool call keeps this false, so a
    // mid-turn retry after tool output still banners.
    expect(deriveRetryBanner({ ...FULL, outputSinceRetry: true })).toBeNull();
    expect(deriveRetryBanner({ ...FULL, outputSinceRetry: false })).not.toBeNull();
  });
});

describe('deriveRetryBanner — full payload', () => {
  it('renders counts, humanized delay and the error label', () => {
    expect(deriveRetryBanner(FULL)).toEqual({
      title: `Network retry 2/10 ${TITLE_TAIL}`,
      detail: 'Next attempt in 8s · unknown',
    });
  });

  it('appends the HTTP status after the error label, Context-panel ordering', () => {
    const view = deriveRetryBanner({
      ...FULL,
      retry: { ...FULL.retry, errorStatus: '529' },
    });
    expect(view?.detail).toBe('Next attempt in 8s · unknown 529');
  });

  // Round-10 inspection ④: the user's live 503 was the UPSTREAM refusing
  // ("No available accounts"), not a network problem — a present HTTP status
  // must flip the title off the "Network" wording.
  it('an HTTP status makes the title say upstream error, not network', () => {
    const view = deriveRetryBanner({
      ...FULL,
      retry: { ...FULL.retry, errorStatus: '503', error: 'server_error' },
    });
    expect(view?.title).toBe(`Upstream error 503 — retrying 2/10, the turn is still running`);
    expect(view?.detail).toBe('Next attempt in 8s · server_error 503');
  });

  it('a null status (transport-layer sentinel) keeps the network wording', () => {
    expect(deriveRetryBanner(FULL)?.title).toBe(`Network retry 2/10 ${TITLE_TAIL}`);
  });
});

describe('deriveRetryBanner — count degradation (attempt-first)', () => {
  it('missing attempt drops the whole count, even with a ceiling present', () => {
    for (const attempt of [0, undefined, -1, Number.NaN]) {
      const view = deriveRetryBanner({ ...FULL, retry: { ...FULL.retry, attempt } });
      expect(view?.title, `attempt=${attempt}`).toBe(`Network retry ${TITLE_TAIL}`);
    }
  });

  it('missing ceiling keeps the bare attempt number', () => {
    for (const maxRetries of [0, undefined]) {
      const view = deriveRetryBanner({ ...FULL, retry: { ...FULL.retry, maxRetries } });
      expect(view?.title, `maxRetries=${maxRetries}`).toBe(`Network retry 2 ${TITLE_TAIL}`);
    }
  });
});

describe('deriveRetryBanner — delay segment', () => {
  it('missing delay drops the segment (0 is the normalizer sentinel)', () => {
    for (const delayMs of [0, undefined, -500, Number.NaN]) {
      const view = deriveRetryBanner({ ...FULL, retry: { ...FULL.retry, delayMs } });
      expect(view?.detail, `delayMs=${delayMs}`).toBe('unknown');
    }
  });

  it('sub-second backoffs never print 0s', () => {
    const view = deriveRetryBanner({ ...FULL, retry: { ...FULL.retry, delayMs: 500 } });
    expect(view?.detail).toBe('Next attempt in <1s · unknown');
  });

  it('rounds to whole seconds', () => {
    const at = (delayMs: number) =>
      deriveRetryBanner({ ...FULL, retry: { ...FULL.retry, delayMs } })?.detail;
    expect(at(1499)).toBe('Next attempt in 1s · unknown');
    expect(at(1501)).toBe('Next attempt in 2s · unknown');
    expect(at(32000)).toBe('Next attempt in 32s · unknown');
  });
});

describe('deriveRetryBanner — error segment', () => {
  it('a bare HTTP status stands alone when the label is missing', () => {
    for (const error of ['', undefined]) {
      const view = deriveRetryBanner({
        ...FULL,
        retry: { ...FULL.retry, error, errorStatus: '529' },
      });
      expect(view?.detail, `error=${JSON.stringify(error)}`).toBe('Next attempt in 8s · 529');
    }
  });

  it('missing label and status drop the segment entirely', () => {
    const view = deriveRetryBanner({
      ...FULL,
      retry: { ...FULL.retry, error: '', errorStatus: null },
    });
    expect(view?.detail).toBe('Next attempt in 8s');
  });
});

describe('deriveRetryBanner — everything absent', () => {
  it('an empty retry object still banners: the event itself is the fact', () => {
    for (const retry of [
      {},
      { attempt: 0, maxRetries: 0, delayMs: 0, errorStatus: null, error: '' },
    ]) {
      expect(deriveRetryBanner({ ...FULL, retry })).toEqual({
        title: `Network retry ${TITLE_TAIL}`,
        detail: null,
      });
    }
  });
});

/**
 * T067 (D21) — the banner in the app's default language.
 *
 * Two 503 rounds were photographed on 2026-09-17 with this banner reading
 * 「Upstream error 503 — retrying 1/3…」 while the composer one line below
 * said 「正在重试 · 1/3 · 3 秒后重试」 about the same retry. Same fact, two
 * languages, eight pixels apart.
 *
 * All four title shapes are covered because the count is what picks the key:
 * a missing `attempt` must not fall back to the English template, which is the
 * failure mode a single happy-path assertion would miss.
 */
describe('deriveRetryBanner — Chinese (T067 D21)', () => {
  const zh = (key: string, params?: Record<string, string | number>) =>
    translate('zh', key, params);

  it('words all four title shapes from the catalog', () => {
    expect(deriveRetryBanner(FULL, zh)?.title).toBe('网络重试中 · 2/10 · 本回合仍在进行');
    expect(deriveRetryBanner({ ...FULL, retry: { delayMs: 8000 } }, zh)?.title).toBe(
      '网络重试中 · 本回合仍在进行'
    );
    expect(
      deriveRetryBanner({ ...FULL, retry: { ...FULL.retry, errorStatus: '503' } }, zh)?.title
    ).toBe('上游返回错误 503 · 正在重试 2/10 · 本回合仍在进行');
    expect(deriveRetryBanner({ ...FULL, retry: { errorStatus: '503' } }, zh)?.title).toBe(
      '上游返回错误 503 · 正在重试 · 本回合仍在进行'
    );
  });

  it('words the delay segment and leaves the upstream error text alone', () => {
    const view = deriveRetryBanner(
      { ...FULL, retry: { ...FULL.retry, errorStatus: '503', error: 'server_error' } },
      zh
    );
    expect(view?.detail).toBe('8s 后重试 · server_error 503');
    // The gateway's own words are not ours to translate — only our frame is.
    expect(view?.detail).toContain('server_error');
  });

  it('reverse: the default translator still emits the exact English bytes', () => {
    // The whole point of the `englishTranslate` default. If this drifts, an
    // un-threaded call site is silently producing different copy rather than
    // the same copy in a different language.
    expect(deriveRetryBanner(FULL)?.title).toBe(`Network retry 2/10 ${TITLE_TAIL}`);
    expect(deriveRetryBanner(FULL)?.detail).toBe('Next attempt in 8s · unknown');
    expect(deriveRetryBanner(FULL, zh)?.title).not.toMatch(/Network retry|the turn is still/);
  });
});
