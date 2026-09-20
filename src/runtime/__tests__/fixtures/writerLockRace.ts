/**
 * One real claimant of a session writer lock, as its own OS process.
 *
 * concurrency-01 is a three-party race, and the parties are processes: the
 * defect is that one claimant's takeover leaves the lock NAME free for a
 * moment, which only another process can exploit. An in-process test can stage
 * that with a proxy around the IO service, but it cannot show that the
 * filesystem primitives the exclusion rests on (`O_EXCL` create, `rename`,
 * `link`) actually behave that way between processes — so the race is also run
 * for real, one fork per claimant, against the same host IO the worker uses.
 *
 * Protocol: report `ready`, wait for `go`, attempt the lock once, report the
 * outcome, then stay alive until `stop` so the parent can inspect the sidecar
 * while the winner is still running.
 *
 * `writerLockRace.ts <session file> [force] [at-link]` — `at-link` stops this
 * claimant in the one window where the lock name is free during a takeover
 * (moved aside, claim not yet posted) and reports `at-link` so the parent can
 * take the name itself before releasing it. That window is milliseconds wide
 * against a real clock and cannot be hit from another event loop on purpose;
 * this is what makes it reachable.
 */

import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRuntime } from '../../bootstrap.ts';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode } from '../../host/errors.ts';
import { acquireWriterLock } from '../../plugins/session/writerLock.ts';

const target = process.argv[2];
if (!target) throw new Error('usage: writerLockRace.ts <session file>');
const force = process.argv[3] === 'force';
const atLink = process.argv.includes('at-link');

const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
const handle = await createRuntime({ env: {}, providers: [faux.provider], traceDir: null });

function send(message: unknown): void {
  process.send?.(message);
}

async function next(expected: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const listen = (message: unknown): void => {
      if (message !== expected) return;
      process.off('message', listen);
      resolve();
    };
    process.on('message', listen);
  });
}

/**
 * The host IO as this claimant uses it, stopping once at the instant the lock
 * name is `to` be changed by the takeover's install.
 *
 * The stop is placed on the install rather than on a read because the install is
 * the step the lock's mutual exclusion rests on: everything before it has been
 * judged by the claimant itself, and everything after it is done. Both of the
 * ways an install can move the name are hooked — the `link` that posts the claim
 * and the `rename` that a replacement would use — so a run of this fixture
 * against either implementation reaches its window and reports it, instead of
 * the parent waiting for a report that a correct implementation never sends.
 */
function pausingAtInstall(io: RuntimeHostIoService): RuntimeHostIoService {
  let pending = true;
  const pause = async (): Promise<void> => {
    if (!pending) return;
    pending = false;
    send('at-link');
    await next('go');
  };
  return new Proxy(io, {
    get(inner, key) {
      const value = Reflect.get(inner, key) as unknown;
      if (typeof value !== 'function') return value;
      const method = value.bind(inner) as (...args: unknown[]) => unknown;
      if (key === 'link' && atLink)
        return async (...args: unknown[]) => {
          await pause();
          return method(...args);
        };
      if (key !== 'rename' || !atLink) return method;
      return async (...args: unknown[]) => {
        if (String(args[1]).endsWith('.writer.lock')) await pause();
        return method(...args);
      };
    },
  });
}

send('ready');
await next('go');
try {
  const io = atLink ? pausingAtInstall(handle.hostIo) : handle.hostIo;
  const lock = await acquireWriterLock(io, target, force ? { force: true } : undefined);
  send({ ok: true, pid: process.pid, token: lock.token });
} catch (error) {
  send({ ok: false, pid: process.pid, code: errorCode(error), message: String(error) });
}
await next('stop');
await handle.dispose();
process.exit(0);
