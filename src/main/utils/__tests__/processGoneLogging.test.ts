import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { registerProcessGoneLogging } from '../processGoneLogging';

function setup() {
  const app = new EventEmitter();
  const log = { error: vi.fn(), info: vi.fn() };
  registerProcessGoneLogging(app as never, log);
  return { app, log };
}

describe('registerProcessGoneLogging (T4)', () => {
  it('logs a dead renderer with its reason, exit code and page', () => {
    const { app, log } = setup();
    const webContents = { id: 3, getURL: () => 'file:///app/index.html' } as unknown as WebContents;
    app.emit('render-process-gone', {}, webContents, { reason: 'crashed', exitCode: 139 });
    expect(log.error).toHaveBeenCalledWith('[process] render-process-gone', {
      reason: 'crashed',
      exitCode: 139,
      webContents: '#3 file:///app/index.html',
    });
  });

  it('survives a destroyed WebContents', () => {
    const { app, log } = setup();
    const webContents = {
      id: 7,
      getURL: () => {
        throw new Error('Object has been destroyed');
      },
    } as unknown as WebContents;
    expect(() =>
      app.emit('render-process-gone', {}, webContents, { reason: 'oom', exitCode: -1 })
    ).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      '[process] render-process-gone',
      expect.objectContaining({ reason: 'oom', webContents: '#7' })
    );
  });

  it('logs child process faults as errors and clean exits as info', () => {
    const { app, log } = setup();
    app.emit(
      'child-process-gone',
      {},
      {
        type: 'GPU',
        reason: 'crashed',
        exitCode: 1,
        name: 'GPU',
      }
    );
    expect(log.error).toHaveBeenCalledWith('[process] child-process-gone', {
      type: 'GPU',
      reason: 'crashed',
      exitCode: 1,
      name: 'GPU',
    });

    app.emit(
      'child-process-gone',
      {},
      {
        type: 'Utility',
        reason: 'clean-exit',
        exitCode: 0,
        serviceName: 'network.mojom.NetworkService',
      }
    );
    expect(log.info).toHaveBeenCalledWith('[process] child-process-gone', {
      type: 'Utility',
      reason: 'clean-exit',
      exitCode: 0,
      serviceName: 'network.mojom.NetworkService',
    });
  });

  it('is registered by the main entry without touching the exit policy', () => {
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../index.ts'),
      'utf8'
    );
    expect(source).toContain('registerProcessGoneLogging(app, log);');
    // The uncaught handlers still exit; that policy is not this change's call.
    expect(source).toMatch(/process\.on\('uncaughtException'[\s\S]*?app\.exit\(1\)/);
  });
});
