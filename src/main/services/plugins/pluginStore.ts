import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  PLUGIN_MANIFEST_FILE,
  type PluginManifest,
  type PluginSettingContrib,
  parsePluginManifest,
} from '@shared/plugins/manifest';
import type { PluginSettingView } from '@shared/plugins/view';
import { readZip, ZipError, type ZipFileEntry } from './zipReader';

/**
 * Plugins on disk (plugin-system README §3):
 *
 *   <root>/installed/<id>/     the unpacked package, replaced on update
 *   <root>/data/<id>/          the plugin's own writable directory
 *   <root>/settings/<id>.json  its setting values; secrets encrypted
 *   <root>/state.json          which plugins are enabled
 *
 * A fresh install is disabled: the user enables it on the Plugins page after
 * seeing what it asks for.
 */

export const MAX_PLUGIN_PACKAGE_BYTES = 50 * 1024 * 1024;

/** Same shape as the credential vault's adapter; the real one is `safeStorage`. */
export interface PluginSecretCrypto {
  available(): boolean;
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  dir: string;
  dataDir: string;
}

interface StateFile {
  version: 1;
  plugins: Record<string, { enabled: boolean; installedAt: number }>;
}

interface SettingsFile {
  values: Record<string, unknown>;
  secrets: Record<string, { enc: 'safeStorage' | 'none'; value: string }>;
}

export class PluginStoreError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'PluginStoreError';
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** The package's files with `manifest.json` at the root, unwrapping one top folder if that is how it was zipped. */
function rootPackageFiles(files: ZipFileEntry[]): ZipFileEntry[] {
  if (files.some((file) => file.path === PLUGIN_MANIFEST_FILE)) return files;
  const tops = new Set(files.map((file) => file.path.split('/')[0]));
  const [top] = tops;
  if (tops.size === 1 && top && files.some((f) => f.path === `${top}/${PLUGIN_MANIFEST_FILE}`)) {
    return files.map((file) => ({ ...file, path: file.path.slice(top.length + 1) }));
  }
  throw new PluginStoreError('plugin_package_invalid', `no ${PLUGIN_MANIFEST_FILE} at the root`);
}

export class PluginStore {
  constructor(
    private readonly root: string,
    private readonly crypto: PluginSecretCrypto,
    private readonly now: () => number = Date.now
  ) {}

  private get installedRoot(): string {
    return path.join(this.root, 'installed');
  }

  private get stateFile(): string {
    return path.join(this.root, 'state.json');
  }

  private settingsFile(id: string): string {
    return path.join(this.root, 'settings', `${id}.json`);
  }

  pluginDir(id: string): string {
    return path.join(this.installedRoot, id);
  }

  dataDir(id: string): string {
    return path.join(this.root, 'data', id);
  }

  get auditFile(): string {
    return path.join(this.root, 'audit.jsonl');
  }

  private readState(): StateFile {
    const state = readJson<StateFile>(this.stateFile, { version: 1, plugins: {} });
    return state?.plugins && typeof state.plugins === 'object'
      ? state
      : { version: 1, plugins: {} };
  }

  /** Installed plugins with a valid manifest; anything else is reported, not loaded. */
  list(): { plugins: InstalledPlugin[]; broken: Array<{ id: string; error: string }> } {
    const state = this.readState();
    const plugins: InstalledPlugin[] = [];
    const broken: Array<{ id: string; error: string }> = [];
    if (!existsSync(this.installedRoot)) return { plugins, broken };
    for (const id of readdirSync(this.installedRoot)) {
      if (id.startsWith('.')) continue;
      const dir = this.pluginDir(id);
      const parsed = parsePluginManifest(readJson(path.join(dir, PLUGIN_MANIFEST_FILE), null));
      if (!parsed.ok) {
        broken.push({ id, error: parsed.error });
        continue;
      }
      if (parsed.manifest.id !== id) {
        broken.push({ id, error: `manifest id ${parsed.manifest.id} does not match its folder` });
        continue;
      }
      plugins.push({
        manifest: parsed.manifest,
        enabled: state.plugins[id]?.enabled === true,
        dir,
        dataDir: this.dataDir(id),
      });
    }
    plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return { plugins, broken };
  }

  get(id: string): InstalledPlugin | undefined {
    return this.list().plugins.find((plugin) => plugin.manifest.id === id);
  }

