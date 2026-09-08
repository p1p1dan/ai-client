import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../bootstrap.ts';
import { RUNTIME_SERVICES } from '../contracts.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'host', 'smoke', 'spikes', '__tests__'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.[cm]?ts$/.test(path) ? [path] : [];
  });
}
describe('runtime host boundary', () => {
  it('keeps filesystem and process APIs inside the host implementation', () => {
    for (const path of sources(root)) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toMatch(
        /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:node:)?(?:fs(?:\/promises)?|child_process|node-pty)['"]/
      );
      expect(text, path).not.toMatch(/process\.(?:send|parentPort|chdir)\b/);
    }
  });
  it('registers real host services and reports trace persistence failure separately', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-trace-failure-'));
    const faux = fauxProvider({ provider: 'probe', models: [{ id: 'probe', name: 'Probe' }] });
    faux.setResponses([fauxAssistantMessage('ready')]);
    const runtime = await createRuntime({ providers: [faux.provider], traceDir: dir, env: {} });
    try {
      for (const name of RUNTIME_SERVICES) expect(runtime.ctx.get(name)).toBeDefined();
      await mkdir(join(dir, 'runs.jsonl'));
      const run = await runtime.run({ prompt: 'ready', systemPrompt: 'ready' });
      expect(run.success).toBe(true);
      expect(run.trace.persistence_error?.code).toBe('trace_write_failed');
      await expect(runtime.trace.flush()).rejects.toThrow();
      expect(runtime.trace.runs).toHaveLength(1);
    } finally {
      await expect(runtime.dispose()).rejects.toThrow();
      expect(runtime.ctx.get('runtimeHostIo')).toBeUndefined();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
