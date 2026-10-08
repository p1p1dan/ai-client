import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GIT_SPAWN_ERROR_MARKER,
  GitOutputLostError,
  isGitOutputLostError,
  NODE_GIT_RUNNER_SCRIPT,
  NodeGitRunnerError,
  type NodeGitRunnerExec,
  resolveBundledNode,
  runGitViaNode,
} from '../nodeGitRunner';

/**
 * The F3 runner (`node -e <script> -- <workdir> <git args>`). Every case drives
 * an injected `exec`; nothing here spawns node or git.
 */

const WORKDIR = '/repo';
const ARGS = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'];

function rejectingExec(error: Record<string, unknown>): NodeGitRunnerExec {
  return async () => {
    throw Object.assign(new Error('Command failed'), error);
  };
}

async function failureOf(exec: NodeGitRunnerExec): Promise<NodeGitRunnerError> {
  const error = await runGitViaNode({ workdir: WORKDIR, args: ARGS, env: {}, exec }).catch(
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(NodeGitRunnerError);
  // A failed run is never "output was lost": that would re-label a real error.
  expect(isGitOutputLostError(error)).toBe(false);
  expect((error as Error).message).not.toMatch(/output was lost/);
  return error as NodeGitRunnerError;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runGitViaNode', () => {
  it('runs git under node with the primary env plus a C locale', async () => {
    vi.stubEnv('AICLIENT_TSD_NODE_PATH', '/opt/node-runtime/node.exe');
    const exec = vi.fn<NodeGitRunnerExec>(async () => ({ stdout: 'out\0', stderr: '' }));

    const result = await runGitViaNode({
      workdir: WORKDIR,
      args: ARGS,
      env: { PATH: '/enhanced/bin', GIT_CONFIG_COUNT: '1' },
      exec,
    });

    expect(result).toEqual({ stdout: 'out\0', stderr: '' });
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0];
    expect(file).toBe('/opt/node-runtime/node.exe');
    expect(args).toEqual(['-e', NODE_GIT_RUNNER_SCRIPT, '--', WORKDIR, ...ARGS]);
    expect(options).toMatchObject({
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { PATH: '/enhanced/bin', GIT_CONFIG_COUNT: '1', LC_ALL: 'C', LANGUAGE: 'C' },
    });
    expect(options.maxBuffer).toBeGreaterThan(0);
  });

  it('fails on a non-zero git exit even with partial stdout', async () => {
    const error = await failureOf(
      rejectingExec({ code: 128, stdout: '# branch.oid deadbeef\0', stderr: 'fatal: broken\n' })
    );
    expect(error.failure).toBe('git-exit');
    expect(error.exitCode).toBe(128);
    expect(error.message).toContain('exit 128');
    expect(error.message).toContain('fatal: broken');
  });

  it('reports git that could not be spawned (inner ENOENT marker)', async () => {
    const error = await failureOf(
      rejectingExec({ code: 127, stdout: '', stderr: `${GIT_SPAWN_ERROR_MARKER} ENOENT` })
    );
    expect(error.failure).toBe('git-spawn');
    expect(error.message).toContain('git could not be started (ENOENT)');
  });

  it('reports node itself not starting, with a string exit code', async () => {
    const error = await failureOf(rejectingExec({ code: 'ENOENT', stdout: '', stderr: '' }));
    expect(error.failure).toBe('node-spawn');
    expect(error.exitCode).toBe('ENOENT');
  });

  it('fails on a timeout instead of returning the half-read output', async () => {
    const error = await failureOf(
      rejectingExec({
        code: null,
        killed: true,
        signal: 'SIGTERM',
        stdout: '# branch.oid deadbeef\0# branch.head main\0',
        stderr: '',
      })
    );
    expect(error.failure).toBe('timeout');
    expect(error.message).toContain('timed out after 30000ms');
  });

  it('fails on a maxBuffer overflow', async () => {
    const error = await failureOf(
      rejectingExec({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: 'x', stderr: '' })
    );
    expect(error.failure).toBe('max-buffer');
  });

  it('relays raw bytes in buffer mode', async () => {
    const blob = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // GBK, not valid UTF-8
    const exec = vi.fn<NodeGitRunnerExec>(async () => ({ stdout: blob, stderr: Buffer.alloc(0) }));

    const result = await runGitViaNode({
      workdir: WORKDIR,
      args: ['show', 'HEAD:a.txt'],
      env: {},
      encoding: 'buffer',
      exec,
    });

    expect(result.stdout).toBe(blob);
    expect(exec.mock.calls[0][2]).toMatchObject({ encoding: 'buffer' });
  });

  it('still recognises the spawn marker when stderr comes back as a Buffer', async () => {
    const error = await runGitViaNode({
      workdir: WORKDIR,
      args: ['show', 'HEAD:a.txt'],
      env: {},
      encoding: 'buffer',
      exec: rejectingExec({
        code: 127,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(`${GIT_SPAWN_ERROR_MARKER} ENOENT`),
      }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NodeGitRunnerError);
    expect((error as NodeGitRunnerError).failure).toBe('git-spawn');
  });

  it('fails when killed by a signal it did not send', async () => {
    const error = await failureOf(
      rejectingExec({ code: null, killed: false, signal: 'SIGKILL', stdout: '', stderr: '' })
    );
    expect(error.failure).toBe('signal');
    expect(error.signal).toBe('SIGKILL');
  });
});

describe('NODE_GIT_RUNNER_SCRIPT', () => {
  it('relays git with its exit code and tags spawn failures', () => {
    expect(NODE_GIT_RUNNER_SCRIPT).toContain("spawn('git',process.argv.slice(2)");
    expect(NODE_GIT_RUNNER_SCRIPT).toContain('cwd:process.argv[1]');
    expect(NODE_GIT_RUNNER_SCRIPT).toContain(GIT_SPAWN_ERROR_MARKER);
    expect(NODE_GIT_RUNNER_SCRIPT).toContain('process.exitCode=127');
    // `process.exit()` can cut off piped stdout that has not drained yet.
    expect(NODE_GIT_RUNNER_SCRIPT).not.toContain('process.exit(');
  });

  it('survives Windows command-line quoting (no double quotes or newlines)', () => {
    expect(NODE_GIT_RUNNER_SCRIPT).not.toContain('"');
    expect(NODE_GIT_RUNNER_SCRIPT).not.toContain('\n');
  });

  it('is valid JavaScript', () => {
    expect(() => new Function(NODE_GIT_RUNNER_SCRIPT)).not.toThrow();
  });
});

describe('resolveBundledNode', () => {
  it('honours AICLIENT_TSD_NODE_PATH', () => {
    vi.stubEnv('AICLIENT_TSD_NODE_PATH', '  C:\\custom\\node.exe  ');
    expect(resolveBundledNode()).toBe('C:\\custom\\node.exe');
  });

  it.skipIf(process.platform === 'win32')('uses PATH node off Windows', () => {
    vi.stubEnv('AICLIENT_TSD_NODE_PATH', '');
    expect(resolveBundledNode()).toBe('node');
  });
});

describe('GitOutputLostError', () => {
  it('is recognised by its code, not by its message', () => {
    expect(isGitOutputLostError(new GitOutputLostError('warning: anything on stderr'))).toBe(true);
    expect(isGitOutputLostError(new Error('its output was lost'))).toBe(false);
  });
});
