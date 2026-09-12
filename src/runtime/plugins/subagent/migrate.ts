/**
 * P5-2-5 — previewing a migration from the legacy `@gotgenes/pi-subagents`
 * documents to native definitions.
 *
 * The legacy backend reads `<agentDir>/agents/*.md` (global) and
 * `<cwd>/.pi/agents/*.md` (project). Native reads `<agentDir>/subagents/*.md`
 * and nothing project-scoped. The two formats overlap but do not match, and
 * three of the legacy fields have no native meaning at all.
 *
 * Everything here is a PREVIEW. It produces the document that would be written
 * and a per-field account of what changed; it writes nothing and deletes
 * nothing. Three rules the P5-2 contract sets, all of them load-bearing:
 *
 * 1. **The original file is kept.** Migration adds a native document; the
 *    legacy one stays where it is, so a user who switches back still has it.
 * 2. **Permissions are never silently changed.** Legacy has no permission
 *    field, so every migrated definition lands on native's `inherit` default.
 *    That is stated in the notes rather than assumed, because a batch migration
 *    that quietly widened a delegate's approval gear is exactly the outcome the
 *    contract forbids.
 * 3. **A project document is not promoted.** `.pi/agents/*.md` comes from the
 *    repository. Migrating it into the user's global catalog would let a
 *    checkout add a trusted delegate, so it is previewed as `project` and
 *    flagged — the decision is the user's, per document, and never a default.
 */

import {
  DEFAULT_SUBAGENT_PERMISSION,
  MAX_SUBAGENT_MAX_TURNS,
  normalizeSubagentName,
  SUBAGENT_THINKING_LEVELS,
  type SubagentAssignableTool,
} from '../../../shared/subagentDefinition.ts';

/** Where a legacy document was found. */
export type LegacyScope = 'global' | 'project';

export interface LegacyDocument {
  /** Absolute path of the legacy file. Kept so the preview can point at it. */
  filePath: string;
  /** Filename stem, which is the legacy identity. */
  name: string;
  scope: LegacyScope;
  raw: string;
}

export type MigrationNoteKind =
  /** Carried across unchanged. */
  | 'kept'
  /** Carried across in a different spelling or shape. */
  | 'adapted'
  /** No native equivalent; the behaviour is lost. */
  | 'dropped'
  /** Needs a decision before the document is usable. */
  | 'conflict';

export interface MigrationNote {
  kind: MigrationNoteKind;
  field: string;
  message: string;
}

export interface MigrationPreview {
  source: LegacyDocument;
  /** Native definition name after normalisation. */
  name: string;
  /** Where it would be written. Absent when it cannot be migrated at all. */
  targetPath?: string;
  /** The native document, ready to write. Absent when `blocked`. */
  document?: string;
  /** True when a native definition of this name already exists. */
  collides: boolean;
  /** True when nothing can be written without a user decision. */
  blocked: boolean;
  notes: MigrationNote[];
}

/**
 * Legacy tool name to native canonical name.
 *
 * `find` becomes `Glob`, which is the nearest thing we have and does the same
 * job; it is reported as ADAPTED rather than kept, because the arguments differ
 * and a prompt written against `find` may need a look. `ls` has no native
 * counterpart — a delegate that listed directories has to use `Glob` instead,
 * and saying so beats writing a tool name that resolves to nothing.
 */
const LEGACY_TOOL_MAP: Record<string, SubagentAssignableTool | null> = {
  read: 'Read',
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  find: 'Glob',
  ls: null,
};

/** Minimal frontmatter read, matching what the legacy loader itself accepts. */
function splitLegacy(raw: string): { frontmatter: Map<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const frontmatter = new Map<string, string>();
  if (!normalized.startsWith('---\n')) return { frontmatter, body: normalized.trim() };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { frontmatter, body: normalized.trim() };
  for (const line of normalized.slice(4, end).split('\n')) {
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_\- ]*):[ \t]*(.*)$/);
    if (!pair) continue;
    frontmatter.set(pair[1].trim().toLowerCase().replace(/[-\s]/g, '_'), pair[2].trim());
  }
  return {
    frontmatter,
    body: normalized
      .slice(end + 4)
      .replace(/^[ \t]*\n/, '')
      .trim(),
  };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && first === trimmed[trimmed.length - 1])
      return trimmed.slice(1, -1);
  }
  return trimmed;
}

function legacyList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((entry) => unquote(entry))
    .filter((entry) => entry.length > 0);
}

/**
 * Build the preview for one legacy document.
 *
 * @param existingNames native definitions already present, for collision
 * detection. A collision does not block — shadowing a name is legitimate — but
 * it has to be visible before anything is written.
 */
