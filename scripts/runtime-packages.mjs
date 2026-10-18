/**
 * The node_modules packages app.asar ships (decision 200).
 *
 * Main, preload and the renderer are bundled by electron-vite, so at run time
 * Main loads only what its bundles leave as a bare specifier, plus what those
 * packages require themselves. Everything else in `dependencies` is already
 * inside `out/` and stays out of the archive. `electron-builder.yml` lists
 * exactly these packages under `files` (packaging-config test), and
 * verify-packaged-app checks the archive against this file and loads each
 * entry through the packaged executable.
 */

/** Bare specifiers Main's bundles load at run time (static imports and `createRequire`). */
export const MAIN_RUNTIME_ENTRIES = [
  // electron.vite.config.ts `runtimeNativePackages`: externals of the Main build.
  'node-pty',
  'sqlite3',
  // createRequire: FileWatcher.ts, SearchService.ts, encoding.ts / previewFileRead.ts.
  '@parcel/watcher',
  '@vscode/ripgrep',
  'isbinaryfile',
];

/** Every package the archive carries: the entries and what they require. */
export const RUNTIME_PACKAGES = [
  ...MAIN_RUNTIME_ENTRIES,
  // sqlite3's binding loader.
  'bindings',
  'file-uri-to-path',
  // @parcel/watcher: libc detection and its glob filter.
  'detect-libc',
  'picomatch',
  'is-glob',
  'is-extglob',
];

/** Per-platform builds, matched by prefix (`@parcel/watcher-win32-x64`, ...). */
export const RUNTIME_PACKAGE_PREFIXES = ['@parcel/watcher-'];

/** Whether a package name may ship in app.asar. */
export function isRuntimePackage(name) {
  return (
    RUNTIME_PACKAGES.includes(name) ||
    RUNTIME_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * The `files` patterns electron-builder.yml must carry for these packages, in
 * order. electron-builder copies every production dependency and applies only
 * the exclusions of `files` to node_modules, so the list is written as
 * "exclude every other package": one pattern for the top level, one per scope.
 */
export function runtimeFilePatterns() {
  const top = [];
  const scopes = new Map();
  const add = (name) => {
    if (!name.startsWith('@')) {
      top.push(name);
      return;
    }
    const [scope, inner] = name.split('/');
    if (!scopes.has(scope)) {
      scopes.set(scope, []);
      top.push(scope);
    }
    scopes.get(scope).push(inner);
  };
  for (const name of RUNTIME_PACKAGES) add(name);
  for (const prefix of RUNTIME_PACKAGE_PREFIXES) add(`${prefix}*`);
  return [
    `!node_modules/!(${top.join('|')}){,/**}`,
    ...[...scopes].map(([scope, inner]) => `!node_modules/${scope}/!(${inner.join('|')}){,/**}`),
  ];
}

const BUILTIN_PREFIX = 'node:';

/**
 * Bare specifiers a built Main or preload chunk leaves for run time: top-level
 * static imports, literal dynamic imports, `require` and `createRequire(...)`
 * calls. Relative paths, `node:` builtins and `electron` are skipped; the
 * caller drops other builtins (`fs`, ...).
 */
export function runtimeSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /^import\s+(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/gm,
    /(?<![\w$.])import\(\s*["']([^"']+)["']\s*\)/g,
    /(?<![\w$.])require\(\s*["']([^"']+)["']\s*\)/g,
    /createRequire\([^)]*\)\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      if (specifier.startsWith(BUILTIN_PREFIX) || specifier === 'electron') continue;
      found.add(packageNameOf(specifier));
    }
  }
  return [...found].sort();
}

/** `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
