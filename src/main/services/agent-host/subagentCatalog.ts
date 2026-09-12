/**
 * P5-2-5 — the management side of the subagent catalog.
 *
 * The runtime loads definitions through its host IO port, inside the worker.
 * This is the other reader of the same directory: Main, on behalf of the
 * settings UI, which has to list, create, edit, rename, delete and switch
 * definitions while a session may be running.
 *
 * Four rules the P5-2 contract sets, and where each one lives here:
 *
 * 1. **A save must not lose a field the UI has no control for.** `save` takes a
 *    whole definition and writes it with {@link formatSubagentDefinition}, so
 *    `permission` and a provider pin survive an edit that only touched the
 *    prompt. The UI's job is to hand back what it was given.
 * 2. **Enablement is app data, never the document.** Switching a definition off
 *    writes a name into shared settings; the Markdown stays shareable and says
 *    nothing about this install.
 * 3. **Builtins are editable by shadowing, not by mutation.** Editing a builtin
 *    writes a USER document of the same name, which the runtime's merge already
 *    prefers. Nothing we ship is ever written to.
 * 4. **The file is the identity.** A rename writes the new document and removes
 *    the old one; it never leaves two files claiming one name.
 *
 * Reads are lenient and writes are strict: a malformed document is listed with
 * its error so the user can fix it, but nothing is saved that would not load.
 *
 * Everything the class touches outside itself — the agent directory, the
 * settings read, the settings write — is constructor-injected, so the tests run
 * against a temp directory and a plain object instead of a running Electron.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_SUBAGENT_DOCUMENTS } from '@shared/subagentBuiltins';
import {
  formatSubagentDefinition,
  MAX_MANAGED_SUBAGENT_DEFINITIONS,
  MAX_SUBAGENT_DOCUMENT_BYTES,
  normalizeSubagentName,
  parseSubagentDefinition,
  type SubagentDefinition,
} from '@shared/subagentDefinition';
import type {
  SubagentCatalogView,
  SubagentRow,
  SubagentSaveRequest,
} from '@shared/types/subagentManagement';
import { NATIVE_SUBAGENTS_DISABLED_KEY } from './nativeSubagentSettings';

export class SubagentCatalogError extends Error {}

export interface SubagentCatalogDeps {
  /** The app's agent directory; `<agentDir>/subagents` is what the UI writes. */
  agentDir: () => string;
  readSettings: () => Record<string, unknown>;
  /** Returns false when the write failed, matching `mergeSettingsPatch`. */
  writeSettings: (patch: Record<string, unknown>) => boolean;
  /** Overridable so a test never reads the developer's real home. */
  home?: () => string;
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? '';
}

export class SubagentCatalogService {
  constructor(private readonly deps: SubagentCatalogDeps) {}

  /** Where the management UI writes. The runtime reads this root first. */
  directory(): string {
    return join(this.deps.agentDir(), 'subagents');
  }

  /**
   * Directories listed, in the runtime's own precedence order.
   *
   * `~/.agents/subagents` is read for the same reason P5-1 still reads
   * `~/.agents/skills`: a user who put definitions there before H/19 unified
   * the agent directory should see them, and should see WHERE they are — which
   * is why a row carries its file path rather than being silently copied over.
   */
  private roots(): string[] {
    return [this.directory(), join((this.deps.home ?? homedir)(), '.agents', 'subagents')];
  }