  /** Unpack and validate a `.pilabplug`, replacing an installed copy of the same id. */
  installPackage(file: string): InstalledPlugin {
    const size = statSync(file).size;
    if (size > MAX_PLUGIN_PACKAGE_BYTES) {
      throw new PluginStoreError('plugin_package_invalid', 'package is larger than 50 MB');
    }
    let files: ZipFileEntry[];
    try {
      files = rootPackageFiles(readZip(readFileSync(file)));
    } catch (error) {
      if (error instanceof ZipError || error instanceof PluginStoreError) throw error;
      throw new PluginStoreError('plugin_package_invalid', String(error));
    }
    const manifestFile = files.find((entry) => entry.path === PLUGIN_MANIFEST_FILE);
    let raw: unknown;
    try {
      raw = JSON.parse(manifestFile?.data.toString('utf8') ?? '');
    } catch {
      throw new PluginStoreError('plugin_manifest_invalid', `${PLUGIN_MANIFEST_FILE} is not JSON`);
    }
    const parsed = parsePluginManifest(raw);
    if (!parsed.ok) throw new PluginStoreError('plugin_manifest_invalid', parsed.error);
    const { manifest } = parsed;
    if (!files.some((entry) => entry.path === manifest.main)) {
      throw new PluginStoreError(
        'plugin_manifest_invalid',
        `main ${manifest.main} is not in the package`
      );
    }

    mkdirSync(this.installedRoot, { recursive: true });
    const staging = path.join(this.installedRoot, `.staging-${manifest.id}-${this.now()}`);
    try {
      for (const entry of files) {
        const target = path.join(staging, ...entry.path.split('/'));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, entry.data);
      }
      const dir = this.pluginDir(manifest.id);
      const retired = path.join(this.installedRoot, `.retired-${manifest.id}-${this.now()}`);
      if (existsSync(dir)) renameSync(dir, retired);
      renameSync(staging, dir);
      rmSync(retired, { recursive: true, force: true });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    mkdirSync(this.dataDir(manifest.id), { recursive: true });

    const state = this.readState();
    state.plugins[manifest.id] = {
      enabled: state.plugins[manifest.id]?.enabled === true,
      installedAt: this.now(),
    };
    writeJsonAtomic(this.stateFile, state);
    const installed = this.get(manifest.id);
    if (!installed)
      throw new PluginStoreError('plugin_install_failed', 'installed copy did not read back');
    return installed;
  }

  uninstall(id: string): void {
    rmSync(this.pluginDir(id), { recursive: true, force: true });
    rmSync(this.dataDir(id), { recursive: true, force: true });
    rmSync(this.settingsFile(id), { force: true });
    const state = this.readState();
    delete state.plugins[id];
    writeJsonAtomic(this.stateFile, state);
  }

  setEnabled(id: string, enabled: boolean): void {
    if (!this.get(id)) throw new PluginStoreError('plugin_not_found', `no plugin ${id}`);
    const state = this.readState();
    state.plugins[id] = { installedAt: state.plugins[id]?.installedAt ?? this.now(), enabled };
    writeJsonAtomic(this.stateFile, state);
  }

  /** Every declared setting's value (default when unset), secrets decrypted. */
  readSettings(manifest: PluginManifest): Record<string, unknown> {
    const file = this.readSettingsFile(manifest.id);
    const values: Record<string, unknown> = {};
    for (const setting of manifest.contributes.settings) {
      if (setting.secret) {
        const stored = file.secrets[setting.key];
        values[setting.key] = stored ? this.decrypt(stored) : setting.default;
      } else {
        values[setting.key] =
          setting.key in file.values ? file.values[setting.key] : setting.default;
      }
    }
    return values;
  }

  /** For the Plugins page: a secret shows only whether it is set. */
  settingsView(manifest: PluginManifest): PluginSettingView[] {
    const file = this.readSettingsFile(manifest.id);
    return manifest.contributes.settings.map((setting) => ({
      setting,
      value: setting.secret
        ? setting.key in file.secrets
        : setting.key in file.values
          ? file.values[setting.key]
          : setting.default,
    }));
  }

  writeSetting(manifest: PluginManifest, key: string, value: unknown): void {
    const setting = manifest.contributes.settings.find((candidate) => candidate.key === key);
    if (!setting) throw new PluginStoreError('plugin_setting_unknown', `no setting ${key}`);
    const file = this.readSettingsFile(manifest.id);
    if (value === null || value === undefined) {
      delete file.values[key];
      delete file.secrets[key];
    } else {
      assertSettingValue(setting, value);
      if (setting.secret) {
        const text = String(value);
        file.secrets[key] = this.crypto.available()
          ? { enc: 'safeStorage', value: this.crypto.encrypt(text) }
          : { enc: 'none', value: text };
      } else file.values[key] = value;
    }
    writeJsonAtomic(this.settingsFile(manifest.id), file);
  }

  private readSettingsFile(id: string): SettingsFile {
    const file = readJson<Partial<SettingsFile>>(this.settingsFile(id), {});
    return {
      values: file.values && typeof file.values === 'object' ? file.values : {},
      secrets: file.secrets && typeof file.secrets === 'object' ? file.secrets : {},
    };
  }

  private decrypt(stored: { enc: string; value: string }): string | undefined {
    if (stored.enc === 'none') return stored.value;
    try {
      return this.crypto.decrypt(stored.value);
    } catch {
      return undefined;
    }
  }
}

function assertSettingValue(setting: PluginSettingContrib, value: unknown): void {
  const ok =
    (setting.type === 'string' && typeof value === 'string') ||
    (setting.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (setting.type === 'boolean' && typeof value === 'boolean') ||
    (setting.type === 'select' && (setting.options ?? []).some((option) => option.value === value));
  if (!ok) {
    throw new PluginStoreError('plugin_setting_invalid', `${setting.key} needs a ${setting.type}`);
  }
}
