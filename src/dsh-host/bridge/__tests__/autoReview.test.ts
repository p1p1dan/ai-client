import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutoModeRules } from '../../../shared/permissions/autoReview/rules.ts';
import type { ToolPermissionRequest } from '../../../shared/permissions/gate.ts';
import { AutoModeRulesSource, type RunCli } from '../autoModeRules.ts';
import { AutoReviewer, type ReviewLlm } from '../autoReviewer.ts';
import type { CompletionChunk } from '../completions.ts';

/**
 * Decision 192: the host's half of the auto gear's review — the rules read
 * once per CLI version from the bundled Claude CLI, and the two-stage review.
 */

const RULES = JSON.stringify({
  allow: ['Local Operations: fine'],
  soft_deny: ['Irreversible Local Destruction: deleting existing files'],
  hard_deny: ['Data Exfiltration: never'],
  environment: [],
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'auto-review-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fakeCli(version: string): Promise<string> {
  const pkg = join(dir, `pkg-${version}`);
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ version }));
  const cli = join(pkg, 'claude');
  await writeFile(cli, '');
  return cli;
}

describe('the auto-mode rules source', () => {
  it('runs the CLI once per version, isolated from the user’s config, and reuses the cache', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run: RunCli = async (_file, args, options) => {
      calls.push({ args, env: options.env });
      return RULES;
    };
    const cli = await fakeCli('2.1.302');
    const cacheDir = join(dir, 'cache');
    const first = await new AutoModeRulesSource({ cli, cacheDir, run }).rules();
    expect(first?.softDeny).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['auto-mode', 'defaults']);
    expect(calls[0]?.env.CLAUDE_CONFIG_DIR).toBe(join(cacheDir, 'claude-config'));
    expect(calls[0]?.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');

    // A new host on the same version reads the cache, not the CLI.
    const again = await new AutoModeRulesSource({ cli, cacheDir, run }).rules();
    expect(again).toEqual(first);
    expect(calls).toHaveLength(1);

    // An upgraded CLI is read again.
    const upgraded = await fakeCli('2.1.303');
    await new AutoModeRulesSource({ cli: upgraded, cacheDir, run }).rules();
    expect(calls).toHaveLength(2);
    expect((await readdir(cacheDir)).filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  const failures: Array<[string, 'missing' | 'present', () => Promise<string>]> = [
    ['the CLI is missing', 'missing', async () => RULES],
    [
      'the CLI fails',
      'present',
      async () => {
        throw new Error('exit 1');
      },
    ],
    ['the CLI prints no rules', 'present', async () => 'Usage: claude'],
  ];
  it.each(
    failures
  )('answers nothing when %s, and does not retry at once', async (_name, state, impl) => {
    let calls = 0;
    const run: RunCli = async () => {
      calls += 1;
      return impl();
    };
    const cli = state === 'missing' ? join(dir, 'nope', 'claude') : await fakeCli('1.0.0');
    let now = 0;
    const source = new AutoModeRulesSource({
      cli,
      cacheDir: join(dir, 'cache'),
      run,
      now: () => now,
    });
    expect(await source.rules()).toBeUndefined();
    const before = calls;
    now = 1_000;
    expect(await source.rules()).toBeUndefined();
    expect(calls).toBe(before);
  });
});

const TOS_REFUSAL =
  "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.";

function stream(
  text: string,
  finish: 'stop' | 'error' | 'refusal' = 'stop'
): AsyncIterable<CompletionChunk> {
  return (async function* () {
    if (text) yield { type: 'text-delta', text };
    yield finish === 'stop'
      ? { type: 'finish', reason: { kind: 'stop' } }
      : {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: finish === 'error' ? 'HTTP 502' : TOS_REFUSAL },
          },
        };
  })();
}

const REQUEST: ToolPermissionRequest = {
  tool: 'bash',
  toolCallId: 'c1',
  path: '/ws',
  command: 'rm -rf dist',
};
const RULE_SET: AutoModeRules = {
  allow: [],
  softDeny: ['Irreversible Local Destruction'],
  hardDeny: ['Data Exfiltration'],
  environment: [],
};

