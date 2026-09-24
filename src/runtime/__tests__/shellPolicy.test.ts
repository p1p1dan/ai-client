import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { standaloneHost } from '../host/config.ts';
import { resolveWorkerShell } from '../host/shell.ts';
import {
  normalizeShellPath,
  shellOperandPath,
  splitShellPath,
} from '../plugins/permissions/bash-analysis.ts';
import { pathPolicy } from '../plugins/permissions/index.ts';
import { normalizeWindowsPathForm } from '../plugins/permissions/windows-paths.ts';
import { alwaysDenied } from './fixtures/approval.ts';

let dir: string;
let outside: string;
let runtime: RuntimeHandle | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shell-policy-'));
  outside = await mkdtemp(join(tmpdir(), 'shell-outside-'));
});
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
async function start(options: Partial<RuntimeBootstrapOptions> = {}) {
  const provider = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  provider.setResponses([fauxAssistantMessage('ready')]);
  runtime = await createRuntime({
    providers: [provider.provider],
    host: standaloneHost({ PATH: process.env.PATH, HOME: homedir() }),
    // The shell the native worker would pick here: /bin/bash on Unix, the
    // installed Git Bash on Windows, so the AST policy is exercised on both.
    tools: { cwd: dir, shellPath: resolveWorkerShell(process.env as Record<string, string>) },
    ...options,
    // The subject of this suite is the shell path gate, so the default approver
    // refuses: a `tool_denied` below then means the command REACHED the gate.
    permissions: { approve: alwaysDenied, ...(options.permissions ?? { gear: 'accept-edits' }) },
  });
  return runtime;
}
async function bash(command: string) {
  const tool = runtime?.ctx.runtimeTools.list().find((tool) => tool.name === 'bash');
  if (!tool) throw new Error('bash missing');
  return tool.execute('shell', { command });
}
/** The Node-side executor, which opens whatever path the guard handed back. */
async function readTool(path: string) {
  const tool = runtime?.ctx.runtimeTools.list().find((tool) => tool.name === 'read');
  if (!tool) throw new Error('read missing');
  return tool.execute('read', { path });
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
    const result = await bash('mkdir sub; printf amber > sub/file; cat sub/file | head -n 1');
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('amber') })])
    );
    await expect(bash('cat sub/*')).resolves.toBeDefined();
    expect(approvals).toBe(0);
    await expect(bash("rg '.env' sub/file")).resolves.toBeDefined();
  });
  it('tolerates a bash wildcard whose parent directory does not exist yet (tools-07)', async () => {
    await start({ permissions: { gear: 'accept-edits' } });
    // `nosuchdir` was never created: checkShellPaths.expand used to opendir()
    // the wildcard's parent unconditionally and let the bare ENOENT abort the
    // whole tool call before a real shell even ran a no-match glob.
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
      await expect(bash(command)).rejects.toMatchObject({ code: 'tool_denied' });
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
  // `mklink /J` needs no privilege, so a junction is the spelling this escape
  // actually takes on Windows. Node ignores the `'junction'` type off Windows
  // and makes an ordinary symlink, which carries the same POSIX `..` semantics,
  // so both branches assert the same property on every platform.
  it('resolves a junction before applying `..` to it', async () => {
    await mkdir(join(outside, 'sub'));
    await writeFile(join(outside, 'outside-file'), 'external');
    await symlink(join(outside, 'sub'), join(dir, 'jlink'), 'junction');
    await start();
    await expect(bash('cat jlink/../outside-file')).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
  // The zero-approval escape: a junction pointing at the workspace ITSELF is
  // inside the workspace by every lexical reading, so `<ws>/self/..` folds back
  // to `<ws>` on paper while the shell climbs out of it.
  it('follows a junction to the workspace and counts `..` above it as outside', async () => {
    await writeFile(join(outside, 'file'), 'external');
    await symlink(dir, join(dir, 'self'), 'junction');
    await start();
    await expect(bash(`cat self/../${basename(outside)}/file`)).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });
  // The guard's ANSWER is what the tools open, so a `..` that cancels a segment
  // which does not exist must not stop the walk: the link after it is still
  // traversed by the OS. Asserted through bash and through the Node-side read,
  // because they open that answer by two different routes.
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
  it('does not load BASH_ENV even when the host environment supplies it', async () => {
    const startup = join(dir, 'startup');
    await writeFile(startup, `printf unexpected > '${join(dir, 'effect')}'`);
    await start({ host: standaloneHost({ PATH: process.env.PATH, BASH_ENV: startup }) });
    await bash('pwd');
    await expect(readFile(join(dir, 'effect'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects malformed shell instead of falling back to an empty permission analysis', async () => {
    await start({ permissions: { gear: 'auto' } });
    await expect(bash("cat 'unfinished")).rejects.toMatchObject({ code: 'invalid_tool_arguments' });
  });
});

// T001 — the analysis reached neither of the two places tree-sitter hangs a
// redirect off a `command` node, so a leading `> file` and a `<<<` here-string
// were invisible to every path judgement.
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
    expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe('hi\n');
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

// T001 — an interpreter handed a script file runs code the analysis never
// reads, which the P1 evidence promised would still reach approval.
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
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('ok');
  });
});

// T001 — `auto` used to return allow before `unresolvedPaths` was consulted, so
// an operand the analysis could not read skipped every judgement.
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
 * The fourth gear, and the one the previous suite explains the need for.
 *
 * `auto` raises a card for an operand the static analysis could not read — a
 * `$VAR`, a `$(…)`, a loop variable — which is exactly the "fully automatic, yet it still pops an approval card"
 * the field pass kept reporting. `bypass` answers those too. What it must NOT
 * do is acquire authority: every deny is decided before any gear is consulted,
 * so the second half of this suite is the list of things that still refuse.
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
    // Both halves of the case `auto` stops for: an unreadable variable, and a
    // variable that resolves to a path outside the workspace.
    await expect(bash('cat "$UNKNOWN_DIR/file" 2>/dev/null; true')).resolves.toBeDefined();
    await expect(bash(`TARGET='${outside}'; cat "$TARGET/file"`)).resolves.toBeDefined();
    await expect(bash('for f in *.txt; do echo "$f"; done')).resolves.toBeDefined();
    expect(approvals).toBe(0);
  });

  it('is not a way past the bundled path denies', async () => {
    await start({ permissions: { gear: 'bypass' } });
    // `approve` is `alwaysDenied` here, so a `tool_denied` could in principle
    // mean "a card was raised and refused". These are policy denies, which
    // return before the gate: the point is that the call never runs.
    for (const command of ['cat .env', 'cat ~/.ssh/config', 'cat *.pem', 'printf x > .env'])
      await expect(bash(command)).rejects.toMatchObject({ code: 'tool_denied' });
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

  it('is not a way past plan mode or the tool whitelist', async () => {
    await start({
      permissions: { mode: 'plan', gear: 'bypass', allowedTools: ['read', 'bash', 'glob', 'grep'] },
    });
    const permissions = runtime?.ctx.runtimePermissions;
    if (!permissions) throw new Error('no permissions service');
    // Plan mode crops write tools, and the gate refuses them even when the
    // caller still holds a handle to one.
    expect(
      permissions.evaluate({ tool: 'write', toolCallId: 'plan-write', path: join(dir, 'a.txt') })
    ).toBe('deny');
    // A tool outside the whitelist is denied on the same principle.
    expect(
      permissions.evaluate({ tool: 'edit', toolCallId: 'not-listed', path: join(dir, 'a.txt') })
    ).toBe('deny');
    // And a non-exploration shell call is still a plan-mode refusal.
    expect(
      permissions.evaluate({
        tool: 'bash',
        toolCallId: 'plan-bash',
        path: dir,
        command: 'rm -rf x',
      })
    ).toBe('deny');
  });
});

