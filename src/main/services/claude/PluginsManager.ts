import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AvailablePlugin, InstalledPlugin, Plugin, PluginMarketplace } from '@shared/types';
import { execInPty } from '../../utils/shell';
import { writeSettingsFile } from '../auth/managedFileWriter';

/** D47 S2a §1: follows `CLAUDE_CONFIG_DIR` when set (managed redirect). */
function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function getPluginsDir(): string {
  return path.join(getClaudeConfigDir(), 'plugins');
}

function getSettingsPath(): string {
  return path.join(getClaudeConfigDir(), 'settings.json');
}

function getInstalledPluginsPath(): string {
  return path.join(getPluginsDir(), 'installed_plugins.json');
}

function getKnownMarketplacesPath(): string {
  return path.join(getPluginsDir(), 'known_marketplaces.json');
}

interface InstalledPluginsJson {
  version: number;
  plugins: Record<string, InstalledPlugin[]>;
}

interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
}

/**
 * 读取已安装的插件
 */
function readInstalledPlugins(): InstalledPluginsJson {
  try {
    const filePath = getInstalledPluginsPath();
    if (!fs.existsSync(filePath)) {
      return { version: 2, plugins: {} };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as InstalledPluginsJson;
  } catch (error) {
    console.error('[PluginsManager] Failed to read installed_plugins.json:', error);
    return { version: 2, plugins: {} };
  }
}

/**
 * 读取 Claude settings
 */
function readSettings(): ClaudeSettings {
  try {
    const filePath = getSettingsPath();
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as ClaudeSettings;
  } catch (error) {
    console.error('[PluginsManager] Failed to read settings.json:', error);
    return {};
  }
}

/**
 * 写入 Claude settings（D47 S2a §1：改走 managedFileWriter 唯一入口）
 */
async function writeSettings(data: ClaudeSettings): Promise<boolean> {
  try {
    const filePath = getSettingsPath();
    await writeSettingsFile(filePath, () => data);
    return true;
  } catch (error) {
    console.error('[PluginsManager] Failed to write settings.json:', error);
    return false;
  }
}

/**
 * 获取所有插件列表
 */
export function getPlugins(): Plugin[] {
  const installed = readInstalledPlugins();
  const settings = readSettings();
  const enabledPlugins = settings.enabledPlugins ?? {};

  const plugins: Plugin[] = [];

  for (const [pluginId, installations] of Object.entries(installed.plugins)) {
    // 取第一个安装（通常是 user scope）
    const installation = installations[0];
    if (!installation) continue;

    // 解析插件 ID：name@marketplace
    const [name, marketplace] = pluginId.split('@');

    plugins.push({
      id: pluginId,
      name: name ?? pluginId,
      marketplace: marketplace ?? 'unknown',
      version: installation.version,
      installPath: installation.installPath,
      enabled: enabledPlugins[pluginId] ?? false,
      installedAt: installation.installedAt,
      lastUpdated: installation.lastUpdated,
    });
  }

  return plugins;
}

/**
 * 设置插件启用状态
 */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<boolean> {
  const settings = readSettings();

  if (!settings.enabledPlugins) {
    settings.enabledPlugins = {};
  }

  settings.enabledPlugins[pluginId] = enabled;

  const success = await writeSettings(settings);

  if (success) {
    console.log(`[PluginsManager] Plugin ${pluginId} ${enabled ? 'enabled' : 'disabled'}`);
  }

  return success;
}

/**
 * 获取插件启用状态
 */
export function getEnabledPlugins(): Record<string, boolean> {
  const settings = readSettings();
  return settings.enabledPlugins ?? {};
}

interface KnownMarketplacesJson {
  [name: string]: {
    source: {
      source: string;
      repo: string;
    };
    installLocation: string;
    lastUpdated: string;
  };
}

/**
 * 读取已知的 marketplaces
 */
function readKnownMarketplaces(): KnownMarketplacesJson {
  try {
    const filePath = getKnownMarketplacesPath();
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as KnownMarketplacesJson;
  } catch (error) {
    console.error('[PluginsManager] Failed to read known_marketplaces.json:', error);
    return {};
  }
}

/**
 * 获取所有 marketplaces
 */
export function getMarketplaces(): PluginMarketplace[] {
  const known = readKnownMarketplaces();

  return Object.entries(known).map(([name, data]) => ({
    name,
    repo: data.source.repo,
    installLocation: data.installLocation,
    lastUpdated: data.lastUpdated,
  }));
}

/**
 * 添加 marketplace（调用 Claude CLI）
 */
export async function addMarketplace(source: string): Promise<boolean> {
  try {
    const cmd = `claude plugin marketplace add "${source}"`;
    console.log(`[PluginsManager] Running: ${cmd}`);
    const stdout = await execInPty(cmd);

    if (stdout) console.log(`[PluginsManager] ${stdout}`);

    console.log(`[PluginsManager] Marketplace added: ${source}`);
    return true;
  } catch (error) {
    console.error('[PluginsManager] Failed to add marketplace:', error);
    return false;
  }
}

/**
 * 删除 marketplace（调用 Claude CLI）
 */
export async function removeMarketplace(name: string): Promise<boolean> {
  try {
    const cmd = `claude plugin marketplace remove "${name}"`;
    console.log(`[PluginsManager] Running: ${cmd}`);
    const stdout = await execInPty(cmd, { timeout: 30000 });

    if (stdout) console.log(`[PluginsManager] ${stdout}`);

    console.log(`[PluginsManager] Marketplace removed: ${name}`);
    return true;
  } catch (error) {
    console.error('[PluginsManager] Failed to remove marketplace:', error);
    return false;
  }
}

/**
 * 刷新 marketplaces（调用 Claude CLI）
 */
export async function refreshMarketplaces(name?: string): Promise<boolean> {
  try {
    const cmd = name
      ? `claude plugin marketplace update "${name}"`
      : 'claude plugin marketplace update';

    console.log(`[PluginsManager] Running: ${cmd}`);
    const stdout = await execInPty(cmd);

    if (stdout) console.log(`[PluginsManager] ${stdout}`);

    console.log(`[PluginsManager] Marketplaces refreshed`);
    return true;
  } catch (error) {
    console.error('[PluginsManager] Failed to refresh marketplaces:', error);
    return false;
  }
}

interface PluginJson {
  name: string;
  description?: string;
  version?: string;
  author?: {
    name?: string;
    email?: string;
  };
}

interface MarketplaceJson {
  name: string;
  description?: string;
  plugins?: Array<{
    name: string;
    description?: string;
    author?: {
      name?: string;
      email?: string;
    };
  }>;
}

/**
 * 扫描 marketplace 中可用的插件
 */
export function getAvailablePlugins(marketplaceName?: string): AvailablePlugin[] {
  const marketplaces = readKnownMarketplaces();
  const installed = readInstalledPlugins();
  const installedIds = new Set(Object.keys(installed.plugins));

  const plugins: AvailablePlugin[] = [];

  const marketplaceEntries = marketplaceName
    ? Object.entries(marketplaces).filter(([name]) => name === marketplaceName)
    : Object.entries(marketplaces);

  for (const [mpName, mpData] of marketplaceEntries) {
    // 方式 1: 检查 marketplace.json（如 claude-plugins-official）
    const marketplaceJsonPath = path.join(
      mpData.installLocation,
      '.claude-plugin',
      'marketplace.json'
    );

    if (fs.existsSync(marketplaceJsonPath)) {
      try {
        const content = fs.readFileSync(marketplaceJsonPath, 'utf-8');
        const mpJson = JSON.parse(content) as MarketplaceJson;

        if (mpJson.plugins) {
          for (const plugin of mpJson.plugins) {
            const pluginId = `${plugin.name}@${mpName}`;
            plugins.push({
              name: plugin.name,
              description: plugin.description,
              author: plugin.author,
              marketplace: mpName,
              installed: installedIds.has(pluginId),
            });
          }
        }
        continue;
      } catch (err) {
        console.warn(`[PluginsManager] Failed to read marketplace.json for ${mpName}:`, err);
      }
    }

    // 方式 2: 扫描根目录的 plugin.json（整个 repo 是一个插件）
    const rootPluginJsonPath = path.join(mpData.installLocation, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(rootPluginJsonPath)) {
      try {
        const content = fs.readFileSync(rootPluginJsonPath, 'utf-8');
        const pluginJson = JSON.parse(content) as PluginJson;
        const pluginId = `${pluginJson.name}@${mpName}`;

        plugins.push({
          name: pluginJson.name,
          description: pluginJson.description,
          author: pluginJson.author,
          marketplace: mpName,
          installed: installedIds.has(pluginId),
        });
        continue;
      } catch (err) {
        console.warn(`[PluginsManager] Failed to read root plugin.json for ${mpName}:`, err);
      }
    }

    // 方式 3: 扫描子目录中的 plugin.json（如 nowledge-community）
    try {
      const dirs = fs.readdirSync(mpData.installLocation, { withFileTypes: true });

      for (const dir of dirs) {
        if (!dir.isDirectory() || dir.name.startsWith('.')) continue;

        // 检查 dir/plugin.json
        const pluginJsonPath = path.join(mpData.installLocation, dir.name, 'plugin.json');
        if (fs.existsSync(pluginJsonPath)) {
          try {
            const content = fs.readFileSync(pluginJsonPath, 'utf-8');
            const pluginJson = JSON.parse(content) as PluginJson;
            const pluginId = `${pluginJson.name}@${mpName}`;

            plugins.push({
              name: pluginJson.name,
              description: pluginJson.description,
              author: pluginJson.author,
              marketplace: mpName,
              installed: installedIds.has(pluginId),
            });
          } catch (err) {
            console.warn(`[PluginsManager] Failed to read plugin.json for ${dir.name}:`, err);
          }
        }
      }
    } catch (err) {
      console.warn(`[PluginsManager] Failed to scan directory for ${mpName}:`, err);
    }
  }

  return plugins;
}

/**
 * 安装插件（调用 Claude CLI）
 */
export async function installPlugin(pluginName: string, marketplace?: string): Promise<boolean> {
  try {
    const pluginSpec = marketplace ? `${pluginName}@${marketplace}` : pluginName;
    const cmd = `claude plugin install "${pluginSpec}"`;

    console.log(`[PluginsManager] Running: ${cmd}`);
    const stdout = await execInPty(cmd, { timeout: 120000 });

    if (stdout) console.log(`[PluginsManager] ${stdout}`);

    console.log(`[PluginsManager] Plugin installed: ${pluginSpec}`);
    return true;
  } catch (error) {
    console.error('[PluginsManager] Failed to install plugin:', error);
    return false;
  }
}

/**
 * 卸载插件（调用 Claude CLI）
 */
export async function uninstallPlugin(pluginId: string): Promise<boolean> {
  try {
    const cmd = `claude plugin uninstall "${pluginId}"`;

    console.log(`[PluginsManager] Running: ${cmd}`);
    const stdout = await execInPty(cmd, { timeout: 30000 });

    if (stdout) console.log(`[PluginsManager] ${stdout}`);

    console.log(`[PluginsManager] Plugin uninstalled: ${pluginId}`);
    return true;
  } catch (error) {
    console.error('[PluginsManager] Failed to uninstall plugin:', error);
    return false;
  }
}
