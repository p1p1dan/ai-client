// config.ts — Path constants, configuration types, and time helpers.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveRoot(): string {
  let dir = __dirname;
  // config.json is the anchor: `vflow init` always writes it to .vflow/, whereas
  // repo.json is created lazily on first CLI run. Keying off repo.json too caused
  // a chicken-and-egg miss on the very first run — ROOT fell through to
  // .vflow/scripts/, so repo.json + proposals/ were then created there, splitting
  // config and repo across two directories permanently. Anchor on config.json so
  // the root is stable from the first invocation.
  for (let i = 0; i < 5; i++) {
    const parent = dirname(dir);
    if (existsSync(join(parent, 'config.json'))) {
      return parent;
    }
    dir = parent;
  }
  return dirname(dirname(__dirname));
}

export const ROOT = resolveRoot();
export const SCRIPTS_DIR = join(ROOT, 'scripts');
export const PROJECT_ROOT = dirname(ROOT);
export const PROPOSALS_DIR = join(ROOT, 'proposals');
export const ARCHIVE_DIR = join(PROPOSALS_DIR, 'archive');
export const RUNTIME_DIR = join(ROOT, 'runtime');
export const SESSIONS_DIR = join(RUNTIME_DIR, 'sessions');
export const KNOWLEDGE_DIR = join(ROOT, 'knowledge');
export const SPEC_DIR = join(ROOT, 'spec');
export const CONFIG_PATH = join(ROOT, 'config.json');
export const REPO_INDEX_PATH = join(ROOT, 'repo.json');
export const WORKFLOW_PATH = join(ROOT, 'workflow.md');

export interface VflowConfig {
  schema_version: number;
  project: string;
  language: string;
  enabled: boolean;
  test_required: boolean;
  build: { command: string; test_command: string };
  features: Record<string, boolean>;
}

export function readJson<T = unknown>(path: string, defaultVal: T | null = null): T | null {
  if (!existsSync(path)) return defaultVal;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (e) {
    console.error(`WARNING: corrupt JSON in ${path}: ${(e as Error).message}`);
    return defaultVal;
  }
}

export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

export function loadConfig(): VflowConfig {
  return readJson<VflowConfig>(CONFIG_PATH, {} as VflowConfig) ?? ({} as VflowConfig);
}

export function isoNow(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().replace(/\.\d{3}Z$/, '');
}

export function isoToday(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

export function yearMonth(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mm}`;
}

export function todayCompact(): string {
  return isoToday().replace(/-/g, '');
}
