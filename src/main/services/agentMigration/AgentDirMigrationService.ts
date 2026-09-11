/**
 * H/19 U2 — inspect `~/.pi/agent` and copy the parts worth having into this
 * app's agent directory.
 *
 * Pure in the same sense as `UserProviderService`: no `electron` import, the
 * two directories and the credential store are injected, so the tests run on a
 * temp dir with a fake store. `index.ts` does the wiring.
 *
 * ## Two copy granularities, on purpose
 *
 * A skill is a unit: half of `skills/reviewer/` is not a skill, it is a broken
 * one. So skills and prompt templates are copied whole-directory, and a
 * destination that already has that name is one conflict the user decides
 * about.
 *
 * Sessions are the opposite: `sessions/<project>/` is a bag of independent
 * `.jsonl` files, and the destination legitimately already holds a directory
 * for the same project. Skipping the whole directory there would hide every old
 * conversation for a project the user is currently working in, so sessions
 * merge FILE by file and only a same-named file is a conflict.
 */

import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIGRATION_ENTRY_DISPLAY_CAP,
  type MigrationConflictPolicy,
  type MigrationEntry,
  type MigrationItem,
  type MigrationItemKind,
  type MigrationOutcome,
  type MigrationPlan,
  type MigrationRequest,
  type MigrationResult,
} from '@shared/agentMigration';
import {
  checkProviderBaseUrl,
  isUserProviderApi,
  normalizeProviderBaseUrl,
} from '@shared/userProviders';
import type { UserProvider } from '../auth/CredentialVault';

/** The subset of the vault this service needs, so a test needs no vault file. */
export interface MigrationProviderStore {
  /** `null` when the group cannot be read at all — never an empty list. */
  list(): readonly UserProvider[] | null;
  save(providers: readonly UserProvider[]): Promise<void>;
}

export interface AgentDirMigrationOptions {
  sourceDir: string;
  targetDir: string;
  providers: MigrationProviderStore;
  /** Resolves `$NAME` API keys found in the user's `models.json`. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  newId?: () => string;
}

const SKILLS_DIR = 'skills';
const PROMPTS_DIR = 'prompts';
const SESSIONS_DIR = 'sessions';
const AGENTS_FILE = 'AGENTS.md';
const MODELS_FILE = 'models.json';
const AUTH_FILE = 'auth.json';

/** One provider as it appears in a `models.json` this app did not write. */
interface ForeignProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  models: string[];
}