function reviewer(
  answers: Array<string | 'error' | 'refusal' | 'hang'>,
  options: { contextWindow?: number; rules?: AutoModeRules | undefined; thinks?: boolean } = {}
) {
  const sent: Array<{ maxTokens?: number; prompt: string }> = [];
  const llm: ReviewLlm = {
    stream(request) {
      const answer = answers.shift() ?? '';
      sent.push({
        maxTokens: request.maxTokens,
        prompt: request.messages[0]?.content[0]?.text ?? '',
      });
      if (answer === 'hang') {
        return (async function* () {
          await new Promise((resolve) => request.signal.addEventListener('abort', resolve));
          yield { type: 'finish', reason: { kind: 'aborted' } } as CompletionChunk;
        })();
      }
      return answer === 'error' || answer === 'refusal' ? stream('', answer) : stream(answer);
    },
  };
  const instance = new AutoReviewer({
    llm: () => llm,
    route: () => ({
      modelId: 'p/cheap',
      selection: { provider: 'route-p', model: 'cheap' },
      image: false,
    }),
    contextWindow: () => options.contextWindow,
    rules: async () => ('rules' in options ? options.rules : RULE_SET),
    transcript: () => [{ kind: 'user', text: 'clean up' }],
    cwd: '/ws',
    ...(options.thinks ? { thinks: true } : {}),
  });
  return { instance, sent };
}

describe('the two-stage review', () => {
  const signal = new AbortController().signal;

  it('allows on a fast no, without the second stage', async () => {
    const r = reviewer(['<block>no']);
    expect(await r.instance.review(REQUEST, {}, signal)).toEqual({ kind: 'allow' });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatchObject({ maxTokens: 64 });
  });

  // User 2026-10-18: a thinking review model (Sonnet 5.5's adaptive thinking)
  // spent the 64 tokens on its thought; like Claude Code, stage 1 gets 2048 more.
  it('gives a thinking review model room to think before its fast verdict', async () => {
    const r = reviewer(['<block>no'], { thinks: true });
    expect(await r.instance.review(REQUEST, {}, signal)).toEqual({ kind: 'allow' });
    expect(r.sent[0]).toMatchObject({ maxTokens: 64 + 2048 });
  });

  it('a fast stage cut off before its verdict falls through to the reasoned stage', async () => {
    // What a thought that used up the cap looks like: no verdict in the text.
    const r = reviewer(['', '<block>no</block>'], { thinks: true });
    expect(await r.instance.review(REQUEST, {}, signal)).toEqual({ kind: 'allow' });
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]?.maxTokens).toBe(8192);
  });

  it('lets the reasoned second stage clear a fast block', async () => {
    const r = reviewer([
      '<block>yes',
      '<thinking>the user named dist/</thinking><block>no</block>',
    ]);
    expect(await r.instance.review(REQUEST, {}, signal)).toEqual({ kind: 'allow' });
    expect(r.sent[1]?.maxTokens).toBe(8192);
    expect(r.sent[1]?.prompt).toContain('<thinking>');
  });

  it('blocks with the second stage’s reason', async () => {
    const r = reviewer(['<block>yes', '<block>yes</block><reason>dist/ 不是本会话建的</reason>']);
    expect(await r.instance.review(REQUEST, {}, signal)).toEqual({
      kind: 'block',
      reason: 'dist/ 不是本会话建的',
    });
  });

  it('treats an unreadable first answer as a block to look at again', async () => {
    const r = reviewer(['hmm', '<block>no</block>']);
    expect(await r.instance.review(REQUEST, {}, signal)).toEqual({ kind: 'allow' });
    expect(r.sent).toHaveLength(2);
  });

  it.each([
    ['the model call fails', ['error'], 'error'],
    ['the second answer has no verdict', ['<block>yes', 'I am not sure'], 'unparseable'],
  ] as const)('fails when %s', async (_name, answers, failure) => {
    const r = reviewer([...answers]);
    expect(await r.instance.review(REQUEST, {}, signal)).toMatchObject({ kind: 'failed', failure });
  });

  it('is unavailable without rules', async () => {
    const r = reviewer([], { rules: undefined });
    expect(await r.instance.review(REQUEST, {}, signal)).toMatchObject({
      kind: 'failed',
      failure: 'unavailable',
    });
    expect(r.sent).toEqual([]);
  });

  it('does not send a conversation the review model cannot hold', async () => {
    const r = reviewer([], { contextWindow: 1_000 });
    expect(await r.instance.review(REQUEST, {}, signal)).toMatchObject({
      kind: 'failed',
      failure: 'too_long',
    });
    expect(r.sent).toEqual([]);
  });

  it('tells a failed call from its service refusing the request, keeping their words', async () => {
    expect(await reviewer(['error']).instance.review(REQUEST, {}, signal)).toEqual({
      kind: 'failed',
      failure: 'error',
      detail: 'HTTP 502',
    });
    expect(await reviewer(['refusal']).instance.review(REQUEST, {}, signal)).toEqual({
      kind: 'failed',
      failure: 'refused',
      detail: TOS_REFUSAL,
    });
  });

  it('stops waiting when the call is stopped', async () => {
    const controller = new AbortController();
    const r = reviewer(['hang']);
    const pending = r.instance.review(REQUEST, {}, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'failed', failure: 'error' });
  });
});

