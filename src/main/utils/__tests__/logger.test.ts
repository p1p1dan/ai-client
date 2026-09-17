import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T066 (D4/D10/D14) — the floor that decides whether ANY main-process
 * diagnostic reaches a file.
 *
 * `initLogger` hijacks `console` into electron-log, so every `console.warn` and
 * `console.log` in the main process is filtered by `transports.file.level`.
 * That level used to be `error` whenever the user's logging switch was off —
 * the state every machine ships in — which is why the 2026-09-17 field pass
 * found a repaired session index, 42 legacy imports and an archived temp chat
 * with zero lines between them. The field notes read it as "electron-log
 * swallows anything below error"; these cases pin the real contract so the
 * regression cannot come back as a one-word edit.
 */

let logsDir = '';

const transports = {
  file: {
    level: 'silly' as string,
    maxSize: 0,
    format: '',
    resolvePathFn: (): string => '',
  },
  console: { level: 'silly' as string, format: '' },
};

const hijackFunctions = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => logsDir) },
}));

vi.mock('electron-log/main.js', () => ({
  default: {
    transports,
    functions: hijackFunctions,
    initialize: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

/** `initLogger` replaces the global console methods; put them back. */
const savedConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), 'aiclient-logger-test-'));
  vi.resetModules();
  transports.file.level = 'silly';
  transports.console.level = 'silly';
});

afterEach(() => {
  Object.assign(console, savedConsole);
  rmSync(logsDir, { recursive: true, force: true });
});

describe('initLogger level floors', () => {
  it('keeps info on the file transport when the logging switch is off', async () => {
    const { initLogger, DISABLED_FILE_LEVEL } = await import('../logger');

    initLogger(false);

    expect(DISABLED_FILE_LEVEL).toBe('info');
    expect(transports.file.level).toBe('info');
    // The regression this file exists for: `error` means every warn and every
    // info written anywhere in the main process is dropped before the file.
    expect(transports.file.level).not.toBe('error');
  });

  it('keeps the developer console at warn when the logging switch is off', async () => {
    const { initLogger, DISABLED_CONSOLE_LEVEL } = await import('../logger');

    initLogger(false);

    expect(DISABLED_CONSOLE_LEVEL).toBe('warn');
    expect(transports.console.level).toBe('warn');
  });

  it('hands both transports the user level once logging is switched on', async () => {
    const { initLogger } = await import('../logger');

    initLogger(true, 'debug');

    expect(transports.file.level).toBe('debug');
    expect(transports.console.level).toBe('debug');
  });

  it('drops back to the floors when the switch goes off again', async () => {
    const { initLogger } = await import('../logger');

    initLogger(true, 'debug');
    initLogger(false, 'debug');

    expect(transports.file.level).toBe('info');
    expect(transports.console.level).toBe('warn');
  });
});
