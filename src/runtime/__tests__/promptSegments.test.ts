/**
 * P2-1 gate.
 *
 * Two things are worth failing CI over here. First the A3 half: an unfilled
 * prompt slot must carry a reason, so "P1 has not written tool guidance yet"
 * never decays into "nobody noticed the tool guidance is missing". Second the
 * ARD D9 half: assembly has to be order-independent and byte-stable, because
 * the cache hit rate the plan is graded on is a property of the request prefix
 * and nothing else in the test suite would notice it drifting.
 */

import { describe, expect, it } from 'vitest';
import { RuntimeConfigError } from '../contracts.ts';
import {
  baseSegments,
  COLLABORATION_PROMPT,
  IDENTITY_PROMPT,
} from '../plugins/prompt/baseSegments.ts';
import {
  environmentSegment,
  environmentText,
  localDate,
  type PromptEnvironment,
} from '../plugins/prompt/environment.ts';
import {
  composeSystemPrompt,
  deferredSlots,
  PROMPT_SLOTS,
  type PromptSegment,
} from '../plugins/prompt/segments.ts';
import { toolSegments } from '../plugins/tools/prompt.ts';

describe('prompt slot table', () => {
  it('has unique slot ids', () => {
    const ids = PROMPT_SLOTS.map((slot) => slot.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('orders static slots before session and turn slots', () => {
    const rank = { static: 0, session: 1, turn: 2 } as const;
    const ranks = PROMPT_SLOTS.map((slot) => rank[slot.stability]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it.each(
    deferredSlots().map((slot) => [slot.id, slot] as const)
  )('%s explains why nothing fills it yet', (_id, slot) => {
    expect(slot.deferred?.phase).toBeTruthy();
    // A phase label alone ("P1") names an owner but not a reason, which is
    // the shell A3 rules out. The bar is a sentence.
    expect((slot.deferred?.reason ?? '').length).toBeGreaterThan(60);
  });

  it('places environment first in the session band, right after the static slots', () => {
    // The static band must stay a byte-identical prefix across machines, so a
    // slot carrying the cwd cannot sit inside it; first in the session band
    // because nothing in it changes mid-session.
    expect(PROMPT_SLOTS.map((slot) => slot.id)).toEqual([
      'identity',
      'collaboration',
      'tool-protocol',
      'tool-guidance',
      'environment',
      'skills',
      'project-instructions',
      'mode',
      'permission-gear',
    ]);
    expect(PROMPT_SLOTS.find((slot) => slot.id === 'environment')?.stability).toBe('session');
  });

  it('leaves no slot both deferred and filled by P2-1', () => {
    const filled = new Set(baseSegments().map((segment) => segment.slot));
    const conflict = deferredSlots().filter((slot) => filled.has(slot.id));
    expect(conflict).toEqual([]);
  });
});

describe('composeSystemPrompt', () => {
  it('emits P2-1 segments in table order regardless of call order', () => {
    const forward = composeSystemPrompt(baseSegments());
    const reversed = composeSystemPrompt([...baseSegments()].reverse());
    expect(forward.text).toBe(reversed.text);
    expect(forward.text).toBe(`${IDENTITY_PROMPT}\n\n${COLLABORATION_PROMPT}`);
    expect(forward.segments.map((segment) => segment.slot)).toEqual(['identity', 'collaboration']);
  });

  it('counts the whole P2-1 prompt as cacheable static prefix', () => {
    const composed = composeSystemPrompt(baseSegments());
    expect(composed.staticPrefixBytes).toBe(composed.bytes);
    expect(composed.bytes).toBe(Buffer.byteLength(composed.text));
  });

  it('stops the static prefix at the first session-scoped segment', () => {
    const withSession: PromptSegment[] = [
      ...baseSegments(),
      { slot: 'project-instructions', text: '# Project instructions\n\nuse tabs' },
    ];
    const composed = composeSystemPrompt(withSession);
    const staticOnly = composeSystemPrompt(baseSegments());
    expect(composed.staticPrefixBytes).toBe(staticOnly.bytes);
    expect(composed.bytes).toBeGreaterThan(composed.staticPrefixBytes);
    // The static part must still be a literal prefix of the whole prompt, or
    // the number is not describing anything a provider could reuse.
    expect(composed.text.startsWith(staticOnly.text)).toBe(true);
  });

  it('drops blank contributions instead of emitting a blank line', () => {
    const composed = composeSystemPrompt([
      ...baseSegments(),
      { slot: 'project-instructions', text: '   \n  ' },
    ]);
    expect(composed.text).toBe(composeSystemPrompt(baseSegments()).text);
    expect(composed.segments.map((segment) => segment.slot)).not.toContain('project-instructions');
  });

  it('trims contributed text so a stray newline cannot shift the suffix', () => {
    const composed = composeSystemPrompt([{ slot: 'identity', text: `\n${IDENTITY_PROMPT}\n\n` }]);
    expect(composed.text).toBe(IDENTITY_PROMPT);
  });

  it('rejects an unknown slot rather than appending it', () => {
    expect(() => composeSystemPrompt([{ slot: 'epilogue', text: 'x' }])).toThrow(
      RuntimeConfigError
    );
  });

  it('rejects two contributions to one slot', () => {
    expect(() =>
      composeSystemPrompt([
        { slot: 'identity', text: 'a' },
        { slot: 'identity', text: 'b' },
      ])
    ).toThrow(RuntimeConfigError);
  });

  it('composes nothing from no contributions', () => {
    const composed = composeSystemPrompt([]);
    expect(composed).toEqual({ text: '', segments: [], bytes: 0, staticPrefixBytes: 0 });
  });

  it('counts only the leading static system-prompt segments in staticPrefixBytes', () => {
    // context-prompt-16. The number used to be described as "the floor of what
    // a provider could serve from cache", which it is not: the tool DEFINITIONS
    // sit ahead of the system prompt in the request and change with the mode,
    // so a stable number here says nothing about the cache on its own. What it
    // does mean — bytes of system prompt that never vary within a build — is
    // what this pins, including that a session or turn slot never counts even
    // when the static ones are all present.
    const statics: PromptSegment[] = [
      { slot: 'identity', text: 'IDENT' },
      { slot: 'collaboration', text: 'COLLAB' },
    ];
    const bare = composeSystemPrompt(statics);
    const withLater = composeSystemPrompt([
      ...statics,
      { slot: 'project-instructions', text: 'PROJECT' },
      { slot: 'mode', text: 'MODE' },
    ]);
    expect(bare.staticPrefixBytes).toBe(bare.bytes);
    expect(withLater.staticPrefixBytes).toBe(bare.bytes);
    expect(withLater.bytes).toBeGreaterThan(withLater.staticPrefixBytes);
  });
});

describe('tool guidance', () => {
  /** Exactly the names `plugins/tools/index.ts` registers. */
  const REGISTERED = ['read', 'write', 'edit', 'bash', 'glob', 'grep'];

  it('names every tool the way the registry spells it', () => {
    // context-prompt-14. The block wrote `Read`, `Edit` and `Bash` next to a
    // correctly lower-cased `glob`/`grep`, inviting the model to call a name
    // the registry does not have and lose a turn to the miss. This block is in
    // the cached prefix, so the invitation was in every request of every run.
    const guidance = toolSegments().find((segment) => segment.slot === 'tool-guidance');
    expect(guidance).toBeDefined();
    for (const name of REGISTERED) {
      const capitalized = `${name[0].toUpperCase()}${name.slice(1)}`;
      expect(guidance?.text).not.toMatch(new RegExp(`\\b${capitalized}\\b`));
    }
    expect(guidance?.text).toContain('read');
    expect(guidance?.text).toContain('edit');
    expect(guidance?.text).toContain('bash');
  });

  it('sends tree search to glob and grep rather than to the shell (tools-20)', () => {
    // A Windows field run spent 183 s on `grep -ran` and 120 s on `find .`
    // through bash, on a tree the glob tool crosses in a fraction of that. The
    // block named glob and grep but never said not to shell out, and a model
    // that reaches for `rg` by habit has no reason to read the omission as a
    // rule.
    const guidance = toolSegments().find((segment) => segment.slot === 'tool-guidance');
    expect(guidance?.text).toMatch(/Search the tree with those two rather than through the shell/);
    expect(guidance?.text).toMatch(/running grep, find, rg, ls -R or dir as a command/);
  });

  it('never states that a write-capable tool exists', () => {
    // Plan mode removes `write` and `edit` from the registry (ARD D14), and
    // this text is in the `static` band, so it cannot know which mode is
    // active. Every mention has to be conditional; the `mode` segment is where
    // the authoritative statement lives.
    const guidance = toolSegments().find((segment) => segment.slot === 'tool-guidance');
    expect(guidance?.text).toContain('When edit is available');
    expect(guidance?.text).toContain('whichever of read, write and edit are available');
    expect(guidance?.text).not.toMatch(/Prefer the available read\/write\/edit tools/);
  });
});

describe('environment segment', () => {
  // Field bug: on Windows with workspace `F:\tmp` the prompt never named the
  // working directory, and the model searched `C:\` for an `@file`.
  const windows: PromptEnvironment = {
    root: 'F:\\tmp',
    platform: 'win32',
    shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
    date: '2026-09-25',
  };
  const linux: PromptEnvironment = {
    root: '/home/me/project',
    platform: 'linux',
    shellPath: '/bin/bash',
    date: '2026-09-25',
  };

  it('renders the Windows facts, Git Bash path advice included', () => {
    expect(environmentText(windows)).toBe(
      'Environment: the working directory is F:\\tmp. Relative paths in tool calls resolve against it, and each bash command starts there. In a user message, @path (for example @docs/notes.md) refers to that file relative to the working directory. Platform: Windows. The bash tool runs C:\\Program Files\\Git\\bin\\bash.exe (Git Bash), not cmd or PowerShell: use POSIX shell syntax, and write Windows paths with forward slashes (F:/tmp) or quote them. Current date: 2026-09-25 (taken when this session started).'
    );
  });

  it('renders the Linux facts', () => {
    expect(environmentText(linux)).toBe(
      'Environment: the working directory is /home/me/project. Relative paths in tool calls resolve against it, and each bash command starts there. In a user message, @path (for example @docs/notes.md) refers to that file relative to the working directory. Platform: Linux. The bash tool runs /bin/bash. Current date: 2026-09-25 (taken when this session started).'
    );
    expect(environmentText({ ...linux, platform: 'darwin' })).toContain('Platform: macOS.');
  });

  it('names no shell when there is no bash tool, or the caller has none', () => {
    // No `shellPath` means `plugins/tools/index.ts` registered no `bash`
    // (windows-04); `bash: false` is a delegate whose definition lacks it.
    const { shellPath: _unused, ...withoutShell } = windows;
    for (const text of [environmentText(withoutShell), environmentText(windows, { bash: false })]) {
      expect(text).toContain('the working directory is F:\\tmp.');
      expect(text).toContain('Platform: Windows.');
      expect(text).not.toMatch(/bash/i);
    }
  });

  it('fills the environment slot without moving the static prefix', () => {
    const statics = [...baseSegments(), ...toolSegments()];
    const staticOnly = composeSystemPrompt(statics);
    const composed = composeSystemPrompt([
      { slot: 'project-instructions', text: 'PROJECT' },
      environmentSegment(linux),
      { slot: 'skills', text: 'SKILLS' },
      ...statics,
    ]);
    expect(composed.segments.map((segment) => segment.slot)).toEqual([
      'identity',
      'collaboration',
      'tool-protocol',
      'tool-guidance',
      'environment',
      'skills',
      'project-instructions',
    ]);
    expect(composed.staticPrefixBytes).toBe(staticOnly.bytes);
    expect(composed.text.startsWith(`${staticOnly.text}\n\n${environmentText(linux)}`)).toBe(true);
  });

  it('formats the local calendar date without a time', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59, 59))).toBe('2026-01-05');
    expect(localDate(new Date(2026, 11, 31, 0, 0, 0))).toBe('2026-12-31');
  });
});
