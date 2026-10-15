/**
 * Arms and variants (docs/agent-project-engineering.md §6). An arm is a client,
 * optionally under a variant: `pilab`, `claude-code`, `pilab+prompt-pack`.
 * A variant names its client and what it overrides; `variants/<name>.json`
 * resolves by name, anything else as a path.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Arm, ClientName, FileSource, LoadedVariant, VariantFile } from './types.ts';

const CLIENTS: readonly ClientName[] = ['pilab', 'claude-code'];

function isClient(value: unknown): value is ClientName {
  return CLIENTS.includes(value as ClientName);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function resolveFiles(
  files: Record<string, FileSource> | undefined,
  dir: string,
  where: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, source] of Object.entries(files ?? {})) {
    if (name.includes('..') || /^[\\/]|^[A-Za-z]:/.test(name)) {
      throw new Error(`${where}: ${name} must be a relative path inside the directory`);
    }
    if (typeof source === 'string') out[name] = source;
    else if (typeof source?.file === 'string')
      out[name] = readFileSync(join(dir, source.file), 'utf8');
    else throw new Error(`${where}: ${name} must be a string or {"file": "..."}`);
  }
  return out;
}

export function loadVariant(spec: string, variantsDir: string): LoadedVariant {
  const byName = join(variantsDir, `${spec}.json`);
  const file = existsSync(byName) ? byName : resolve(spec);
  if (!existsSync(file)) throw new Error(`variant ${spec}: neither ${byName} nor ${file} exists`);
  const bytes = readFileSync(file);
  const raw = JSON.parse(bytes.toString('utf8')) as VariantFile;
  if (typeof raw.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.name)) {
    throw new Error(`${file}: name must match [A-Za-z0-9][A-Za-z0-9._-]*`);
  }
  if (!isClient(raw.client)) throw new Error(`${file}: client must be pilab or claude-code`);
  if (raw.env !== undefined && !isStringRecord(raw.env))
    throw new Error(`${file}: env values must be strings`);
  if (
    raw.args !== undefined &&
    !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string'))
  ) {
    throw new Error(`${file}: args must be an array of strings`);
  }
  const dir = dirname(file);
  const resolvedFiles = {
    dshHome: resolveFiles(raw.dshHomeFiles, dir, `${file} dshHomeFiles`),
    agentDir: resolveFiles(raw.agentDirFiles, dir, `${file} agentDirFiles`),
    config: resolveFiles(raw.configFiles, dir, `${file} configFiles`),
  };
  // The hash covers what the variant does, referenced files included.
  const sha256 = createHash('sha256')
    .update(bytes)
    .update(JSON.stringify(resolvedFiles))
    .digest('hex');
  return { ...raw, file, sha256, resolvedFiles };
}

/** `pilab,claude-code,pilab+prompt-pack` -> arms, each variant loaded and checked against its client. */
export function parseArms(spec: string, variantsDir: string): Arm[] {
  const arms: Arm[] = [];
  for (const part of spec
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const plus = part.indexOf('+');
    const client = plus < 0 ? part : part.slice(0, plus);
    if (!isClient(client)) throw new Error(`arm ${part}: client must be pilab or claude-code`);
    if (plus < 0) {
      arms.push({ id: client, client });
      continue;
    }
    const variant = loadVariant(part.slice(plus + 1), variantsDir);
    if (variant.client !== client) {
      throw new Error(`arm ${part}: variant ${variant.name} is for ${variant.client}`);
    }
    arms.push({ id: `${client}+${variant.name}`, client, variant });
  }
  if (arms.length === 0) throw new Error('no arms');
  const ids = arms.map((arm) => arm.id);
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate arms in ${spec}`);
  return arms;
}
