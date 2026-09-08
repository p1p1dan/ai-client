import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';

// Canonicalize the existing ancestor so new targets cannot escape through a symlink.
export async function canonicalPath(
  io: RuntimeHostIoService,
  cwd: string,
  input: string
): Promise<string> {
  const absolute = isAbsolute(input) ? input : `${cwd}${sep}${input}`;
  try {
    return await io.realpath(absolute);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return resolve(await canonicalPath(io, cwd, parent), basename(absolute));
  }
}