export class AgentDirMigrationService {
  private readonly sourceDir: string;
  private readonly targetDir: string;
  private readonly providers: MigrationProviderStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: AgentDirMigrationOptions) {
    this.sourceDir = options.sourceDir;
    this.targetDir = options.targetDir;
    this.providers = options.providers;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** What is there to bring over, and what would collide. Reads only. */
  inspect(): MigrationPlan {
    const sourceExists = isDirectory(this.sourceDir);
    // Same directory means this app is already pointed at the user's own dir
    // (a developer with `PI_CODING_AGENT_DIR` set). Copying a directory onto
    // itself is not a migration, it is a way to lose files.
    const distinct = sourceExists && !samePath(this.sourceDir, this.targetDir);
    const items = distinct
      ? [
          this.inspectDirectory('skills', SKILLS_DIR),
          this.inspectDirectory('promptTemplates', PROMPTS_DIR),
          this.inspectAgentsFile(),
          this.inspectProviders(),
          this.inspectSessions(),
        ].filter((item): item is MigrationItem => item !== null)
      : [];
    return {
      sourceDir: this.sourceDir,
      targetDir: this.targetDir,
      sourceExists,
      items,
      // An item all of whose entries already exist at the destination is still
      // listed — the user may want to overwrite — but it does not make the page
      // claim there is work to do.
      nothingToDo: items.every((item) => item.total === item.conflicts + item.blocked),
    };
  }

  async apply(request: MigrationRequest): Promise<MigrationResult> {
    const kinds = new Set(request.kinds);
    const outcomes: MigrationOutcome[] = [];
    for (const kind of kinds) {
      outcomes.push(await this.applyKind(kind, request.onConflict));
    }
    return { outcomes, plan: this.inspect() };
  }

  // ─── inspection ───

  private inspectDirectory(kind: MigrationItemKind, dirName: string): MigrationItem | null {
    const sourcePath = join(this.sourceDir, dirName);
    const targetPath = join(this.targetDir, dirName);
    const names = listEntries(sourcePath);
    if (names.length === 0) return null;
    const entries = names.map((name) => ({
      name,
      conflict: existsSync(join(targetPath, name)),
    }));
    return item(kind, sourcePath, targetPath, entries);
  }

  private inspectAgentsFile(): MigrationItem | null {
    const sourcePath = join(this.sourceDir, AGENTS_FILE);
    const targetPath = join(this.targetDir, AGENTS_FILE);
    if (!isFile(sourcePath)) return null;
    return item('agentsFile', sourcePath, targetPath, [
      { name: AGENTS_FILE, conflict: existsSync(targetPath) },
    ]);
  }

  /**
   * One entry per CONVERSATION, not per project directory.
   *
   * Both counts used to be per directory, and both were wrong for it (H/21
   * point-check D5/D3, 2026-09-11):
   *
   *  - the number the user sees is the one thing telling them whether this is
   *    a handful of chats or a decade of them, and "6" for 74 conversations
   *    answers nothing — the point of the checkbox is being able to leave a
   *    huge history behind;
   *  - an EMPTY source directory copies nothing, yet counted as one pending
   *    item forever, so the first-launch offer came back on every launch
   *    proposing to copy a folder with nothing in it.
   *
   * Counting files fixes both: an empty directory contributes zero, and a fully
   * copied set has every file conflicted, so `total === conflicts` and the item
   * correctly reads as "already here".
   */
  private inspectSessions(): MigrationItem | null {
    const sourcePath = join(this.sourceDir, SESSIONS_DIR);
    const targetPath = join(this.targetDir, SESSIONS_DIR);
    const projects = listEntries(sourcePath).filter((name) => isDirectory(join(sourcePath, name)));
    const entries: MigrationEntry[] = [];
    const display: MigrationEntry[] = [];
    for (const project of projects) {
      const files = listEntries(join(sourcePath, project)).filter((file) =>
        isFile(join(sourcePath, project, file))
      );
      if (files.length === 0) continue;
      const copied = files.filter((file) => existsSync(join(targetPath, project, file)));
      for (const file of files) {
        entries.push({ name: `${project}/${file}`, conflict: copied.includes(file) });
      }
      // Shown, not counted: the file names are uuids, so the project directory
      // is the only part a person recognises.
      display.push({ name: project, conflict: copied.length === files.length });
    }
    if (entries.length === 0) return null;
    return item('sessions', sourcePath, targetPath, entries, display);
  }

  private inspectProviders(): MigrationItem | null {
    const sourcePath = join(this.sourceDir, MODELS_FILE);
    const found = this.readForeignProviders();
    if (found.length === 0) return null;
    const existing = this.providers.list();
    const entries: MigrationEntry[] = found.map((provider) => {
      const blocked = this.blockReason(provider);
      return {
        name: provider.name,
        // A store that cannot be read is not proof of "no conflict": treating
        // it as one would import duplicates on top of services we cannot see.
        // Flagged as a conflict instead, which defaults to skipping.
        conflict: existing === null || existing.some((row) => sameName(row.name, provider.name)),
        ...(blocked ? { blocked } : {}),
      };
    });
    return item('providers', sourcePath, 'AI services in this app', entries);
  }

  /**
   * The user's `models.json` providers, with each one's key resolved.
   *
   * Two places carry a key: the provider's own `apiKey` field (what pi's own
   * `pi auth` writes for a hand-edited config) and `auth.json` keyed by provider
   * id. Both are read, the provider's own first, because that is the one the
   * user last edited by hand.
   */
  private readForeignProviders(): ForeignProvider[] {
    const models = readJsonObject(join(this.sourceDir, MODELS_FILE));
    const providers = models?.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
    const auth = readJsonObject(join(this.sourceDir, AUTH_FILE)) ?? {};
    const result: ForeignProvider[] = [];
    for (const [id, raw] of Object.entries(providers as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
      result.push({
        id,
        name,
        baseUrl: typeof row.baseUrl === 'string' ? row.baseUrl : '',
        api: typeof row.api === 'string' ? row.api : '',
        apiKey: typeof row.apiKey === 'string' ? row.apiKey : readAuthKey(auth[id]),
        models: readModelIds(row.models),
      });
    }
    return result;
  }

  /** Why this service cannot be imported at all, or `undefined` when it can. */
  private blockReason(provider: ForeignProvider): string | undefined {
    if (!isUserProviderApi(provider.api)) {
      return provider.api
        ? `this app cannot talk to the "${provider.api}" API style`
        : 'the entry names no API style';
    }
    const issue = checkProviderBaseUrl(normalizeProviderBaseUrl(provider.baseUrl));
    if (issue) return `its service URL is ${issue}`;
    const key = this.resolveKey(provider.apiKey);
    if (key === null) {
      // `$NAME` that this process cannot see. Named, because the fix is one
      // the user can make and a silently dropped service is not.
      return `its API key reads ${provider.apiKey}, an environment variable this app cannot see`;
    }
    if (!key) return 'no API key is stored for it';
    return undefined;
  }

  /** Literal key, resolved `$NAME`, or `null` when the reference is unresolvable. */
  private resolveKey(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('$')) return trimmed;
    const resolved = this.env[trimmed.slice(1)]?.trim();
    return resolved ? resolved : null;
  }

  // ─── application ───

  private async applyKind(
    kind: MigrationItemKind,
    onConflict: MigrationConflictPolicy
  ): Promise<MigrationOutcome> {
    switch (kind) {
      case 'skills':
        return this.copyEntries(kind, SKILLS_DIR, onConflict);
      case 'promptTemplates':
        return this.copyEntries(kind, PROMPTS_DIR, onConflict);
      case 'agentsFile':
        return this.copyAgentsFile(onConflict);
      case 'sessions':
        return this.copySessions(onConflict);
      case 'providers':
        return this.importProviders(onConflict);
    }
  }

  /** Whole-entry copy: one skill or one template directory at a time. */
  private copyEntries(
    kind: MigrationItemKind,
    dirName: string,
    onConflict: MigrationConflictPolicy
  ): MigrationOutcome {
    const outcome = emptyOutcome(kind);
    const sourcePath = join(this.sourceDir, dirName);
    const targetPath = join(this.targetDir, dirName);
    for (const name of listEntries(sourcePath)) {
      const target = join(targetPath, name);
      const exists = existsSync(target);
      if (exists && onConflict === 'skip') {
        outcome.skipped += 1;
        continue;
      }
      try {
        copyTree(join(sourcePath, name), target);
        if (exists) outcome.overwritten += 1;
        else outcome.copied += 1;
      } catch (error) {
        outcome.failed.push({ name, error: messageOf(error) });
      }
    }
    return outcome;
  }

  private copyAgentsFile(onConflict: MigrationConflictPolicy): MigrationOutcome {
    const outcome = emptyOutcome('agentsFile');
    const source = join(this.sourceDir, AGENTS_FILE);
    const target = join(this.targetDir, AGENTS_FILE);
    if (!isFile(source)) return outcome;
    const exists = existsSync(target);
    if (exists && onConflict === 'skip') {
      outcome.skipped += 1;
      return outcome;
    }
    try {
      mkdirSync(this.targetDir, { recursive: true });
      copyFileSync(source, target);
      if (exists) outcome.overwritten += 1;
      else outcome.copied += 1;
    } catch (error) {
      outcome.failed.push({ name: AGENTS_FILE, error: messageOf(error) });
    }
    return outcome;
  }

  /**
   * U3 — the session history, merged file by file.
   *
   * This is what keeps "my old conversations" true across the directory move.
   * The files are pi's own JSONL and are copied byte for byte; nothing here
   * parses or rewrites them.
   */
  private copySessions(onConflict: MigrationConflictPolicy): MigrationOutcome {
    const outcome = emptyOutcome('sessions');
    const sourcePath = join(this.sourceDir, SESSIONS_DIR);
    const targetPath = join(this.targetDir, SESSIONS_DIR);
    for (const project of listEntries(sourcePath)) {
      const projectSource = join(sourcePath, project);
      if (!isDirectory(projectSource)) continue;
      for (const file of listEntries(projectSource)) {
        const source = join(projectSource, file);
        if (!isFile(source)) continue;
        const target = join(targetPath, project, file);
        const exists = existsSync(target);
        if (exists && onConflict === 'skip') {
          outcome.skipped += 1;
          continue;
        }
        try {
          mkdirSync(join(targetPath, project), { recursive: true });
          copyFileSync(source, target);
          if (exists) outcome.overwritten += 1;
          else outcome.copied += 1;
        } catch (error) {
          outcome.failed.push({ name: `${project}/${file}`, error: messageOf(error) });
        }
      }
    }
    return outcome;
  }

  /**
   * The H/17 defect's actual repair: the user's own providers become services
   * in this app's vault, where the settings page can show and edit them.
   *
   * One save at the end rather than one per provider — a partial write here
   * would leave the group in a state neither file describes.
   */
  private async importProviders(onConflict: MigrationConflictPolicy): Promise<MigrationOutcome> {
    const outcome = emptyOutcome('providers');
    const found = this.readForeignProviders();
    if (found.length === 0) return outcome;

    const existing = this.providers.list();
    if (existing === null) {
      outcome.failed.push({
        name: 'AI services',
        error: 'stored AI services could not be read; unlock the system keyring and try again',
      });
      return outcome;
    }

    const merged = [...existing];
    let changed = false;
    for (const provider of found) {
      const blocked = this.blockReason(provider);
      if (blocked) {
        outcome.failed.push({ name: provider.name, error: blocked });
        continue;
      }
      // `blockReason` already proved all three of these.
      const apiKey = this.resolveKey(provider.apiKey) as string;
      const baseUrl = normalizeProviderBaseUrl(provider.baseUrl);
      const index = merged.findIndex((row) => sameName(row.name, provider.name));
      if (index >= 0) {
        if (onConflict === 'skip') {
          outcome.skipped += 1;
          continue;
        }
        const previous = merged[index] as UserProvider;
        merged[index] = {
          ...previous,
          baseUrl,
          api: provider.api,
          apiKey,
          models: provider.models.length > 0 ? provider.models : (previous.models ?? []),
          // Set on overwrite too: the row being replaced may predate this fix,
          // so re-running the migration is how an already-renamed service gets
          // its original key back.
          ...configKeyOf(provider),
        };
        outcome.overwritten += 1;
      } else {
        merged.push({
          id: this.newId(),
          name: provider.name,
          baseUrl,
          api: provider.api,
          apiKey,
          models: provider.models,
          enabled: true,
          createdAt: this.now().toISOString(),
          // The key this provider had in the user's own `models.json`. Dropping
          // it renames the provider, and every session that recorded the old
          // name stays broken after a migration that reported success — the
          // exact failure the migration exists to repair (H/21 point-check D1).
          ...configKeyOf(provider),
        });
        outcome.copied += 1;
      }
      changed = true;
    }

    if (changed) {
      try {
        await this.providers.save(merged);
      } catch (error) {
        return {
          ...emptyOutcome('providers'),
          failed: [{ name: 'AI services', error: messageOf(error) }],
        };
      }
    }
    return outcome;
  }
}