  private disabledNames(): string[] {
    const raw = this.deps.readSettings()[NATIVE_SUBAGENTS_DISABLED_KEY];
    return Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === 'string')
      : [];
  }

  private setDisabledNames(names: readonly string[]): void {
    if (!this.deps.writeSettings({ [NATIVE_SUBAGENTS_DISABLED_KEY]: [...names] })) {
      throw new SubagentCatalogError('Failed to save the subagent switch');
    }
  }

  /**
   * Everything the management UI shows, in one read.
   *
   * User documents first, then the builtins they did not shadow — the same
   * precedence the runtime applies, computed the same way, so the list a user
   * edits is the list a session will load.
   */
  async read(): Promise<SubagentCatalogView> {
    const disabled = new Set(this.disabledNames());
    const rows: SubagentRow[] = [];
    const broken: SubagentCatalogView['broken'] = [];
    const claimed = new Set<string>();

    for (const root of this.roots()) {
      for (const document of await this.listDocuments(root)) {
        const parsed = parseSubagentDefinition(document.raw, {
          source: 'user',
          fallbackName: basenameOf(document.path),
          filePath: document.path,
        });
        if (!parsed.ok) {
          broken.push({
            filePath: document.path,
            name: normalizeSubagentName(basenameOf(document.path)),
            errors: parsed.errors,
          });
          continue;
        }
        // First root wins a name, which is the runtime's rule. The shadowed copy
        // is not listed twice: two rows for one name is a list nobody can act on.
        if (claimed.has(parsed.definition.name)) continue;
        claimed.add(parsed.definition.name);
        rows.push(row(parsed.definition, disabled, parsed.warnings));
      }
    }

    for (const raw of BUILTIN_SUBAGENT_DOCUMENTS) {
      const parsed = parseSubagentDefinition(raw, { source: 'builtin' });
      if (!parsed.ok || claimed.has(parsed.definition.name)) continue;
      claimed.add(parsed.definition.name);
      rows.push(row(parsed.definition, disabled, parsed.warnings));
    }

    return {
      rows,
      broken,
      directory: this.directory(),
      // A disabled name matching nothing is a tombstone: a definition renamed
      // or deleted while it was off. Reported so the caller can clear it —
      // otherwise a future definition reusing the name arrives switched off.
      staleDisabled: [...disabled].filter(
        (name) => !rows.some((entry) => entry.name === name) && !broken.some((e) => e.name === name)
      ),
    };
  }

  /**
   * Create or update one definition.
   *
   * `previousName` is what makes an edit a rename rather than a copy. The
   * document is validated by parsing what is about to be written, so a save
   * that would not load fails here with the parser's own message instead of
   * becoming a broken row the next time the list is read.
   */
  async save(request: SubagentSaveRequest): Promise<SubagentCatalogView> {
    const name = normalizeSubagentName(request.name);
    if (!name) throw new SubagentCatalogError('A subagent needs a name');

    const document = formatSubagentDefinition({
      name,
      description: request.description,
      tools: request.tools,
      ...(request.model ? { model: request.model } : {}),
      ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      ...(request.permission ? { permission: request.permission } : {}),
      ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
      prompt: request.prompt,
    });
    const parsed = parseSubagentDefinition(document, { source: 'user' });
    if (!parsed.ok) throw new SubagentCatalogError(parsed.errors.join('; '));
    if (Buffer.byteLength(document, 'utf8') > MAX_SUBAGENT_DOCUMENT_BYTES) {
      throw new SubagentCatalogError(
        `This definition is larger than ${Math.round(
          MAX_SUBAGENT_DOCUMENT_BYTES / 1024
        )} KiB; it is a prompt, not a definition`
      );
    }

    const previous = request.previousName ? normalizeSubagentName(request.previousName) : undefined;
    const before = await this.read();
    const userCount = before.rows.filter((entry) => entry.source === 'user').length;
    const replacesUser = before.rows.some(
      (entry) => entry.source === 'user' && entry.name === name
    );
    if (!replacesUser && userCount >= MAX_MANAGED_SUBAGENT_DEFINITIONS) {
      throw new SubagentCatalogError(
        `This install already keeps ${MAX_MANAGED_SUBAGENT_DEFINITIONS} subagent definitions, which is the limit`
      );
    }
    if (previous && previous !== name && before.rows.some((entry) => entry.name === name)) {
      // A rename onto an occupied name would delete the old file and leave the
      // occupant, which looks exactly like the rename silently failing.
      throw new SubagentCatalogError(`A subagent named "${name}" already exists`);
    }

    await mkdir(this.directory(), { recursive: true });
    await writeFile(this.pathFor(name), document, 'utf8');

    if (previous && previous !== name) {
      // The new document lands before the old one goes, so a crash between the
      // two leaves a duplicate rather than nothing.
      const old = before.rows.find((entry) => entry.name === previous);
      if (old?.filePath) await rm(old.filePath, { force: true });
      this.carryEnablement(previous, name);
    }
    return this.read();
  }

  /**
   * Delete a user definition.
   *
   * A builtin cannot be deleted, and saying so beats a delete that appears to
   * work and leaves the row in place: what the user wants there is the switch.
   */
  async remove(name: string): Promise<SubagentCatalogView> {
    const normalized = normalizeSubagentName(name);
    const catalog = await this.read();
    const target = catalog.rows.find((entry) => entry.name === normalized);
    const brokenTarget = catalog.broken.find((entry) => entry.name === normalized);
    if (!target && !brokenTarget)
      throw new SubagentCatalogError(`No subagent named "${normalized}"`);
    if (target?.source === 'builtin') {
      throw new SubagentCatalogError(
        `"${normalized}" ships with the app and cannot be deleted; switch it off instead`
      );
    }
    const filePath = target?.filePath ?? brokenTarget?.filePath;
    if (filePath) await rm(filePath, { force: true });
    // The switch goes with it. Leaving it behind is the tombstone case: a later
    // definition reusing this name would arrive silently off.
    const disabled = this.disabledNames();
    if (disabled.includes(normalized)) {
      this.setDisabledNames(disabled.filter((entry) => entry !== normalized));
    }
    return this.read();
  }

  /** Switch one definition on or off for this install. */
  async setEnabled(name: string, enabled: boolean): Promise<SubagentCatalogView> {
    const normalized = normalizeSubagentName(name);
    const current = this.disabledNames();
    const next = enabled
      ? current.filter((entry) => entry !== normalized)
      : current.includes(normalized)
        ? current
        : [...current, normalized];
    if (next.length !== current.length) this.setDisabledNames(next);
    return this.read();
  }

  /** Drop disabled names that match no definition. */
  async clearStaleDisabled(): Promise<SubagentCatalogView> {
    const catalog = await this.read();
    if (catalog.staleDisabled.length === 0) return catalog;
    const stale = new Set(catalog.staleDisabled);
    this.setDisabledNames(this.disabledNames().filter((entry) => !stale.has(entry)));
    return this.read();
  }

  private pathFor(name: string): string {
    return join(this.directory(), `${name}.md`);
  }

  /** A renamed definition keeps its switch; the old name is gone. */
  private carryEnablement(from: string, to: string): void {
    const current = this.disabledNames();
    if (!current.includes(from)) return;
    this.setDisabledNames([...current.filter((entry) => entry !== from), to]);
  }

  private async listDocuments(root: string): Promise<{ path: string; raw: string }[]> {
    let names: string[];
    try {
      names = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
        .map((entry) => entry.name)
        // Sorted so two documents that would collide resolve the same way here
        // as they do in the runtime; directory order is not a contract.
        .sort();
    } catch {
      // No directory is the normal state, not an error worth a red banner.
      return [];
    }
    const documents: { path: string; raw: string }[] = [];
    for (const name of names) {
      const path = join(root, name);
      try {
        const raw = await readFile(path, 'utf8');
        if (Buffer.byteLength(raw, 'utf8') > MAX_SUBAGENT_DOCUMENT_BYTES) continue;
        documents.push({ path, raw });
      } catch {
        // Losing the whole list over one unreadable file would be worse than
        // losing the one.
      }
    }
    return documents;
  }
}

function row(
  definition: SubagentDefinition,
  disabled: ReadonlySet<string>,
  warnings: readonly string[]
): SubagentRow {
  return {
    name: definition.name,
    description: definition.description,
    tools: [...definition.tools],
    ...(definition.model ? { model: { ...definition.model } } : {}),
    ...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {}),
    ...(definition.permission ? { permission: definition.permission } : {}),
    ...(definition.maxTurns !== undefined ? { maxTurns: definition.maxTurns } : {}),
    prompt: definition.prompt,
    source: definition.source,
    ...(definition.filePath ? { filePath: definition.filePath } : {}),
    enabled: !disabled.has(definition.name),
    ...(warnings.length ? { warnings: [...warnings] } : {}),
  };
}
