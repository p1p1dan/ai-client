/**
 * P5-2-1 — where definitions come from, and how a pin becomes a model.
 *
 * Provenance: the discovery and merge behaviour is PI-Desktop's
 * `packages/agent-runtime/src/subagent-definitions.ts` at `948ee676`. Two parts
 * of it do not survive the move, both for reasons recorded in
 * `topics/p5-2-0-baseline.md`:
 *
 * 1. **The directory is `<agentDir>/subagents`, not `~/.agents/subagents`.**
 *    H/19 (the unified agent directory, landed 2026-09-10) makes the app's own
 *    agent directory the one home for user resources, and P5-1 already put
 *    skills and prompt templates there. `~/.agents/subagents` is still read as
 *    a compatibility root, exactly as P5-1 still reads `~/.agents/skills`.
 *    Project directories are never scanned: a repository must not be able to
 *    add a delegate to the user's catalog by being opened.
 * 2. **Pin resolution is local.** The reference had to ask Electron main to
 *    turn a pin into a provider binding, because its model catalog lived in
 *    another process and every pin meant a new client in the sidecar. Our
 *    model adapter already holds the whole bound catalog in this process, so a
 *    pin is a lookup. What survives unchanged is the rule that matters: an
 *    unresolvable pin resolves to NOTHING rather than to the session model. A
 *    definition that asks for a cheap model must never silently spend the
 *    expensive one.
 *
 * Reading goes through the host IO port, not `node:fs` — ARD D11 point 4, the
 * same constraint that made the skills loader a reimplementation rather than a
 * call into pi.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeFileKind, RuntimeModelRef } from '../../contracts.ts';
import { BUILTIN_SUBAGENT_DOCUMENTS } from './builtins.ts';
import {
  MAX_SUBAGENT_DOCUMENT_BYTES,
  mergeSubagentDefinitions,
  parseSubagentDefinition,
  type SubagentDefinition,
  type SubagentModelPin,
  subagentModelKey,
  subagentPinnedProviders,
} from './definition.ts';

/**
 * The file access this module needs, and nothing more.
 *
 * Both answer `undefined` for the expected absence — no subagents directory is
 * the normal case, not an error worth failing a turn over. Unexpected host
 * failures still propagate: on the encrypted target a transport fault must not
 * read as "the user has no delegates".
 */
export interface SubagentDocumentSource {
  readText(path: string): Promise<string | undefined>;
  list(path: string): Promise<readonly { name: string; kind: RuntimeFileKind }[] | undefined>;
}

export type SubagentDiagnosticCode =
  | 'read_failed'
  | 'parse_failed'
  | 'document_too_large'
  | 'too_many'
  | 'builtin_invalid'
  | 'stale_activation';

export interface SubagentDiagnostic {
  code: SubagentDiagnosticCode;
  message: string;
  path: string;
}

export interface SubagentCatalogConfig {
  /** Managed agent directory; supplies `<agentDir>/subagents`. */
  agentDir?: string | null;
  /** Overridable for tests, which must never touch the developer's real home. */
  home?: string;
}

/**
 * Directories scanned, in precedence order (earlier wins a name clash).
 *
 * No project root appears here, and that is a security property rather than an
 * omission: see the module note.
 */
export function subagentRoots(config: SubagentCatalogConfig): readonly string[] {
  const roots: string[] = [];
  if (config.agentDir) roots.push(join(config.agentDir, 'subagents'));
  roots.push(join(config.home ?? homedir(), '.agents', 'subagents'));
  return roots;
}

/** Parsed builtins. Rebuilt per call so a bad constant surfaces as a
 * diagnostic in exactly the way a bad user document does. */
function builtinDefinitions(): {
  definitions: SubagentDefinition[];
  diagnostics: SubagentDiagnostic[];
} {
  const definitions: SubagentDefinition[] = [];
  const diagnostics: SubagentDiagnostic[] = [];
  for (const raw of BUILTIN_SUBAGENT_DOCUMENTS) {
    const parsed = parseSubagentDefinition(raw, { source: 'builtin' });
    if (parsed.ok) definitions.push(parsed.definition);
    else
      diagnostics.push({
        code: 'builtin_invalid',
        message: `builtin subagent invalid: ${parsed.errors.join('; ')}`,
        path: '<builtin>',
      });
  }
  return { definitions, diagnostics };
}

