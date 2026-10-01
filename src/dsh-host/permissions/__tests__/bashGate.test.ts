import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Approver,
  type BuiltGate,
  buildGate,
  fileCall,
  type GateOptions,
} from '../../../shared/permissions/__tests__/gateHarness.ts';
import { bashCall } from './bashHarness.ts';

/**
 * Moved from src/runtime/__tests__/shellPolicy.test.ts (dsh-rebase P1-12 step 2):
 * the bash AST path gate — denied operands however they are spelled, symlinks
 * and junctions, redirects, wrapper words, interpreter payloads, unresolved
 * operands, the bypass gear's limits, `$(...)` in the name position, glued
 * options and `key=value` operands, and the policy layers.
 *
 * Driven on the pure library with the host's own tree-sitter grammar
 * (`loadBashParser`), through the three steps the runtime `bash` tool took
 * before running anything (`bashCall`). Nothing runs: where the runtime case
 * also checked what the command wrote, that half is left out and said so, and
 * where a later command depended on what an earlier one created, the test
 * creates it. The pure-helper cases (separator folding, Windows spellings),
 * the plan-mode / whitelist case and the invalid-policy case need no syntax
 * tree and live in src/shared/permissions/__tests__/.
 */

let dir: string;
let outside: string;
let built: BuiltGate | undefined;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'shell-policy-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'shell-outside-')));
});
afterEach(async () => {
  built?.gate.dispose();
  built = undefined;
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/**
 * The subject of this suite is the shell path gate, so the default approver
 * refuses: a `tool_denied` below then means the command REACHED the gate.
 */
const alwaysDenied: Approver = async () => 'deny';

async function start(options: { agentDir?: string; permissions?: GateOptions } = {}) {
  built?.gate.dispose();
  built = await buildGate(dir, {
    approve: alwaysDenied,
    ...(options.permissions ?? { gear: 'accept-edits' }),
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
  });
  return built;
}
function bash(command: string) {
  if (!built) throw new Error('no gate');
  return bashCall(built, command);
}
/** The Node-side `read`, which opens whatever path the guard handed back. */
function readTool(path: string) {
  if (!built) throw new Error('no gate');
  return fileCall(built, 'read', 'read', path);
}
async function config(path: string, document: unknown) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(document));
}

