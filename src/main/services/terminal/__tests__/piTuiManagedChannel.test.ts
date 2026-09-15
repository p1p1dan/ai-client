/**
 * The company channel a user sees inside the embedded terminal.
 *
 * ## The property
 *
 * On the managed route `PiTuiPty` deletes every inherited credential variable
 * from the terminal's environment and exports only `PI_CODING_AGENT_DIR`, the
 * managed-route marker and the User-Agent (`resolveManagedPiPtyEnv`). So the
 * only credential channel left for the pi CLI running in that terminal is the
 * `models.json` / `auth.json` pair this app writes into the agent directory. A
 * user opens the terminal and the company models are simply there, keyed and
 * addressed, with nothing of ours involved at request time.
 *
 * That last clause is why this file exists: because nothing of ours runs during
 * a TUI turn, nothing of ours can report the failure either. If pi changes how
 * it parses either file, or we change how we write them, the company models
 * stop working in the terminal silently.
 *
 * ## The two layers
 *
 * Both are driven by the production builder — `PiModelConfigService.sync`
 * writes the files exactly as the app does, and `buildNativeModelCatalog`
 * assembles the same pair in memory.
 *
 *  1. Contract: read the written pair back with pi's OWN parsers (`ModelConfig`
 *     and `readStoredCredential`/`AuthStorage` from the installed package).
 *     Milliseconds, no child process.
 *  2. End-to-end: spawn the real bundled pi CLI against a local fake gateway,
 *     with exactly the environment `PiTuiPty` would hand it. Roughly 0.4 s per
 *     spawn, about 1 s of the file's runtime.
 *
 * Layer 2 is not redundant. Layer 1 can only see that the documents parse;
 * which provider pi picks when no `--model` is given, which key it presents and
 * which User-Agent it sends are all decided inside pi at request time, from
 * these two files. That is the part a schema change would break first.
 *
 * ## Process safety
 *
 * Every spawn is bounded by `timeout` + `killSignal`, which makes Node kill the
 * child it owns. This file never computes a pid and never calls `process.kill`.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PI_PROJECT_TRUST_ENV,
  PI_USER_AGENT_ENV,
  PI_USER_AGENT_HEADER,
} from '@shared/piModelConfig';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PiModelConfigService } from '../../piModelConfig/PiModelConfigService';

const COMPANY_PROVIDER = 'company-gw';
const COMPANY_MODEL = 'company-model-a';
/** The key the management endpoint hands out. This is what must reach the gateway. */
const COMPANY_KEY = 'company-test-key-123';
/**
 * The login key a provider inherits when it does NOT carry its own.
 *
 * Deliberately different from `COMPANY_KEY` and deliberately unusable-looking:
 * if the two were equal, every assertion below would pass even if the builder
 * lost the administrator's key and fell back to the login one.
 */
const LOGIN_KEY = 'login-key-must-not-reach-the-gateway';
const TEST_USER_AGENT = 'aiclient-managed-tui-test/0.0.0';
const SPAWN_TIMEOUT_MS = 30_000;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../../../../..');
const PI_PACKAGE = join(REPO_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent');
const PI_CLI = join(PI_PACKAGE, 'dist', 'bundle', 'cli.js');
/**
 * pi's `exports` map publishes only `.`, `./client` and `./rpc-entry`, so a bare
 * specifier for these internals fails with ERR_PACKAGE_PATH_NOT_EXPORTED. An
 * absolute file URL bypasses the map, which is acceptable HERE precisely because
 * the point is to use the parser the installed copy actually ships.
 */
const PI_CORE = join(PI_PACKAGE, 'dist', 'core');

/**
 * Just enough of those two modules to call them.
 *
 * Hand-written instead of `typeof import(...)` for the same reason the runtime
 * import goes through a file URL: the subpaths are outside pi's `exports` map,
 * so TypeScript cannot resolve a type-only import of them either.
 */
interface PiProviderShape {
  api?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: Array<{ id: string }>;
}

interface PiModelConfigModule {
  ModelConfig: {
    load(modelsJsonPath: string): Promise<{
      getError(): string | undefined;
      getProviderIds(): readonly string[];
      getProvider(providerId: string): PiProviderShape | undefined;
    }>;
  };
}

interface PiCredential {
  type: string;
  key?: string;
}

interface PiAuthStorageModule {
  AuthStorage: {
    create(authPath: string): { read(providerId: string): Promise<PiCredential | undefined> };
  };
  readStoredCredential(providerId: string, authPath: string): PiCredential | undefined;
}

interface GatewayHit {
  method: string;
  path: string;
  authorization: string | null;
  userAgent: string | null;
  model: unknown;
}

let server: Server;
let gatewayPort = 0;
let hits: GatewayHit[] = [];
let root = '';
let agentDir = '';
let homeDir = '';
let workDir = '';

/** The wire answer a management endpoint gives a managed client (plan D01). */
function managementResponse(baseUrl: string): unknown {
  return {
    version: 1,
    updatedAt: '2026-09-15T00:00:00.000Z',
    providers: {
      [COMPANY_PROVIDER]: {
        name: 'Company Gateway',
        api: 'openai-completions',
        baseUrl,
        apiKey: COMPANY_KEY,
        credentials: { baseUrl: 'managed', apiKey: 'managed' },
        models: [
          { id: COMPANY_MODEL, name: 'Company Model A', contextWindow: 128000, maxTokens: 8192 },
        ],
      },
    },
  };
}

function managedService(): PiModelConfigService {
  return new PiModelConfigService({
    agentDir,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(managementResponse(companyBaseUrl())),
    }),
    now: () => 1_726_000_000_000,
    // Stated, so the checked-in release snapshot cannot add providers to this
    // catalog and turn the "only the company provider is listed" assertions
    // into a test of whatever that file happens to contain today.
    readBundledCatalog: () => null,
    userProviders: () => [],
    managedCredentialsEnabled: () => true,
  });
}

