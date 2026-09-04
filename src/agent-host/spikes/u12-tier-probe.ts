/**
 * U12 probe — does the session permission tier actually reach the gate?
 *
 * Boots the SAME bootstrap the Pi worker uses (bundled permission plugin,
 * inline session-tier authorizer), then asks the plugin's own
 * `PermissionsService` what it would decide for a write. Prints the resolved
 * agentDir, which plugin copy loaded, and the policy state/origin per surface.
 *
 *   node --experimental-strip-types src/agent-host/spikes/u12-tier-probe.ts
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortableExtensionUiBridge } from '../extensionUiBridge.ts';
import { resolveBundledPermissionPlugin } from '../permissionPlugin.ts';
import { bootstrapPiAgentSession, type PiSdkModule } from '../piAgentSessionBootstrap.ts';
import { createSessionTierAuthorizer } from '../sessionTierAuthorizer.ts';

const SESSION_SERVICES_KEY = Symbol.for('@gotgenes/pi-permission-system:session-services');

interface PermissionCheckResult {
  state: string;
  origin: string;
  matchedPattern?: string;
  source: string;
}

interface PermissionsServiceSlice {
  checkPermission(surface: string, value?: string, agentName?: string): PermissionCheckResult;
  getToolPermission(toolName: string, agentName?: string): string;
}

const cwd = mkdtempSync(join(tmpdir(), 'u12-tier-probe-'));
const log = (...args: unknown[]) => console.log('[probe]', ...args);

const sdk = (await import('@earendil-works/pi-coding-agent')) as unknown as PiSdkModule;

const { factory, state } = createSessionTierAuthorizer({ log, initialTier: 'handsoff' });

const extensionUi = createPortableExtensionUiBridge({
  onRequest: (request) =>
    log('EXTENSION UI REQUEST →', request.method, JSON.stringify(request.args)),
});

const bootstrapped = await bootstrapPiAgentSession({
  sdk,
  cwd,
  projectTrusted: true,
  extensionUi,
  additionalExtensionFactories: [{ name: 'aiclient-session-tier', factory, hidden: true }],
  // FORCE_BUNDLED=1 answers "can we inject our own copy even when the user
  // already configured the package?" — the E option in the U12 tier fix.
  ...(process.env.FORCE_BUNDLED === '1'
    ? {
        decidePermissionGate: () => ({
          additionalExtensionPaths: [resolveBundledPermissionPlugin() as string],
          reason: 'bundled' as const,
          gated: true,
        }),
      }
    : {}),
  log,
  onPermissionActivity: (payload) => log('permission activity:', JSON.stringify(payload)),
});

log('agentDir           =', bootstrapped.agentDir);
log('permission gate    =', bootstrapped.permissionGate);
log('pi sessionId       =', bootstrapped.handle.session.sessionId);
log('tier state         =', state.getTier());

const services = (globalThis as Record<symbol, unknown>)[SESSION_SERVICES_KEY] as
  | Map<string, PermissionsServiceSlice>
  | undefined;
log('session services   =', services ? [...services.keys()] : 'ABSENT');

const service = services?.get(String(bootstrapped.handle.session.sessionId));
if (!service) {
  log('!! no PermissionsService for this session — the chain link cannot have registered');
} else {
  for (const [surface, value] of [
    ['write', join(cwd, 'probe.txt')],
    ['edit', join(cwd, 'probe.txt')],
    ['read', join(cwd, 'probe.txt')],
    ['bash', 'rm -rf /tmp/nothing'],
    ['path', join(cwd, 'probe.txt')],
  ] as const) {
    const result = service.checkPermission(surface, value);
    log(
      `checkPermission(${surface}) → state=${result.state} origin=${result.origin} source=${result.source} pattern=${result.matchedPattern ?? '-'}`
    );
  }
}

await bootstrapped.handle.dispose?.();
process.exit(0);
