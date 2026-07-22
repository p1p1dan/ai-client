import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app } from 'electron';
import type sqlite3 from 'sqlite3';

// electron-builder's asarUnpack does not extract sqlite3's compiled native
// binding (node_sqlite3.node) out of app.asar for this project's pnpm layout,
// so `bindings` can never find it when required from inside the archive
// (native addons cannot be dlopen'd from an asar anyway). electron-builder.yml
// ships a full extraResources copy of sqlite3 outside the asar instead;
// load from there when packaged so `bindings` resolves against a real path.
// Main process output is ESM, so use createRequire to bypass the ESM linker.
const require = createRequire(import.meta.url);

function loadSqlite3(): typeof sqlite3 {
  if (app.isPackaged) {
    return require(join(process.resourcesPath, 'node_modules', 'sqlite3'));
  }
  return require('sqlite3');
}

let sqlite3Instance: typeof sqlite3 | null = null;

export function getSqlite3(): typeof sqlite3 {
  sqlite3Instance ??= loadSqlite3();
  return sqlite3Instance;
}
