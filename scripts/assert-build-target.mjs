/**
 * Refuse a local cross-platform package build.
 *
 * `dist:prereq` prepares HOST-platform inputs — fetch-node-runtime defaults to
 * process.platform/arch, and build-agent-host copies this machine's node-pty
 * and codex platform package — while afterPack.mjs deliberately takes files for
 * the TARGET platform (context.electronPlatformName). Running `build:win` on
 * Linux therefore stages a Linux runtime and then asks for node.exe: it either
 * dies deep inside packaging or, worse, produces a package with the wrong
 * platform's binaries in it.
 *
 * The project's answer is that cross-platform builds go through CI's native
 * runners (user decision, 2026-08-21). This guard turns a confusing late
 * failure into one line, up front.
 *
 * Usage: node scripts/assert-build-target.mjs <platform-key|platform>
 *   e.g. win32-x64, linux-x64, darwin  (bare platform matches any arch)
 */

const target = process.argv[2];
const hostPlatform = process.platform;
const hostArch = process.arch;
const hostKey = `${hostPlatform}-${hostArch}`;

if (!target) {
  console.error('[assert-build-target] usage: assert-build-target.mjs <platform-key|platform>');
  process.exit(1);
}

// A bare platform (no arch) matches any arch on that platform: the mac scripts
// build both arm64 and x64 from the same host.
const matches = target.includes('-') ? target === hostKey : target === hostPlatform;

if (!matches) {
  console.error(
    `[assert-build-target] refusing to build ${target} on ${hostKey}.\n` +
      `  Local packaging is host-platform only: dist:prereq stages this machine's\n` +
      `  Node runtime, node-pty and codex platform package, while afterPack takes\n` +
      `  the target platform's files — the two would not agree.\n` +
      `  Build ${target} on CI instead (Actions -> Build -> Run workflow), or run\n` +
      `  this command on a ${target} machine.`
  );
  process.exit(1);
}
