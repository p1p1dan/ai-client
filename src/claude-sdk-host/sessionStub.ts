/**
 * Route-B prototype: the identity stub of a Claude-SDK-backed chat, the file
 * Main keeps as the session's durable `sessionFile` (same role as the DSH
 * bridge's `*.dsh.json`, `src/dsh-host/bridge/stub.ts`).
 *
 * `<configDir>/aiclient-sessions/<ccSessionId><CLAUDE_SDK_STUB_SUFFIX>`. The suffix is
 * what Main's engine switch reads on resume (`claudeSdkEngine.ts`), so a session
 * created on this engine reopens on it whatever the switch says today.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CLAUDE_SDK_STUB_SUFFIX } from '../shared/claudeSdkEngine.ts';

export interface ClaudeSdkSessionStub {
  engine: 'claude-sdk';
  version: 1;
  /** The Claude Code session id (a UUID), passed as `sessionId` first and `resume` after. */
  ccSessionId: string;
  logicalSessionId: string;
  cwd: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** True once the CLI has written a transcript, so `resume` can find it. */
  started: boolean;
  /**
   * Route B S-1: the chat's model as our `provider/modelId` ref. Written at
   * create from the bootstrap model, updated once a model switch has taken;
   * Main resumes with it. Absent in stubs written before S-1.
   */
  model?: string;
}

export function stubPathFor(configDir: string, ccSessionId: string): string {
  return join(configDir, 'aiclient-sessions', `${ccSessionId}${CLAUDE_SDK_STUB_SUFFIX}`);
}

export function createStub(
  configDir: string,
  logicalSessionId: string,
  cwd: string,
  model?: string
): { file: string; stub: ClaudeSdkSessionStub } {
  const stub: ClaudeSdkSessionStub = {
    engine: 'claude-sdk',
    version: 1,
    ccSessionId: randomUUID(),
    logicalSessionId,
    cwd,
    createdAt: Date.now(),
    started: false,
    ...(model ? { model } : {}),
  };
  const file = stubPathFor(configDir, stub.ccSessionId);
  writeStub(file, stub);
  return { file, stub };
}

export function writeStub(file: string, stub: ClaudeSdkSessionStub): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(stub, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

export function readStub(file: string): ClaudeSdkSessionStub {
  if (!basename(file).endsWith(CLAUDE_SDK_STUB_SUFFIX)) {
    throw Object.assign(new Error(`not a Claude SDK session stub: ${file}`), {
      code: 'WORKER_SESSION_ENGINE_MISMATCH',
    });
  }
  const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<ClaudeSdkSessionStub>;
  if (
    value.engine !== 'claude-sdk' ||
    typeof value.ccSessionId !== 'string' ||
    typeof value.logicalSessionId !== 'string' ||
    typeof value.cwd !== 'string'
  ) {
    throw Object.assign(new Error(`malformed Claude SDK session stub: ${file}`), {
      code: 'WORKER_SESSION_STUB_INVALID',
    });
  }
  return {
    engine: 'claude-sdk',
    version: 1,
    ccSessionId: value.ccSessionId,
    logicalSessionId: value.logicalSessionId,
    cwd: value.cwd,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    started: value.started === true,
    ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
  };
}
