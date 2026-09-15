/**
 * T035 / decision 008 — the `settingSources` switch, across all four layered
 * sources at once.
 *
 * The switch is one line of config and four independent readers, which is
 * exactly the shape that drifts: it is easy to gate the permission policy and
 * forget the second user skills root, and nothing fails loudly when that
 * happens — the session just quietly keeps reading a file the caller asked it
 * not to. So each reader gets the same three questions here: does omitting the
 * list still mean all three, does switching a tier off actually stop the read,
 * and does the local tier win over the project one.
 */

import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_PROJECT_TRUSTED } from '../../shared/piModelConfig.ts';
import type { RuntimeHostIoService } from '../contracts.ts';
import { RuntimeHostError } from '../host/errors.ts';
import { loadMcpConfig, type McpConfigSource, mcpConfigFiles } from '../plugins/mcp/config.ts';
import { loadPermissionPolicy } from '../plugins/permissions/policy.ts';
import {
  type InstructionSource,
  loadInstructionChain,
} from '../plugins/prompt/projectInstructions.ts';
import { skillRoots, templateRoots } from '../plugins/skills/index.ts';
import { resolveSettingSources } from '../settingSources.ts';

const AGENT_DIR = resolve('/agent');
const CWD = resolve('/work/repo');
const HOME = resolve('/home/u');

const GLOBAL_POLICY = join(AGENT_DIR, 'pi-permissions.jsonc');
const PROJECT_POLICY = join(CWD, '.pi/agent/pi-permissions.jsonc');
const LOCAL_POLICY = join(CWD, '.pi/agent/pi-permissions.local.jsonc');

/** Only `readFile` is ever reached by the policy loader; the rest would be a lie. */
function policyIo(files: Record<string, unknown>) {
  const reads: string[] = [];
  const io = {
    async readFile(path: string) {
      reads.push(path);
      const document = files[path];
      if (document === undefined) throw new RuntimeHostError('ENOENT', `no such file: ${path}`);
      return {
        bytes: new TextEncoder().encode(JSON.stringify(document)),
        truncated: false,
        source: 'direct' as const,
      };
    },
  } as unknown as RuntimeHostIoService;
  return { io, reads };
}

function mcpSource(files: Record<string, unknown>): McpConfigSource {
  return {
    async readText(path) {
      const document = files[path];
      return document === undefined ? undefined : JSON.stringify(document);
    },
  };
}

/** `skillRoots` only stats `.git` while climbing; nothing here has one. */
const noGit = {
  async stat() {
    throw new RuntimeHostError('ENOENT', 'no .git');
  },
} as unknown as Pick<RuntimeHostIoService, 'stat'>;

describe('resolveSettingSources', () => {
  it('treats an omitted list as all three', () => {
    expect(resolveSettingSources({ projectTrusted: true })).toEqual({
      user: true,
      project: true,
      local: true,
    });
  });

  it('treats an empty list as none of them', () => {
    // Distinct from "omitted" on purpose: a fixed probe asks for exactly this.
    expect(resolveSettingSources({ projectTrusted: true, settingSources: [] })).toEqual({
      user: false,
      project: false,
      local: false,
    });
  });

  it('closes project and local for an untrusted workspace whatever the list says', () => {
    expect(resolveSettingSources({ settingSources: ['user', 'project', 'local'] })).toEqual({
      user: true,
      project: false,
      local: false,
    });
  });
});

describe('loadPermissionPolicy under settingSources', () => {
  it('reads all three tiers by default and lets local win on a shared key', async () => {
    const { io } = policyIo({
      [GLOBAL_POLICY]: { permission: { bash: { 'git *': 'ask', 'npm *': 'ask' } } },
      [PROJECT_POLICY]: { permission: { bash: { 'git *': 'allow' } } },
      [LOCAL_POLICY]: { permission: { bash: { 'git *': 'deny' } } },
    });
    const policy = await loadPermissionPolicy(io, {
      cwd: CWD,
      agentDir: AGENT_DIR,
      projectTrusted: true,
    });
    expect(policy.config.permission?.bash).toMatchObject({ 'git *': 'deny', 'npm *': 'ask' });
    expect(policy.sources).toEqual([GLOBAL_POLICY, PROJECT_POLICY, LOCAL_POLICY]);
  });

  it('does not read the agent-dir files when the user source is off', async () => {
    const { io, reads } = policyIo({
      [GLOBAL_POLICY]: { permission: { bash: 'deny' } },
      [PROJECT_POLICY]: { permission: { bash: 'allow' } },
    });
    const policy = await loadPermissionPolicy(io, {
      cwd: CWD,
      agentDir: AGENT_DIR,
      projectTrusted: true,
      settingSources: ['project', 'local'],
    });
    expect(reads).not.toContain(GLOBAL_POLICY);
    expect(policy.sources).toEqual([PROJECT_POLICY]);
  });

  it('keeps the bundled policy whatever the switch says', async () => {
    // decision 008 clause 3: the shipped fail-closed policy is the product's
    // own floor, not a source a caller can drop. `*.env` is one of its denies.
    const { io } = policyIo({});
    const policy = await loadPermissionPolicy(io, {
      cwd: CWD,
      agentDir: AGENT_DIR,
      projectTrusted: true,
      settingSources: [],
    });
    expect(policy.sources).toEqual([]);
    expect(policy.config.permission?.path).toMatchObject({ '*.env': 'deny' });
  });

  it('withholds the local file from an untrusted workspace', async () => {
    const { io, reads } = policyIo({ [LOCAL_POLICY]: { permission: { bash: 'allow' } } });
    const policy = await loadPermissionPolicy(io, { cwd: CWD, agentDir: AGENT_DIR });
    expect(reads).not.toContain(LOCAL_POLICY);
    expect(policy.sources).toEqual([]);
  });
});

