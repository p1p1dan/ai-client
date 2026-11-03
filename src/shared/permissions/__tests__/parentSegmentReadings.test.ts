import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolPermissionRequest } from '../gate.ts';
import { authorizeTarget } from '../shellPaths.ts';
import { buildGate, type GateOptions, nodeFs, outcome } from './gateHarness.ts';

/**
 * Decision 207 §15 item 7, §14 G: a path that climbs with `..` across a link
 * reads two ways. POSIX resolves the link before the `..` after it
 * (`canonicalPath`); win32, and DSH's file tools there, fold the `..` as
 * text first. Both readings are judged. Symlinks stand in for the
 * junctions pnpm makes on Windows.
 */

let root: string;
let ws: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'perm-dotdot-')));
  ws = join(root, 'ws');
  mkdirSync(join(ws, 'a', 'b', 'c'), { recursive: true });
  mkdirSync(join(root, 'other', 'sub'), { recursive: true });
  mkdirSync(join(root, 'secret'));
  writeFileSync(join(root, 'x.txt'), 'root\n');
  writeFileSync(join(root, 'other', 'x.txt'), 'other\n');
  writeFileSync(join(ws, 'x.txt'), 'ws\n');
  writeFileSync(join(ws, 'a', 'x.txt'), 'a\n');
  // Points out: `link/..` is `other` by the link, the workspace by the text.
  symlinkSync(join(root, 'other', 'sub'), join(ws, 'link'));
  // Two levels down, as pnpm's `node_modules/foo`: `deep/../..` is `ws/a` by
  // the link, the workspace's parent by the text.
  symlinkSync(join(ws, 'a', 'b', 'c'), join(ws, 'deep'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A `read` of `input` under full auto, which asks only about a path outside the workspace. */
async function judged(input: string, options: GateOptions & { duringApproval?: () => void } = {}) {
  const { duringApproval, ...gateOptions } = options;
  const asked: ToolPermissionRequest[] = [];
  const seen: ToolPermissionRequest[] = [];
  const built = await buildGate(ws, {
    gear: 'auto',
    approve: async (request) => {
      asked.push(request);
      duringApproval?.();
      return 'allow-once';
    },
    ...gateOptions,
  });
  const result = await outcome(
    authorizeTarget(
      {
        fs: nodeFs,
        cwd: built.cwd,
        authorize: (request, signal) => {
          seen.push(request);
          return built.gate.authorize(request, signal);
        },
      },
      { tool: 'read', toolCallId: `call-${input}`, input }
    )
  );
  return { asked, seen, result };
}

describe('a `..` across a link is judged by both readings (decision 207 §15 item 7)', () => {
  it('`link/../x` (out by the link, in by the text): asked as outside, both readings on the request', async () => {
    const { asked, seen, result } = await judged('link/../x.txt');
    expect(result).toBe('allowed');
    expect(asked).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      path: join(root, 'other', 'x.txt'),
      paths: [join(ws, 'x.txt')],
    });
  });

  it('`deep/../../x` (in by the link, out by the text): asked as outside', async () => {
    const { asked, seen, result } = await judged('deep/../../x.txt');
    expect(result).toBe('allowed');
    expect(asked).toHaveLength(1);
    expect(seen[0]).toMatchObject({ path: join(ws, 'a', 'x.txt'), paths: [join(root, 'x.txt')] });
  });

  it('no `..`, or a `..` that crosses no link: as before — no card, no second path', async () => {
    for (const input of ['a/x.txt', 'a/b/../x.txt', 'deep/y.txt']) {
      const { asked, seen, result } = await judged(input);
      expect(result, input).toBe('allowed');
      expect(asked, input).toEqual([]);
      expect(seen[0]?.paths, input).toBeUndefined();
    }
  });

  it('the other reading inside a denied directory: refused outright, no card', async () => {
    const { asked, result } = await judged('deep/../../secret/k.txt', {
      scopes: [{ root: join(root, 'secret'), tools: ['*'], action: 'deny' }],
    });
    expect(result).not.toBe('allowed');
    expect(asked).toEqual([]);
  });

  it('the other reading changing during the approval (a link it crosses re-pointed): path changed', async () => {
    const hop = join(root, 'hop');
    symlinkSync(join(root, 'other'), hop);
    try {
      const { asked, result } = await judged('deep/../../hop/x.txt', {
        duringApproval: () => {
          unlinkSync(hop);
          symlinkSync(join(root, 'secret'), hop);
        },
      });
      expect(asked).toHaveLength(1);
      expect(result).toBe('path_changed');
    } finally {
      rmSync(hop, { force: true });
    }
  });
});
