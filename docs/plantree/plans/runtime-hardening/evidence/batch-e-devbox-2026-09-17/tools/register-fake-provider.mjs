#!/usr/bin/env node
/**
 * register-fake-provider.mjs — wire the fake-gateway.mjs server into ai-client's
 * credential vault as a custom UserProvider (docs/plantree ... handbook.md 5.3, path B).
 *
 * ai-client stores custom "AI services" in vault.json as a `userProviders` field that is
 * EITHER a plaintext array of UserProvider objects OR (when `userProvidersEnc === "safeStorage"`)
 * an OS-keyring-encrypted string that this plain Node script cannot decrypt (safeStorage is an
 * Electron-only API). This script never guesses at that string's content — it always backs up
 * the whole vault file byte-for-byte before touching anything, and refuses to fabricate a merged
 * provider list when the existing one is encrypted (it just replaces the live array with a
 * single fake entry and tells you how to get the original back).
 *
 * Usage:
 *   node register-fake-provider.mjs --port <port> [--id <id>] --vault <path> [--dry-run]
 *   node register-fake-provider.mjs --restore <bak-file> --vault <path>
 *
 * Options:
 *   --port <n>     Port the fake gateway (fake-gateway.mjs) is listening on. Required unless --restore.
 *   --id <id>      UserProvider id to write. Default: probe-fake
 *   --vault <path> Path to vault.json. Default: /home/ai/.pilab/jyw-ai-client-dev/credentials/vault.json
 *   --dry-run      Print the vault JSON that WOULD be written, but do not touch any file.
 *                  (apiKey values and any pre-existing encrypted userProviders string are always
 *                  redacted in printed output — never printed in full, dry-run or not.)
 *   --restore <bak-file>  Copy a previously written backup file back onto --vault, byte-for-byte,
 *                  undoing whatever this script wrote earlier. Does not touch fake-gateway.mjs.
 *
 * What a non-dry-run write does:
 *   1. Read --vault, parse JSON.
 *   2. Back it up to `<vault>.bak-<ISO-timestamp-with-dashes>` using an exclusive ('wx') file
 *      write — if a backup at that exact path already exists, it is left alone and NOT
 *      overwritten (this only matters if you run twice within the same millisecond, but the
 *      exclusivity guarantee is unconditional).
 *   3. If the existing `userProviders` was an encrypted string (userProvidersEnc !== "none"),
 *      print a warning that the original service list is only recoverable via `--restore <bak>`,
 *      and start the live `userProviders` array from empty (plus the new fake entry) rather than
 *      guessing at its contents.
 *      If the existing `userProviders` was already a plaintext array, the new fake entry (keyed
 *      by --id) is appended/replaces any entry with the same id, and every other entry is kept.
 *   4. Set `userProvidersEnc: "none"` and write the vault back out.
 *
 * The written UserProvider (per src/main/services/auth/CredentialVault.ts's UserProvider type):
 *   { id, name: "Fake Gateway", baseUrl: "http://127.0.0.1:<port>", api: "anthropic-messages",
 *     apiKey: "fake-key", models: ["fake-sonnet"], enabled: true, createdAt: <ISO now> }
 *
 * Safety: this script never prints an apiKey or the encrypted userProviders string to stdout,
 * in either dry-run or real mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_VAULT = '/home/ai/.pilab/jyw-ai-client-dev/credentials/vault.json';
const DEFAULT_ID = 'probe-fake';

function parseArgs(argv) {
  const args = { port: null, id: DEFAULT_ID, vault: DEFAULT_VAULT, dryRun: false, restore: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--vault') args.vault = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--restore') args.restore = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!args.restore) {
    if (!args.port || Number.isNaN(args.port))
      throw new Error('--port <n> is required (unless using --restore)');
  }
  return args;
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Deep-clone a vault object, replacing anything sensitive with a redaction marker. */
function redactForPrint(vault) {
  const clone = JSON.parse(JSON.stringify(vault));
  if (typeof clone.userProviders === 'string') {
    clone.userProviders = `<redacted encrypted string, length=${clone.userProviders.length}>`;
  } else if (Array.isArray(clone.userProviders)) {
    clone.userProviders = clone.userProviders.map((p) => ({
      ...p,
      apiKey: typeof p?.apiKey === 'string' ? '<redacted>' : p?.apiKey,
    }));
  }
  return clone;
}