describe('MCP config under settingSources', () => {
  it('drops the user file when the user source is off', () => {
    expect(
      mcpConfigFiles({
        agentDir: AGENT_DIR,
        cwd: CWD,
        projectTrusted: true,
        settingSources: ['project', 'local'],
      }).map((file) => file.scope)
    ).toEqual(['project', 'local']);
  });

  it('lets a local server replace a project one of the same name', async () => {
    const loaded = await loadMcpConfig(
      mcpSource({
        [join(AGENT_DIR, 'mcp.json')]: { mcpServers: { files: { command: 'user.mjs' } } },
        [join(CWD, '.pi', 'mcp.json')]: { mcpServers: { files: { command: 'project.mjs' } } },
        [join(CWD, '.pi', 'mcp.local.json')]: { mcpServers: { files: { command: 'local.mjs' } } },
      }),
      { agentDir: AGENT_DIR, cwd: CWD, projectTrusted: true }
    );
    expect(loaded.servers).toHaveLength(1);
    expect(loaded.servers[0]).toMatchObject({ command: 'local.mjs', scope: 'local' });
  });

  it('lets a local file turn off a server the project declared', async () => {
    // `disabled` and a redefinition have to mean the same precedence, or a user
    // who silenced a server locally finds it running anyway.
    const loaded = await loadMcpConfig(
      mcpSource({
        [join(CWD, '.pi', 'mcp.json')]: { mcpServers: { files: { command: 'project.mjs' } } },
        [join(CWD, '.pi', 'mcp.local.json')]: {
          mcpServers: { files: { command: 'project.mjs', disabled: true } },
        },
      }),
      { cwd: CWD, projectTrusted: true }
    );
    expect(loaded.servers).toEqual([]);
  });

  it('keeps the user server when the local tier alone is switched off', async () => {
    const loaded = await loadMcpConfig(
      mcpSource({
        [join(AGENT_DIR, 'mcp.json')]: { mcpServers: { files: { command: 'user.mjs' } } },
        [join(CWD, '.pi', 'mcp.local.json')]: { mcpServers: { files: { command: 'local.mjs' } } },
      }),
      {
        agentDir: AGENT_DIR,
        cwd: CWD,
        projectTrusted: true,
        settingSources: ['user', 'project'],
      }
    );
    expect(loaded.servers[0]).toMatchObject({ command: 'user.mjs', scope: 'user' });
  });
});

