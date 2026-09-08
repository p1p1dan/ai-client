import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// encoding.ts -> git/runtime.ts -> terminal/PtyManager pulls the node-pty native
// module, which is built for Electron and cannot load under a plain Node test.
// Nothing here spawns git, so the PATH helper is all that has to exist.
vi.mock('../../terminal/PtyManager', () => ({
  getEnhancedPath: () => process.env.PATH ?? '',
}));

import { detectBinaryFile, readWorkingTreeFile } from '../encoding';

/**
 * ARD D13: on the encrypted Windows host the security driver whitelists by
 * process, and Main is not whitelisted, so every working-tree file Main reads
 * comes back as a `%TSD-Header-###%` container. Two things then break silently:
 * the container's NUL bytes make every text file look BINARY, and any bytes
 * that do get through decode into garbage.
 *
 * The decryption itself is the driver's, so it cannot be exercised here. What
 * this test pins is the part we own: that the header is detected, that the
 * decrypting reader is spawned instead of reading the container, and that its
 * output — not the container — decides text-vs-binary. The stub below stands in
 * for the whitelisted node.exe via AICLIENT_TSD_NODE_PATH.
 */

const PLAINTEXT = 'hello from the whitelisted carrier\n';
const HEADER = '%TSD-Header-###%';

let root: string;
let previousOverride: string | undefined;

/** A container whose own bytes sniff as binary, holding text after the header. */
function writeEncrypted(filePath: string): void {
  const body = Buffer.concat([
    Buffer.from(HEADER),
    Buffer.alloc(64), // NUL padding: this is what makes the container look binary
    Buffer.from(PLAINTEXT),
  ]);
  writeFileSync(filePath, body);
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'aiclient-tsd-'));
  const stub = path.join(root, 'fake-node.mjs');
  // Stands in for the whitelisted node.exe: strips the container framing the
  // same way transparent decryption would hand back the original bytes.
  writeFileSync(
    stub,
    [
      "import { readFileSync } from 'node:fs';",
      'const raw = readFileSync(process.argv[process.argv.length - 1]);',
      `const marker = raw.indexOf(Buffer.from(${JSON.stringify(PLAINTEXT)}));`,
      'process.stdout.write(marker === -1 ? raw : raw.subarray(marker));',
    ].join('\n')
  );
  const launcher = path.join(root, 'fake-node.sh');
  // execFile gets an argv shaped like ['-e', script, '--', file]; the stub only
  // needs the file, so the launcher drops the inline-script arguments.
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, {
    mode: 0o755,
  });
  previousOverride = process.env.AICLIENT_TSD_NODE_PATH;
  process.env.AICLIENT_TSD_NODE_PATH = launcher;
});

afterAll(() => {
  if (previousOverride === undefined) delete process.env.AICLIENT_TSD_NODE_PATH;
  else process.env.AICLIENT_TSD_NODE_PATH = previousOverride;
  rmSync(root, { recursive: true, force: true });
});

describe('Main-side working-tree reads on the encrypted host (D13)', () => {
  it('sanity: the raw container really does sniff as binary', () => {
    const filePath = path.join(root, 'sniff.txt');
    writeEncrypted(filePath);
    const out = execFileSync(process.execPath, [
      '-e',
      "const{isBinaryFileSync}=require('isbinaryfile');process.stdout.write(String(isBinaryFileSync(process.argv[1])))",
      filePath,
    ]);
    expect(out.toString()).toBe('true');
  });

  it('returns decrypted bytes instead of the container', async () => {
    const filePath = path.join(root, 'tracked.txt');
    writeEncrypted(filePath);
    const buffer = await readWorkingTreeFile(filePath);
    expect(buffer.toString('utf8')).toBe(PLAINTEXT);
  });

  it('reads plaintext files without spawning anything', async () => {
    const filePath = path.join(root, 'plain.txt');
    writeFileSync(filePath, PLAINTEXT);
    const buffer = await readWorkingTreeFile(filePath);
    expect(buffer.toString('utf8')).toBe(PLAINTEXT);
  });

  it('classifies an encrypted text file as text, not binary', async () => {
    const filePath = path.join(root, 'diff-me.txt');
    writeEncrypted(filePath);
    await expect(detectBinaryFile(filePath, root, ':diff-me.txt')).resolves.toBe(false);
  });

  it('still classifies a genuinely binary file as binary', async () => {
    const filePath = path.join(root, 'image.bin');
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]));
    await expect(detectBinaryFile(filePath, root, ':image.bin')).resolves.toBe(true);
  });

  it('falls back to git content when the file is gone', async () => {
    const missing = path.join(root, 'deleted.txt');
    await expect(detectBinaryFile(missing, root, ':deleted.txt')).resolves.toBe(false);
  });
});
