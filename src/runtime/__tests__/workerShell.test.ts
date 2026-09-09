import { describe, expect, it } from 'vitest';
import { resolveWorkerShell } from '../host/shell.ts';

describe('native worker shell selection', () => {
  it('uses Git Bash before the Windows WSL launcher', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(
      resolveWorkerShell(
        { ProgramFiles: 'C:\\Program Files', Path: 'C:\\Windows\\System32' },
        'win32',
        () => true
      )
    ).toBe(bash);
  });

  it('finds a custom Git installation from its cmd entry on Path', () => {
    const bash = 'D:\\Tools\\Git\\bin\\bash.exe';
    expect(
      resolveWorkerShell(
        { Path: 'C:\\Windows\\System32;D:\\Tools\\Git\\cmd' },
        'win32',
        (path) => path === bash
      )
    ).toBe(bash);
  });

  it('never treats a WSL launcher or a relative PATH entry as native bash', () => {
    expect(
      resolveWorkerShell(
        { Path: 'C:\\Windows\\System32;C:\\Windows\\Sysnative;.' },
        'win32',
        () => true
      )
    ).toBeUndefined();
  });

  it('uses a per-user Git installation', () => {
    const bash = 'C:\\Users\\test\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
    expect(
      resolveWorkerShell(
        { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
        'win32',
        (path) => path === bash
      )
    ).toBe(bash);
  });

  it('uses /bin/bash on Unix and can find bash on PATH when absent', () => {
    expect(resolveWorkerShell({}, 'linux', (path) => path === '/bin/bash')).toBe('/bin/bash');
    expect(
      resolveWorkerShell(
        { PATH: '/opt/bin:/usr/bin' },
        'darwin',
        (path) => path === '/opt/bin/bash'
      )
    ).toBe('/opt/bin/bash');
    expect(resolveWorkerShell({}, 'linux', () => false)).toBeUndefined();
  });
});