// ─── helpers ───

/**
 * The `configKey` field for a migrated provider, or nothing when its source key
 * is unusable.
 *
 * A spread rather than a plain value so the field stays absent instead of
 * present-and-empty: an empty string here would read as "keep this key" and
 * produce a provider id of `""` in `models.json`.
 */
function configKeyOf(provider: ForeignProvider): { configKey?: string } {
  const key = provider.id.trim();
  return key ? { configKey: key } : {};
}

/**
 * @param entries what is being COUNTED — one per thing that would be copied.
 * @param display what is being SHOWN, when the two differ. Sessions are the
 *   only kind that needs this: they are counted one per conversation, because
 *   that is the number a person can decide about, but listing 74 uuid file
 *   names tells nobody anything — so the names shown are the project
 *   directories instead.
 */
function item(
  kind: MigrationItemKind,
  sourcePath: string,
  targetPath: string,
  entries: MigrationEntry[],
  display: MigrationEntry[] = entries
): MigrationItem {
  return {
    kind,
    sourcePath,
    targetPath,
    entries: display.slice(0, MIGRATION_ENTRY_DISPLAY_CAP),
    total: entries.length,
    conflicts: entries.filter((entry) => entry.conflict && !entry.blocked).length,
    blocked: entries.filter((entry) => entry.blocked).length,
  };
}

