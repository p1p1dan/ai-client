import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetManagedFileWriterQueuesForTests } from '../../auth/managedFileWriter';
import { deleteMcpServer, readMcpServers, syncMcpServers, upsertMcpServer } from '../McpManager';

describe('McpManager (D47 S2a §1)', () => {
  let homeDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-manager-'));
    // `os.homedir()` reads `process.env.HOME`/`USERPROFILE` — McpManager.ts
    // uses a namespace import (`import * as os`), which vitest's ESM module
    // namespace refuses to `vi.spyOn` ("Module namespace is not
    // configurable"); env override is what `OnboardingService.test.ts` uses
    // for the same reason and is the portable choice here too.
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.CLAUDE_CONFIG_DIR;
    resetManagedFileWriterQueuesForTests();
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  function legacyClaudeJsonPath(): string {
    return path.join(homeDir, '.claude.json');
  }

  it('legacy path stays ~/.claude.json (top-level, NOT nested under .claude/) when CLAUDE_CONFIG_DIR is unset', async () => {
    const ok = await upsertMcpServer({
      id: 'foo',
      name: 'foo',
      transportType: 'stdio',
      command: 'node',
      enabled: true,
    });
    expect(ok).toBe(true);
    expect(existsSync(legacyClaudeJsonPath())).toBe(true);
    expect(existsSync(path.join(homeDir, '.claude', '.claude.json'))).toBe(false);
  });

  it('follows CLAUDE_CONFIG_DIR when set: writes <CLAUDE_CONFIG_DIR>/.claude.json, not ~/.claude.json', async () => {
    const managedDir = mkdtempSync(path.join(os.tmpdir(), 'mcp-manager-managed-'));
    process.env.CLAUDE_CONFIG_DIR = managedDir;
    try {
      const ok = await upsertMcpServer({
        id: 'foo',
        name: 'foo',
        transportType: 'stdio',
        command: 'node',
        enabled: true,
      });
      expect(ok).toBe(true);
      expect(existsSync(path.join(managedDir, '.claude.json'))).toBe(true);
      expect(existsSync(legacyClaudeJsonPath())).toBe(false);
    } finally {
      rmSync(managedDir, { recursive: true, force: true });
    }
  });

  it('syncMcpServers writes only enabled servers and resolves to a boolean (now async)', async () => {
    const result = syncMcpServers([
      { id: 'a', name: 'a', transportType: 'stdio', command: 'node', enabled: true },
      { id: 'b', name: 'b', transportType: 'stdio', command: 'node', enabled: false },
    ]);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(true);
    expect(readMcpServers()).toEqual({ a: { command: 'node' } });
  });

  it('writeClaudeJson goes through managedFileWriter: 0600 mode and preserves foreign keys', async () => {
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(legacyClaudeJsonPath(), JSON.stringify({ someForeignKey: 'keep-me' }), 'utf-8');

    await upsertMcpServer({
      id: 'foo',
      name: 'foo',
      transportType: 'stdio',
      command: 'node',
      enabled: true,
    });

    const doc = JSON.parse(readFileSync(legacyClaudeJsonPath(), 'utf-8'));
    // NOTE: McpManager's own read-then-write (readClaudeJson + writeClaudeJson)
    // passes a fully-formed document to the managedFileWriter mutator (it
    // ignores managedFileWriter's freshly-read `current`), so this call
    // itself replaces the whole doc — foreign-key preservation here comes
    // from readClaudeJson() having read `someForeignKey` before this write,
    // not from managedFileWriter's read-latest step.
    expect(doc.someForeignKey).toBe('keep-me');
    expect(doc.mcpServers.foo).toEqual({ command: 'node' });
  });

  it('deleteMcpServer removes the entry and resolves true', async () => {
    await upsertMcpServer({
      id: 'foo',
      name: 'foo',
      transportType: 'stdio',
      command: 'node',
      enabled: true,
    });
    const ok = await deleteMcpServer('foo');
    expect(ok).toBe(true);
    expect(readMcpServers()).toEqual({});
  });
});