function companyBaseUrl(): string {
  return `http://127.0.0.1:${gatewayPort}/v1`;
}

/**
 * A gateway that records what it was asked and answers the smallest valid
 * `openai-completions` stream. Minimal on purpose: the assertions are about the
 * request, and a richer reply would only add ways for this fixture to drift.
 */
function startGateway(): Promise<Server> {
  const created = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      let model: unknown;
      try {
        model = (JSON.parse(body) as { model?: unknown }).model;
      } catch {
        model = undefined;
      }
      hits.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        model,
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (choice: unknown): string =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: typeof model === 'string' ? model : 'unknown',
          choices: [choice],
        })}\n\n`;
      res.write(
        chunk({
          index: 0,
          delta: { role: 'assistant', content: 'OK_FROM_COMPANY' },
          finish_reason: null,
        })
      );
      res.write(chunk({ index: 0, delta: {}, finish_reason: 'stop' }));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolveListening) => {
    created.listen(0, '127.0.0.1', () => resolveListening(created));
  });
}

/**
 * The terminal's environment, reproduced.
 *
 * Nothing inherited: `PiTuiPty` strips every credential variable on the managed
 * route, and this map is what is left. A test process that leaked its own
 * `OPENAI_API_KEY` in here would prove nothing at all, because pi would have a
 * second credential channel to succeed from.
 */
function tuiEnv(): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: homeDir,
    TERM: 'dumb',
    PI_CODING_AGENT_DIR: agentDir,
    [PI_PROJECT_TRUST_ENV]: '0',
    [PI_USER_AGENT_ENV]: TEST_USER_AGENT,
  };
}

interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runPiCli(args: readonly string[]): Promise<CliRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [PI_CLI, ...args], {
      cwd: workDir,
      env: tuiEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Node kills the child it owns when this elapses; no pid arithmetic here.
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', rejectRun);
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

/** Everything a failed run needs to be diagnosable from CI output alone. */
function report(label: string, run: CliRun): string {
  return [
    `${label}: code=${run.code} signal=${run.signal}`,
    `--- stderr ---`,
    run.stderr.trim() || '(empty)',
    `--- stdout ---`,
    run.stdout.trim() || '(empty)',
  ].join('\n');
}

function expectCleanExit(label: string, run: CliRun): void {
  expect(
    run.signal,
    `${label} was killed (spawn timeout is ${SPAWN_TIMEOUT_MS}ms)\n${report(label, run)}`
  ).toBeNull();
  expect(run.code, report(label, run)).toBe(0);
}

beforeAll(async () => {
  server = await startGateway();
  const address = server.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('fake gateway did not bind a TCP port');
  }
  gatewayPort = address.port;

  root = mkdtempSync(join(tmpdir(), 'pi-tui-managed-'));
  agentDir = join(root, 'agent');
  homeDir = join(root, 'home');
  workDir = join(root, 'work');
  for (const dir of [agentDir, homeDir, workDir]) mkdirSync(dir, { recursive: true });

  // The production write path: the same call the app makes after login, into a
  // temp agent directory instead of the real one.
  const result = await managedService().sync({
    endpointUrl: 'https://management.example/api/v1/models-config',
    apiKey: LOGIN_KEY,
    inheritedBaseUrl: 'https://login.example/v1',
  });
  if (result.source !== 'remote' || !result.ok) {
    throw new Error(`catalog sync did not take the remote path: ${JSON.stringify(result)}`);
  }
}, 30_000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('managed catalog, read back by pi itself', () => {
  it('assembles in memory exactly what it wrote to disk', () => {
    const catalog = managedService().buildNativeModelCatalog({
      inheritedApiKey: LOGIN_KEY,
      inheritedBaseUrl: 'https://login.example/v1',
    });
    const service = managedService();
    expect(catalog.models).toEqual(JSON.parse(readFileSync(service.modelsPath, 'utf8')));
    expect(catalog.auth).toEqual(JSON.parse(readFileSync(service.authPath, 'utf8')));
  });

  it("parses under pi's own ModelConfig with the company provider intact", async () => {
    const { ModelConfig } = (await import(
      /* @vite-ignore */ pathToFileURL(join(PI_CORE, 'model-config.js')).href
    )) as PiModelConfigModule;

    const config = await ModelConfig.load(managedService().modelsPath);
    expect(config.getError(), 'pi rejected the models.json this app writes').toBeUndefined();
    expect(config.getProviderIds()).toEqual([COMPANY_PROVIDER]);

    const provider = config.getProvider(COMPANY_PROVIDER);
    expect(provider?.baseUrl).toBe(companyBaseUrl());
    expect(provider?.api).toBe('openai-completions');
    expect(provider?.models?.map((model) => model.id)).toEqual([COMPANY_MODEL]);
    // F08: the header travels as an environment REFERENCE, never as a literal.
    expect(provider?.headers?.[PI_USER_AGENT_HEADER]).toBe(`$${PI_USER_AGENT_ENV}`);
  });

  it("resolves the company key under pi's own auth storage", async () => {
    const { AuthStorage, readStoredCredential } = (await import(
      /* @vite-ignore */ pathToFileURL(join(PI_CORE, 'auth-storage.js')).href
    )) as PiAuthStorageModule;
    const authPath = managedService().authPath;

    expect(readStoredCredential(COMPANY_PROVIDER, authPath)).toEqual({
      type: 'api_key',
      key: COMPANY_KEY,
    });
    const stored = await AuthStorage.create(authPath).read(COMPANY_PROVIDER);
    expect(stored).toEqual({ type: 'api_key', key: COMPANY_KEY });
    // The login key is not a second answer sitting next to it.
    expect(JSON.stringify(stored)).not.toContain(LOGIN_KEY);
  });

  it('keeps the key out of models.json entirely', () => {
    const modelsText = readFileSync(managedService().modelsPath, 'utf8');
    expect(modelsText).not.toContain(COMPANY_KEY);
    expect(modelsText).not.toContain(LOGIN_KEY);
  });
});

describe('e2e: the bundled pi CLI in a managed terminal', () => {
  beforeEach(() => {
    hits = [];
  });

  it('e2e: lists only the company model, with no built-in provider alongside it', async () => {
    const run = await runPiCli(['--list-models']);
    expectCleanExit('pi --list-models', run);

    expect(run.stdout, report('pi --list-models', run)).toContain(COMPANY_PROVIDER);
    expect(run.stdout, report('pi --list-models', run)).toContain(COMPANY_MODEL);
    // A built-in table sneaking back in is the failure mode plan D03 is about:
    // a menu full of models nobody enabled, none of which this user can call.
    for (const builtin of ['openai', 'anthropic', 'google', 'xai', 'openrouter']) {
      expect(
        run.stdout.toLowerCase(),
        `${builtin} leaked into the managed model list`
      ).not.toContain(builtin);
    }
    // Listing is a local read; it must not touch the gateway.
    expect(hits).toEqual([]);
  }, 40_000);

  it('e2e: sends one company-keyed request when asked for a turn with no --model', async () => {
    const run = await runPiCli(['-p', 'hi']);
    expectCleanExit('pi -p hi', run);

    expect(hits.length, `expected exactly one gateway request\n${report('pi -p hi', run)}`).toBe(1);
    const hit = hits[0];
    expect(hit.method).toBe('POST');
    expect(hit.path).toBe('/v1/chat/completions');
    // The whole point: the administrator's key, not this client's login key,
    // and not an environment variable the terminal was never given.
    expect(
      hit.authorization,
      `wrong credential reached the gateway\n${report('pi -p hi', run)}`
    ).toBe(`Bearer ${COMPANY_KEY}`);
    // No --model was passed, so pi chose this itself out of the catalog.
    expect(hit.model, `wrong model was chosen\n${report('pi -p hi', run)}`).toBe(COMPANY_MODEL);
    // F08: the gateway can tell this app apart from a stock pi installation.
    expect(hit.userAgent).toBe(TEST_USER_AGENT);
    // The reply really came back through the company channel.
    expect(run.stdout).toContain('OK_FROM_COMPANY');
  }, 40_000);
});
