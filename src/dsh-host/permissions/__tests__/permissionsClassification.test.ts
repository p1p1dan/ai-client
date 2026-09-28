import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAllowlist } from '../../../shared/dshPluginAllowlist.ts';
import {
  classifyTool,
  DSH_TOOL_CLASSES,
  PLUGIN_TOOL_CLASSES,
  pluginToolClass,
} from '../classification.ts';

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
    expect(classifyTool('fixture_ping')).toBe('unknown');
    expect(classifyTool('toString')).toBe('unknown');
    expect(pluginToolClass('toString')).toBeUndefined();
  });
});

/**
 * dsh-rebase P1-10d — the allowlisted plugins' tools (decisions 059, 060):
 * classified by the review, not by the plugin's catalog labels, and kept in
 * step with the allowlist and with what the installed plugin registers.
 */
describe('allowlisted plugin tool classification (P1-10d)', () => {
  const allowlistFile = join(hostDir, 'plugins', 'allowlist.json');
  const { allowlist, failures } = parseAllowlist(JSON.parse(readFileSync(allowlistFile, 'utf8')));

  /** Tool names a plugin's installed lib registers through dsh-tools' `defineTool`. */
  function registeredToolNames(name: string): Set<string> {
    const names = new Set<string>();
    for (const file of libFiles(join(hostDir, 'node_modules', ...name.split('/'), 'lib'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/defineTool\d*\(\{\s*name:\s*["']([a-z_]+)["']/g))
        names.add(match[1]);
    }
    return names;
  }

  it('reads the committed allowlist cleanly', () => {
    expect(failures).toEqual([]);
    expect(allowlist.plugins.map((entry) => entry.name)).toContain('dsh-office-tools');
  });

  it("equals every allowlist entry's refined tools, and nothing else", () => {
    const listed: Record<string, unknown> = {};
    for (const entry of allowlist.plugins) {
      for (const [tool, value] of Object.entries(entry.tools)) {
        if (tool !== '*') listed[tool] = value;
      }
    }
    expect(PLUGIN_TOOL_CLASSES).toEqual(listed);
  });

  it('classifies every tool each installed allowlisted plugin registers', () => {
    for (const entry of allowlist.plugins) {
      const registered = registeredToolNames(entry.name);
      expect(registered.size, entry.name).toBeGreaterThan(0);
      const refined = Object.keys(entry.tools).filter((tool) => tool !== '*');
      // Every tool the plugin registers is refined (none falls to `'*': 'ask'`
      // unnoticed), and nothing refined is missing from the plugin.
      expect([...registered].sort(), entry.name).toEqual(refined.sort());
    }
  });

  it('never overlaps a DSH tool name', () => {
    const shared = Object.keys(PLUGIN_TOOL_CLASSES).filter((name) =>
      Object.hasOwn(DSH_TOOL_CLASSES, name)
    );
    expect(shared).toEqual([]);
  });

  it("gates dsh-office-tools' writes as writes, whatever its catalog says (decision 060 rule 4)", () => {
    expect(['word_read', 'excel_read', 'ppt_read'].map(classifyTool)).toEqual([
      'read',
      'read',
      'read',
    ]);
    for (const name of ['word_create', 'word_update', 'excel_create', 'excel_update', 'ppt_create'])
      expect(classifyTool(name), name).toBe('write');
    for (const value of Object.values(PLUGIN_TOOL_CLASSES)) expect(value.path).toBe('path');
  });
});
