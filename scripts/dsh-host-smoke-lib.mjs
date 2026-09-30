/**
 * Pure helpers of the packaged DSH host smoke (scripts/packaged-dsh-host-smoke.mjs)
 * and its Windows diagnostics (scripts/dsh-host-windows-diag.mjs), kept apart so
 * scripts/__tests__ can load them without running a smoke.
 */

/**
 * The runners DSH puts in front of a tool, each `<node> <runner.js> [options] -- <tool argv>`:
 * dsh-subprocess-local's Windows Job runner (every ordinary spawn on win32
 * goes through it, so the host's own child_process only ever sees node.exe)
 * and dsh-sandbox-windows-acl's confinement runner (a sandboxed shell call).
 */
const NODE_RUNNERS =
  /[\\/]@deepseek-ai[\\/](dsh-subprocess-local|dsh-sandbox-windows-acl)[\\/]lib[\\/]runner\.js$/i;

/**
 * A spawn record's whole argv. The hooks log an async spawn as Node's
 * normalized options, whose `args` already start with argv[0]; a sync one as
 * the caller's own arguments, which do not.
 */
export function spawnArgv(record) {
  const args = Array.isArray(record?.args) ? record.args.map(String) : [];
  if (record?.kind === 'spawn' && args.length > 0) return args;
  return [String(record?.file ?? ''), ...args];
}

/**
 * The program a spawn record runs, through DSH's launchers:
 *   - Linux with a user systemd session (Main's environment carries
 *     XDG_RUNTIME_DIR and DBus, decision 022): `systemd-run … -- <runner> -- <tool argv>`,
 *     the tool is the first word after the second `--`;
 *   - Windows: `<node> …/dsh-subprocess-local/lib/runner.js -- <tool argv>`, and for a
 *     sandboxed call `<tool argv>` is itself `<node> …/dsh-sandbox-windows-acl/lib/runner.js
 *     --workspace … -- <tool argv>` (decision 134).
 * A record that is none of these runs its own argv[0].
 */
export function spawnTarget(record) {
  let argv = spawnArgv(record);
  for (let depth = 0; depth < 4 && argv.length > 0; depth += 1) {
    let next = -1;
    if (/(^|[\\/])systemd-run$/.test(argv[0])) {
      const first = argv.indexOf('--');
      next = first < 0 ? -1 : argv.indexOf('--', first + 1);
    } else if (NODE_RUNNERS.test(argv[1] ?? '')) {
      next = argv.indexOf('--', 2);
    }
    if (next < 0 || next + 1 >= argv.length) break;
    argv = argv.slice(next + 1);
  }
  return argv[0];
}

/** Whether `file` names ripgrep (`rg`, `rg.exe`). */
export function isRipgrep(file) {
  return /(^|[\\/])rg(\.exe)?$/i.test(String(file ?? ''));
}
