/**
 * P5-1 gate — skills, prompt templates and slash expansion, the wired half.
 *
 * The pure half (frontmatter, discovery, roots, the IO adapter, templates and
 * slash expansion) moved to `src/shared/skills/__tests__/skills.test.ts` with
 * the library (dsh-rebase P1-16 prep), case bodies unchanged. What stays here
 * is what only this runtime has: the prompt block, and a real runtime built
 * over a real directory, because the two things worth proving end to end are
 * that the catalog reaches the system prompt the provider actually receives,
 * and that the `skill` tool loads a file OUTSIDE the workspace without raising
 * a permission card — which is the entire reason the tool exists instead of
 * telling the model to use `read`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { skillsSegment } from '../plugins/skills/prompt.ts';
import { neverAsked } from './fixtures/approval.ts';

const front = (name: string, description: string, body = 'Do the thing.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

/** One assistant turn that does nothing but call the `skill` tool. */
function skillCall(name: string) {
  const message = fauxAssistantMessage('');
  message.content = [{ type: 'toolCall', id: `call-${name}`, name: 'skill', arguments: { name } }];
  message.stopReason = 'toolUse';
  return message;
}

describe('P5-1 prompt block', () => {
  it('emits nothing for an empty catalog and escapes what it emits', () => {
    expect(skillsSegment([])).toBeUndefined();
    const segment = skillsSegment([
      {
        name: 'a&b',
        description: '<danger>',
        filePath: '/x/SKILL.md',
        scope: 'user',
        disableModelInvocation: false,
      },
    ]);
    expect(segment?.slot).toBe('skills');
    expect(segment?.text).toContain('<name>a&amp;b</name>');
    expect(segment?.text).toContain('<description>&lt;danger&gt;</description>');
    expect(segment?.text).toContain('<location>/x/SKILL.md</location>');
  });

  // skills-mcp-09 — the author's opt-out removes the skill from the prompt
  // segment entirely; it does not just hide the description.
  it('drops a disable-model-invocation skill from the segment', () => {
    const hidden = {
      name: 'hidden',
      description: 'd',
      filePath: '/x/SKILL.md',
      scope: 'user' as const,
      disableModelInvocation: true,
    };
    expect(skillsSegment([hidden])).toBeUndefined();
    const shown = {
      name: 'shown',
      description: 'd',
      filePath: '/y/SKILL.md',
      scope: 'user' as const,
      disableModelInvocation: false,
    };
    const segment = skillsSegment([hidden, shown]);
    expect(segment?.text).not.toContain('<name>hidden</name>');
    expect(segment?.text).toContain('<name>shown</name>');
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

  /** T002 — writes a global policy override, same location `shellPolicy.test.ts` uses. */
  async function policy(document: unknown) {
    const path = join(agentDir, 'extensions', 'pi-permission-system', 'config.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(document));
  }

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
      permissions: { approve: neverAsked, ...options.permissions },
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

  // T002/skills-mcp-11 — before the fix, the `skill` tool never called
  // `authorize` at all, so `permission.activity` had no row proving a skill
  // load was ever gated. `source: 'policy'` (not `'session-grant'`) also
  // proves this was the bundled default's `allow`, not a leftover grant.
  it('records a permission.activity row for the skill tool', async () => {
    const { handle, faux } = await runtime({ permissions: { gear: 'ask' } });
    const decisions: Array<{ decision: string; source: string }> = [];
    const unsubscribe = handle.ctx.runtimePermissions.onActivity((record) => {
      if (record.phase === 'decision' && record.request.tool === 'skill')
        decisions.push({ decision: record.decision, source: record.source });
    });
    faux.setResponses([skillCall('pdf'), fauxAssistantMessage('loaded')]);
    await handle.run({ prompt: 'use the pdf skill' });
    unsubscribe();
    expect(decisions).toEqual([{ decision: 'allow', source: 'policy' }]);
  });

  // T002/skills-mcp-11 — before the fix, the `skill` tool read the file
  // straight off the catalog with no gate at all, so a managed environment's
  // `"skill": "deny"` (or a per-name deny) could not stop it.
  it('lets an explicit skill deny policy rule actually block the tool call', async () => {
    await policy({ permission: { skill: 'deny' } });
    const { handle, faux } = await runtime({ permissions: { gear: 'auto' } });
    faux.setResponses([skillCall('pdf'), fauxAssistantMessage('blocked')]);
    let errored = false;
    const result = await handle.run({
      prompt: 'use the pdf skill',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'skill')
          errored = event.isError;
      },
    });
    expect(result.success).toBe(true);
    expect(errored).toBe(true);
  });

  // T002/skills-mcp-11 — `/skill:name` expansion read the body through the
  // exact same unguarded path as the tool; a deny rule has to reach it too.
  it('lets an explicit skill deny policy rule block /skill:name expansion', async () => {
    await policy({ permission: { skill: { pdf: 'deny' } } });
    const { handle } = await runtime({ permissions: { gear: 'auto' } });
    await expect(handle.skills?.expand('/skill:pdf')).rejects.toMatchObject({
      code: 'tool_denied',
    });
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

  // skills-mcp-25 — the catalog knows about a skill (it was there at scan
  // time) but the file is gone by the time the tool reads it; the fallback
  // text at index.ts:225-235 was never covered.
  it('answers the skill tool fallback text when the catalog file can no longer be read', async () => {
    const { handle, faux } = await runtime();
    await rm(join(agentDir, 'skills', 'pdf', 'SKILL.md'));
    faux.setResponses([skillCall('pdf'), fauxAssistantMessage('done')]);
    const texts: string[] = [];
    let errored = false;
    const result = await handle.run({
      prompt: 'use the pdf skill',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'skill') {
          errored = event.isError;
          for (const part of event.result.content) if (part.type === 'text') texts.push(part.text);
        }
      },
    });
    expect(result.success).toBe(true);
    expect(errored).toBeFalsy();
    expect(texts.join('\n')).toContain('could not be read from');
  });

  // skills-mcp-20 — the catalog is a snapshot from worker start; `refresh()`
  // is the missing capability that lets a newly installed skill (or template)
  // become visible without a worker restart.
  it('picks up a newly installed skill and template after refresh()', async () => {
    const { handle, faux } = await runtime();
    let prompt = '';
    faux.setResponses([
      (context) => {
        prompt = context.systemPrompt ?? '';
        return fauxAssistantMessage('done');
      },
    ]);
    await handle.run({ prompt: 'hello' });
    expect(prompt).not.toContain('<name>new-skill</name>');
    expect(handle.skills?.templates.map((item) => item.name)).not.toContain('new-template');

    await mkdir(join(agentDir, 'skills', 'new-skill'), { recursive: true });
    await writeFile(
      join(agentDir, 'skills', 'new-skill', 'SKILL.md'),
      front('new-skill', 'Installed after the worker started')
    );
    await writeFile(
      join(agentDir, 'prompts', 'new-template.md'),
      '---\ndescription: Installed after the worker started\n---\nBody.\n'
    );
    await handle.skills?.refresh();

    let prompt2 = '';
    faux.setResponses([
      (context) => {
        prompt2 = context.systemPrompt ?? '';
        return fauxAssistantMessage('done');
      },
    ]);
    await handle.run({ prompt: 'hello again' });
    expect(prompt2).toContain('<name>new-skill</name>');
    expect(handle.skills?.templates.map((item) => item.name)).toContain('new-template');
  });
});
