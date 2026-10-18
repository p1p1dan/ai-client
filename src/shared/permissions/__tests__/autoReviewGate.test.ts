import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AutoReviewVerdict } from '../autoReview/types.ts';
import { denialSource, PermissionGate, type ToolPermissionRequest } from '../gate.ts';
import { loadPermissionPolicy } from '../policy.ts';
import { analyzePwsh } from '../pwshAnalysis.ts';

/**
 * Decision 192: under `auto`, a call that would ask goes to the review model
 * first. Allowed runs; blocked or failed is refused without a card; after
 * Claude Code's limits (3 in a row, 20 in all) a blocked call is a card that
 * carries the reason. Every other gear, and a gate without `review`, is as
 * before.
 */

const ROOT = path.resolve('/ws');
let ids = 0;

function pwsh(command: string): ToolPermissionRequest {
  const analysis = analyzePwsh(command, ROOT, { HOME: '/home/me' }, { platform: 'linux' });
  return {
    tool: 'pwsh',
    toolCallId: `call-${++ids}`,
    path: ROOT,
    command,
    paths: analysis.paths,
    commands: analysis.commands,
    unresolvedPaths: analysis.unresolvedPaths,
    exploration: analysis.exploration,
    ...(analysis.parameterPaths ? { parameterPaths: analysis.parameterPaths } : {}),
  };
}

function harness(
  verdicts: AutoReviewVerdict[] | ((request: ToolPermissionRequest) => AutoReviewVerdict),
  gear: 'ask' | 'accept-edits' | 'auto' | 'bypass' = 'auto'
) {
  const reviewed: string[] = [];
  const asked: Array<{ command: string; reviewReason?: string; askReason?: string }> = [];
  const records: Array<{ phase: string; source?: string; reviewReason?: string }> = [];
  const queue = Array.isArray(verdicts) ? [...verdicts] : null;
  const gate = new PermissionGate({
    cwd: ROOT,
    gear,
    review: async (request) => {
      reviewed.push(request.command ?? request.tool);
      if (queue) return queue.shift() ?? { kind: 'allow' };
      return (verdicts as (request: ToolPermissionRequest) => AutoReviewVerdict)(request);
    },
    approve: async (request, _signal, _queue, context) => {
      asked.push({
        command: request.command ?? request.tool,
        ...(context?.reviewReason ? { reviewReason: context.reviewReason } : {}),
        ...(context?.askReason ? { askReason: context.askReason } : {}),
      });
      return 'allow-once';
    },
  });
  gate.onActivity((record) =>
    records.push({
      phase: record.phase,
      ...(record.phase === 'decision' ? { source: record.source } : {}),
      ...(record.phase === 'decision' && record.reviewReason
        ? { reviewReason: record.reviewReason }
        : {}),
    })
  );
  return { gate, reviewed, asked, records };
}

async function outcome(gate: PermissionGate, request: ToolPermissionRequest) {
  try {
    await gate.authorize(request);
    return 'allowed';
  } catch (error) {
    return denialSource(error) ?? 'threw';
  }
}

