import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Keep the tree leader alive until the parent has terminated the whole command tree.
let started = false;
process.on('message', (request) => {
  if (started) return;
  started = true;
  try {
    const command = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    command.on('error', (error) => process.send?.({ type: 'spawn-error', message: error.message }));
    command.on('exit', (code, signal) => process.send?.({ type: 'exit', code, signal }));
  } catch (error) {
    process.send?.({
      type: 'spawn-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
process.on('disconnect', () => {
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/PID', String(process.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => process.exit(1));
  } else {
    process.kill(-process.pid, 'SIGKILL');
  }
});
