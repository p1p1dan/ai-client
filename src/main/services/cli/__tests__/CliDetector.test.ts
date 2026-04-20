import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const execInPtyMock = vi.fn();
const getEnvForCommandMock = vi.fn(() => ({
  PATH: 'C:\\Windows\\System32;C:\\Users\\ga\\AppData\\Roaming\\npm',
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../../utils/shell', () => ({
  execInPty: execInPtyMock,
  getEnvForCommand: getEnvForCommandMock,
}));

function createSpawnProcess({
  stdout = '',
  stderr = '',
  exitCode = 0,
}: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };

  child.pid = 4321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (stdout) {
      child.stdout.emit('data', Buffer.from(stdout));
    }
    if (stderr) {
      child.stderr.emit('data', Buffer.from(stderr));
    }
    child.emit('close', exitCode);
  });

  return child;
}

describe('CliDetector', () => {
  afterEach(() => {
    spawnMock.mockReset();
    execInPtyMock.mockReset();
    getEnvForCommandMock.mockClear();
    vi.resetModules();
  });

  it('detects claude via cmd fallback when shell-based detection fails', async () => {
    execInPtyMock.mockRejectedValue(new Error('Command exited with code 1'));
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (
        command === 'cmd.exe' &&
        args[0] === '/d' &&
        args[1] === '/s' &&
        args[2] === '/c' &&
        args[3]?.includes('claude --version')
      ) {
        return createSpawnProcess({ stdout: 'claude 1.0.72\n' });
      }

      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    });

    const { cliDetector } = await import('../CliDetector');
    const result = await cliDetector.detectOne('claude');

    expect(result).toMatchObject({
      id: 'claude',
      installed: true,
      version: '1.0.72',
      isBuiltin: true,
    });
  });
});
