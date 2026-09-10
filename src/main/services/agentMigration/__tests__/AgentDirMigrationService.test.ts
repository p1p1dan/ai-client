/**
 * H/19 U2 — the migration, on real temp directories.
 *
 * Real files rather than an `fs` mock: the thing worth proving is that the
 * user's directory comes out UNCHANGED, and a mock would only prove that the
 * calls we expected were the calls we made.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserProvider } from '../../auth/CredentialVault';
import { AgentDirMigrationService, type MigrationProviderStore } from '../AgentDirMigrationService';

let root: string;
let source: string;
let target: string;
let stored: UserProvider[];
let readable: boolean;

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function store(): MigrationProviderStore {
  return {
    list: () => (readable ? stored : null),
    save: async (providers) => {
      stored = [...providers];
    },
  };
}

function service(options: { env?: NodeJS.ProcessEnv } = {}): AgentDirMigrationService {
  return new AgentDirMigrationService({
    sourceDir: source,
    targetDir: target,
    providers: store(),
    env: options.env ?? {},
    now: () => new Date('2026-09-10T00:00:00.000Z'),
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });
}

function item(plan: ReturnType<AgentDirMigrationService['inspect']>, kind: string) {
  return plan.items.find((entry) => entry.kind === kind);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiclient-migration-'));
  source = join(root, 'user', '.pi', 'agent');
  target = join(root, 'app', 'pi-agent');
  mkdirSync(target, { recursive: true });
  stored = [];
  readable = true;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('inspect', () => {
  it('says nothing exists when the user has no Pi directory', () => {
    const plan = service().inspect();
    expect(plan.sourceExists).toBe(false);
    expect(plan.items).toEqual([]);
    expect(plan.nothingToDo).toBe(true);
  });

  it('lists each kind with its own entries, and omits the empty ones', () => {
    write(join(source, 'skills', 'reviewer', 'SKILL.md'), '# reviewer');
    write(join(source, 'AGENTS.md'), 'guidance');
    const plan = service().inspect();

    expect(plan.items.map((entry) => entry.kind)).toEqual(['skills', 'agentsFile']);
    expect(item(plan, 'skills')?.entries).toEqual([{ name: 'reviewer', conflict: false }]);
    expect(plan.nothingToDo).toBe(false);
  });

  it('flags a name the destination already has, without calling it a failure', () => {
    write(join(source, 'skills', 'reviewer', 'SKILL.md'), '# theirs');
    write(join(target, 'skills', 'reviewer', 'SKILL.md'), '# ours');
    const plan = service().inspect();
    expect(item(plan, 'skills')).toMatchObject({ total: 1, conflicts: 1 });
    // Everything present already means there is nothing to do — but the item is
    // still listed, because the user may want to replace it.
    expect(plan.nothingToDo).toBe(true);
  });
});

describe('apply — files', () => {
  it('copies a skill and leaves the source untouched', async () => {
    write(join(source, 'skills', 'reviewer', 'SKILL.md'), '# reviewer');
    const result = await service().apply({ kinds: ['skills'], onConflict: 'skip' });

    expect(result.outcomes[0]).toMatchObject({ kind: 'skills', copied: 1, skipped: 0 });
    expect(readFileSync(join(target, 'skills', 'reviewer', 'SKILL.md'), 'utf8')).toBe('# reviewer');
    expect(readFileSync(join(source, 'skills', 'reviewer', 'SKILL.md'), 'utf8')).toBe('# reviewer');
  });

  it('keeps what is already here unless replacing was asked for', async () => {
    write(join(source, 'skills', 'reviewer', 'SKILL.md'), '# theirs');
    write(join(target, 'skills', 'reviewer', 'SKILL.md'), '# ours');

    const skipped = await service().apply({ kinds: ['skills'], onConflict: 'skip' });
    expect(skipped.outcomes[0]).toMatchObject({ copied: 0, skipped: 1, overwritten: 0 });
    expect(readFileSync(join(target, 'skills', 'reviewer', 'SKILL.md'), 'utf8')).toBe('# ours');

    const replaced = await service().apply({ kinds: ['skills'], onConflict: 'overwrite' });
    expect(replaced.outcomes[0]).toMatchObject({ copied: 0, skipped: 0, overwritten: 1 });
    expect(readFileSync(join(target, 'skills', 'reviewer', 'SKILL.md'), 'utf8')).toBe('# theirs');
  });

  it('running twice adds nothing the second time', async () => {
    write(join(source, 'skills', 'reviewer', 'SKILL.md'), '# reviewer');
    write(join(source, 'AGENTS.md'), 'guidance');
    const first = await service().apply({
      kinds: ['skills', 'agentsFile'],
      onConflict: 'skip',
    });
    const second = await service().apply({
      kinds: ['skills', 'agentsFile'],
      onConflict: 'skip',
    });
    expect(first.outcomes.every((outcome) => outcome.copied === 1)).toBe(true);
    expect(second.outcomes.every((outcome) => outcome.copied === 0 && outcome.skipped === 1)).toBe(
      true
    );
    expect(second.plan.nothingToDo).toBe(true);
  });

  it('merges session history file by file rather than directory by directory', async () => {
    // U3: a project the user is already working in has a directory HERE too.
    // Whole-directory skipping would hide every one of their older
    // conversations for exactly the project they use most.
    write(join(source, 'sessions', '-home-u-repo', 'old.jsonl'), 'a');
    write(join(source, 'sessions', '-home-u-repo', 'shared.jsonl'), 'theirs');
    write(join(target, 'sessions', '-home-u-repo', 'shared.jsonl'), 'ours');

    const result = await service().apply({ kinds: ['sessions'], onConflict: 'skip' });
    expect(result.outcomes[0]).toMatchObject({ copied: 1, skipped: 1 });
    expect(readFileSync(join(target, 'sessions', '-home-u-repo', 'old.jsonl'), 'utf8')).toBe('a');
    expect(readFileSync(join(target, 'sessions', '-home-u-repo', 'shared.jsonl'), 'utf8')).toBe(
      'ours'
    );
  });

  it('refuses to migrate a directory onto itself', () => {
    write(join(source, 'skills', 'reviewer', 'SKILL.md'), '# reviewer');
    const same = new AgentDirMigrationService({
      sourceDir: source,
      targetDir: source,
      providers: store(),
    });
    expect(same.inspect().items).toEqual([]);
  });
});

describe('apply — AI services', () => {
  function writeModels(providers: Record<string, unknown>, auth?: Record<string, unknown>): void {
    write(join(source, 'models.json'), JSON.stringify({ providers }));
    if (auth) write(join(source, 'auth.json'), JSON.stringify(auth));
  }

  it('imports a provider with an inline key, models and all', async () => {
    writeModels({
      cx2: {
        name: 'CX2',
        baseUrl: 'https://cx2.example.com/v1',
        api: 'openai-responses',
        apiKey: 'sk-real',
        models: [{ id: 'gpt-5.6' }, { id: 'gpt-5.6-mini' }],
      },
    });

    const result = await service().apply({ kinds: ['providers'], onConflict: 'skip' });
    expect(result.outcomes[0]).toMatchObject({ copied: 1, failed: [] });
    expect(stored).toEqual([
      {
        id: 'id-1',
        name: 'CX2',
        baseUrl: 'https://cx2.example.com/v1',
        api: 'openai-responses',
        apiKey: 'sk-real',
        models: ['gpt-5.6', 'gpt-5.6-mini'],
        enabled: true,
        createdAt: '2026-09-10T00:00:00.000Z',
      },
    ]);
  });

  it('takes the key from auth.json when the provider carries none', async () => {
    writeModels(
      { local: { baseUrl: 'https://x.example.com/v1', api: 'openai-completions' } },
      { local: { type: 'api_key', key: 'sk-from-auth' } }
    );
    await service().apply({ kinds: ['providers'], onConflict: 'skip' });
    expect(stored[0]).toMatchObject({ name: 'local', apiKey: 'sk-from-auth' });
  });

  it('resolves a $NAME key from the environment, and refuses when it is unset', async () => {
    writeModels({
      env: { baseUrl: 'https://x.example.com/v1', api: 'openai-completions', apiKey: '$MY_KEY' },
    });

    const missing = await service().apply({ kinds: ['providers'], onConflict: 'skip' });
    expect(missing.outcomes[0]?.failed[0]?.error).toContain('environment variable');
    expect(stored).toEqual([]);

    const present = await service({ env: { MY_KEY: 'sk-env' } }).apply({
      kinds: ['providers'],
      onConflict: 'skip',
    });
    expect(present.outcomes[0]).toMatchObject({ copied: 1 });
    expect(stored[0]?.apiKey).toBe('sk-env');
  });

  it('names what it cannot import instead of dropping it', () => {
    writeModels({
      exotic: { baseUrl: 'https://x.example.com/v1', api: 'opencode-go', apiKey: 'k' },
      keyless: { baseUrl: 'https://y.example.com/v1', api: 'openai-completions' },
    });
    const plan = service().inspect();
    const providers = item(plan, 'providers');
    expect(providers?.blocked).toBe(2);
    expect(providers?.entries.map((entry) => entry.blocked)).toEqual([
      expect.stringContaining('opencode-go'),
      expect.stringContaining('API key'),
    ]);
  });

  it('does not duplicate a service on a second run, and can replace one', async () => {
    writeModels({
      cx2: {
        name: 'CX2',
        baseUrl: 'https://cx2.example.com/v1',
        api: 'openai-completions',
        apiKey: 'sk-one',
      },
    });
    await service().apply({ kinds: ['providers'], onConflict: 'skip' });
    expect(stored).toHaveLength(1);

    writeModels({
      cx2: {
        name: 'CX2',
        baseUrl: 'https://cx2.example.com/v2',
        api: 'openai-completions',
        apiKey: 'sk-two',
      },
    });
    const again = await service().apply({ kinds: ['providers'], onConflict: 'skip' });
    expect(again.outcomes[0]).toMatchObject({ copied: 0, skipped: 1 });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.apiKey).toBe('sk-one');

    const replaced = await service().apply({ kinds: ['providers'], onConflict: 'overwrite' });
    expect(replaced.outcomes[0]).toMatchObject({ overwritten: 1 });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ apiKey: 'sk-two', baseUrl: 'https://cx2.example.com/v2' });
  });

  it('writes nothing when the stored group cannot be read', async () => {
    // The failure that matters: importing on top of a list we could not see
    // would delete every service already in it.
    writeModels({
      cx2: { baseUrl: 'https://cx2.example.com/v1', api: 'openai-completions', apiKey: 'k' },
    });
    readable = false;
    const result = await service().apply({ kinds: ['providers'], onConflict: 'overwrite' });
    expect(result.outcomes[0]?.failed[0]?.error).toContain('could not be read');
    expect(stored).toEqual([]);
  });
});
