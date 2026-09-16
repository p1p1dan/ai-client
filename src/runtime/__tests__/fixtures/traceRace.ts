/**
 * One real trace writer, as its own OS process.
 *
 * concurrency-03 / capacity-05 are about two WORKERS sharing one trace
 * directory — `AICLIENT_RUNTIME_TRACE_DIR` is inherited by every worker a
 * forensic run starts, so `runs.jsonl` has as many writers as there are
 * sessions. Whether rotation and appends stay mutually exclusive across that
 * boundary is a property of the filesystem, not of the plugin's promise chain,
 * so it is exercised with real processes against the real host IO.
 *
 * Protocol: report `ready`, wait for `go`, write `count` runs, flush, report
 * `done`.
 */

import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Context } from 'cordis';
import { createRuntime } from '../../bootstrap.ts';
import { TracePlugin } from '../../trace.ts';

const [dir, label, count, maxFileBytes, generations] = process.argv.slice(2);
if (!dir || !label) throw new Error('usage: traceRace.ts <dir> <label> <count> <bytes> <gens>');

const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
const handle = await createRuntime({ env: {}, providers: [faux.provider], traceDir: null });
const trace = new TracePlugin(new Context(), {
  io: handle.hostIo,
  dir,
  versionStamp: { config_version: 'race' },
  maxFileBytes: Number(maxFileBytes),
  fileGenerations: Number(generations),
});

await new Promise<void>((resolve) => {
  const listen = (message: unknown): void => {
    if (message !== 'go') return;
    process.off('message', listen);
    resolve();
  };
  process.on('message', listen);
  process.send?.('ready');
});

for (let index = 0; index < Number(count); index++) {
  const run = trace.begin({
    runId: `${label}-${index}`,
    input: `${label}-${index}`.padEnd(800, '.'),
    model: 'm',
    provider: 'p',
  });
  await run.finish({ final_output: 'ok', usage: null, success: true });
}
await trace.flush();
process.send?.('done');
await handle.dispose();
process.exit(0);
