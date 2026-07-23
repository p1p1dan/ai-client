/**
 * Agent Host entry — runs under whitelisted Node 24.
 * Protocol: stdin NDJSON commands → stdout NDJSON Runtime Events; logs on stderr.
 *
 * Phase 0: handshake + shutdown only. Claude drivers land in Phase 2 after spike selection.
 */

import { createInterface } from 'node:readline';
import { COMETIX_PIN } from './pin.ts';

const PROTOCOL_VERSION = 1;
let seq = 0;
let driver: 'agent-sdk' | 'stream-json' = 'stream-json';
let shuttingDown = false;

function emit(event: Record<string, unknown>): void {
  seq += 1;
  const line = JSON.stringify({
    ...event,
    seq,
    timestamp: Date.now(),
  });
  process.stdout.write(`${line}\n`);
}

function log(...args: unknown[]): void {
  console.error('[agent-host]', ...args);
}

async function handleCommand(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object') {
    emit({
      type: 'host.error',
      payload: { code: 'invalid_command', message: 'Command must be a JSON object' },
    });
    return;
  }

  const cmd = raw as {
    type?: string;
    requestId?: string;
    protocolVersion?: number;
    payload?: { driver?: 'agent-sdk' | 'stream-json' };
  };

  if (cmd.protocolVersion !== PROTOCOL_VERSION) {
    emit({
      type: 'host.error',
      requestId: cmd.requestId,
      payload: {
        code: 'protocol_mismatch',
        message: `Expected protocolVersion ${PROTOCOL_VERSION}, got ${String(cmd.protocolVersion)}`,
      },
    });
    return;
  }

  switch (cmd.type) {
    case 'host.initialize': {
      if (cmd.payload?.driver) driver = cmd.payload.driver;
      emit({
        type: 'host.ready',
        requestId: cmd.requestId,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          driver,
          nodeVersion: process.version,
          nodeExecPath: process.execPath,
          cometixVersion: COMETIX_PIN.version,
        },
      });
      return;
    }
    case 'host.shutdown': {
      shuttingDown = true;
      emit({
        type: 'host.ready',
        requestId: cmd.requestId,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          driver,
          nodeVersion: process.version,
          shuttingDown: true,
        },
      });
      // Exit after draining the write.
      setImmediate(() => process.exit(0));
      return;
    }
    default: {
      // Phase 0 stub: acknowledge unknown session commands without crashing.
      log('unhandled command (phase0 stub):', cmd.type);
      emit({
        type: 'host.error',
        requestId: cmd.requestId,
        payload: {
          code: 'not_implemented',
          message: `Command not implemented in Phase 0 stub: ${String(cmd.type)}`,
          fatal: false,
        },
      });
    }
  }
}

async function main(): Promise<void> {
  log('starting', {
    node: process.version,
    execPath: process.execPath,
    cometix: COMETIX_PIN.version,
    pid: process.pid,
  });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (shuttingDown) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      await handleCommand(JSON.parse(trimmed));
    } catch (err) {
      emit({
        type: 'host.error',
        payload: {
          code: 'parse_error',
          message: err instanceof Error ? err.message : String(err),
          fatal: false,
        },
      });
    }
  }
}

main().catch((err) => {
  log('fatal', err);
  process.exit(1);
});