// T001 — a `$(...)` in the command-name position was never walked, so the inner
// command's operands reached no judgement at all.
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

// T001 — `addPath` dropped values glued to a switch and joined `key=value`
// operands onto cwd, which made a target outside the workspace read as inside.
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

// T001 — Windows commands are written with '/' while node's `sep` is '\\', and
// splitting on `sep` alone glued the wildcard to its parent so nothing matched.
// Pinned on the pure helpers, which needs no Windows machine.
describe('shell path separator folding', () => {
  it('keeps a wildcard its own segment when the command used the other separator', () => {
    expect(normalizeShellPath('C:\\work\\conf/*', '\\')).toBe('C:\\work\\conf\\*');
    expect(splitShellPath('C:\\work\\conf/*', '\\')).toEqual(['C:', 'work', 'conf', '*']);
    expect(splitShellPath(normalizeShellPath('C:\\work\\conf/*', '\\'), '\\')).toEqual([
      'C:',
      'work',
      'conf',
      '*',
    ]);
  });
  it('leaves a POSIX path alone, backslashes in names included', () => {
    expect(normalizeShellPath('/work/conf/*', '/')).toBe('/work/conf/*');
    expect(splitShellPath('/work/od\\d/*', '/')).toEqual(['', 'work', 'od\\d', '*']);
  });
});