describe('what a review costs (decision 193 §10)', () => {
  const signal = new AbortController().signal;

  /** A review model that bills each request: a provisional sample, then the settled one. */
  function billedLlm(answers: string[], failSecond = false): ReviewLlm {
    let call = 0;
    return {
      stream() {
        call += 1;
        const index = call;
        const text = answers.shift() ?? '';
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 20_000, outputTokens: 0 } };
          yield { type: 'text-delta', text };
          yield {
            type: 'usage',
            usage: {
              inputTokens: 1_000 * index,
              outputTokens: 10 * index,
              cacheReadTokens: 19_000,
            },
          };
          yield failSecond && index === 2
            ? { type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 502' } } }
            : { type: 'finish', reason: { kind: 'stop' } };
        })() as AsyncIterable<CompletionChunk>;
      },
    };
  }

  function reviewerWith(llm: ReviewLlm, onUsage: (usage: unknown) => void): AutoReviewer {
    return new AutoReviewer({
      llm: () => llm,
      route: () => ({
        modelId: 'p/cheap',
        selection: { provider: 'route-p', model: 'cheap' },
        image: false,
      }),
      contextWindow: () => undefined,
      rules: async () => RULE_SET,
      transcript: () => [{ kind: 'user', text: 'clean up' }],
      cwd: '/ws',
      onUsage,
    });
  }

  it('reports each request’s settled usage once, the failed one included', async () => {
    const one: unknown[] = [];
    const allow = reviewerWith(billedLlm(['<block>no']), (usage) => one.push(usage));
    expect(await allow.review(REQUEST, {}, signal)).toEqual({ kind: 'allow' });
    expect(one).toEqual([{ inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 19_000 }]);

    const two: unknown[] = [];
    const failing = reviewerWith(billedLlm(['<block>yes', ''], true), (usage) => two.push(usage));
    expect(await failing.review(REQUEST, {}, signal)).toMatchObject({ kind: 'failed' });
    expect(two).toEqual([
      { inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 19_000 },
      { inputTokens: 2_000, outputTokens: 20, cacheReadTokens: 19_000 },
    ]);
  });

  it('reports nothing for a request that reported nothing, and survives a failing listener', async () => {
    const reported: unknown[] = [];
    const quiet = reviewerWith({ stream: () => stream('<block>no') }, (usage) =>
      reported.push(usage)
    );
    expect(await quiet.review(REQUEST, {}, signal)).toEqual({ kind: 'allow' });
    expect(reported).toEqual([]);
    const throwing = reviewerWith(billedLlm(['<block>no']), () => {
      throw new Error('bookkeeping broke');
    });
    expect(await throwing.review(REQUEST, {}, signal)).toEqual({ kind: 'allow' });
  });
});
