import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migratePermissionTier } from '../../types/runtimePermission.ts';
import type { PermissionActivityRecord, PermissionGate, ToolPermissionRequest } from '../gate.ts';
import { modeSegment, permissionGearSegment } from '../promptText.ts';
import {
  type Approver,
  type BuiltGate,
  buildGate,
  fileCall,
  type GateOptions,
  outcome,
} from './gateHarness.ts';

/**
 * Moved from the permission cases of src/runtime/__tests__/tools.test.ts, two
 * of src/runtime/__tests__/shellPolicy.test.ts and the skill-gate cases of
 * src/runtime/__tests__/skills.test.ts (dsh-rebase P1-12 step 2): what each
 * gear and mode lets a file tool do, the legacy tiers, the D14 prompt text,
 * symlink escapes, file grants, the approval deadline, deny scopes inside a
 * search, and a skill's trusted path. Cases that run a bash command line live
 * in src/dsh-host/permissions/__tests__/bashGateTools.test.ts.
 *
 * Only verdicts are pinned: nothing runs after an approval here, so a runtime
 * assertion about the tool's own output is left out and said so.
 */

let dir: string;
const gates: PermissionGate[] = [];
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'perm-gears-tools-')));
});
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.dispose();
  await rm(dir, { recursive: true, force: true });
});

/** A suite that does not MEAN to be asked: being asked is a loud failure. */
const neverAsked: Approver = (request) => {
  throw new Error(`unexpected permission request for ${request.tool}`);
};

/** The gate the runtime suite built with `runtime(options)`. */
async function runtime(options: GateOptions = {}, workspace = dir): Promise<BuiltGate> {
  const built = await buildGate(workspace, { approve: neverAsked, ...options });
  gates.push(built.gate);
  return built;
}

describe('native tools (permission cases)', () => {
  it.each([
    ['ask', 'read', 'allow'],
    ['ask', 'write', 'ask'],
    ['ask', 'edit', 'ask'],
    ['ask', 'bash', 'ask'],
    ['accept-edits', 'read', 'allow'],
    ['accept-edits', 'write', 'allow'],
    ['accept-edits', 'edit', 'allow'],
    ['accept-edits', 'bash', 'allow'],
    ['auto', 'read', 'allow'],
    ['auto', 'write', 'allow'],
    ['auto', 'edit', 'allow'],
    ['auto', 'bash', 'allow'],
    ['bypass', 'read', 'allow'],
    ['bypass', 'write', 'allow'],
    ['bypass', 'edit', 'allow'],
    ['bypass', 'bash', 'allow'],
  ] as const)('evaluates agent / %s / %s as %s', async (gear, tool, expected) => {
    const r = await runtime({ mode: 'agent', gear });
    expect(
      r.gate.evaluate({
        tool,
        toolCallId: 'matrix',
        path: join(dir, 'a'),
        command: tool === 'bash' ? 'pwd' : undefined,
      })
    ).toBe(expected);
  });

  it.each([
    ['readonly', 'plan', 'ask'],
    ['pragmatic', 'agent', 'ask'],
    ['handsoff', 'agent', 'accept-edits'],
    ['fullopen', 'agent', 'auto'],
  ] as const)('migrates %s into %s / %s', async (tier, mode, gear) => {
    expect(migratePermissionTier(tier)).toEqual({ mode, gear });
    const r = await runtime({ tier });
    expect({ mode: r.gate.mode, gear: r.gate.gear }).toEqual({ mode, gear });
  });

  it('contributes D14 mode and gear text to the prompt slots', () => {
    // The runtime composed these into its fixed prompt slots; DSH puts the
    // same two texts, mode first, into its prompt context (permissionHost.test).
    expect(modeSegment('plan').slot).toBe('mode');
    expect(permissionGearSegment('accept-edits').slot).toBe('permission-gear');
    expect(modeSegment('plan').text).toContain('Bash is for inspection only');
    expect(permissionGearSegment('accept-edits').text).toContain(
      'bash calls are allowed without ordinary approval'
    );
  });

  it('gates symlink escape before writing a new child', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'perm-outside-'));
    try {
      await symlink(outside, join(dir, 'link'), 'dir');
      // `accept-edits` waves through writes inside the workspace, so a write
      // that lands outside it through a symlink has to be the one thing that
      // still asks — and this approver refuses it.
      const r = await runtime({ gear: 'accept-edits', approve: async () => 'deny' });
      await expect(
        fileCall(r, 'write', 'test-write', 'link/new', { content: 'no' })
      ).rejects.toMatchObject({ code: 'tool_denied' });
      // (The runtime case also checked nothing was created outside: the tool running.)
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('grants the approved file itself, and clears it on settings change', async () => {
    let approvals = 0;
    const r = await runtime({
      approve: async () => {
        approvals++;
        return 'allow-session';
      },
    });
    const write = (path: string, content: string) =>
      fileCall(r, 'write', 'test-write', path, { content });
    await write('nested/a', '1');
    await write('nested/a', '2');
    expect(approvals).toBe(1);
    // ...and stops there: neither the sibling nor the subdirectory was on a card.
    await write('nested/b', '3');
    expect(approvals).toBe(2);
    await write('nested/deep/c', '4');
    expect(approvals).toBe(3);
    r.gate.configure({ gear: 'ask' });
    await write('nested/a', '5');
    expect(approvals).toBe(4);
  });

  it('denies on approval timeout even when an external approver never settles', async () => {
    const r = await runtime({ timeoutMs: 20, approve: () => new Promise(() => {}) });
    await expect(fileCall(r, 'write', 'test-write', 'a', { content: 'no' })).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });

  it('applies deny scopes inside recursive grep instead of only checking the root', async () => {
    // The runtime walk asked `canTraverse` for every entry; DSH's search filter
    // asks it for every result (decision 048). The root itself is searchable.
    await writeFile(join(dir, 'private.txt'), 'hidden');
    await writeFile(join(dir, 'open.txt'), 'shown');
    const r = await runtime({
      scopes: [{ root: join(dir, 'private.txt'), tools: ['grep'], action: 'deny' }],
    });
    expect(await outcome(fileCall(r, 'grep', 'test-grep', '.'))).toBe('allowed');
    const entry = (name: string) =>
      r.gate.canTraverse({ tool: 'grep', toolCallId: 'test-grep', path: join(r.cwd, name) });
    expect(entry('private.txt')).toBe(false);
    expect(entry('open.txt')).toBe(true);
  });
});