export function previewLegacyMigration(
  source: LegacyDocument,
  options: { targetDir: string; existingNames?: readonly string[] }
): MigrationPreview {
  const notes: MigrationNote[] = [];
  const { frontmatter, body } = splitLegacy(source.raw);
  const name = normalizeSubagentName(frontmatter.get('name') ?? source.name);
  const collides = (options.existingNames ?? []).includes(name);

  if (source.scope === 'project') {
    notes.push({
      kind: 'conflict',
      field: 'source',
      message:
        'this document comes from the repository, and migrating it would add a delegate to your global catalog that the project chose; approve it per document',
    });
  }

  const description = unquote(frontmatter.get('description') ?? '').trim();
  if (!description) {
    notes.push({
      kind: 'conflict',
      field: 'description',
      message: 'the legacy document has no description; native requires one before it will load',
    });
  }

  const declaredTools = legacyList(frontmatter.get('tools'));
  const tools: string[] = [];
  for (const legacy of declaredTools) {
    const mapped = LEGACY_TOOL_MAP[legacy.trim().toLowerCase()];
    if (mapped === undefined) {
      notes.push({ kind: 'dropped', field: 'tools', message: `unknown legacy tool "${legacy}"` });
      continue;
    }
    if (mapped === null) {
      notes.push({
        kind: 'dropped',
        field: 'tools',
        message: `"${legacy}" has no native equivalent; use Glob to list files instead`,
      });
      continue;
    }
    if (!tools.includes(mapped)) tools.push(mapped);
    // Only a rename that changes more than the casing is worth a note; `read`
    // to `Read` is noise, `find` to `Glob` is a different tool with different
    // arguments and a prompt that may need a second look.
    if (mapped.toLowerCase() !== legacy.trim().toLowerCase()) {
      notes.push({
        kind: 'adapted',
        field: 'tools',
        message: `"${legacy}" becomes "${mapped}", which takes different arguments`,
      });
    }
  }

  const model = unquote(frontmatter.get('model') ?? '').trim();
  let modelLine: string | undefined;
  if (model) {
    if (model.includes('/')) {
      modelLine = model;
      notes.push({ kind: 'kept', field: 'model', message: `pinned to ${model}` });
    } else {
      // Legacy pins a bare model id; native needs a provider to resolve it, and
      // guessing one is how a definition ends up on a model nobody picked.
      notes.push({
        kind: 'conflict',
        field: 'model',
        message: `"${model}" names no provider; native needs "<provider>/${model}" — pick one, or drop the pin to inherit the session model`,
      });
    }
  }

  const thinking = unquote(frontmatter.get('thinking') ?? '')
    .trim()
    .toLowerCase();
  const thinkingLine =
    thinking && (SUBAGENT_THINKING_LEVELS as readonly string[]).includes(thinking)
      ? thinking
      : undefined;
  if (thinking && !thinkingLine) {
    notes.push({
      kind: 'dropped',
      field: 'thinking',
      message: `unknown thinking level "${thinking}"`,
    });
  }

  const maxTurnsRaw = unquote(frontmatter.get('max_turns') ?? '').trim();
  let maxTurnsLine: string | undefined;
  if (maxTurnsRaw) {
    const parsed = Number(maxTurnsRaw);
    if (Number.isInteger(parsed) && parsed > 0) {
      const clamped = Math.min(parsed, MAX_SUBAGENT_MAX_TURNS);
      maxTurnsLine = String(clamped);
      if (clamped !== parsed) {
        notes.push({
          kind: 'adapted',
          field: 'max_turns',
          message: `${parsed} clamped to native's cap of ${MAX_SUBAGENT_MAX_TURNS}`,
        });
      }
    } else {
      notes.push({
        kind: 'adapted',
        field: 'max_turns',
        message: `"${maxTurnsRaw}" is not a positive integer; the delegate becomes unlimited`,
      });
    }
  }

  if (frontmatter.get('prompt_mode') === 'replace' || frontmatter.get('prompt_mode') === 'append') {
    if (frontmatter.get('prompt_mode') === 'append') {
      notes.push({
        kind: 'dropped',
        field: 'prompt_mode',
        message:
          'native always uses the document body as the delegate prompt; an "append" body will read differently without the base prompt it was written to extend',
      });
    }
  }
  if (frontmatter.get('inherit_context') === 'true') {
    notes.push({
      kind: 'dropped',
      field: 'inherit_context',
      message:
        'a native delegate never sees the parent conversation; put whatever it needs in the Task brief',
    });
  }
  if (frontmatter.get('run_in_background') === 'false') {
    notes.push({
      kind: 'dropped',
      field: 'run_in_background',
      message: 'every native delegate runs in the background; there is no foreground mode',
    });
  }
  if (frontmatter.get('display_name')) {
    notes.push({
      kind: 'dropped',
      field: 'display_name',
      message: 'native shows the definition name; there is no separate display name',
    });
  }
  if (frontmatter.get('locked')) {
    notes.push({ kind: 'dropped', field: 'locked', message: 'native has no field locking' });
  }
  if (frontmatter.get('enabled') === 'false') {
    notes.push({
      kind: 'adapted',
      field: 'enabled',
      message:
        'native keeps enablement in app data, not in the document, so this one arrives switched off in this install and the file stays shareable',
    });
  }

  // Always stated, never assumed: legacy has no permission field, so everything
  // lands on native's default and the user is told so before anything is saved.
  notes.push({
    kind: 'kept',
    field: 'permission',
    message: `legacy documents declare no approval gear, so this lands on "${DEFAULT_SUBAGENT_PERMISSION}" — it follows the session, and migrating changes nobody's permissions`,
  });

  if (!body.trim()) {
    notes.push({
      kind: 'conflict',
      field: 'prompt',
      message: 'the legacy document has an empty body; native needs instructions to load it',
    });
  }

  const blocked = notes.some((note) => note.kind === 'conflict');
  if (blocked) return { source, name, collides, blocked, notes };

  const lines = ['---', `name: ${name}`, `description: ${description}`];
  if (tools.length) lines.push(`tools: [${tools.join(', ')}]`);
  if (modelLine) lines.push(`model: ${modelLine}`);
  if (thinkingLine) lines.push(`thinkingLevel: ${thinkingLine}`);
  if (maxTurnsLine) lines.push(`maxTurns: ${maxTurnsLine}`);
  lines.push('---', '', body);

  return {
    source,
    name,
    targetPath: `${options.targetDir}/${name}.md`,
    document: lines.join('\n'),
    collides,
    blocked: false,
    notes,
  };
}

/** Preview a whole directory's worth, in a stable order. */
export function previewLegacyMigrations(
  documents: readonly LegacyDocument[],
  options: { targetDir: string; existingNames?: readonly string[] }
): MigrationPreview[] {
  return [...documents]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((document) => previewLegacyMigration(document, options));
}