async function loadRoot(
  source: SubagentDocumentSource,
  root: string
): Promise<{ definitions: SubagentDefinition[]; diagnostics: SubagentDiagnostic[] }> {
  const definitions: SubagentDefinition[] = [];
  const diagnostics: SubagentDiagnostic[] = [];
  const entries = await source.list(root);
  if (!entries) return { definitions, diagnostics };
  // Sorted so two documents that would collide resolve the same way on every
  // machine; directory order is not a contract any filesystem makes.
  const names = entries
    .filter((entry) => entry.kind === 'file' && /\.md$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const filePath = join(root, name);
    let raw: string | undefined;
    try {
      raw = await source.readText(filePath);
    } catch (error) {
      diagnostics.push({
        code: 'read_failed',
        message: `unreadable (${error instanceof Error ? error.message : String(error)})`,
        path: filePath,
      });
      continue;
    }
    if (raw === undefined) continue;
    if (Buffer.byteLength(raw, 'utf8') > MAX_SUBAGENT_DOCUMENT_BYTES) {
      diagnostics.push({
        code: 'document_too_large',
        message: `document exceeds ${MAX_SUBAGENT_DOCUMENT_BYTES} bytes; it is a prompt, not a definition`,
        path: filePath,
      });
      continue;
    }
    const parsed = parseSubagentDefinition(raw, {
      source: 'user',
      fallbackName: name,
      filePath,
    });
    for (const warning of parsed.warnings)
      diagnostics.push({ code: 'parse_failed', message: warning, path: filePath });
    if (parsed.ok) definitions.push(parsed.definition);
    else
      diagnostics.push({
        code: 'parse_failed',
        message: parsed.errors.join('; '),
        path: filePath,
      });
  }
  return { definitions, diagnostics };
}

export interface SubagentCatalog {
  definitions: readonly SubagentDefinition[];
  diagnostics: readonly SubagentDiagnostic[];
}

/**
 * Definitions offered to a session: the user's documents, then the builtins.
 *
 * Load failures degrade to diagnostics. One malformed document must not cost
 * the session its other delegates, let alone its turn.
 */
export async function loadSubagentCatalog(
  source: SubagentDocumentSource,
  config: SubagentCatalogConfig
): Promise<SubagentCatalog> {
  const builtin = builtinDefinitions();
  const userDefinitions: SubagentDefinition[] = [];
  const diagnostics: SubagentDiagnostic[] = [];
  for (const root of subagentRoots(config)) {
    const loaded = await loadRoot(source, root);
    userDefinitions.push(...loaded.definitions);
    diagnostics.push(...loaded.diagnostics);
  }
  const merged = mergeSubagentDefinitions([...userDefinitions, ...builtin.definitions]);
  diagnostics.push(...builtin.diagnostics);
  if (merged.dropped.length > 0) {
    diagnostics.push({
      code: 'too_many',
      message: `dropped past the catalog cap: ${merged.dropped.join(', ')}`,
      path: '<catalog>',
    });
  }
  return { definitions: merged.definitions, diagnostics };
}

/**
 * Apply the user's enable/disable choices to a loaded catalog.
 *
 * Enablement lives in app data, keyed by definition name, and is never written
 * into the Markdown: the document is a shareable artifact, the switch is this
 * install's state. Disabled names that match nothing are reported so the caller
 * can drop them — otherwise a renamed definition leaves a tombstone that
 * silently disables a future definition that happens to reuse the name.
 */
export function applySubagentActivation(
  catalog: SubagentCatalog,
  disabled: Iterable<string>
): { definitions: readonly SubagentDefinition[]; stale: readonly string[] } {
  const disabledSet = new Set(disabled);
  const known = new Set(catalog.definitions.map((definition) => definition.name));
  return {
    definitions: catalog.definitions.filter((definition) => !disabledSet.has(definition.name)),
    stale: [...disabledSet].filter((name) => !known.has(name)),
  };
}

/**
 * Turn a definition's pin into a catalog ref, or nothing.
 *
 * Exact provider/model first, then a case-insensitive match, because a pin is
 * hand-written in a Markdown file and `Anthropic/...` should not be a silent
 * miss. Nothing looser than that: guessing which model a near-miss meant is how
 * a delegate ends up on a model the user did not pick.
 */
export function resolveSubagentPin(
  pin: SubagentModelPin,
  available: readonly RuntimeModelRef[]
): RuntimeModelRef | undefined {
  const exact = available.find((ref) => ref.provider === pin.provider && ref.id === pin.modelId);
  if (exact) return exact;
  const provider = pin.provider.toLowerCase();
  const modelId = pin.modelId.toLowerCase();
  return available.find(
    (ref) => ref.provider.toLowerCase() === provider && ref.id.toLowerCase() === modelId
  );
}

/**
 * Report pins that cannot be honoured, before a delegate is ever started.
 *
 * Two distinct failures, kept distinct: a pin whose provider is past the cap
 * (the definition set names too many providers) and a pin that names nothing in
 * the catalog. Both leave the definition loaded and usable for everything else;
 * `Task` is where the model is told, because that is where the choice is made.
 */
export function subagentPinDiagnostics(
  definitions: readonly SubagentDefinition[],
  available: readonly RuntimeModelRef[]
): SubagentDiagnostic[] {
  const allowed = new Set(subagentPinnedProviders(definitions));
  const diagnostics: SubagentDiagnostic[] = [];
  for (const definition of definitions) {
    const pin = definition.model;
    if (!pin) continue;
    const key = subagentModelKey(pin);
    if (!allowed.has(pin.provider)) {
      diagnostics.push({
        code: 'too_many',
        message: `${definition.name}: too many pinned providers, ignoring "${key}"`,
        path: definition.filePath ?? '<builtin>',
      });
      continue;
    }
    if (!resolveSubagentPin(pin, available)) {
      diagnostics.push({
        code: 'parse_failed',
        message: `${definition.name}: no configured model matches "${key}"`,
        path: definition.filePath ?? '<builtin>',
      });
    }
  }
  return diagnostics;
}
