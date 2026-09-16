import { resolve } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRuntime } from '../bootstrap.ts';
import type { RuntimeHostConfig } from '../contracts.ts';

export interface CarrierEvidence {
  execPath: string;
  /** `process.versions.electron`, or null outside an Electron process. */
  electron: string | null;
  platform: NodeJS.Platform;
}

/**
 * Does the process we are actually running in match the carrier we claim to be
 * (tsd-06)?
 *
 * The assertion this replaces compared the trace's carrier with the host object
 * the trace copied it from, so it held even when the probe ran on the wrong
 * carrier — P1-8 asks for the opposite ("a double that only changes the carrier
 * string does not count as a pass"). These comparisons can fail: an Electron
 * utility worker reports an Electron version and must spawn a SHIPPED Node that
 * is not its own binary; a bundled-node worker has no Electron version and IS
 * the Node it would use.
 */
export function carrierEvidence(
  host: Pick<RuntimeHostConfig, 'carrier' | 'node'>,
  evidence: CarrierEvidence
): boolean {
  const same = (path: string) => {
    const normalized = resolve(path);
    const self = resolve(evidence.execPath);
    return evidence.platform === 'win32'
      ? normalized.toLowerCase() === self.toLowerCase()
      : normalized === self;
  };
  const isSelf = host.node ? same(host.node.path) : false;
  if (host.carrier === 'electron-utility')
    return Boolean(evidence.electron) && host.node?.source === 'bundled' && !isSelf;
  if (host.carrier === 'bundled-node')
    return !evidence.electron && host.node?.source === 'bundled' && isSelf;
  return !evidence.electron && host.node?.source === 'current-process' && isSelf;
}

export async function runHostToolsProbe(host: RuntimeHostConfig, cwd: string, shellPath: string) {
  const provider = fauxProvider({
    provider: 'probe',
    models: [{ id: 'local', name: 'Local probe' }],
  });
  provider.setResponses([fauxAssistantMessage('ready')]);
  const runtime = await createRuntime({
    host,
    tools: { cwd, shellPath },
    providers: [provider.provider],
    permissions: {
      mode: 'agent',
      gear: 'accept-edits',
      // decision 012 — `approve` is required with `tools`. The probe only
      // touches its own workspace, so `accept-edits` answers everything it
      // does; being asked here means the probe stopped proving that.
      approve: (request) => {
        throw new Error(`host tools probe was asked to approve ${request.tool}`);
      },
    },
    traceDir: cwd,
  });
  const text = (blocks: { type: string; text?: string }[]) =>
    blocks.map((block) => block.text ?? '').join('');
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = runtime.ctx.runtimeTools.list().find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`missing tool: ${name}`);
    return tool.execute(`probe-${name}`, args);
  };
  try {
    await call('write', { path: 'probe.txt', content: 'amber\n' });
    const read = text((await call('read', { path: 'probe.txt' })).content);
    await call('edit', { path: 'probe.txt', edits: [{ oldText: 'amber', newText: 'azure' }] });
    const edited = text((await call('read', { path: 'probe.txt' })).content);
    const bash = text((await call('bash', { command: 'printf host-ok' })).content);
    const glob = text((await call('glob', { pattern: '*.txt' })).content);
    const grep = text((await call('grep', { pattern: 'azure', include: '*.txt' })).content);
    const run = await runtime.run({ prompt: 'Reply ready', systemPrompt: 'Reply ready' });
    const assertions = {
      read: read === 'amber\n',
      edit: edited === 'azure\n',
      bash: bash.includes('host-ok') && bash.includes('exit=0'),
      glob: glob.includes('probe.txt'),
      grep: grep.includes('azure'),
      trace: run.trace.version_stamp.carrier === host.carrier && !run.trace.persistence_error,
      // The one assertion that can tell the probe it is running somewhere else.
      carrier: carrierEvidence(host, {
        execPath: process.execPath,
        electron: process.versions.electron ?? null,
        platform: process.platform,
      }),
    };
    return {
      passed: Object.values(assertions).every(Boolean),
      assertions,
      carrier: host.carrier,
      nodeSource: host.node?.source ?? null,
      nodePath: host.node?.path ?? null,
      tsdReadFallback: host.tsdReadFallback,
      execPath: process.execPath,
      node: process.version,
      electron: process.versions.electron ?? null,
      stamp: run.trace.version_stamp,
    };
  } finally {
    await runtime.dispose();
  }
}
