/**
 * P5-1 gate — skills, prompt templates and slash expansion.
 *
 * Two halves, deliberately split:
 *
 * - The **pure** half runs the loader against an in-memory tree through
 *   {@link SkillSource}, the same way `projectInstructions.test.ts` does. Every
 *   discovery rule ported from pi is pinned here, because each of them fails
 *   SILENTLY: a skill in the wrong kind of root, a missing description, a name
 *   that cannot be a command — none of those throws, they just make the user's
 *   skill not exist.
 * - The **wired** half builds a real runtime over a real directory, because the
 *   two things worth proving end to end are that the catalog reaches the system
 *   prompt the provider actually receives, and that the `skill` tool loads a
 *   file OUTSIDE the workspace without raising a permission card — which is the
 *   entire reason the tool exists instead of telling the model to use `read`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import {
  expandPrompt,
  formatSkillInvocation,
  parseCommandArgs,
  parseSlashInvocation,
  substituteArgs,
} from '../plugins/skills/expand.ts';
import { skillRoots, templateRoots } from '../plugins/skills/index.ts';
import {
  loadSkills,
  MAX_DESCRIPTION_BYTES,
  parseFrontmatter,
  type SkillRoot,
  type SkillSource,
} from '../plugins/skills/loader.ts';
import { skillsSegment } from '../plugins/skills/prompt.ts';
import { loadPromptTemplates, templateBody } from '../plugins/skills/templates.ts';

/** In-memory tree. Directories are implied by the keys, as on a real filesystem. */
function fakeSource(files: Record<string, string>): SkillSource {
  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    for (
      let parent = join(path, '..');
      parent !== join(parent, '..');
      parent = join(parent, '..')
    ) {
      directories.add(parent);
    }
  }
  return {
    async readText(path) {
      return files[path];
    },
    async list(path) {
      if (!directories.has(path)) return undefined;
      const children = new Map<string, 'file' | 'directory'>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(`${path}/`)) continue;
        const rest = file.slice(path.length + 1);
        const slash = rest.indexOf('/');
        children.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'directory');
      }
      return [...children].map(([name, kind]) => ({ name, kind }));
    },
  };
}

const USER: SkillRoot = { path: '/agent/skills', scope: 'user', rootMarkdown: true };
const AGENTS: SkillRoot = { path: '/home/.agents/skills', scope: 'user', rootMarkdown: false };
const PROJECT: SkillRoot = { path: '/work/.pi/skills', scope: 'project', rootMarkdown: true };

