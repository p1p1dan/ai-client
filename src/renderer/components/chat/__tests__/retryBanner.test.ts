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

/** Catalog-backed Chinese translator, shared by the T093 and T067 blocks. */
const zhTranslate = (key: string, params?: Record<string, string | number>) =>
  translate('zh', key, params);

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
 * T093 (decision 029 clause 3) — the countdown is derived, not formatted once.
 *
 * The defect this replaces: the banner printed 「30 秒后重试」 at the instant the
 * event arrived and then held that text for the whole backoff, so a user
 * watching a stalled turn could not tell a countdown from a frozen screen.
 *
 * The clock is INJECTED (`nowMs`), never read off `Date.now()`, which is what
 * makes the whole progression assertable here rather than in a timer test.
 */
describe('deriveRetryBanner — live countdown (T093)', () => {
  /** Arbitrary fixed epoch; only the differences matter. */
  const AT = 1_700_000_000_000;
  const LIVE: RetryBannerInput = {
    ...FULL,
    retry: { ...FULL.retry, delayMs: 10_000, retryAt: AT + 10_000 },
    nowMs: AT,
  };

  it('counts down from retryAt against the injected clock', () => {
    const at = (offsetMs: number) => deriveRetryBanner({ ...LIVE, nowMs: AT + offsetMs })?.detail;
    expect(at(0)).toBe('Next attempt in 10s · unknown');
    expect(at(1_000)).toBe('Next attempt in 9s · unknown');
    expect(at(7_000)).toBe('Next attempt in 3s · unknown');
    // Sub-second remainder keeps the existing `<1s` wording rather than `0s`:
    // one formatter serves both shapes, so they cannot word the tail
    // differently.
    expect(at(9_500)).toBe('Next attempt in <1s · unknown');
  });

  it('switches to "retrying now" once retryAt has passed', () => {
    // Exactly at the instant, and well past it: the attempt is out, so there
    // is nothing left to count and a `0s` would be a lie with a number on it.
    expect(deriveRetryBanner({ ...LIVE, nowMs: AT + 10_000 })?.detail).toBe(
      'Retrying now… · unknown'
    );
    expect(deriveRetryBanner({ ...LIVE, nowMs: AT + 45_000 })?.detail).toBe(
      'Retrying now… · unknown'
    );
    expect(deriveRetryBanner({ ...LIVE, nowMs: AT + 45_000 }, zhTranslate)?.detail).toBe(
      '正在重试… · unknown'
    );
    // The title never claims the turn died: the retry IS the turn continuing.
    expect(deriveRetryBanner({ ...LIVE, nowMs: AT + 45_000 })?.title).toContain(TITLE_TAIL);
  });

  it('falls back to the static text when retryAt is absent', () => {
    // An old worker sends `delayMs` only. A clock alone must not turn that
    // duration into a countdown it is not running.
    expect(deriveRetryBanner({ ...FULL, nowMs: AT })?.detail).toBe('Next attempt in 8s · unknown');
    // And the reverse: `retryAt` with no clock (every turn but the in-flight
    // one is handed `STATIC_NOW_MS`, which is 0) degrades the same way.
    expect(deriveRetryBanner({ ...LIVE, nowMs: undefined })?.detail).toBe(
      'Next attempt in 10s · unknown'
    );
    expect(deriveRetryBanner({ ...LIVE, nowMs: 0 })?.detail).toBe('Next attempt in 10s · unknown');
    // Neither field: the timing segment disappears, it is never invented.
    expect(
      deriveRetryBanner({ ...FULL, retry: { ...FULL.retry, delayMs: 0 }, nowMs: AT })?.detail
    ).toBe('unknown');
  });
});

/**
 * T093 — a delegate's retry says so.
 *
 * Before decision 029 clause 8 the delegate's provider budget carried no
 * callbacks at all, so a fan-out sitting in a gateway outage was silent. Now
 * that it banners, the banner has to name whose request it is: it renders in
 * the PARENT's timeline, where an unattributed 「正在重试」 reads as the main
 * conversation being stuck.
 */
describe('deriveRetryBanner — subagent attribution (T093)', () => {
  const DELEGATED: RetryBannerInput = {
    ...FULL,
    retry: { ...FULL.retry, delegationId: '1103083d-0000-0000-0000-000000000000' },
  };

  it('names the delegate when the retry belongs to a subagent', () => {
    expect(deriveRetryBanner({ ...DELEGATED, delegateName: 'code-reviewer' })?.title).toBe(
      `Subagent code-reviewer · Network retry 2/10 ${TITLE_TAIL}`
    );
    expect(
      deriveRetryBanner({ ...DELEGATED, delegateName: 'code-reviewer' }, zhTranslate)?.title
    ).toBe('子代理 code-reviewer · 网络重试中 · 2/10 · 本回合仍在进行');
  });

  it('falls back to the bare noun rather than printing a uuid', () => {
    // The lane that knows the name may not exist yet (a retry can precede the
    // delegate's first event) or may have been evicted. `delegationId` still
    // proves a delegate is involved, so the attribution survives the name.
    for (const delegateName of [undefined, null, '', '   ']) {
      const view = deriveRetryBanner({ ...DELEGATED, delegateName });
      expect(view?.title, `delegateName=${JSON.stringify(delegateName)}`).toBe(
        `A subagent · Network retry 2/10 ${TITLE_TAIL}`
      );
      expect(view?.title).not.toContain('1103083d');
    }
  });

  it('leaves the main conversation unprefixed, name or no name', () => {
    expect(deriveRetryBanner(FULL)?.title).toBe(`Network retry 2/10 ${TITLE_TAIL}`);
    // A stale name with no delegation is not attribution — `delegationId` is
    // the only thing that decides whose request this is.
    expect(deriveRetryBanner({ ...FULL, delegateName: 'code-reviewer' })?.title).toBe(
      `Network retry 2/10 ${TITLE_TAIL}`
    );
    for (const delegationId of ['', '   ']) {
      expect(deriveRetryBanner({ ...FULL, retry: { ...FULL.retry, delegationId } })?.title).toBe(
        `Network retry 2/10 ${TITLE_TAIL}`
      );
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
  const zh = zhTranslate;

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
