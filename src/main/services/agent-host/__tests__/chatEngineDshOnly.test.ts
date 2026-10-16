import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../renderer/components/chat/__tests__/stripComments';

/**
 * Chat engines: DSH for every chat, and since route B (S-1) the Claude Agent
 * SDK engine for new Claude chats (docs/plantree/plans/claude-sdk-engine/
 * topics/s1-engine-selection.md). Written for one engine in dsh-rebase P1-1
 * (decisions 004 and 009) and rewritten for two.
 *
 * Behaviour tests prove which engine a chat gets (`claudeSdkEngine.test.ts`,
 * `WorkerManagerClaudeSdk.test.ts`); these pin the shape that keeps the choice
 * in one place. A second selector creeps in as a model-id check, an
 * `isPackaged` gate, an environment switch or a fifth spawn site long before
 * any behaviour test sees it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../../..');
const REPO = path.resolve(SRC, '..');
const AGENT_HOST = path.resolve(HERE, '..');

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

const stripped = new Map<string, string>();
function code(file: string): string {
  let text = stripped.get(file);
  if (text === undefined) {
    text = stripComments(read(file), file);
    stripped.set(file, text);
  }
  return text;
}

/** Shipped code and config; tests may name a retired switch to prove it is ignored. */
function codeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) codeFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|yml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Product code of Main, the renderer and the shared libraries; not either host. */
const appFiles = () => [
  ...codeFiles(path.join(SRC, 'main')),
  ...codeFiles(path.join(SRC, 'renderer')),
  ...codeFiles(path.join(SRC, 'shared')),
];

const rel = (file: string) => path.relative(REPO, file).replaceAll('\\', '/');

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

