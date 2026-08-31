#!/usr/bin/env node

/**
 * AiClient distributor-policy patch for @gotgenes/pi-permission-system@27.0.1.
 *
 * Upstream's <extensionRoot>/config.json is loaded only by the runtime-knob
 * ConfigStore; PermissionManager's FilePolicyLoader does not include it in the
 * enforcement ruleset. AiClient ships its baseline there so it stays below the
 * user's global/project/agent scopes and never writes ~/.pi. This patch adds an
 * explicit `bundled` policy scope to the real PermissionManager.
 *
 * Invoked by src/agent-host/package.json postinstall so every npm ci (dev/CI)
 * produces the same source tree that build-agent-host copies into the artifact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = process.env.AICLIENT_PI_PERMISSION_PACKAGE_ROOT
  ? path.resolve(process.env.AICLIENT_PI_PERMISSION_PACKAGE_ROOT)
  : path.join(repoRoot, 'src', 'agent-host', 'node_modules', '@gotgenes', 'pi-permission-system');
const manifestPath = path.join(packageRoot, 'package.json');

function fail(message) {
  throw new Error(`[patch-pi-permission-system] ${message}`);
}

if (!fs.existsSync(manifestPath)) fail(`package is missing at ${packageRoot}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.version !== '27.0.1') {
  fail(`expected 27.0.1, found ${String(manifest.version)}; re-audit and update the patch`);
}

function patch(relativePath, edits) {
  const file = path.join(packageRoot, relativePath);
  let source = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const { before, after, already } of edits) {
    if (source.includes(after) || (already && source.includes(already))) continue;
    const matches = source.split(before).length - 1;
    if (matches !== 1) fail(`${relativePath}: expected one patch anchor, found ${matches}`);
    source = source.replace(before, after);
    changed = true;
  }
  if (changed) fs.writeFileSync(file, source);
  return changed;
}

const cacheStampBefore = [
  '    return `',
  '$',
  '{getFileStamp(this.globalConfigPath)}|',
  '$',
  '{projectStamp}|',
  '$',
  '{agentStamp}|',
  '$',
  '{projectAgentStamp}`;',
].join('');
const cacheStampAfter = [
  '    const bundledStamp = this.bundledConfigPath\n',
  '      ? getFileStamp(this.bundledConfigPath)\n',
  '      : "none";\n',
  '    return `',
  '$',
  '{bundledStamp}|',
  '$',
  '{getFileStamp(this.globalConfigPath)}|',
  '$',
  '{projectStamp}|',
  '$',
  '{agentStamp}|',
  '$',
  '{projectAgentStamp}`;',
].join('');

const changed = [];

if (
  patch('src/rule.ts', [
    {
      before: 'export type RuleOrigin =\n  | "global"',
      after: 'export type RuleOrigin =\n  | "bundled"\n  | "global"',
    },
  ])
)
  changed.push('src/rule.ts');

if (
  patch('src/policy-loader.ts', [
    {
      before: 'export interface ResolvedPolicyPaths {\n  globalConfigPath: string;',
      after:
        'export interface ResolvedPolicyPaths {\n  bundledConfigPath: string | null;\n  bundledConfigExists: boolean;\n  globalConfigPath: string;',
    },
    {
      before: 'export interface PolicyLoader {\n  loadGlobalConfig(): ScopeConfig;',
      after:
        'export interface PolicyLoader {\n  loadBundledConfig(): ScopeConfig;\n  loadGlobalConfig(): ScopeConfig;',
    },
    {
      before: 'export interface PolicyLoaderOptions {\n  globalConfigPath?: string;',
      after:
        'export interface PolicyLoaderOptions {\n  bundledConfigPath?: string;\n  globalConfigPath?: string;',
    },
    {
      before:
        'export class FilePolicyLoader implements PolicyLoader {\n  private readonly globalConfigPath: string;',
      after:
        'export class FilePolicyLoader implements PolicyLoader {\n  private readonly bundledConfigPath: string | null;\n  private readonly globalConfigPath: string;',
    },
    {
      before: '  private globalConfigCache: FileCacheEntry<ScopeConfig> | null = null;',
      after:
        '  private bundledConfigCache: FileCacheEntry<ScopeConfig> | null = null;\n  private globalConfigCache: FileCacheEntry<ScopeConfig> | null = null;',
    },
    {
      before: '  constructor(options: PolicyLoaderOptions = {}) {\n    this.globalConfigPath =',
      after:
        '  constructor(options: PolicyLoaderOptions = {}) {\n    this.bundledConfigPath = options.bundledConfigPath ?? null;\n    this.globalConfigPath =',
    },
    {
      before: '\n  loadGlobalConfig(): ScopeConfig {',
      after:
        '\n  loadBundledConfig(): ScopeConfig {\n    if (!this.bundledConfigPath) return {};\n    const stamp = getFileStamp(this.bundledConfigPath);\n    if (this.bundledConfigCache?.stamp === stamp) {\n      return this.bundledConfigCache.value;\n    }\n    const { config, issues } = loadUnifiedConfig(this.bundledConfigPath);\n    this.accumulateConfigIssues(issues);\n    const value: ScopeConfig = { permission: config.permission };\n    this.bundledConfigCache = { stamp, value };\n    return value;\n  }\n\n  loadGlobalConfig(): ScopeConfig {',
      already: '\n  loadBundledConfig(): ScopeConfig {',
    },
    {
      before:
        '    const value: ScopeConfig = { permission: config.permission };\n    this.bundledConfigCache = { stamp, value };',
      after:
        '    const value: ScopeConfig = {\n      permission: config.permission,\n      ...(issues.length > 0 ? { invalid: true } : {}),\n    };\n    this.bundledConfigCache = { stamp, value };',
    },
    {
      before:
        '    const value: ScopeConfig = {\n      permission: config.permission,\n    };\n\n    this.globalConfigCache = { stamp, value };',
      after:
        '    const value: ScopeConfig = {\n      permission: config.permission,\n      ...(issues.length > 0 ? { invalid: true } : {}),\n    };\n\n    this.globalConfigCache = { stamp, value };',
    },
    {
      before: cacheStampBefore,
      after: cacheStampAfter,
    },
    {
      before: '    return {\n      globalConfigPath: this.globalConfigPath,',
      after:
        '    return {\n      bundledConfigPath: this.bundledConfigPath,\n      bundledConfigExists: this.bundledConfigPath\n        ? existsSync(this.bundledConfigPath)\n        : false,\n      globalConfigPath: this.globalConfigPath,',
    },
  ])
)
  changed.push('src/policy-loader.ts');

if (
  patch('src/permission-manager.ts', [
    {
      before:
        'export class PermissionManager implements ScopedPermissionManager {\n  private readonly agentDir: string | undefined;',
      after:
        'export class PermissionManager implements ScopedPermissionManager {\n  private readonly agentDir: string | undefined;\n  private readonly bundledConfigPath: string | undefined;',
    },
    {
      before:
        '  constructor(options: PermissionManagerOptions = {}) {\n    this.agentDir = options.agentDir;',
      after:
        '  constructor(options: PermissionManagerOptions = {}) {\n    this.agentDir = options.agentDir;\n    this.bundledConfigPath = options.bundledConfigPath;',
    },
    {
      before:
        '          ? derivePolicyLoaderOptions(options.agentDir, undefined)\n          : options,',
      after:
        '          ? derivePolicyLoaderOptions(\n              options.agentDir,\n              undefined,\n              options.bundledConfigPath,\n            )\n          : options,',
    },
    {
      before: '        derivePolicyLoaderOptions(this.agentDir, cwd),',
      after:
        '        derivePolicyLoaderOptions(\n          this.agentDir,\n          cwd,\n          this.bundledConfigPath,\n        ),',
    },
    {
      before: '    const globalConfig = this.loader.loadGlobalConfig();',
      after:
        '    const bundledConfig = this.loader.loadBundledConfig();\n    const globalConfig = this.loader.loadGlobalConfig();',
    },
    {
      before:
        '    const { mergedPermission, origins } = mergeScopesWithOrigins([\n      ["global", globalConfig],',
      after:
        '    const { mergedPermission, origins } = mergeScopesWithOrigins([\n      ["bundled", bundledConfig],\n      ["global", globalConfig],',
    },
    {
      before:
        '    const failClosedScopes: RuleOrigin[] = [];\n    if (projectConfig.invalid === true) failClosedScopes.push("project");',
      after:
        '    const failClosedScopes: RuleOrigin[] = [];\n    if (bundledConfig.invalid === true) failClosedScopes.push("bundled");\n    if (globalConfig.invalid === true) failClosedScopes.push("global");\n    if (projectConfig.invalid === true) failClosedScopes.push("project");',
    },
    {
      before:
        'function derivePolicyLoaderOptions(\n  agentDir: string,\n  cwd: string | undefined | null,\n): PolicyLoaderOptions {\n  return {\n    globalConfigPath:',
      after:
        'function derivePolicyLoaderOptions(\n  agentDir: string,\n  cwd: string | undefined | null,\n  bundledConfigPath?: string,\n): PolicyLoaderOptions {\n  return {\n    bundledConfigPath,\n    globalConfigPath:',
    },
  ])
)
  changed.push('src/permission-manager.ts');

if (
  patch('src/index.ts', [
    {
      before: 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      after:
        'import { join } from "node:path";\nimport type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    },
    {
      before: 'import { isYoloModeEnabled } from "./extension-config";',
      after: 'import { EXTENSION_ROOT, isYoloModeEnabled } from "./extension-config";',
    },
    {
      before: '  const permissionManager = new PermissionManager({\n    agentDir,',
      after:
        '  const permissionManager = new PermissionManager({\n    agentDir,\n    bundledConfigPath: join(EXTENSION_ROOT, "config.json"),',
    },
  ])
)
  changed.push('src/index.ts');

console.log(
  changed.length > 0
    ? `[patch-pi-permission-system] patched ${changed.join(', ')}`
    : '[patch-pi-permission-system] already applied'
);
