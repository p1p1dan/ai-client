/**
 * T08-a smoke — does pi actually LOAD the bundled permission extension?
 *
 * Resolution succeeding only proves the files are on disk. This proves the
 * thing that matters: that pi's resource loader accepts the path we pass it and
 * ends up with the extension bound. The distinction is not academic — the build
 * filter strips `.ts` from every other package, and this one's entry
 * (`pi.extensions: ["./src/index.ts"]`) IS TypeScript, so a filter regression
 * would ship a directory that resolves fine and loads nothing. An ungated tool
 * call looks exactly like one that needed no approval, so a silent failure here
 * is a security regression that no unit test can catch.
 *
 * Run against the PACKAGED tree — that is the artifact users get:
 *   pnpm build:agent-host
 *   ./out-node-runtime/node --experimental-strip-types \
 *     src/agent-host/spikes/t08a-permission-plugin-smoke.ts out-agent-host
 *
 * With no argument it checks the dev tree (`src/agent-host`).
 * Exit 0 = loaded, 1 = not loaded.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ExtensionsResult {
  extensions?: unknown[];
  errors?: Array<{ path?: string; error?: string }>;
}

const baseArg = process.argv[2];
const base = baseArg
  ? resolve(process.cwd(), baseArg)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = join(base, 'node_modules', '@gotgenes', 'pi-permission-system');

// Isolated cwd AND agentDir: this must never read or write the developer's own
// ~/.pi, whose settings.json may already load this package — which is exactly
// the case the runtime's dedup exists for and would mask the result here.
const cwd = mkdtempSync(join(tmpdir(), 'pi-plugin-smoke-cwd-'));
const agentDir = mkdtempSync(join(tmpdir(), 'pi-plugin-smoke-agent-'));

try {
  const sdk = (await import('@earendil-works/pi-coding-agent')) as unknown as {
    SettingsManager: {
      create: (cwd: string, agentDir: string, o: { projectTrusted: boolean }) => unknown;
    };
    createAgentSessionServices: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };

  const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const services = await sdk.createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: { additionalExtensionPaths: [pluginPath] },
  });

  const loader = (services.resourceLoader ?? services.resources) as
    | { getExtensionsResult?: () => ExtensionsResult; extensionsResult?: ExtensionsResult }
    | undefined;
  const result: ExtensionsResult =
    loader?.getExtensionsResult?.() ?? loader?.extensionsResult ?? {};
  const extensions = result.extensions ?? [];
  const errors = result.errors ?? [];

  console.log(`[t08a] plugin path: ${pluginPath}`);
  console.log(`[t08a] extensions loaded: ${extensions.length}`);
  for (const extension of extensions) {
    console.log(`  - ${JSON.stringify(extension).slice(0, 200)}`);
  }
  for (const error of errors) {
    console.log(`  ! ${error.path}: ${error.error}`);
  }

  const loaded = extensions.some((e) => JSON.stringify(e).includes('pi-permission-system'));
  console.log(loaded ? '[t08a] RESULT: LOADED' : '[t08a] RESULT: NOT LOADED');
  process.exit(loaded ? 0 : 1);
} finally {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
}
