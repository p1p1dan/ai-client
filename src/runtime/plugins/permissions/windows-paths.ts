/**
 * One spelling per file, before anything compares paths (windows-01).
 *
 * Windows accepts several spellings of the same file and our gates compare
 * strings: the deny for `~/.ssh/*` only holds if every spelling reaches the
 * comparison the same way. Git Bash — the shell the bash tool runs on Windows —
 * writes MSYS drive notation (`/c/Users/JC/.ssh/id_ed25519`), Cygwin writes
 * `/cygdrive/c/...`, and the kernel's extended-length form (`\\?\C:\...`) comes
 * back from APIs that resolve a path for us. `path.win32.isAbsolute` answers
 * `true` for the MSYS form, so it used to be folded to `\c\Users\...` and land
 * under a drive-relative `c` directory that no deny pattern mentions.
 *
 * POSIX is deliberately untouched: `/c/Users` is an ordinary absolute path
 * there, and rewriting it would invent a drive letter on a machine without one.
 */
export function normalizeWindowsPathForm(
  path: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32' || !path) return path;
  let value = path;
  // `\\?\C:\x`, `//?/C:/x` and the device form `\\.\`: an addressing prefix the
  // kernel understands, never part of the file's identity. `\\?\UNC\srv\share`
  // is the extended spelling of `\\srv\share`.
  const extended = /^[\\/]{2}[?.][\\/]/.exec(value);
  if (extended) {
    const rest = value.slice(extended[0].length);
    value = /^UNC[\\/]/i.test(rest) ? `\\\\${rest.slice(4)}` : rest;
  }
  const cygdrive = /^\/cygdrive\/([A-Za-z])(?=\/|$)/.exec(value);
  const msys = cygdrive ?? /^\/([A-Za-z])(?=\/|$)/.exec(value);
  if (msys) value = `${msys[1].toUpperCase()}:${value.slice(msys[0].length) || '/'}`;
  // Drive letters are compared character by character further down; upper-case
  // it so `c:\x` and `C:\x` cannot differ before the comparison runs.
  if (/^[a-z]:/.test(value)) value = value[0].toUpperCase() + value.slice(1);
  return value;
}