describe('Bash AST permission enforcement', () => {
  it.each([
    'cat ".e"\'nv\'',
    'FILE=.env; cat "$FILE"',
    'printf x > .env',
    "bash -c 'cat .env'",
    'echo "$(cat .env)"',
    'VALUE=$(cat .env); echo ok',
    'VALUE=$(cat .env) pwd',
    'cat "$HOME/.ssh/config"',
    'cat ~/.ssh/config',
    'cat *.pem',
    'rg -f .env file',
    'grep -f.env file',
    'grep --file=.env file',
  ])('blocks denied operands in auto: %s', async (command) => {
    await start({ permissions: { gear: 'auto' } });
    await expect(bash(command)).rejects.toMatchObject({ code: 'tool_denied' });
  });
  it('allows normal workspace commands and pipelines without approval', async () => {
    let approvals = 0;
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(
      bash('mkdir sub; printf amber > sub/file; cat sub/file | head -n 1')
    ).resolves.toBeDefined();
    // (The runtime case also checked the output said `amber`: the command running.)
    // What that command would have left behind, for the wildcard below to expand over.
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub/file'), 'amber');
    await expect(bash('cat sub/*')).resolves.toBeDefined();
    expect(approvals).toBe(0);
    await expect(bash("rg '.env' sub/file")).resolves.toBeDefined();
  });
  it('tolerates a bash wildcard whose parent directory does not exist yet (tools-07)', async () => {
    await start({ permissions: { gear: 'accept-edits' } });
    await expect(bash('cat nosuchdir/*.log')).resolves.toBeDefined();
  });
  it('requires approval for variable and nested-shell external paths', async () => {
    await start();
    for (const command of [
      `TARGET='${outside}'; cat "$TARGET/file"`,
      `bash -c 'cd "${outside}"; pwd'`,
      `cd '${outside}' && pwd`,
      'cat "$UNKNOWN_DIR/file"',
      `git -C'${outside}' status`,
    ]) {
      await expect(bash(command), command).rejects.toMatchObject({ code: 'tool_denied' });
    }
  });
  it('applies deny scopes to shell operands within the workspace', async () => {
    await writeFile(join(dir, 'private.txt'), 'private');
    await start({
      permissions: {
        gear: 'auto',
        scopes: [{ root: join(dir, 'private.txt'), tools: ['bash'], action: 'deny' }],
      },
    });
    await expect(bash('cat private.txt')).rejects.toMatchObject({ code: 'tool_denied' });
  });
  it('checks symlink targets reached by wildcard expansion', async () => {
    await writeFile(join(outside, 'file'), 'external');
    await symlink(join(outside, 'file'), join(dir, 'outside-link'));
    await start();
    await expect(bash('cat outside-*')).rejects.toMatchObject({ code: 'tool_denied' });
  });
  it('does not normalize away symlink traversal before checking its real target', async () => {
    await mkdir(join(outside, 'sub'));
    await symlink(join(outside, 'sub'), join(dir, 'link'), 'dir');
    await writeFile(join(outside, 'secret'), 'external');
    await start();
    await expect(bash('cat link/../secret')).rejects.toMatchObject({ code: 'tool_denied' });
  });
  // Node makes an ordinary symlink for `'junction'` off Windows, with the same
  // POSIX `..` semantics, so both branches assert the same property.
  it('resolves a junction before applying `..` to it', async () => {
    await mkdir(join(outside, 'sub'));
    await writeFile(join(outside, 'outside-file'), 'external');
    await symlink(join(outside, 'sub'), join(dir, 'jlink'), 'junction');
    await start();
    await expect(bash('cat jlink/../outside-file')).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
  // A junction pointing at the workspace ITSELF folds back to `<ws>` on paper
  // while the shell climbs out of it.
  it('follows a junction to the workspace and counts `..` above it as outside', async () => {
    await writeFile(join(outside, 'file'), 'external');
    await symlink(dir, join(dir, 'self'), 'junction');
    await start();
    await expect(bash(`cat self/../${basename(outside)}/file`)).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
  // The guard's ANSWER is what the tools open, so a `..` that cancels a missing
  // segment must not stop the walk. Asserted through bash and through the
  // Node-side read, because they open that answer by two different routes.
  it('re-resolves a link reached after `..` cancels a missing segment', async () => {
    await writeFile(join(outside, 'secret.txt'), 'external');
    await symlink(outside, join(dir, 'link'), 'junction');
    await start();
    await expect(bash('cat nosuchdir/../link/secret.txt')).rejects.toMatchObject({
      code: 'tool_denied',
    });
    await expect(readTool('nosuchdir/../link/secret.txt')).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
  it('re-resolves a plain file symlink reached the same way', async () => {
    await writeFile(join(outside, 'secret.txt'), 'external');
    await symlink(join(outside, 'secret.txt'), join(dir, 'filelink'), 'file');
    await start();
    await expect(bash('cat nosuchdir/../filelink')).rejects.toMatchObject({
      code: 'tool_denied',
    });
    await expect(readTool('nosuchdir/../filelink')).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
  it('counts a dangling link as the missing segment that `..` cancels', async () => {
    await writeFile(join(outside, 'secret.txt'), 'external');
    await symlink(join(dir, 'never-created'), join(dir, 'dangling'), 'file');
    await symlink(outside, join(dir, 'link'), 'junction');
    await start();
    await expect(bash('cat dangling/../link/secret.txt')).rejects.toMatchObject({
      code: 'tool_denied',
    });
    await expect(readTool('dangling/../link/secret.txt')).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
  it('does not let a workspace allow scope authorize external shell paths', async () => {
    await start({
      permissions: {
        gear: 'accept-edits',
        scopes: [{ root: dir, tools: ['bash'], action: 'allow' }],
      },
    });
    await expect(bash(`cat '${outside}/file'`)).rejects.toMatchObject({ code: 'tool_denied' });
  });
  it('rechecks shell paths after approval before executing a retargeted symlink', async () => {
    await writeFile(join(dir, 'safe'), 'safe');
    await writeFile(join(outside, 'other'), 'outside');
    await symlink(join(dir, 'safe'), join(dir, 'link'));
    await start({
      permissions: {
        gear: 'ask',
        approve: async () => {
          await rm(join(dir, 'link'));
          await symlink(join(outside, 'other'), join(dir, 'link'));
          return 'allow-once';
        },
      },
    });
    await expect(bash('cat link')).rejects.toMatchObject({ code: 'path_changed' });
  });
  it('rejects malformed shell instead of falling back to an empty permission analysis', async () => {
    await start({ permissions: { gear: 'auto' } });
    await expect(bash("cat 'unfinished")).rejects.toMatchObject({ code: 'invalid_tool_arguments' });
  });
});

// T001 — a leading `> file` and a `<<<` here-string hang off the `command`
// node outside its arguments.
describe('Bash AST redirects that are not arguments', () => {
  it.each([
    'printf x > .env',
    '> .env echo x',
    'cat <<< "$(cat .env)"',
    'cat <<< .env',
  ])('blocks a denied name reached through a redirect in auto: %s', async (command) => {
    await start({ permissions: { gear: 'auto' } });
    await expect(bash(command)).rejects.toMatchObject({ code: 'tool_denied' });
  });
  it('asks before a leading redirect writes outside the workspace', async () => {
    let approvals = 0;
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash(`> '${join(outside, 'x')}' echo hi`)).rejects.toMatchObject({
      code: 'tool_denied',
    });
    expect(approvals).toBe(1);
  });
  it('leaves an in-workspace redirect and a plain here-string alone', async () => {
    let approvals = 0;
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash('> out.txt echo hi')).resolves.toBeDefined();
    await expect(bash('cat <<< hello')).resolves.toBeDefined();
    expect(approvals).toBe(0);
    // (The runtime case also read `out.txt` back: that half was the command running.)
  });
});

// T001 — a `bash` deny rule is written against the bare verb, so the analysis
// has to judge the command under that spelling however it was reached.
describe('Bash AST command-name normalization', () => {
  async function denyRemove(gear: 'auto' | 'accept-edits') {
    const agentDir = join(dir, 'agent');
    await config(join(agentDir, 'extensions/pi-permission-system/config.json'), {
      permission: { bash: { 'rm *': 'deny' } },
    });
    await start({ agentDir, permissions: { gear } });
  }
  it.each([
    'command rm -rf src',
    'timeout 5 rm file',
    'nice -n 5 rm file',
    'nohup rm file',
    'stdbuf -o0 rm file',
    'time rm file',
    'exec rm file',
    '/bin/rm file',
  ])('keeps a bash deny rule on a wrapped or absolute spelling: %s', async (command) => {
    await denyRemove('auto');
    await expect(bash(command)).rejects.toMatchObject({ code: 'tool_denied' });
  });
  it('does not extend that deny to other commands behind the same wrappers', async () => {
    await denyRemove('auto');
    await expect(bash('timeout 5 echo ok')).resolves.toBeDefined();
    await expect(bash('command echo ok')).resolves.toBeDefined();
    await expect(bash('nice -n 5 echo ok')).resolves.toBeDefined();
  });
  it('judges the operands of a wrapped command, not the wrapper', async () => {
    let approvals = 0;
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash(`timeout 5 cat '${join(outside, 'file')}'`)).rejects.toMatchObject({
      code: 'tool_denied',
    });
    expect(approvals).toBe(1);
  });
  it('asks for a wrapper whose inner command cannot be read', async () => {
    let approvals = 0;
    await start({
      permissions: {
        gear: 'auto',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash('timeout 5')).rejects.toMatchObject({ code: 'tool_denied' });
    expect(approvals).toBe(1);
  });
});

// T001 — an interpreter handed a script file runs code the analysis never reads.
describe('Bash AST interpreter payloads', () => {
  it.each([
    'bash deploy.sh',
    'sh deploy.sh',
    'zsh deploy.sh',
    'dash deploy.sh',
    'bash',
  ])('requires approval for an unreadable interpreter payload: %s', async (command) => {
    let approvals = 0;
    await writeFile(join(dir, 'deploy.sh'), 'printf hi\n');
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash(command)).rejects.toMatchObject({ code: 'tool_denied' });
    expect(approvals).toBe(1);
  });
  it('still runs a -c payload the analysis could read, without approval', async () => {
    let approvals = 0;
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash("bash -c 'printf ok > note.txt'")).resolves.toBeDefined();
    expect(approvals).toBe(0);
    // (The runtime case also read `note.txt` back: that half was the command running.)
  });
});

// T001 — `auto` used to return allow before `unresolvedPaths` was consulted.
describe('Bash AST unresolved operands under auto', () => {
  it('asks in auto when an operand could not be resolved', async () => {
    let approvals = 0;
    await start({
      permissions: {
        gear: 'auto',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash('cat "$UNKNOWN_DIR/file"')).rejects.toMatchObject({ code: 'tool_denied' });
    expect(approvals).toBe(1);
  });
  it('still runs a fully resolved command in auto without approval', async () => {
    let approvals = 0;
    await start({
      permissions: {
        gear: 'auto',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash('printf ok > note.txt')).resolves.toBeDefined();
    expect(approvals).toBe(0);
  });
});

/**
 * The fourth gear: `bypass` answers the unresolved-operand asks `auto` still
 * raises, and acquires no authority — every deny is decided before any gear.
 * (Its plan-mode / whitelist case needs no syntax tree: gearsAndTools.test.)
 */
describe('the bypass gear', () => {
  it('runs an unresolved-operand command with no card at all', async () => {
    let approvals = 0;
    await writeFile(join(outside, 'file'), 'amber');
    await start({
      permissions: {
        gear: 'bypass',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash('cat "$UNKNOWN_DIR/file" 2>/dev/null; true')).resolves.toBeDefined();
    await expect(bash(`TARGET='${outside}'; cat "$TARGET/file"`)).resolves.toBeDefined();
    await expect(bash('for f in *.txt; do echo "$f"; done')).resolves.toBeDefined();
    expect(approvals).toBe(0);
  });

  it('is not a way past the bundled path denies', async () => {
    await start({ permissions: { gear: 'bypass' } });
    for (const command of ['cat .env', 'cat ~/.ssh/config', 'cat *.pem', 'printf x > .env'])
      await expect(bash(command), command).rejects.toMatchObject({ code: 'tool_denied' });
  });

  it('is not a way past a configured bash or path deny rule', async () => {
    const agentDir = join(dir, 'agent');
    await config(join(agentDir, 'extensions/pi-permission-system/config.json'), {
      permission: { bash: { 'rm *': 'deny' }, path: { 'private.txt': 'deny' } },
    });
    await start({ agentDir, permissions: { gear: 'bypass' } });
    await expect(bash('rm file')).rejects.toMatchObject({ code: 'tool_denied' });
    // Including the wrapped spellings T001 normalizes.
    await expect(bash('timeout 5 rm file')).rejects.toMatchObject({ code: 'tool_denied' });
    await expect(bash('cat private.txt')).rejects.toMatchObject({ code: 'tool_denied' });
  });

  it('is not a way past a deny scope', async () => {
    await writeFile(join(dir, 'private.txt'), 'private');
    await start({
      permissions: {
        gear: 'bypass',
        scopes: [{ root: join(dir, 'private.txt'), tools: ['bash'], action: 'deny' }],
      },
    });
    await expect(bash('cat private.txt')).rejects.toMatchObject({ code: 'tool_denied' });
  });
});

// T001 — a `$(...)` in the command-name position was never walked.
describe('Bash AST command substitution in the name position', () => {
  // Approving rather than refusing, so the assertion separates "the inner
  // operand was judged and denied" from "the whole call was merely unresolved".
  it.each([
    '$(cat .env) foo',
    '`cat .env` foo',
  ])('judges the operands of the inner command: %s', async (command) => {
    let approvals = 0;
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'allow-once';
        },
      },
    });
    await expect(bash(command)).rejects.toMatchObject({ code: 'tool_denied' });
    expect(approvals).toBe(0);
  });
  it('only asks when the inner command touches nothing denied', async () => {
    let approvals = 0;
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub/file'), 'amber');
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'allow-once';
        },
      },
    });
    await expect(bash('$(echo cat) sub/file')).resolves.toBeDefined();
    expect(approvals).toBe(1);
  });
});

// T001 — values glued to a switch, and `key=value` operands joined onto cwd.
describe('Bash AST option and key=value operands', () => {
  it('registers a path glued to a short option', async () => {
    let approvals = 0;
    await writeFile(join(dir, 'file'), 'x');
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash(`cp -t'${outside}' file`)).rejects.toMatchObject({ code: 'tool_denied' });
    expect(approvals).toBe(1);
  });
  // A deny scope rather than a `*.env` rule: the suffix rules match the whole
  // word `if=secret.env` too, so they cannot tell the two spellings apart.
  it('registers the value of a key=value operand against the deny rules', async () => {
    await writeFile(join(dir, 'private.txt'), 'private');
    await start({
      permissions: {
        gear: 'auto',
        scopes: [{ root: join(dir, 'private.txt'), tools: ['bash'], action: 'deny' }],
      },
    });
    await expect(bash('dd if=private.txt of=copy bs=1')).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
  it('asks before a key=value operand targets a path outside the workspace', async () => {
    let approvals = 0;
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(
      bash(`dd if=/dev/zero of='${join(outside, 'blob')}' bs=1 count=1`)
    ).rejects.toMatchObject({ code: 'tool_denied' });
    expect(approvals).toBe(1);
  });
  it('does not turn plain switches or in-workspace operands into approvals', async () => {
    let approvals = 0;
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub/file'), 'amber');
    await start({
      permissions: {
        gear: 'accept-edits',
        approve: async () => {
          approvals++;
          return 'deny';
        },
      },
    });
    await expect(bash('ls -la')).resolves.toBeDefined();
    await expect(bash('head -n 1 sub/file')).resolves.toBeDefined();
    await expect(bash('dd if=sub/file of=sub/copy bs=1 count=5')).resolves.toBeDefined();
    expect(approvals).toBe(0);
  });
});

describe('native permission policy loading', () => {
  it('imports global deny rules and retains them in auto', async () => {
    const agentDir = join(dir, 'agent');
    await config(join(agentDir, 'extensions/pi-permission-system/config.json'), {
      permission: { bash: { 'touch *': 'deny' }, path: { 'private.txt': 'deny' } },
    });
    await start({ agentDir, permissions: { gear: 'auto' } });
    await expect(bash('touch changed')).rejects.toMatchObject({ code: 'tool_denied' });
    await expect(bash('cat private.txt')).rejects.toMatchObject({ code: 'tool_denied' });
  });
  it('ignores project policy until the host explicitly trusts it', async () => {
    await config(join(dir, '.pi/extensions/pi-permission-system/config.json'), {
      permission: { bash: 'deny' },
    });
    await start({ permissions: { gear: 'accept-edits' } });
    await expect(bash('pwd')).resolves.toBeDefined();
    await start({ permissions: { gear: 'accept-edits', projectTrusted: true } });
    await expect(bash('pwd')).rejects.toMatchObject({ code: 'tool_denied' });
  });
  it('reads legacy JSONC and overlays current global config without discarding table entries', async () => {
    const agentDir = join(dir, 'agent');
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, 'pi-permissions.jsonc'),
      '{ // old policy\n "permission": { "bash": { "touch *": "deny" } } }'
    );
    await config(join(agentDir, 'extensions/pi-permission-system/config.json'), {
      permission: { bash: { 'rm *': { action: 'deny', reason: 'keep files' } } },
    });
    await start({ agentDir, permissions: { gear: 'auto' } });
    await expect(bash('touch file')).rejects.toMatchObject({ code: 'tool_denied' });
    await expect(bash('rm file')).rejects.toMatchObject({ code: 'tool_denied' });
  });
});
