// Moved from src/runtime/plugins/skills/loader.ts (dsh-rebase P1-16 prep): the frontmatter reader and the diagnostic shape.

/**
 * The `---` header every skill and prompt template starts with.
 *
 * Split out of the loader so the prompt-template reader and the DSH skill
 * compatibility report can share the one reader the 1.0.x runtime used; the
 * rules themselves are unchanged — see `parseFrontmatter`.
 */

export type SkillDiagnosticCode = 'read_failed' | 'parse_failed' | 'invalid_metadata' | 'too_many';

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  message: string;
  path: string;
}

/** Frontmatter delimiters, tolerant of a BOM and CRLF the way pi is. */
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * skills-mcp-10 — a bare YAML block-scalar indicator (`|`, `>`), optionally
 * with a chomping (`+`/`-`) and/or indentation digit, and nothing else. This
 * is what a folded/literal value (`description: >`) looks like to this
 * reader: the real content lives on the indented lines below, which are
 * skipped by design, so the key's own line has only the indicator left.
 */
const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?\d?[+-]?$/;

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** Prompt templates use it; parsed here because both share this reader. */
  argumentHint?: string;
  /** skills-mcp-09 — `true` only when the frontmatter literally says so. */
  disableModelInvocation?: boolean;
}

/** Where a frontmatter diagnostic should land. Optional: pure callers (tests) skip reporting. */
export interface FrontmatterReport {
  diagnostics: SkillDiagnostic[];
  path: string;
}

/**
 * Read the leading `---` block as a flat map of scalars.
 *
 * Deliberately NOT a YAML parser. The fields that matter here are all one-line
 * scalars, and pulling a YAML dependency into the runtime subpackage to read
 * three of them would add a parser — and its failure modes — to the trusted
 * path that composes the system prompt. A file whose frontmatter needs real
 * YAML simply does not declare a description, and is reported as such: a key
 * whose value is a bare block-scalar indicator is dropped (never returned as
 * if `>` or `|` were the actual value) and, when `report` is supplied, logged
 * as an `invalid_metadata` diagnostic naming the key.
 */
export function parseFrontmatter(
  text: string,
  report?: FrontmatterReport
): SkillFrontmatter | undefined {
  const match = FRONTMATTER.exec(text);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    // Indented lines belong to a nested structure this reader does not model;
    // skipping them is what keeps a list-valued key from being read as a scalar.
    if (separator <= 0 || /^\s/.test(line)) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    if (BLOCK_SCALAR_INDICATOR.test(value)) {
      report?.diagnostics.push({
        code: 'invalid_metadata',
        path: report.path,
        message: `frontmatter key "${key}" uses a YAML block scalar ("${value}"), which this reader does not parse; use a one-line value instead`,
      });
      continue;
    }
    fields[key] = value;
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields['argument-hint'] ? { argumentHint: fields['argument-hint'] } : {}),
    ...(fields['disable-model-invocation'] !== undefined
      ? { disableModelInvocation: fields['disable-model-invocation'].toLowerCase() === 'true' }
      : {}),
  };
}