const front = (name: string, description: string, body = 'Do the thing.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

/** One assistant turn that does nothing but call the `skill` tool. */
function skillCall(name: string) {
  const message = fauxAssistantMessage('');
  message.content = [{ type: 'toolCall', id: `call-${name}`, name: 'skill', arguments: { name } }];
  message.stopReason = 'toolUse';
  return message;
}

describe('P5-1 frontmatter', () => {
  it('reads one-line scalars and strips matching quotes', () => {
    expect(
      parseFrontmatter('---\nname: a\ndescription: "b: c"\nargument-hint: \'<x>\'\n---\nbody')
    ).toEqual({ name: 'a', description: 'b: c', argumentHint: '<x>' });
  });

  it('answers undefined without a leading delimiter block', () => {
    expect(parseFrontmatter('# Just a document\n')).toBeUndefined();
  });

  it('ignores indented lines rather than reading a nested key as a scalar', () => {
    // `allowed-tools:` with a YAML list under it is legal in the standard and
    // this reader does not model it. What matters is that it does not turn the
    // first list item into the value of some key.
    const parsed = parseFrontmatter(
      '---\nname: a\nallowed-tools:\n  - read\n  - bash\ndescription: d\n---\nbody'
    );
    expect(parsed).toEqual({ name: 'a', description: 'd' });
  });

  it('tolerates CRLF and a BOM', () => {
    expect(parseFrontmatter('﻿---\r\nname: a\r\ndescription: d\r\n---\r\nbody')).toEqual({
      name: 'a',
      description: 'd',
    });
  });
});

describe('P5-1 skill discovery', () => {
  it('finds SKILL.md directories and, in a pi-style root only, loose markdown', async () => {
    const source = fakeSource({
      '/agent/skills/loose.md': front('loose', 'A loose skill'),
      '/agent/skills/packaged/SKILL.md': front('packaged', 'A packaged skill'),
      '/home/.agents/skills/ignored.md': front('ignored', 'Root markdown in an .agents root'),
      '/home/.agents/skills/group/nested.md': front('nested', 'Nested markdown declares itself'),
    });
    const { skills } = await loadSkills(source, [USER, AGENTS]);
    expect(skills.map((skill) => skill.name)).toEqual(['loose', 'nested', 'packaged']);
  });

  it('treats SKILL.md at the top of a pi-style root as a loose root file', async () => {
    // There is no directory to name it after, so the filename supplies the
    // fallback. Below the root the directory branch consumes it instead.
    const source = fakeSource({ '/agent/skills/SKILL.md': front('toplevel', 'At the root') });
    const { skills } = await loadSkills(source, [USER]);
    expect(skills.map((skill) => skill.name)).toEqual(['toplevel']);
  });

  it("does not treat a skill directory's subdirectories as more skills", async () => {
    const source = fakeSource({
      '/agent/skills/outer/SKILL.md': front('outer', 'The skill'),
      '/agent/skills/outer/reference/SKILL.md': front('inner', 'An asset that looks like a skill'),
    });
    const { skills } = await loadSkills(source, [USER]);
    expect(skills.map((skill) => skill.name)).toEqual(['outer']);
  });

  it('falls back to the directory name and keeps a name that differs from it', async () => {
    const source = fakeSource({
      '/agent/skills/by-dir/SKILL.md': '---\ndescription: No name field\n---\nbody',
      '/agent/skills/other-dir/SKILL.md': front('declared', 'Name differs from directory'),
    });
    const { skills } = await loadSkills(source, [USER]);
    expect(skills.map((skill) => skill.name).sort()).toEqual(['by-dir', 'declared']);
  });

  it('reports a declared skill with no description and stays silent about undeclared files', async () => {
    const source = fakeSource({
      '/agent/skills/broken/SKILL.md': '---\nname: broken\n---\nbody',
      '/agent/skills/README.md': '# Not a skill\n',
    });
    const { skills, diagnostics } = await loadSkills(source, [USER]);
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([
      {
        code: 'invalid_metadata',
        path: join('/agent/skills/broken', 'SKILL.md'),
        message: 'frontmatter has no non-empty description',
      },
    ]);
  });

  it('refuses a name that cannot address the skill tool', async () => {
    const source = fakeSource({
      '/agent/skills/a/SKILL.md': front('has space', 'd'),
      '/agent/skills/b/SKILL.md': front('../escape', 'd'),
    });
    const { skills, diagnostics } = await loadSkills(source, [USER]);
    expect(skills).toEqual([]);
    expect(diagnostics.map((item) => item.code)).toEqual(['invalid_metadata', 'invalid_metadata']);
  });

  it('lets a project root override a user skill of the same name', async () => {
    const source = fakeSource({
      '/agent/skills/review/SKILL.md': front('review', 'User version'),
      '/work/.pi/skills/review/SKILL.md': front('review', 'Project version'),
    });
    const { skills } = await loadSkills(source, [USER, PROJECT]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ description: 'Project version', scope: 'project' });
  });

  it('collapses a multi-line description and caps it', async () => {
    const long = 'x'.repeat(MAX_DESCRIPTION_BYTES + 50);
    const source = fakeSource({
      '/agent/skills/a/SKILL.md': `---\nname: a\ndescription: ${long}\n---\nbody`,
    });
    const { skills } = await loadSkills(source, [USER]);
    expect(Buffer.byteLength(skills[0].description)).toBe(MAX_DESCRIPTION_BYTES);
  });

  it('returns names in a stable order regardless of directory listing order', async () => {
    const source = fakeSource({
      '/agent/skills/zebra/SKILL.md': front('zebra', 'z'),
      '/agent/skills/alpha/SKILL.md': front('alpha', 'a'),
      '/agent/skills/mid/SKILL.md': front('mid', 'm'),
    });
    const { skills } = await loadSkills(source, [USER]);
    expect(skills.map((skill) => skill.name)).toEqual(['alpha', 'mid', 'zebra']);
  });

  it('skips a root that is not there at all', async () => {
    const { skills, diagnostics } = await loadSkills(fakeSource({}), [USER, AGENTS]);
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});

describe('P5-1 root selection', () => {
  it('withholds project roots until the folder is trusted', () => {
    const untrusted = skillRoots({ agentDir: '/agent', cwd: '/work', home: '/home' });
    expect(untrusted.map((root) => root.path)).toEqual([
      join('/agent', 'skills'),
      join('/home', '.agents', 'skills'),
    ]);
    const trusted = skillRoots({
      agentDir: '/agent',
      cwd: '/work',
      home: '/home',
      projectTrusted: true,
    });
    expect(trusted.map((root) => root.path)).toEqual([
      join('/agent', 'skills'),
      join('/home', '.agents', 'skills'),
      join('/work', '.pi', 'skills'),
      join('/work', '.agents', 'skills'),
    ]);
    expect(templateRoots({ agentDir: '/agent', cwd: '/work' }).map((root) => root.path)).toEqual([
      join('/agent', 'prompts'),
    ]);
  });
});

describe('P5-1 prompt templates', () => {
  it('reads description and argument hint, and falls back to the first body line', async () => {
    const source = fakeSource({
      '/agent/prompts/review.md':
        '---\ndescription: Review staged changes\nargument-hint: "<PR-URL>"\n---\nReview $1 now.\n',
      '/agent/prompts/plain.md': 'Just do the work.\nSecond line.\n',
      '/agent/prompts/notes.txt': 'ignored',
    });
    const { templates } = await loadPromptTemplates(source, [
      { path: '/agent/prompts', scope: 'user' },
    ]);
    expect(templates).toEqual([
      {
        name: 'plain',
        description: 'Just do the work.',
        filePath: join('/agent/prompts', 'plain.md'),
        scope: 'user',
      },
      {
        name: 'review',
        description: 'Review staged changes',
        argumentHint: '<PR-URL>',
        filePath: join('/agent/prompts', 'review.md'),
        scope: 'user',
      },
    ]);
  });

  it('is not recursive, because /name has no syntax for a subdirectory', async () => {
    const source = fakeSource({ '/agent/prompts/group/deep.md': 'body' });
    const { templates } = await loadPromptTemplates(source, [
      { path: '/agent/prompts', scope: 'user' },
    ]);
    expect(templates).toEqual([]);
  });

  it('strips the frontmatter from the body', () => {
    expect(templateBody('---\ndescription: d\n---\nthe body\n')).toBe('the body');
    expect(templateBody('no frontmatter\n')).toBe('no frontmatter');
  });
});

describe('P5-1 slash expansion', () => {
  it('recognises only a leading slash command', () => {
    expect(parseSlashInvocation('/review the diff')).toEqual({
      kind: 'template',
      name: 'review',
      args: 'the diff',
    });
    expect(parseSlashInvocation('/skill:pdf-tools extract')).toEqual({
      kind: 'skill',
      name: 'pdf-tools',
      args: 'extract',
    });
    expect(parseSlashInvocation('look in /tmp for it')).toBeUndefined();
    expect(parseSlashInvocation('/usr/bin/env')).toBeUndefined();
  });

  it('keeps trailing lines as the argument text, on the same line or below it', () => {
    expect(parseSlashInvocation('/review line one\nline two')?.args).toBe('line one\nline two');
    expect(parseSlashInvocation('/review\nline one\nline two')?.args).toBe('line one\nline two');
    expect(parseSlashInvocation('/review')?.args).toBe('');
  });

  it('substitutes positional, slice and all-argument placeholders like pi does', () => {
    const args = parseCommandArgs('one "two three" four');
    expect(args).toEqual(['one', 'two three', 'four']);
    expect(substituteArgs('[$1][$2][$9]', args)).toBe('[one][two three][]');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: `${@:N}` is pi's slice placeholder, not a JS template
    const slices = '[${@:2}][${@:1:2}]';
    expect(substituteArgs(slices, args)).toBe('[two three four][one two three]');
    expect(substituteArgs('[$ARGUMENTS][$@]', args)).toBe(
      '[one two three four][one two three four]'
    );
  });

  it('expands a template and a skill, and passes unknown commands through untouched', async () => {
    const skill = {
      name: 'pdf',
      description: 'd',
      filePath: '/agent/skills/pdf/SKILL.md',
      scope: 'user' as const,
    };
    const catalog = {
      skills: [skill],
      templates: [
        {
          name: 'review',
          description: 'd',
          filePath: '/agent/prompts/review.md',
          scope: 'user' as const,
        },
      ],
      readBody: async (path: string) =>
        path.endsWith('review.md') ? 'Review $1.' : 'Skill instructions.',
    };
    await expect(expandPrompt('/review HEAD', catalog)).resolves.toEqual({
      expanded: true,
      text: 'Review HEAD.',
      invocation: { kind: 'template', name: 'review', args: 'HEAD' },
    });
    const skillResult = await expandPrompt('/skill:pdf extract page 2', catalog);
    expect(skillResult).toMatchObject({ expanded: true });
    if (skillResult.expanded) {
      expect(skillResult.text).toBe(
        formatSkillInvocation(skill, 'Skill instructions.', 'extract page 2')
      );
      expect(skillResult.text).toContain('User: extract page 2');
      expect(skillResult.text).toContain('location="/agent/skills/pdf/SKILL.md"');
    }
    // `/new`, `/settings` and `/compact` never reach the worker; anything else
    // the catalog does not know goes to the model exactly as typed.
    await expect(expandPrompt('/unknown thing', catalog)).resolves.toEqual({
      expanded: false,
      reason: 'unknown_command',
    });
    await expect(expandPrompt('plain prompt', catalog)).resolves.toEqual({ expanded: false });
  });
});

describe('P5-1 prompt block', () => {
  it('emits nothing for an empty catalog and escapes what it emits', () => {
    expect(skillsSegment([])).toBeUndefined();
    const segment = skillsSegment([
      { name: 'a&b', description: '<danger>', filePath: '/x/SKILL.md', scope: 'user' },
    ]);
    expect(segment?.slot).toBe('skills');
    expect(segment?.text).toContain('<name>a&amp;b</name>');
    expect(segment?.text).toContain('<description>&lt;danger&gt;</description>');
    expect(segment?.text).toContain('<location>/x/SKILL.md</location>');
  });
});

describe('P5-1 wired into a real runtime', () => {
  let dir: string;
  let root: string;
  let agentDir: string;
  const runtimes: RuntimeHandle[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-skills-'));
    root = join(dir, 'project');
    agentDir = join(dir, 'agent');
    await mkdir(join(agentDir, 'skills', 'pdf'), { recursive: true });
    await mkdir(join(agentDir, 'prompts'), { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(
      join(agentDir, 'skills', 'pdf', 'SKILL.md'),
      front('pdf', 'Extract text from PDFs', 'STEP ONE: open the file.')
    );
    await writeFile(
      join(agentDir, 'prompts', 'review.md'),
      '---\ndescription: Review staged changes\n---\nReview $1 carefully.\n'
    );
  });

  afterEach(async () => {
    for (const handle of runtimes.splice(0)) await handle.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  async function runtime(options: Partial<RuntimeBootstrapOptions> = {}) {
    const faux = fauxProvider({
      provider: 'test',
      models: [{ id: 'test', name: 'Test', contextWindow: 128_000 }],
    });
    const handle = await createRuntime({
      env: {},
      traceDir: null,
      providers: [faux.provider],
      tools: { cwd: root },
      agentDir,
      // `home` points at an empty directory so the developer's own
      // `~/.agents/skills` cannot leak into the assertion.
      skills: { home: join(dir, 'empty-home') },
      ...options,
    });
    runtimes.push(handle);
    return { handle, faux };
  }

  it('puts the catalog in the system prompt the provider receives', async () => {
    const { handle, faux } = await runtime();
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('done');
      },
    ]);
    await handle.run({ prompt: 'hello' });
    expect(prompts[0]).toContain('<available_skills>');
    expect(prompts[0]).toContain('<name>pdf</name>');
    expect(prompts[0]).toContain('<description>Extract text from PDFs</description>');
    // A template is the user's shortcut, not something the model is told about.
    expect(prompts[0]).not.toContain('Review staged changes');
    expect(prompts[0]).not.toContain('Review $1 carefully.');
    expect(handle.skills?.templates.map((item) => item.name)).toEqual(['review']);
  });

  it('says nothing at all when discovery is not configured', async () => {
    const { handle, faux } = await runtime({ skills: undefined });
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('done');
      },
    ]);
    await handle.run({ prompt: 'hello' });
    expect(prompts[0]).not.toContain('available_skills');
    expect(handle.skills).toBeUndefined();
  });

  it('loads a skill outside the workspace through the tool without asking for approval', async () => {
    const { handle, faux } = await runtime({
      // No `approve` at all: the permission engine throws "approval UI is not
      // connected" if anything reaches the ask path, so this run PROVES the
      // skill tool never gates. That is the property the tool exists for — the
      // same file read through `read` would be outside cwd and therefore `ask`.
      permissions: { gear: 'ask' },
    });
    faux.setResponses([skillCall('pdf'), fauxAssistantMessage('loaded')]);
    const results: string[] = [];
    const result = await handle.run({
      prompt: 'use the pdf skill',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'skill') {
          for (const part of event.result.content)
            if (part.type === 'text') results.push(part.text);
        }
      },
    });
    expect(result.success).toBe(true);
    expect(results.join('\n')).toContain('STEP ONE: open the file.');
    expect(results.join('\n')).toContain('location=');
  });

  it('answers an unknown skill name with the list instead of failing the turn', async () => {
    const { handle, faux } = await runtime();
    faux.setResponses([skillCall('nope'), fauxAssistantMessage('ok')]);
    const texts: string[] = [];
    const result = await handle.run({
      prompt: 'use nope',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'skill') {
          expect(event.isError).toBeFalsy();
          for (const part of event.result.content) if (part.type === 'text') texts.push(part.text);
        }
      },
    });
    expect(result.success).toBe(true);
    expect(texts.join('\n')).toContain('No skill named "nope"');
    expect(texts.join('\n')).toContain('Available: pdf');
  });

  it('expands what the user typed against the live catalog', async () => {
    const { handle } = await runtime();
    await expect(handle.skills?.expand('/review HEAD~1')).resolves.toEqual({
      expanded: true,
      text: 'Review HEAD~1 carefully.',
      invocation: { kind: 'template', name: 'review', args: 'HEAD~1' },
    });
    const skill = await handle.skills?.expand('/skill:pdf');
    expect(skill).toMatchObject({ expanded: true });
    if (skill?.expanded) expect(skill.text).toContain('STEP ONE: open the file.');
  });
});
