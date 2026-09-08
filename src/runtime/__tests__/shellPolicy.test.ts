import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { standaloneHost } from '../host/config.ts';

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
    tools: { cwd: dir, shellPath: '/bin/bash' },
    permissions: { gear: 'accept-edits' },
    ...options,
  });
  return runtime;
}
async function bash(command: string) {
  const tool = runtime?.ctx.runtimeTools.list().find((tool) => tool.name === 'bash');
  if (!tool) throw new Error('bash missing');
  return tool.execute('shell', { command });
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
  it('requires approval for variable and nested-shell external paths', async () => {
    await start();
    for (const command of [
      `TARGET='${outside}'; cat "$TARGET/file"`,
      `bash -c 'cd "${outside}"; pwd'`,
      `cd '${outside}' && pwd`,
      'cat "$UNKNOWN_DIR/file"',
      `git -C${outside} status`,
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
