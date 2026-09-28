import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyTool, DSH_TOOL_CLASSES } from '../classification.ts';

/**
 * dsh-rebase P1-6b — the classification table is a static guard (decision
 * 047): every tool the installed DSH defines must be named, so upgrading DSH
 * cannot put a new tool past the gate as "unknown" without anyone noticing.
 */

const hostDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dshDir = join(hostDir, 'node_modules', '@deepseek-ai');

function libFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  if (existsSync(dir)) visit(dir);
  return out;
}

/** Tool names the installed DSH packages register (their `defineTool` / register calls). */
function definedToolNames(): Set<string> {
  const names = new Set<string>();
  const basePatch = readFileSync(join(dshDir, 'dsh-base', 'cordis.patch.yml'), 'utf8');
  for (const match of basePatch.matchAll(/^\s+toolName:\s*([a-z_]+)\s*$/gm)) names.add(match[1]);
  for (const pkg of readdirSync(dshDir)) {
    for (const file of libFiles(join(dshDir, pkg, 'lib'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/defineTool\(\{\s*name:\s*["']([a-z_]+)["']/g))
        names.add(match[1]);
      // `name: SOME_CONSTANT` inside a defineTool or a raw register call.
      for (const match of text.matchAll(
        /(?:defineTool\(\{|schemaEntry = \{)\s*name:\s*([A-Z_]+)\b/g
      )) {
        const value = text.match(new RegExp(`const ${match[1]} = ["']([a-z_]+)["']`));
        if (value) names.add(value[1]);
      }
      // `name: toolName` with the default from the row's config schema.
      if (/defineTool\(\{\s*name:\s*toolName\b/.test(text)) {
        for (const match of text.matchAll(
          /toolName:\s*z\.string\(\)\.default\(["']([a-z_]+)["']\)/g
        ))
          names.add(match[1]);
      }
    }
  }
  return names;
}

describe('DSH tool classification (decision 047)', () => {
  const defined = definedToolNames();

  it('finds the tools of the installed DSH (the scan itself works)', () => {
    for (const name of [
      'bash',
      'read',
      'write',
      'glob',
      'grep',
      'run_code',
      'workflow',
      'subagent',
      'subagent_fork',
      'list_agents',
      'exit_plan_mode',
      'plugin_manager',
      'structured_output',
      // P1-4d3: the host's own dsh-tool-ask-user, beside dsh-base.
      'ask_user_question',
    ]) {
      expect(defined.has(name), name).toBe(true);
    }
  });

  it('classifies every tool the installed DSH defines', () => {
    const unclassified = [...defined].filter((name) => classifyTool(name) === 'unknown').sort();
    expect(unclassified).toEqual([]);
  });

  it('names no tool the installed DSH does not define', () => {
    const stale = Object.keys(DSH_TOOL_CLASSES).filter((name) => !defined.has(name));
    expect(stale).toEqual([]);
  });

  it('covers the live tool list of the product composition (P1-6b experiment host A)', () => {
    // `ctx.tools.schemas()` on a real host with tool presentation `both`.
    for (const name of [
      // P1-4d3: the product bundle mounts dsh-tool-ask-user (decision 114).
      'ask_user_question',
      'bash',
      'create_goal',
      'edit',
      'exit_plan_mode',
      'get_goal',
      'glob',
      'grep',
      'interrupt_agent',
      'job_kill',
      'job_list',
      'job_output',
      'list_agents',
      'read',
      'read_image',
      'run_code',
      'send_message',
      'skill',
      'subagent',
      'subagent_fork',
      'todo_write',
      'update_goal',
      'workflow',
      'write',
    ]) {
      expect(classifyTool(name), name).not.toBe('unknown');
    }
  });

  it('keeps delegation internal and program runners opaque', () => {
    expect(['subagent', 'subagent_fork', 'todo_write', 'job_output'].map(classifyTool)).toEqual([
      'internal',
      'internal',
      'internal',
      'internal',
    ]);
    // Decision 098: asking the user is the interaction, never gated (1.0.x's `ask` was not).
    expect(classifyTool('ask_user_question')).toBe('internal');
    expect(['run_code', 'workflow', 'plugin_manager'].map(classifyTool)).toEqual([
      'opaque',
      'opaque',
      'opaque',
    ]);
    expect(classifyTool('word_create')).toBe('unknown');
    expect(classifyTool('toString')).toBe('unknown');
  });
});