describe('the bypass gear (from shellPolicy)', () => {
  it('is not a way past plan mode or the tool whitelist', async () => {
    const r = await runtime({
      mode: 'plan',
      gear: 'bypass',
      allowedTools: ['read', 'bash', 'glob', 'grep'],
      approve: async () => 'deny',
    });
    // Plan mode refuses write tools at the gate.
    expect(
      r.gate.evaluate({ tool: 'write', toolCallId: 'plan-write', path: join(dir, 'a.txt') })
    ).toBe('deny');
    // A tool outside the whitelist is denied on the same principle.
    expect(
      r.gate.evaluate({ tool: 'edit', toolCallId: 'not-listed', path: join(dir, 'a.txt') })
    ).toBe('deny');
    // And a non-exploration shell call is still a plan-mode refusal.
    expect(
      r.gate.evaluate({
        tool: 'bash',
        toolCallId: 'plan-bash',
        path: dir,
        command: 'rm -rf x',
      })
    ).toBe('deny');
  });
});

describe('native permission policy loading (from shellPolicy)', () => {
  it('fails startup for invalid policy rather than losing a deny', async () => {
    const agentDir = join(dir, 'agent');
    const path = join(agentDir, 'extensions/pi-permission-system/config.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ permission: { bash: 'invalid' } }));
    await expect(runtime({ agentDir })).rejects.toMatchObject({
      code: 'permission_policy_invalid',
    });
  });
});

/**
 * The skill gate (T002 / skills-mcp-11): a skill is judged on its NAME
 * (`policyValue`) at a path the host already trusts. The request is the one
 * the runtime's skills plugin built (`authorizeSkill`); the DSH row builds the
 * same rule set for its own `skill` tool (permissionHost.test).
 */
describe('the skill gate (from skills)', () => {
  let root: string;
  let agentDir: string;
  beforeEach(async () => {
    root = join(dir, 'project');
    agentDir = join(dir, 'agent');
    await mkdir(join(agentDir, 'skills', 'pdf'), { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(join(agentDir, 'skills', 'pdf', 'SKILL.md'), 'STEP ONE: open the file.\n');
  });

  async function policy(document: unknown) {
    const path = join(agentDir, 'extensions', 'pi-permission-system', 'config.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(document));
  }

  const skill = (toolCallId: string): ToolPermissionRequest => ({
    tool: 'skill',
    toolCallId,
    path: join(agentDir, 'skills', 'pdf', 'SKILL.md'),
    policyValue: 'pdf',
    trustedPath: true,
    preview: { label: 'Skill', text: 'pdf' },
  });

  it('loads a skill outside the workspace through the tool without asking for approval', async () => {
    // `neverAsked`: anything reaching the ask path fails the case. The same
    // file through `read` would be outside cwd and therefore `ask`.
    const r = await runtime({ gear: 'ask', agentDir }, root);
    await expect(r.gate.authorize(skill('skill-1'))).resolves.toBeUndefined();
  });

  it('records a permission.activity row for the skill tool', async () => {
    const r = await runtime({ gear: 'ask', agentDir }, root);
    const decisions: Array<{ decision: string; source: string }> = [];
    const unsubscribe = r.gate.onActivity((record: PermissionActivityRecord) => {
      if (record.phase === 'decision' && record.request.tool === 'skill')
        decisions.push({ decision: record.decision, source: record.source });
    });
    await r.gate.authorize(skill('skill-1'));
    unsubscribe();
    // `policy`, not `session-grant`: the bundled default's allow.
    expect(decisions).toEqual([{ decision: 'allow', source: 'policy' }]);
  });

  it('lets an explicit skill deny policy rule actually block the tool call', async () => {
    await policy({ permission: { skill: 'deny' } });
    const r = await runtime({ gear: 'auto', agentDir }, root);
    await expect(r.gate.authorize(skill('skill-1'))).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });

  it('lets an explicit per-name skill deny rule block the skill (the /skill:name request)', async () => {
    await policy({ permission: { skill: { pdf: 'deny' } } });
    const r = await runtime({ gear: 'auto', agentDir }, root);
    await expect(r.gate.authorize(skill('skill-expand:pdf'))).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
});