describe('full auto with a review model', () => {
  it('runs what the review allows, with no card', async () => {
    const h = harness([{ kind: 'allow' }]);
    expect(await outcome(h.gate, pwsh('Remove-Item notes.txt'))).toBe('allowed');
    expect(h.reviewed).toEqual(['Remove-Item notes.txt']);
    expect(h.asked).toEqual([]);
    expect(h.records.map((record) => record.phase)).toEqual(['review', 'decision']);
    expect(h.records[1]?.source).toBe('review-allowed');
  });

  it('refuses what the review blocks, with its reason on the record and no card', async () => {
    const h = harness([{ kind: 'block', reason: 'dist/ existed before this session' }]);
    let message = '';
    try {
      await h.gate.authorize(pwsh('rm -r dist'));
    } catch (error) {
      expect(denialSource(error)).toBe('review-denied');
      message = (error as Error).message;
    }
    expect(message).toContain('dist/ existed before this session');
    expect(message).toContain('Do not retry it in another form');
    expect(h.asked).toEqual([]);
    expect(h.records.at(-1)).toEqual({
      phase: 'decision',
      source: 'review-denied',
      reviewReason: 'dist/ existed before this session',
    });
  });

  it('refuses a call the review could not judge, telling the model it may retry as-is', async () => {
    const h = harness([{ kind: 'failed', failure: 'timeout' }]);
    let message = '';
    try {
      await h.gate.authorize(pwsh('rm -r dist'));
    } catch (error) {
      expect(denialSource(error)).toBe('review-failed');
      message = (error as Error).message;
    }
    expect(message).toContain('not a judgment that the action is unsafe');
    expect(h.asked).toEqual([]);
  });

  it('asks as before when no rules or no review model can be reached', async () => {
    const h = harness([{ kind: 'failed', failure: 'unavailable' }]);
    expect(await outcome(h.gate, pwsh('rm -r dist'))).toBe('allowed');
    expect(h.asked).toEqual([{ command: 'rm -r dist', askReason: 'dangerous' }]);
  });

  it('turns the third block in a row into a card that carries the reason', async () => {
    const block = (reason: string): AutoReviewVerdict => ({ kind: 'block', reason });
    const h = harness([block('one'), block('two'), block('three')]);
    expect(await outcome(h.gate, pwsh('rm a.txt'))).toBe('review-denied');
    expect(await outcome(h.gate, pwsh('rm b.txt'))).toBe('review-denied');
    expect(await outcome(h.gate, pwsh('rm c.txt'))).toBe('allowed');
    expect(h.asked).toEqual([
      { command: 'rm c.txt', reviewReason: 'three', askReason: 'dangerous' },
    ]);
  });

  it('starts counting again after a call auto lets through', async () => {
    const block: AutoReviewVerdict = { kind: 'block', reason: 'no' };
    const h = harness([block, block, { kind: 'allow' }, block, block]);
    expect(await outcome(h.gate, pwsh('rm a.txt'))).toBe('review-denied');
    expect(await outcome(h.gate, pwsh('rm b.txt'))).toBe('review-denied');
    expect(await outcome(h.gate, pwsh('rm c.txt'))).toBe('allowed');
    expect(await outcome(h.gate, pwsh('rm d.txt'))).toBe('review-denied');
    expect(await outcome(h.gate, pwsh('rm e.txt'))).toBe('review-denied');
    expect(h.asked).toEqual([]);
  });

  it('does not count a failed review', async () => {
    const failed: AutoReviewVerdict = { kind: 'failed', failure: 'error' };
    const h = harness([failed, failed, failed, failed]);
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(await outcome(h.gate, pwsh(`rm ${name}.txt`))).toBe('review-failed');
    }
    expect(h.asked).toEqual([]);
  });

  it('asks every block from the 20th on, once, then counts afresh', async () => {
    let n = 0;
    const h = harness(() => {
      n += 1;
      // An allow between every two blocks keeps the consecutive count under 3.
      return n % 3 === 0 ? { kind: 'allow' } : { kind: 'block', reason: `block ${n}` };
    });
    const results: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      results.push(await outcome(h.gate, pwsh(`rm f${index}.txt`)));
    }
    // Blocks fall on n = 1, 2, 4, 5, …; the 20th block is n = 29.
    expect(h.asked.map((entry) => entry.reviewReason)).toEqual(['block 29']);
    expect(results.filter((result) => result === 'review-denied')).toHaveLength(19);
  });

  it('never reviews a call auto allows anyway, nor one a deny rule refuses', async () => {
    const policy = await loadPermissionPolicy(
      {
        readFile: async (file: string) => {
          if (file !== path.join('/agent', 'pi-permissions.jsonc'))
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return {
            bytes: new TextEncoder().encode('{ "permission": { "bash": { "rm *": "deny" } } }'),
          };
        },
      },
      { cwd: ROOT, agentDir: '/agent', sources: { user: true, project: false, local: false } }
    );
    const reviewed: string[] = [];
    const gate = new PermissionGate({
      cwd: ROOT,
      gear: 'auto',
      policy,
      review: async (request) => {
        reviewed.push(request.command ?? request.tool);
        return { kind: 'allow' };
      },
      approve: async () => 'allow-once',
    });
    expect(await outcome(gate, pwsh('npm test'))).toBe('allowed');
    expect(await outcome(gate, pwsh('rm a.txt'))).toBe('policy-deny');
    expect(reviewed).toEqual([]);
  });

  it('reviews only under auto: ask and accept-edits keep their cards', async () => {
    for (const gear of ['ask', 'accept-edits'] as const) {
      const h = harness([{ kind: 'allow' }], gear);
      expect(await outcome(h.gate, pwsh('rm a.txt'))).toBe('allowed');
      expect(h.reviewed).toEqual([]);
      expect(h.asked).toHaveLength(1);
    }
  });

  it('is cancelled with the call: a stop during the review refuses it as cancelled', async () => {
    const controller = new AbortController();
    const gate = new PermissionGate({
      cwd: ROOT,
      gear: 'auto',
      review: (_request, _context, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ kind: 'failed', failure: 'error' }));
          controller.abort();
        }),
      approve: async () => 'allow-once',
    });
    await expect(gate.authorize(pwsh('rm a.txt'), controller.signal)).rejects.toSatisfy(
      (error) => denialSource(error) === 'cancelled'
    );
  });

  it('says so on the gate, for the prompt text', () => {
    expect(harness([]).gate.autoReview).toBe(true);
    expect(new PermissionGate({ cwd: ROOT, gear: 'auto' }).autoReview).toBe(false);
  });
});