describe('skills and prompt templates under settingSources', () => {
  it('scans no user root when the user source is off', async () => {
    const roots = await skillRoots(noGit, {
      agentDir: AGENT_DIR,
      cwd: CWD,
      home: HOME,
      projectTrusted: true,
      settingSources: ['project', 'local'],
    });
    // Both user roots, not just the agent dir's: `~/.agents/skills` is the
    // other half of the same tier and used to be unconditional.
    expect(roots.map((root) => root.path)).not.toContain(join(AGENT_DIR, 'skills'));
    expect(roots.map((root) => root.path)).not.toContain(join(HOME, '.agents', 'skills'));
    expect(roots.every((root) => root.scope === 'project')).toBe(true);
  });

  it('scans no project root when the project source is off, and defines no local root', async () => {
    const roots = await skillRoots(noGit, {
      agentDir: AGENT_DIR,
      cwd: CWD,
      home: HOME,
      projectTrusted: true,
      settingSources: ['user', 'local'],
    });
    // decision 008 names three local FILES and no local skills directory, so
    // asking for `local` must not conjure a fourth path out of nowhere.
    expect(roots.map((root) => root.path)).toEqual([
      join(AGENT_DIR, 'skills'),
      join(HOME, '.agents', 'skills'),
    ]);
  });

  it('keeps user before project so the nearer declaration still wins', async () => {
    const roots = await skillRoots(noGit, {
      agentDir: AGENT_DIR,
      cwd: CWD,
      home: HOME,
      projectTrusted: true,
    });
    const scopes = roots.map((root) => root.scope);
    expect(scopes.lastIndexOf('user')).toBeLessThan(scopes.indexOf('project'));
  });

  it('gates prompt templates on the same two switches', () => {
    expect(
      templateRoots({ agentDir: AGENT_DIR, cwd: CWD, projectTrusted: true }).map(
        (root) => root.path
      )
    ).toEqual([join(AGENT_DIR, 'prompts'), join(CWD, '.pi', 'prompts')]);
    expect(
      templateRoots({
        agentDir: AGENT_DIR,
        cwd: CWD,
        projectTrusted: true,
        settingSources: ['project'],
      }).map((root) => root.path)
    ).toEqual([join(CWD, '.pi', 'prompts')]);
  });
});

/**
 * decision 009 — what a company-account session actually loads.
 *
 * Until this decision the managed route started its worker with
 * `projectTrusted: false`, and all four readers below quietly skipped the
 * repository. Nothing failed: the policy merged one scope fewer, the MCP
 * servers were not there to be missed, the skills menu was shorter, and the
 * repo's own CLAUDE.md never reached the prompt. That is the whole reason this
 * block drives the real constant rather than a literal `true` — flipping
 * {@link NATIVE_PROJECT_TRUSTED} back has to turn something red here, or the
 * decision has no test at all.
 *
 * The one project-scoped thing that stays out is model settings, and it is
 * absent by construction rather than by a switch: no reader in this runtime
 * takes a model catalogue from the workspace. The catalogue arrives from Main's
 * hand-over or from the agent directory (`plugins/model-adapter/catalog.ts`),
 * which is why there is no fifth case below.
 */
describe('decision 009 — a trusted project, through every project-scoped reader', () => {
  const PROJECT_MCP = join(CWD, '.pi', 'mcp.json');
  const CLAUDE_MD = join(CWD, 'CLAUDE.md');

  it('merges the repository permission policy over the agent directory', async () => {
    const { io } = policyIo({
      [GLOBAL_POLICY]: { permission: { bash: { 'git *': 'ask' } } },
      [PROJECT_POLICY]: { permission: { bash: { 'git *': 'allow' } } },
    });
    const policy = await loadPermissionPolicy(io, {
      cwd: CWD,
      agentDir: AGENT_DIR,
      projectTrusted: NATIVE_PROJECT_TRUSTED,
    });
    expect(policy.sources).toContain(PROJECT_POLICY);
    expect(policy.config.permission?.bash).toMatchObject({ 'git *': 'allow' });
  });

  it('connects the servers the repository declares', async () => {
    const loaded = await loadMcpConfig(
      mcpSource({ [PROJECT_MCP]: { mcpServers: { files: { command: 'project.mjs' } } } }),
      { agentDir: AGENT_DIR, cwd: CWD, projectTrusted: NATIVE_PROJECT_TRUSTED }
    );
    expect(loaded.servers[0]).toMatchObject({ command: 'project.mjs', scope: 'project' });
  });

  it('scans the repository skill and prompt-template roots', async () => {
    const roots = await skillRoots(noGit, {
      agentDir: AGENT_DIR,
      cwd: CWD,
      home: HOME,
      projectTrusted: NATIVE_PROJECT_TRUSTED,
    });
    expect(roots.some((root) => root.scope === 'project')).toBe(true);
    expect(
      templateRoots({
        agentDir: AGENT_DIR,
        cwd: CWD,
        projectTrusted: NATIVE_PROJECT_TRUSTED,
      }).map((root) => root.path)
    ).toContain(join(CWD, '.pi', 'prompts'));
  });

  it('puts the repository’s own instructions in the prompt', async () => {
    const files: Record<string, string> = { [CLAUDE_MD]: 'repo house rules' };
    const source: InstructionSource = {
      async readText(path) {
        return files[path];
      },
      async realpath(path) {
        return path in files || path === CWD ? path : undefined;
      },
    };
    const chain = await loadInstructionChain(source, {
      root: CWD,
      projectTrusted: NATIVE_PROJECT_TRUSTED,
    });
    expect(chain.map((entry) => entry.content)).toEqual(['repo house rules']);
  });
});
