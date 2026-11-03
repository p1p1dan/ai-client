// Linux-only evidence shim: SHIM_GATEWAY_MODEL_ID replaces the --model-id a spawned fake-gateway.mjs gets.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const originalSpawn = childProcess.spawn;
childProcess.spawn = function spawn(command, args, ...rest) {
  const id = process.env.SHIM_GATEWAY_MODEL_ID;
  if (
    id &&
    Array.isArray(args) &&
    args.some((a) => typeof a === 'string' && a.endsWith('fake-gateway.mjs'))
  ) {
    args = [...args];
    const at = args.indexOf('--model-id');
    if (at >= 0) args[at + 1] = id;
    else args.push('--model-id', id);
    console.error(`[shim] fake gateway --model-id ${id}`);
  }
  return originalSpawn.call(this, command, args, ...rest);
};
syncBuiltinESMExports();
