/**
 * Issue #9 (decision 173 §4.5, prototype README §7): what 「复制诊断信息」
 * copies. Numbers, clock times, the version, the model and effort, and the
 * gateway session id — laid out for a monospace font, and nothing a chat says.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { initialMetadataRegistry, reduceMessageMetadata } from '@/components/chat/messageMetadata';
import { buildCacheDiagnostics, formatClockTime } from '../surfaces/cacheDiagnostics';
import { cacheTurnsOf, collectSettledSteps, deriveRunCacheView } from '../surfaces/runPanelModel';
import { GATEWAY_SESSION, issue9Steps, TURN_START } from './cacheStepsFixture';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

function diagnosticsOf(steps = issue9Steps(), t = zh) {
  const cache = deriveRunCacheView({ steps, hasUnlistedHistory: false, alertDismissed: false }, t);
  return buildCacheDiagnostics(
    {
      appVersion: '1.1.0-dsh.9',
      platform: 'win32',
      model: 'claude-opus-5-5',
      effort: 'max',
      sessionSteps: 22,
      session: cache.session,
      prefix: cache.prefix,
      turns: cacheTurnsOf(steps, t),
    },
    t
  );
}

describe('buildCacheDiagnostics (issue #9)', () => {
  const lines = diagnosticsOf().split('\n');

  it('opens with the version, the gateway session, the model and the totals', () => {
    expect(lines.slice(0, 6)).toEqual([
      'PiLab Ai 缓存诊断（只含数字与网关会话 ID）',
      '版本：1.1.0-dsh.9 · Windows',
      `网关会话 ID：${GATEWAY_SESSION}`,
      '模型：claude-opus-5-5 · 推理档位 max',
      '本会话：22 步，3 步找不到本地原因（其中重建 2 次），共重写约 174,678 tokens',
      '前缀校验：找不到本地原因的请求都是在上一个请求的末尾追加',
    ]);
  });

  it('dates the turn, then lists every step with its time, figures and verdict', () => {
    expect(lines[6]).toBe('');
    // Local time with its UTC offset, so a gateway log in another zone lines up.
    expect(lines[7]).toMatch(/^回合 1 开始于 2026-10-10 14:05:29 UTC[+-]\d{2}:\d{2}$/);
    expect(lines[8]).toBe('');
    const table = lines.slice(9);
    expect(table).toHaveLength(23);
    expect(table[0]).toBe(' 步  时间        提示词    缓存读    缓存写  判定');
    expect(table[1]).toBe('  1  14:05:29     43975         0     43973  首次写入');
    expect(table[2]).toBe('  2  14:05:43     58080     43973     14105');
    expect(table[15]).toBe(' 15  14:13:02    174880     36848    138030  无法解释，重写 132930');
    expect(table[17]).toBe(' 17  14:13:53    185292    169776     15514  读到第 14 步的前缀');
    expect(table[20]).toBe(' 20  14:19:19    140160     98410     41748  提示词变短 −73035');
    // Every step carries its own time.
    for (const [index, line] of table.slice(1).entries()) {
      expect(line, `step ${index + 1}`).toMatch(/^ {1,2}\d{1,2} {2}\d{2}:\d{2}:\d{2} {2}/);
    }
  });

  it('leaves the gateway session line out when the host named none', () => {
    const steps = issue9Steps((spec) =>
      spec.cache
        ? {
            ...spec,
            cache: { ...spec.cache, session: { ...spec.cache.session, gatewaySession: undefined } },
          }
        : spec
    );
    const text = diagnosticsOf(steps);
    expect(text).not.toContain('网关会话 ID：');
    expect(text).not.toContain(GATEWAY_SESSION);
    expect(text.split('\n')[2]).toBe('模型：claude-opus-5-5 · 推理档位 max');
  });

  it('carries nothing the chat said or ran: no prompt, tool input or output, path or address', () => {
    const events = (
      JSON.parse(
        readFileSync(
          join(import.meta.dirname, '../../../../shared/__tests__/fixtures/dsh/stream.usage.json'),
          'utf8'
        )
      ) as { type: string; sessionId?: string; payload?: Record<string, unknown> }[]
    ).map((event, index) => ({ ...event, timestamp: TURN_START + index * 1_000 }));
    const registry = events.reduce(
      (current, event) => reduceMessageMetadata(current, event),
      initialMetadataRegistry
    );
    const steps = collectSettledSteps(registry.byMessage);
    expect(steps).toHaveLength(3);
    const text = diagnosticsOf(steps);

    const said: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === 'string') {
        for (const part of value.split(/\s+/)) if (part.length >= 6) said.push(part);
      } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collect(item);
      }
    };
    for (const event of events) {
      if (/^(message\.delta|thinking\.delta|tool\.)/.test(event.type)) collect(event.payload);
    }
    expect(said).toEqual(expect.arrayContaining(['P1-USAGE:', 'usage-probe']));
    for (const word of said.filter((part) => !/^(dsh-|toolu_|<ms>)/.test(part))) {
      expect(text).not.toContain(word);
    }
    expect(text).not.toMatch(/https?:\/\/|\/home\/|[A-Za-z]:\\/);
    // Two turns, each with its own table.
    expect(text.match(/^回合 \d/gm)).toHaveLength(2);
  });

  it('reads in English from the source strings', () => {
    const english = diagnosticsOf(issue9Steps(), (key, params) => translate('en', key, params));
    expect(english.split('\n')[0]).toBe(
      'PiLab Ai cache diagnostics (numbers and the gateway session ID only)'
    );
    expect(english).toContain(`Gateway session ID: ${GATEWAY_SESSION}`);
    expect(english).toContain('Step  Time        Prompt    Reused   Written  Verdict');
    expect(formatClockTime(TURN_START)).toBe('14:05:12');
  });
});