function emptyOutcome(kind: MigrationItemKind): MigrationOutcome {
  return { kind, copied: 0, skipped: 0, overwritten: 0, failed: [] };
}

/** Sorted so two runs list the same thing in the same order. */
function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Recursive copy.
 *
 * Symlinks are followed rather than recreated: `statSync` resolves them, so a
 * skill directory the user symlinked into place arrives here as real files. A
 * copied symlink would point back into the user's directory and quietly make
 * this app's copy change when theirs did — the opposite of what "copy, never
 * move" promises.
 *
 * Always overwrites. The skip/overwrite decision is made one level up, per
 * entry, because that is the level the user was asked about.
 */
function copyTree(source: string, target: string): void {
  if (isDirectory(source)) {
    mkdirSync(target, { recursive: true });
    for (const name of listEntries(source)) {
      copyTree(join(source, name), join(target, name));
    }
    return;
  }
  if (!isFile(source)) return;
  mkdirSync(dirOf(target), { recursive: true });
  copyFileSync(source, target);
}

function dirOf(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return separator > 0 ? path.slice(0, separator) : path;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[/\\]+$/, '') === b.replace(/[/\\]+$/, '');
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `auth.json` entries are `{type,key}` in pi's own writer and, historically, bare strings. */
function readAuthKey(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const row = value as Record<string, unknown>;
  if (typeof row.key === 'string') return row.key;
  return typeof row.apiKey === 'string' ? row.apiKey : '';
}

function readModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const row of value) {
    if (typeof row === 'string') {
      ids.push(row);
      continue;
    }
    if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
      ids.push((row as { id: string }).id);
    }
  }
  return [...new Set(ids)];
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
