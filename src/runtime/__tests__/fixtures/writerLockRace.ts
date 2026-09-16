/**
 * One real claimant of a session writer lock, as its own OS process.
 *
 * concurrency-01 is a three-party race, and the parties are processes: the
 * defect is that one claimant's takeover leaves the lock NAME free for a
 * moment, which only another process can exploit. An in-process test can stage
 * that with a proxy around the IO service, but it cannot show that the
 * filesystem primitives the exclusion rests on (`O_EXCL` create, `rename`)
 * actually behave that way between processes — so the race is also run for
 * real, one fork per claimant, against the same host IO the worker uses.
 *
 * Protocol: report `ready`, wait for `go`, attempt the lock once, report the
 * outcome, then stay alive until `stop` so the parent can inspect the sidecar
 * while the winner is still running.
 */

import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRuntime } from '../../bootstrap.ts';
import { errorCode } from '../../host/errors.ts';
import { acquireWriterLock } from '../../plugins/session/writerLock.ts';

const target = process.argv[2];
if (!target) throw new Error('usage: writerLockRace.ts <session file>');
const force = process.argv[3] === 'force';

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

send('ready');
await next('go');
try {
  const lock = await acquireWriterLock(handle.hostIo, target, force ? { force: true } : undefined);
  send({ ok: true, pid: process.pid, token: lock.token });
} catch (error) {
  send({ ok: false, pid: process.pid, code: errorCode(error), message: String(error) });
}
await next('stop');
await handle.dispose();
process.exit(0);