function loadVault(vaultPath) {
  const raw = fs.readFileSync(vaultPath, 'utf8');
  return { raw, json: JSON.parse(raw) };
}

function backupVault(vaultPath, raw) {
  const backupPath = `${vaultPath}.bak-${timestampForFilename()}`;
  try {
    fs.writeFileSync(backupPath, raw, { flag: 'wx' });
    return backupPath;
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.log(
        `[register-fake-provider] backup already exists at ${backupPath}, leaving it untouched`
      );
      return backupPath;
    }
    throw err;
  }
}

function buildFakeProvider(id, port) {
  return {
    id,
    // E1 fix (batch D method note 2): the worker-side wire id is a slug of `name`,
    // not of `id` (PiModelConfigService.ts:697-706 userProviderId()). Writing
    // "Fake Gateway" here produced `fake-gateway/fake-sonnet` while every plan
    // and settings key says `probe-fake/fake-sonnet`. Use the id verbatim.
    name: id,
    baseUrl: `http://127.0.0.1:${port}`,
    api: 'anthropic-messages',
    apiKey: 'fake-key',
    models: ['fake-sonnet'],
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

function buildNewVault(original, id, port) {
  const wasEncrypted = original.userProvidersEnc && original.userProvidersEnc !== 'none';
  const fakeProvider = buildFakeProvider(id, port);

  let newProviders;
  let note;
  if (wasEncrypted || typeof original.userProviders === 'string') {
    newProviders = [fakeProvider];
    note =
      '原有加密服务列表已备份，恢复用 `--restore <bak>`（脚本无法解密 safeStorage 字符串，因此这次写入不会保留原有服务，只能靠备份找回）。';
  } else if (Array.isArray(original.userProviders)) {
    const rest = original.userProviders.filter((p) => p?.id !== id);
    newProviders = [...rest, fakeProvider];
    note = `原有 ${rest.length} 个明文服务已保留，追加/替换了 id="${id}" 这一条。`;
  } else {
    newProviders = [fakeProvider];
    note = '原 vault 没有 userProviders 字段，新建为仅含 fake provider 的数组。';
  }

  const newVault = {
    ...original,
    userProviders: newProviders,
    userProvidersEnc: 'none',
  };
  return { newVault, note };
}

function doRestore(args) {
  if (!fs.existsSync(args.restore)) {
    throw new Error(`backup file not found: ${args.restore}`);
  }
  const backupRaw = fs.readFileSync(args.restore, 'utf8');
  // Sanity check: must be valid JSON before we overwrite anything.
  JSON.parse(backupRaw);
  fs.writeFileSync(args.vault, backupRaw);
  console.log(`[register-fake-provider] restored ${args.vault} from ${args.restore}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.restore) {
    doRestore(args);
    return;
  }

  const { raw, json: original } = loadVault(args.vault);
  const { newVault, note } = buildNewVault(original, args.id, args.port);

  if (args.dryRun) {
    console.log('[register-fake-provider] DRY RUN — nothing will be written.');
    console.log(`[register-fake-provider] vault path: ${args.vault}`);
    console.log(
      `[register-fake-provider] existing userProvidersEnc: ${JSON.stringify(original.userProvidersEnc)}`
    );
    console.log(
      `[register-fake-provider] existing userProviders type: ${
        typeof original.userProviders === 'string'
          ? 'encrypted string'
          : Array.isArray(original.userProviders)
            ? `plaintext array (${original.userProviders.length} entries)`
            : String(original.userProviders)
      }`
    );
    console.log(`[register-fake-provider] ${note}`);
    console.log(
      '[register-fake-provider] vault JSON that WOULD be written (apiKey / encrypted strings redacted):'
    );
    console.log(JSON.stringify(redactForPrint(newVault), null, 2));
    return;
  }

  const backupPath = backupVault(args.vault, raw);
  fs.writeFileSync(args.vault, JSON.stringify(newVault, null, 2));
  console.log(`[register-fake-provider] backed up original vault to ${backupPath}`);
  console.log(
    `[register-fake-provider] wrote fake provider "${args.id}" -> http://127.0.0.1:${args.port} into ${args.vault}`
  );
  console.log(`[register-fake-provider] ${note}`);
}

main();
