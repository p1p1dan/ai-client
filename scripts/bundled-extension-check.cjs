/**
 * R03 — is each bundled feature extension present in pi's loaded list?
 *
 * Split out of `packaged-worker-smoke.cjs` so the matching rule is testable
 * without Electron. The probe keeps the package list itself: this module only
 * decides whether a list pi reported satisfies it, and must not learn the names
 * from the repo the artifact was built from.
 *
 * ## Why the paths are normalised
 *
 * The entries carry the path pi resolved, and the roots handed to pi are built
 * with `path.join` (`permissionPlugin.ts` → `lookupBundledPackage`). On Windows
 * that means `...\node_modules\@scope\name\index.ts`, so a scoped package name
 * — which is written with a forward slash — can never match as a literal
 * substring. Comparing on a POSIX-normalised copy is what makes this check mean
 * the same thing on all three platforms. Windows CI red on 0.4.0-test.7 was
 * exactly this, with the files correctly packaged.
 */

/** Path separators normalised to `/`; anything but a string is no path at all. */
function toPosixPath(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/') : '';
}

/**
 * @param {Array<{ path?: unknown, ok?: unknown }>} loaded pi's extension inventory
 *   as `worker.bootstrap` reports it (`WorkerExtensionInfo[]`).
 * @param {readonly string[]} packages npm names that must be running.
 * @returns {string[]} one message per package that is missing or failed to load;
 *   empty means every one of them is live.
 */
function checkBundledExtensionsLoaded(loaded, packages) {
  const entries = Array.isArray(loaded) ? loaded : [];
  const describe = () => JSON.stringify(entries.map((e) => ({ path: e?.path, ok: e?.ok })));
  const problems = [];
  for (const pkg of packages) {
    const hit = entries.find((entry) => toPosixPath(entry?.path).includes(pkg));
    if (!hit) {
      problems.push(`bundled extension ${pkg} did not load; got ${describe()}`);
      continue;
    }
    // The field is `ok` (`WorkerExtensionInfo`), and it is false when pi
    // collected a load error for that path instead of running the module.
    if (hit.ok === false) {
      problems.push(`bundled extension ${pkg} reported a load error: ${JSON.stringify(hit)}`);
    }
  }
  return problems;
}

module.exports = { checkBundledExtensionsLoaded, toPosixPath };
