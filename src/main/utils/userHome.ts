import { homedir } from 'node:os';
import { resolveUserHome } from '@shared/userHome';

/** This process's home for the app's own files and `~` — see `@shared/userHome`. */
export function getUserHome(): string {
  return resolveUserHome({ platform: process.platform, env: process.env, osHome: homedir() });
}
