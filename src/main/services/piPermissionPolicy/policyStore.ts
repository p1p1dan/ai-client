/**
 * T08-c slice 2 — reading and writing permission-policy scope files.
 *
 * Split from `index.ts` so it can be tested against a real temp directory
 * without pulling in Electron: everything here takes explicit paths and touches
 * nothing else. `index.ts` is the thin part that knows which paths those are.
 *
 * ## The one rule this module enforces structurally
 *
 * It writes ONE path, the one the caller hands it, and it never invents a
 * parent. The T08-a red line — we do not write the user's own `~/.pi`, because
 * that directory belongs to their `pi` CLI and editing it would change a tool we
 * do not own — is enforced by the caller choosing what to pass; keeping this
 * module path-agnostic is what makes that choice reviewable in one place.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  isEmptyPolicyDocument,
  isJsonObject,
  type JsonObject,
  type PolicyScope,
  type PolicyScopeId,
  parsePermissionConfig,
  serializePolicyDocument,
} from '@shared/piPermissionPolicy';

export interface ScopeLocation {
  id: PolicyScopeId;
  path: string;
  /**
   * Set when this scope must be READ for display but excluded from the merge —
   * an untrusted project (D11 decision 4). Reading it anyway is deliberate:
   * "your repository ships a policy and it is being ignored" is the single most
   * useful thing this panel can tell someone on the managed route.
   */
  withheldReason?: string;
}

/**
 * Read one scope file.
 *
 * A missing file is normal and is not an error. A file that exists but does not
 * parse IS reported, and is excluded from the merge — which mirrors the
 * enforcer, whose parser also refuses trailing commas and falls back rather than
 * guessing.
 */
export function readScope(location: ScopeLocation): PolicyScope {
  const base = {
    id: location.id,
    path: location.path,
    ...(location.withheldReason ? { withheldReason: location.withheldReason } : {}),
  };
  if (!existsSync(location.path)) {
    return { ...base, present: false, config: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(location.path, 'utf8'));
  } catch (error) {
    return {
      ...base,
      present: true,
      config: {},
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  const { config, issues } = parsePermissionConfig(raw);
  return { ...base, present: true, config, ...(issues.length > 0 ? { issues } : {}) };
}

export function readScopes(locations: readonly ScopeLocation[]): PolicyScope[] {
  return locations.map(readScope);
}

/**
 * The scope file as a raw JSON object, for patching.
 *
 * Anything unreadable comes back as `{}` — a patch applied on top of an
 * unparseable file replaces it, which is the only outcome that lets a user
 * recover from a broken hand edit through the UI instead of a text editor.
 */
export function readRawDocument(path: string): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist a scope document, creating the directory when needed.
 *
 * An empty document DELETES the file rather than writing `{}`. An empty config
 * and no config are the same policy, but they are not the same thing on screen:
 * a file that exists makes the panel report a scope that says nothing, and makes
 * "reset to default" leave a trace that looks like a setting.
 */
export function writeScopeDocument(path: string, document: JsonObject): void {
  if (isEmptyPolicyDocument(document)) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializePolicyDocument(document));
}
