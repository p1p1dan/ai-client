import { readFileSync } from 'node:fs';
import path from 'node:path';
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';

/**
 * 2026-09-20 user report — the composition panel, after the buckets landed.
 *
 * ## The two things the pure suite cannot see
 *
 * `conversationSegments.test.ts` proves the buckets are computed correctly. It
 * says nothing about whether the VIEW draws them, and nothing about whether a
 * reader can tell them apart from the numbers on the Run panel — which is
 * exactly what the report was about. The user read 「助手 424.3k 99%」 as a token
 * figure and asked whether the cache rate was broken; the panel was showing
 * characters, the Run panel was showing tokens, and neither said so.
 *
 * So: labels are asserted by BOTH their key and their zh string. `t(BUCKET
 * _LABEL[id])` is a variable lookup, and `i18nCoverage.test.ts` deliberately
 * cannot see those (it scans single-quoted literals only) — a renamed bucket
 * would sail past it and render 「Tool output」 in a Chinese UI. Reading the key
 * out of the source and checking it against the catalog closes that gap without
 * pretending the scanner can.
 */
const viewPath = path.join(
  process.cwd(),
  'src/renderer/components/workspace-shell/surfaces/ContextSurfaceView.tsx'
);
const view = readFileSync(viewPath, 'utf8');

describe('the composition panel states what it is counting', () => {
  it('labels the four content buckets, and every label has a zh entry', () => {
    const block = view.slice(view.indexOf('const BUCKET_LABEL'));
    const literal = block.slice(0, block.indexOf('};'));
    for (const key of ['Your instructions', 'Assistant reply', 'Tool output', 'Thinking content']) {
      expect(literal, `${key} is missing from BUCKET_LABEL`).toContain(`'${key}'`);
      // Present AND translated — a key that exists but maps back to itself is
      // how an English label reaches a Chinese screen.
      const zh = zhTranslations[key as keyof typeof zhTranslations];
      expect(typeof zh, `${key} has no zh entry`).toBe('string');
      expect(zh, `${key} is untranslated`).not.toBe(key);
    }
    // `Thinking` alone is the RUNNING status key (「思考中」) — a bucket label must
    // not claim the activity is happening, and reusing the key would have made
    // the legend read 「思考中」 for text that finished long ago.
    expect(literal).not.toContain("thinking: 'Thinking'");
  });

  it('draws the donut from the buckets, not from the senders', () => {
    // The whole point of the change: the ring is the content-kind split.
    expect(view).toContain(
      'conversation.buckets.map((bucket) => ({ key: bucket.id, share: bucket.share }))'
    );
    expect(view).toContain('BUCKET_COLOR[arc.key as ConversationBucketId]');
    // The by-sender view survives as its own bar, so it is not simply deleted.
    expect(view).toContain('conversation.roles.map((role) => (');
    expect(view).toContain("t('By sender')");
  });

  it('says in words that these are characters in this window, not tokens', () => {
    const key =
      'Characters in the messages this window has loaded — not tokens, and not the context window. Token usage is on the Run panel.';
    expect(view).toContain(`t(\n              '${key}'`);
    expect(zhTranslations[key]).toBe(
      '这里是本窗口已加载消息的字符数，不是 token，也不是上下文窗口。token 用量在「运行」面板。'
    );
  });
});
