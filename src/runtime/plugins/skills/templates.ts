/**
 * P5-1 (K2) — prompt templates, the `/name` half of the composer's slash menu.
 *
 * Provenance: the layout and the frontmatter keys are pi's
 * (`docs/prompt-templates.md`): a flat `prompts/` directory, filename minus
 * `.md` becomes the command, `description` optional with the first non-empty
 * body line as the fallback, `argument-hint` shown in autocomplete. Reading
 * goes through the same {@link SkillSource} port as skills, for D11's reason.
 *
 * Unlike a skill, a template is not advertised to the model at all — it never
 * enters the system prompt. It is a piece of text the USER expands by typing
 * `/name`, which is why loading it is cheap to get wrong quietly: an unparsed
 * template simply never appears in the menu.
 */

import { basename, extname, join } from 'node:path';
import {
  parseFrontmatter,
  type SkillDiagnostic,
  type SkillScope,
  type SkillSource,
} from './loader.ts';

export interface RuntimePromptTemplate {
  name: string;
  description: string;
  /** Shown before the description in autocomplete, e.g. `<PR-URL>`. */
  argumentHint?: string;
  filePath: string;
  scope: SkillScope;
}

export interface TemplateRoot {
  path: string;
  scope: SkillScope;
}

export const MAX_TEMPLATES = 200;
/** A template body is sent as the prompt, so it shares the instruction budget's order of magnitude. */
export const MAX_TEMPLATE_BYTES = 64 * 1024;

function isValidName(name: string): boolean {
  return /^[\w.-]{1,64}$/.test(name);
}

/** Everything after the frontmatter block, which is what `/name` expands to. */
export function templateBody(text: string): string {
  const match = /^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
  return (match ? text.slice(match[0].length) : text).trim();
}

function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.replace(/\s+/g, ' ');
  }
  return '';
}

export interface LoadedTemplates {
  templates: readonly RuntimePromptTemplate[];
  diagnostics: readonly SkillDiagnostic[];
}

/**
 * Scan each root's direct `.md` children. Not recursive: pi's template
 * directory is flat, and `/name` has no syntax for a subdirectory, so a nested
 * file would be loaded and then be unreachable.
 *
 * Later roots win a name collision, same precedence as skills.
 */
export async function loadPromptTemplates(
  source: SkillSource,
  roots: readonly TemplateRoot[]
): Promise<LoadedTemplates> {
  const found: RuntimePromptTemplate[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const root of roots) {
    if (found.length >= MAX_TEMPLATES) {
      diagnostics.push({
        code: 'too_many',
        path: root.path,
        message: `stopped after ${MAX_TEMPLATES} templates; this root was not scanned`,
      });
      continue;
    }
    let entries: readonly { name: string; kind: string }[] | undefined;
    try {
      entries = await source.list(root.path);
    } catch (error) {
      diagnostics.push({
        code: 'read_failed',
        path: root.path,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!entries) continue;
    const ordered = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of ordered) {
      if (found.length >= MAX_TEMPLATES) break;
      if (entry.kind !== 'file' || entry.name.startsWith('.')) continue;
      if (extname(entry.name).toLowerCase() !== '.md') continue;
      const name = basename(entry.name, extname(entry.name));
      if (!isValidName(name)) {
        diagnostics.push({
          code: 'invalid_metadata',
          path: join(root.path, entry.name),
          message: `"${name}" is not usable as a command name`,
        });
        continue;
      }
      const filePath = join(root.path, entry.name);
      let text: string | undefined;
      try {
        text = await source.readText(filePath);
      } catch (error) {
        diagnostics.push({
          code: 'read_failed',
          path: filePath,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (text === undefined) continue;
      const body = templateBody(text);
      if (!body) {
        diagnostics.push({
          code: 'parse_failed',
          path: filePath,
          message: 'template has no body below the frontmatter',
        });
        continue;
      }
      const front = parseFrontmatter(text);
      found.push({
        name,
        description: front?.description?.replace(/\s+/g, ' ').trim() || firstLine(body),
        ...(front?.argumentHint ? { argumentHint: front.argumentHint } : {}),
        filePath,
        scope: root.scope,
      });
    }
  }
  const byName = new Map<string, RuntimePromptTemplate>();
  for (const template of found) byName.set(template.name, template);
  return {
    templates: [...byName.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    ),
    diagnostics,
  };
}
