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

import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_SUBAGENT_DOCUMENTS } from '@shared/subagentBuiltins';
import {
  canonicalToolName,
  DEFAULT_SUBAGENT_TOOLS,
  formatSubagentDefinition,
  MAX_MANAGED_SUBAGENT_DEFINITIONS,
  MAX_SUBAGENT_DOCUMENT_BYTES,
  MAX_SUBAGENT_MAX_TURNS,
  normalizeSubagentName,
  parseSubagentDefinition,
  SUBAGENT_ASSIGNABLE_TOOLS,
  type SubagentDefinition,
} from '@shared/subagentDefinition';
import { type LegacyDocument, previewLegacyMigrations } from '@shared/subagentMigration';
import type {
  SubagentCatalogView,
  SubagentImportPreview,
  SubagentImportResult,
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
      // Canonicalised and expanded before writing, so the round-trip check
      // below compares semantics and not spelling. The parser reads `read` back
      // as `Read`, an empty list back as the read-only default and `*` back as
      // every assignable tool; writing what it will read means a lenient caller
      // is still accepted rather than refused for a difference that is not one.
      tools: writableTools(request.tools),
      ...(request.model ? { model: request.model } : {}),
      ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      ...(request.permission ? { permission: request.permission } : {}),
      // Clamped here rather than left to the parser, for the same reason: the
      // parser clamps too, and a document that came back clamped would read as
      // a failed round trip instead of as the cap doing its job.
      ...(request.maxTurns !== undefined
        ? { maxTurns: Math.min(request.maxTurns, MAX_SUBAGENT_MAX_TURNS) }
        : {}),
      prompt: request.prompt,
    });
    const parsed = parseSubagentDefinition(document, { source: 'user' });
    if (!parsed.ok) throw new SubagentCatalogError(parsed.errors.join('; '));
    // subagent-data-07 — "it parses" was never the promise. The contract is
    // that a save round-trips every executable field, and this checks exactly
    // that by writing what was read back out: if the two documents differ, some
    // field did not survive the trip. It caught a real one — the writer escapes
    // an embedded `'` by doubling it and the reader did not undo that, so a
    // description grew a quote every time it was saved — and it is the guard
    // that stops a description carrying a newline from writing a second
    // frontmatter line (a `permission:` among them) that nobody asked for.
    if (formatSubagentDefinition(parsed.definition) !== document) {
      throw new SubagentCatalogError(
        'This definition cannot be stored without changing it — a value here (usually the description) contains a line break or quoting the document format cannot carry.'
      );
    }
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
    await this.writeDocument(this.pathFor(name), document);

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

  /**
   * subagent-data-01 — what the legacy `<agentDir>/agents` directory would
   * become, per document, without writing anything.
   *
   * The preview logic itself has existed since P5-2-5 and SA19 signed it off as
   * delivered; what did not exist was any way to reach it — no scan, no IPC, no
   * button. A user with `@gotgenes/pi-subagents` definitions had to retype them.
   *
   * Only the GLOBAL directory is scanned. `.pi/agents` comes from whatever
   * repository happens to be open, and offering to promote it into the user's
   * catalog would let a checkout put a trusted delegate on the menu — the same
   * rule the runtime's own loader follows by never scanning a project root.
   */
  async previewLegacyImport(): Promise<SubagentImportPreview> {
    const sourceDirectory = join(this.deps.agentDir(), 'agents');
    const documents = await this.readLegacyDocuments(sourceDirectory);
    if (documents.length === 0) return { sourceDirectory, rows: [] };
    const existing = await this.read();
    const previews = previewLegacyMigrations(documents, {
      targetDir: this.directory(),
      existingNames: existing.rows.map((entry) => entry.name),
    });
    return {
      sourceDirectory,
      rows: previews.map((preview) => ({
        filePath: preview.source.filePath,
        name: preview.name,
        ...(preview.targetPath ? { targetPath: preview.targetPath } : {}),
        collides: preview.collides,
        blocked: preview.blocked,
        notes: preview.notes,
      })),
    };
  }

  /**
   * Import the named legacy documents, and only those.
   *
   * Re-scanned and re-previewed here rather than trusting a document the
   * renderer sends back: a page cannot be allowed to write arbitrary Markdown
   * into the catalog directory, and re-reading is also what makes "the file
   * changed since you looked" fail loudly instead of writing a stale copy.
   *
   * Nothing is overwritten and nothing is deleted. A name already held by a
   * USER document is skipped with a reason — the user has an editor and a
   * delete button for that case, and silently replacing the definition a
   * session may be running would be the one destructive act this flow makes.
   * Shadowing a BUILTIN is fine and goes ahead: that is what customising one
   * has always meant.
   */
  async applyLegacyImport(names: readonly string[]): Promise<SubagentImportResult> {
    const wanted = new Set(names.map((name) => normalizeSubagentName(name)));
    const imported: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const documents = await this.readLegacyDocuments(join(this.deps.agentDir(), 'agents'));
    let catalog = await this.read();
    const previews = previewLegacyMigrations(documents, {
      targetDir: this.directory(),
      existingNames: catalog.rows.map((entry) => entry.name),
    });
    let userCount = catalog.rows.filter((entry) => entry.source === 'user').length;

    for (const candidate of previews) {
      if (!wanted.has(candidate.name)) continue;
      wanted.delete(candidate.name);
      if (candidate.blocked || !candidate.document) {
        skipped.push({
          name: candidate.name,
          reason: 'it needs a decision first — see the notes on its row',
        });
        continue;
      }
      if (catalog.rows.some((entry) => entry.source === 'user' && entry.name === candidate.name)) {
        skipped.push({
          name: candidate.name,
          reason: `a subagent named "${candidate.name}" already exists here; rename or delete it first`,
        });
        continue;
      }
      if (userCount >= MAX_MANAGED_SUBAGENT_DEFINITIONS) {
        skipped.push({
          name: candidate.name,
          reason: `this install already keeps ${MAX_MANAGED_SUBAGENT_DEFINITIONS} subagent definitions, which is the limit`,
        });
        continue;
      }
      await mkdir(this.directory(), { recursive: true });
      await this.writeDocument(this.pathFor(candidate.name), candidate.document);
      imported.push(candidate.name);
      userCount += 1;
      catalog = await this.read();
    }
    for (const missing of wanted) {
      skipped.push({ name: missing, reason: 'no legacy document of that name was found' });
    }
    return { imported, skipped, catalog };
  }

  private async readLegacyDocuments(root: string): Promise<LegacyDocument[]> {
    return (await this.listDocuments(root)).map((document) => ({
      filePath: document.path,
      name: basenameOf(document.path),
      scope: 'global' as const,
      raw: document.raw,
    }));
  }

  private pathFor(name: string): string {
    return join(this.directory(), `${name}.md`);
  }

  /**
   * concurrency-06 — put the document in place in one step, never in two.
   *
   * The other reader of this directory is not a person: since T020 every worker
   * rescans the whole of it at the top of every turn, one process per session.
   * A plain `writeFile` truncates first and writes second, so a scan landing in
   * between parses an empty or half file, reports it as broken, and the
   * definition disappears from that turn's menu — a ghost the user cannot
   * reproduce because the next turn has the whole file again. Writing to a
   * staging name and renaming over the target removes the window: `rename`
   * replaces atomically on POSIX and on Windows, so the `.md` name only ever
   * holds a complete document.
   *
   * The staging name deliberately does not end in `.md`, so neither this
   * service's own scan nor the runtime's picks it up while it exists. Contents
   * are flushed before the rename for the reason `writeJsonAtomically` states:
   * the swap is atomic against a reader either way, but not against a power cut.
   */
  private async writeDocument(path: string, document: string): Promise<void> {
    const staging = `${path}.${randomUUID()}.tmp`;
    try {
      // `wx`: a staging name is ours alone, and a collision means something
      // else is using it — better to fail than to overwrite it.
      const handle = await open(staging, 'wx', 0o600);
      try {
        await handle.writeFile(document, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, path);
    } catch (error) {
      await rm(staging, { force: true });
      throw error;
    }
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

/** The tool list as the parser will read it back; see `save`. */
function writableTools(tools: readonly string[]): string[] {
  if (tools.some((tool) => tool.trim() === '*')) return [...SUBAGENT_ASSIGNABLE_TOOLS];
  const canonical: string[] = [];
  for (const tool of tools) {
    const name = canonicalToolName(tool);
    if (name && !canonical.includes(name)) canonical.push(name);
  }
  return canonical.length > 0 ? canonical : [...DEFAULT_SUBAGENT_TOOLS];
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