describe('chat engines: DSH, and the Claude Agent SDK engine for Anthropic-protocol chats (route B)', () => {
  it('createDshChatSlot opens a DSH channel by default and has no engine logic of its own', () => {
    const source = code(path.join(AGENT_HOST, 'createDshChatSlot.ts'));
    // P1-3a: a chat session is a channel on the app's one shared DSH host.
    expect(source).toContain("from './DshHostSupervisor'");
    expect(source).toContain('dshHostSupervisor.openChannel(');
    // Route B: the caller's transport replaces the channel; the slot never chooses.
    expect(source).toContain('options.createTransport');
    for (const banned of [
      'forkPiWorkerProcess',
      'PiWorkerProcess',
      'forkDshHost',
      'DshHostProcess',
      'AICLIENT_DEV_ENGINE',
      'isPackaged',
      'claudeSdk',
      'ClaudeSdk',
      'CLAUDE_SDK',
      'engine',
      'process.env',
    ]) {
      expect(source, banned).not.toContain(banned);
    }
  });

  /**
   * Decision 1: the engine of a new chat is `chooseNewChatEngine`, of a
   * reopened one `engineForSessionFile`, both in `claudeSdkEngine.ts` and both
   * asked by `WorkerManager` exactly once. Nothing else in the app decides by
   * a model's name.
   */
  it('engine selection lives only in claudeSdkEngine.ts, asked once each by WorkerManager', () => {
    const engine = code(path.join(AGENT_HOST, 'claudeSdkEngine.ts'));
    expect(engine).toContain('export function chooseNewChatEngine(');
    expect(engine).toContain('export function engineForSessionFile(');
    const manager = code(path.join(AGENT_HOST, 'WorkerManager.ts'));
    expect(count(manager, /\bchooseNewChatEngine\(/g)).toBe(1);
    expect(count(manager, /\bengineForSessionFile\(/g)).toBe(1);
    expect(manager).toContain('engine: chosen.engine,');
    const offenders: string[] = [];
    for (const file of appFiles()) {
      if (file.endsWith(`${path.sep}claudeSdkEngine.ts`)) continue;
      const text = code(file);
      for (const name of ['chooseNewChatEngine', 'engineForSessionFile', 'isClaudeFamilyModelId']) {
        if (text.includes(name) && !file.endsWith(`${path.sep}WorkerManager.ts`)) {
          offenders.push(`${rel(file)}: ${name}`);
        }
      }
      // The prototype's selector keyed on the model id; none may come back.
      if (/\/\^claude-\//.test(text)) offenders.push(`${rel(file)}: a claude- model-id check`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Decision 3: the S-0 dev switch and Main's environment gateway are gone;
   * the address and key come from the plan and the broker. The host's launch
   * variable names stay (`openClaudeSdkTransport` sets them).
   */
  it('Main reads no engine switch and no gateway or key from its environment', () => {
    const offenders: string[] = [];
    for (const file of appFiles()) {
      const text = read(file);
      for (const banned of [
        'AICLIENT_CLAUDE_SDK_ENGINE',
        'env.AICLIENT_CLAUDE_SDK_BASE_URL',
        'env.AICLIENT_CLAUDE_SDK_API_KEY',
        'isClaudeSdkEngineEnabled',
        'CLAUDE_SDK_GATEWAY_MISSING',
      ]) {
        if (text.includes(banned)) offenders.push(`${rel(file)}: ${banned}`);
      }
    }
    expect(offenders).toEqual([]);
    const engine = code(path.join(AGENT_HOST, 'claudeSdkEngine.ts'));
    expect(engine).toContain('AICLIENT_CLAUDE_SDK_BASE_URL: baseURL,');
    expect(engine).toContain('AICLIENT_CLAUDE_SDK_API_KEY: apiKey,');
  });

  /**
   * Decision 3: Main gives WorkerManager the switch, the plan it built last
   * (building one only before the first; a lookup never re-announces one),
   * the broker's keys and host availability — so WorkerManager itself never
   * reads the catalog, the settings store or the vault.
   */
  it('Main installs the SDK engine source beside the DSH host’s', () => {
    const wiring = code(path.join(AGENT_HOST, 'dshHostModelSource.ts'));
    for (const line of [
      'lastPlan = plan;',
      'workerManager.setClaudeSdkEngineSource({',
      'enabled: () => claudeSdkEngineEnabled(),',
      'plan: () => lastPlan ?? resolveDshModelPlan(),',
      'key: (providerId) => broker.keyFor(providerId),',
      'hostAvailable: createClaudeSdkHostAvailability({',
    ]) {
      expect(wiring, line).toContain(line);
    }
    const manager = code(path.join(AGENT_HOST, 'WorkerManager.ts'));
    for (const banned of ['readSettingsState', 'claudeSdkEngineEnabled', 'DshCredentialBroker']) {
      expect(manager, banned).not.toContain(banned);
    }
  });

  /**
   * The SDK host is started from one place: `openClaudeSdkTransport`, the one
   * maker of `ClaudeSdkProcessTransport`, reached by WorkerManager only
   * through the spawn path (`claudeSdkSpawn`, called from `spawnForEntry`).
   */
  it('the SDK host is started only from the spawn path', () => {
    const offenders: string[] = [];
    for (const file of codeFiles(path.join(SRC, 'main'))) {
      const text = code(file);
      const base = path.basename(file);
      if (text.includes('new ClaudeSdkProcessTransport(') && base !== 'claudeSdkEngine.ts') {
        offenders.push(`${rel(file)}: new ClaudeSdkProcessTransport`);
      }
      if (
        /\bopenClaudeSdkTransport\b/.test(text) &&
        !['claudeSdkEngine.ts', 'WorkerManager.ts'].includes(base)
      ) {
        offenders.push(`${rel(file)}: openClaudeSdkTransport`);
      }
    }
    expect(offenders).toEqual([]);
    const manager = code(path.join(AGENT_HOST, 'WorkerManager.ts'));
    // Defined once, called once: inside `spawnForEntry`.
    expect(count(manager, /\bthis\.claudeSdkSpawn\(/g)).toBe(1);
    expect(manager).toContain('...(sdk ? { createTransport: sdk.createTransport } : {}),');
  });

  it('WorkerManager spawns through exactly five paths and never binds a session to pi', () => {
    const source = read(path.join(AGENT_HOST, 'WorkerManager.ts'));
    // create, create's DSH retry after an SDK host that did not start (user
    // ruling 2026-10-16), cold resume, fork target, crash restart.
    expect(source.match(/this\.spawnForEntry\(/g)).toHaveLength(5);
    expect(source).toContain('this.forgetFailedClaudeSdkStart(entry);');
    expect(source).not.toContain('PI_AGENT');
    expect(source.match(/agent: DSH_AGENT/g)?.length).toBeGreaterThanOrEqual(7);
  });

  /**
   * Decision 2: a chat reopens on its engine by its stub's suffix, spelled
   * once (`@shared/claudeSdkEngine`). The renderer learns the engine from
   * `session.created` / `session.resumed` (decision 9), never from the shape
   * of `runtimeIdentity`.
   */
  it('the stub suffix is spelled once, and the SDK host agrees with it', () => {
    const offenders = appFiles()
      .filter((file) => !file.endsWith(path.join('shared', 'claudeSdkEngine.ts')))
      .filter((file) => code(file).includes('.ccsdk.json'))
      .map(rel);
    expect(offenders).toEqual([]);
    const shared = code(path.join(SRC, 'shared', 'claudeSdkEngine.ts'));
    expect(shared).toContain("export const CLAUDE_SDK_STUB_SUFFIX = '.ccsdk.json';");
    const stub = code(path.join(SRC, 'claude-sdk-host', 'sessionStub.ts'));
    // Either the host imports the shared constant or it spells the same value.
    expect(
      /CLAUDE_SDK_STUB_SUFFIX[^;]*from\s+'[^']*shared\/claudeSdkEngine(\.ts)?'/.test(stub) ||
        stub.includes("CLAUDE_SDK_STUB_SUFFIX = '.ccsdk.json'")
    ).toBe(true);
    const engine = code(path.join(AGENT_HOST, 'claudeSdkEngine.ts'));
    expect(engine).toMatch(/CLAUDE_SDK_STUB_SUFFIX,[\s\S]*from '@shared\/claudeSdkEngine'/);
  });

  /**
   * The chat bootstrap carries no model catalog: its `auth` half is plaintext
   * provider keys, the DSH host never reads it, and the host's RPC server keeps
   * the whole bootstrap payload for the life of the session. Keys reach the
   * host per request instead (P1-5, decision 034). Since P1-15 (decision 125)
   * one-shot completions run on the same host and carry none either; the
   * native utility service that assembled one was deleted in P1-12 step 1
   * (`oneShotCompletionsStatic.test.ts`). An SDK chat's key reaches its own
   * host through the launch environment, never the bootstrap.
   * Comments are stripped: both files explain the ban by naming the field.
   */
  it('chat bootstraps and one-shot completions carry no model catalog', () => {
    const manager = code(path.join(AGENT_HOST, 'WorkerManager.ts'));
    for (const banned of [
      'modelCatalog',
      'readModelCatalog',
      'resolveNativeModelCatalog',
      'WorkerModelCatalog',
      'piModelConfig',
      "from 'electron'",
    ]) {
      expect(manager, banned).not.toContain(banned);
    }
    const slot = code(path.join(AGENT_HOST, 'createDshChatSlot.ts'));
    // P1-12 step 3 (decision 147): the field left the protocol type itself,
    // so the slot's payload no longer needs to omit it.
    expect(slot).toContain('type ChatSlotBootstrapPayload = WorkerBootstrapPayload;');
    const protocol = code(path.join(AGENT_HOST, '../../../shared/types/workerRpc.ts'));
    expect(protocol).not.toContain('modelCatalog');
    expect(protocol).not.toContain('WorkerModelCatalog');
    expect(slot).not.toContain('options.modelCatalog');
    expect(slot).not.toMatch(/\bmodelCatalog\s*:/);
    expect(slot).not.toMatch(/apiKey/i);
    const completions = code(path.join(AGENT_HOST, 'DshCompletionService.ts'));
    for (const banned of ['modelCatalog', 'resolveNativeModelCatalog', 'WorkerModelCatalog']) {
      expect(completions, banned).not.toContain(banned);
    }
  });

  /**
   * P1-3a (decision 019): one shared host with one bridge. The per-session host
   * launch, its environment-borne generation and bridge switch, and the P0-6
   * prototype bridge are gone from the tree and from the scripts that drive
   * the host.
   */
  it('leaves no trace of the per-session host or the prototype bridge', () => {
    const banned = [
      'forkDshHost',
      'bridgeGeneration',
      'AICLIENT_DSH_BRIDGE',
      'AICLIENT_DSH_SHARED_BRIDGE',
      'aiclient-shared-bridge',
      'shared-bridge',
      'sharedPlugin',
    ];
    const files = [
      ...codeFiles(SRC),
      ...codeFiles(path.join(REPO, 'scripts')),
      path.join(REPO, '.github', 'workflows', 'build.yml'),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const name of banned) {
        if (text.includes(name)) offenders.push(`${path.relative(REPO, file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('leaves no trace of the P0-3 dev engine switch in the source tree', () => {
    const banned = [
      'devDshEngine',
      'isDevDshEngineSelected',
      'forkDevDshHost',
      'buildDevDshHostLaunch',
      'AICLIENT_DEV_ENGINE',
      'dsh-home-dev',
    ];
    const offenders: string[] = [];
    for (const file of codeFiles(SRC)) {
      const text = read(file);
      for (const name of banned) {
        if (text.includes(name)) offenders.push(`${path.relative(SRC, file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
