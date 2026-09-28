import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../renderer/components/chat/__tests__/stripComments';

/**
 * dsh-rebase P1-5 static guards (design shard 05 §3): the development route and
 * its environment variables are gone from the product, routes reach the host
 * only through `configure`, and the one place a key is handed over never logs
 * it. Comments are stripped where a file explains a ban by naming it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');

/** Product sources: everything under src/ but tests, probe tools and installed packages. */
function productFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (['node_modules', '__tests__', 'tools'].includes(name)) continue;
    if (statSync(file).isDirectory()) productFiles(file, out);
    else if (/\.(ts|tsx|mts|mjs|js|yml|json)$/.test(name)) out.push(file);
  }
  return out;
}

const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');
const code = (rel: string) => stripComments(read(rel), path.join(REPO, rel));

describe('P1-5 static guards', () => {
  it('no product source names the retired development route or its variables', () => {
    const offenders = productFiles(path.join(REPO, 'src')).filter((file) =>
      /AICLIENT_DSH_GATEWAY_|aiclient-gateway/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders.map((file) => path.relative(REPO, file))).toEqual([]);
  });

  it('the host environment adds no key back, packaged or not', () => {
    const env = code('src/main/services/agent-host/dshHostEnvironment.ts');
    expect(env).not.toMatch(/GATEWAY|AICLIENT_KEY_/);
    expect(env).not.toMatch(/isPackaged\)/);
  });

  it('the supervisor configures every host it spawns and answers keys only through its source', () => {
    const supervisor = code('src/main/services/agent-host/DshHostSupervisor.ts');
    expect(supervisor).toContain('this.sendControl(host, configure);');
    expect(supervisor).toContain('this.modelSource?.credentials?.answer(request, context)');
  });

  it('the broker never passes a key to its log', () => {
    const broker = code('src/main/services/agent-host/DshCredentialBroker.ts');
    for (const line of broker.split('\n').filter((text) => text.includes('log?.('))) {
      expect(line).not.toMatch(/\bkey\b|value/);
    }
  });

  it('Main installs the model source before any host can start', () => {
    expect(code('src/main/ipc/index.ts')).toContain('installChatEngineModelSource();');
    expect(code('src/main/services/agent-host/dshHostModelSource.ts')).toContain(
      'dshHostSupervisor.setModelSource('
    );
  });
});
