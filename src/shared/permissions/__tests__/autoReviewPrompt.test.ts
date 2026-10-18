import { describe, expect, it } from 'vitest';
import type { HistoryMessage } from '../../types/sessionHistory.ts';
import {
  buildReviewSystemPrompt,
  buildReviewTranscript,
  reviewTranscriptFromHistory,
} from '../autoReview/prompt.ts';
import { parseAutoModeRules } from '../autoReview/rules.ts';
import { estimateTokens, parseReviewAnswer, reviewTimeoutMs } from '../autoReview/verdict.ts';

/** Decision 192 §3.2: what the review model is sent, and how its answer is read. */

const RULES_JSON = JSON.stringify({
  allow: ['Local Operations: deleting files the agent created'],
  soft_deny: ['Irreversible Local Destruction [must name the target]: deleting existing files'],
  hard_deny: ['Data Exfiltration: sending secrets out'],
  environment: ['**Trusted repo**: unknown'],
});

function message(
  role: HistoryMessage['role'],
  blocks: HistoryMessage['blocks'],
  extra: Partial<HistoryMessage> = {}
): HistoryMessage {
  return { id: `history:${Math.random()}`, role, blocks, ...extra } as HistoryMessage;
}

describe('the auto-mode rules from the CLI', () => {
  it('reads the four lists', () => {
    const rules = parseAutoModeRules(RULES_JSON);
    expect(rules?.softDeny).toHaveLength(1);
    expect(rules?.hardDeny[0]).toContain('Data Exfiltration');
  });

  it.each([
    ['not json', 'Usage: claude [options]'],
    ['an array', '[]'],
    ['a list that is not strings', JSON.stringify({ allow: [], soft_deny: [1], hard_deny: [] })],
    ['no block rules at all', JSON.stringify({ allow: ['x'], soft_deny: [], hard_deny: [] })],
  ])('refuses %s', (_name, text) => {
    expect(parseAutoModeRules(text)).toBeNull();
  });
});

describe('the conversation the reviewer reads', () => {
  const history = [
    message('user', [{ type: 'text', id: 'u1', text: '修一下打包脚本' }]),
    message('assistant', [
      { type: 'thinking', id: 'a0', text: 'the user surely wants dist/ gone' },
      { type: 'text', id: 'a1', text: '我把 dist/ 删了吧？' },
      { type: 'tool_call', id: 'a2', toolCallId: 'c1', name: 'read', input: { path: 'x' } },
      { type: 'tool_call', id: 'a3', toolCallId: 'c2', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_result', id: 'a4', toolCallId: 'c2', ok: true, output: 'SECRET-OUTPUT' },
    ]),
    message('user', [{ type: 'text', id: 'u2', text: '好' }]),
    message('user', [{ type: 'text', id: 'u3', text: 'job finished' }], {
      origin: { kind: 'job' },
    }),
    message('system', [{ type: 'text', id: 's1', text: 'context summary' }]),
  ];

  it('keeps the user’s words and the agent’s acting calls, nothing the agent wrote', () => {
    const entries = reviewTranscriptFromHistory(history, () => false);
    expect(entries).toEqual([
      { kind: 'user', text: '修一下打包脚本' },
      { kind: 'tool_call', name: 'bash', input: { command: 'ls' } },
      { kind: 'user', text: '好' },
    ]);
    const text = buildReviewTranscript(entries, {
      tool: 'bash',
      cwd: '/ws',
      command: 'rm -rf dist',
    });
    expect(text).not.toContain('我把 dist/ 删了吧');
    expect(text).not.toContain('SECRET-OUTPUT');
    expect(text).not.toContain('surely');
    expect(text).toContain('<action_under_review>');
    expect(text.indexOf('<action_under_review>')).toBeGreaterThan(text.indexOf('</conversation>'));
  });

  it('marks a subagent’s task as the parent agent’s words, not the user’s', () => {
    const text = buildReviewTranscript([], {
      tool: 'bash',
      cwd: '/ws',
      command: 'rm x',
      delegation: { agentName: 'cleaner', task: 'delete x' },
    });
    expect(text).toContain('written by the parent agent, not by the user');
  });

  it('puts the hard rules before the soft ones, with the framing first', () => {
    const rules = parseAutoModeRules(RULES_JSON);
    if (!rules) throw new Error('no rules');
    const system = buildReviewSystemPrompt(rules);
    expect(system.indexOf('## HARD BLOCK')).toBeLessThan(system.indexOf('## SOFT BLOCK'));
    expect(system).toContain('By default, actions are ALLOWED');
    expect(system).toContain('names nothing');
  });
});

describe('the reviewer’s answer', () => {
  it.each([
    ['<block>no', { block: false }],
    ['<block>no</block>', { block: false }],
    ['<thinking>maybe <block>yes</block>?</thinking><block>no</block>', { block: false }],
    [
      '<block>yes</block><reason>要删除之前就有的 dist/</reason>',
      { block: true, reason: '要删除之前就有的 dist/' },
    ],
    ['<block>yes</block>', { block: true }],
  ])('reads %s', (text, expected) => {
    expect(parseReviewAnswer(text)).toEqual(expected);
  });

  it.each([
    ['nothing', 'I think it is fine'],
    ['both verdicts', '<block>yes</block><block>no</block>'],
  ])('has no verdict when it says %s', (_name, text) => {
    expect(parseReviewAnswer(text)).toBeNull();
  });

  it('keeps a long reason short', () => {
    const answer = parseReviewAnswer(`<block>yes</block><reason>${'x'.repeat(1000)}</reason>`);
    expect(answer?.block && answer.reason?.length).toBeLessThan(310);
  });
});

describe('the review’s deadline', () => {
  it('is Claude Code’s: 60 s, 10 s more per 50k tokens past 50k, at most 120 s', () => {
    expect(reviewTimeoutMs(1_000)).toBe(60_000);
    expect(reviewTimeoutMs(50_000)).toBe(60_000);
    expect(reviewTimeoutMs(50_001)).toBe(70_000);
    expect(reviewTimeoutMs(160_000)).toBe(90_000);
    expect(reviewTimeoutMs(1_000_000)).toBe(120_000);
  });

  it('counts CJK as about a token per character', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('删除目录')).toBe(4);
  });
});