// T039 / windows-01 — one file, several legal Windows spellings, and gates that
// compare strings. Git Bash writes `/c/Users/...`, Cygwin `/cygdrive/c/...` and
// the kernel `\\?\C:\...`; before this, only the native spelling matched the
// deny for `~/.ssh/*`, so `cat /c/Users/JC/.ssh/id_ed25519` was allowed outright
// in the auto gear. Platform and home are injected, so no Windows machine is
// needed and the POSIX behaviour is asserted next to it.
describe('windows path spellings', () => {
  const win = { platform: 'win32' as const, home: 'C:\\Users\\JC' };
  const posixEnvironment = { platform: 'linux' as const, home: '/home/jc' };

  it('folds MSYS, Cygwin and extended-length spellings onto the native one', () => {
    expect(normalizeWindowsPathForm('/c/Users/JC/.ssh/id_ed25519', 'win32')).toBe(
      'C:/Users/JC/.ssh/id_ed25519'
    );
    expect(normalizeWindowsPathForm('/cygdrive/d/data/app.env', 'win32')).toBe('D:/data/app.env');
    expect(normalizeWindowsPathForm('\\\\?\\C:\\Users\\JC\\.ssh\\config', 'win32')).toBe(
      'C:\\Users\\JC\\.ssh\\config'
    );
    expect(normalizeWindowsPathForm('\\\\?\\UNC\\srv\\share\\key.pem', 'win32')).toBe(
      '\\\\srv\\share\\key.pem'
    );
    expect(normalizeWindowsPathForm('c:\\work\\app.ts', 'win32')).toBe('C:\\work\\app.ts');
    expect(normalizeWindowsPathForm('/c', 'win32')).toBe('C:/');
    // Not a drive letter: a real directory named `conf` keeps its own spelling.
    expect(normalizeWindowsPathForm('/conf/app.ts', 'win32')).toBe('/conf/app.ts');
    // Off Windows every one of those is an ordinary path and stays untouched.
    expect(normalizeWindowsPathForm('/c/Users/JC/.ssh/id_ed25519', 'linux')).toBe(
      '/c/Users/JC/.ssh/id_ed25519'
    );
  });

  it('matches the uncoverable deny whatever spelling the shell used', () => {
    for (const spelling of [
      'C:\\Users\\JC\\.ssh\\id_ed25519',
      '/c/Users/JC/.ssh/id_ed25519',
      '/c/Users/JC/.ssh/config',
      '/cygdrive/c/Users/JC/.ssh/known_hosts',
      '\\\\?\\C:\\Users\\JC\\.ssh\\id_ed25519',
      '/c/Users/JC/.aws/credentials',
      'c:/users/jc/.aws/credentials',
    ]) {
      expect(pathPolicy(spelling, win), spelling).toBe('deny');
    }
    expect(pathPolicy('/c/Users/JC/work/app.ts', win)).toBe('allow');
    // The basename rules never depended on the spelling, and still do not.
    expect(pathPolicy('/c/Users/JC/work/.env', win)).toBe('deny');
  });

  it('leaves the POSIX reading of the same strings alone', () => {
    // `/c/...` is an ordinary absolute path here and names nobody's key.
    expect(pathPolicy('/c/Users/JC/.ssh/id_ed25519', posixEnvironment)).toBe('allow');
    expect(pathPolicy('/home/jc/.ssh/id_ed25519', posixEnvironment)).toBe('deny');
    expect(pathPolicy('/home/jc/.aws/credentials', posixEnvironment)).toBe('deny');
    expect(pathPolicy('/home/jc/work/app.ts', posixEnvironment)).toBe('allow');
  });

  it('registers a Git Bash operand under the spelling every gate compares', () => {
    expect(shellOperandPath('/c/Users/JC/.ssh/id_ed25519', 'C:\\work', 'win32')).toBe(
      'C:\\Users\\JC\\.ssh\\id_ed25519'
    );
    expect(shellOperandPath('notes.txt', 'C:\\work', 'win32')).toBe('C:\\work\\notes.txt');
    expect(shellOperandPath('conf/*', 'C:\\work', 'win32')).toBe('C:\\work\\conf\\*');
    expect(shellOperandPath('/etc/hosts', '/work', 'linux')).toBe('/etc/hosts');
    expect(shellOperandPath('notes.txt', '/work', 'linux')).toBe('/work/notes.txt');
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
    await runtime?.dispose();
    runtime = undefined;
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
  it('fails startup for invalid policy rather than losing a deny', async () => {
    const agentDir = join(dir, 'agent');
    await config(join(agentDir, 'extensions/pi-permission-system/config.json'), {
      permission: { bash: 'invalid' },
    });
    await expect(start({ agentDir })).rejects.toMatchObject({ code: 'permission_policy_invalid' });
  });
});
