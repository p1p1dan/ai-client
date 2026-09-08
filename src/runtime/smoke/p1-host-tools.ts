import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRuntime } from '../bootstrap.ts';
import type { RuntimeHostConfig } from '../contracts.ts';

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
    permissions: { mode: 'agent', gear: 'accept-edits' },
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
    };
    return {
      passed: Object.values(assertions).every(Boolean),
      assertions,
      carrier: host.carrier,
      execPath: process.execPath,
      node: process.version,
      electron: process.versions.electron ?? null,
      stamp: run.trace.version_stamp,
    };
  } finally {
    await runtime.dispose();
  }
}
