import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

// Adapt the existing GitInstaller / Pi SDK search order. Do not select the WSL
// launcher: tools need a Windows cwd and the runner's native process tree.
export function resolveWorkerShell(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  const windows = platform === 'win32';
  const paths = windows ? win32 : posix;
  const candidates: string[] = [];
  if (windows) {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (root) candidates.push(paths.join(root, 'Git', 'bin', 'bash.exe'));
    }
    if (env.LOCALAPPDATA) {
      candidates.push(paths.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
    }
  } else {
    candidates.push('/bin/bash');
  }
  const pathKey = Object.keys(env).find((key) =>
    windows ? key.toLowerCase() === 'path' : key === 'PATH'
  );
  for (const entry of (env[pathKey ?? 'PATH'] ?? '').split(paths.delimiter)) {
    if (!entry || !paths.isAbsolute(entry)) continue;
    if (windows && /[\\/](?:system32|sysnative)[\\/]?$/i.test(entry)) continue;
    candidates.push(paths.join(entry, windows ? 'bash.exe' : 'bash'));
    if (windows && paths.basename(entry).toLowerCase() === 'cmd') {
      candidates.push(paths.join(entry, '..', 'bin', 'bash.exe'));
    }
  }
  return candidates.find(exists);
}
