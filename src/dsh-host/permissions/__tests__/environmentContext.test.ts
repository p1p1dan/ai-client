import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DshAgentView } from '../dshTypes.ts';
import {
  ENVIRONMENT_PROMPT_CONTEXT,
  type EnvironmentFacts,
  environmentPromptText,
  localDateText,
} from '../environmentContext.ts';
import { apply } from '../plugin.ts';
import { agent, createFakeDsh } from './fakeDsh.ts';

/**
 * Decision 164 (GitHub issue #2) — the `aiclient:environment` runtime context:
 * the facts it states per platform, the date granularity that bounds how
 * often DSH appends a new snapshot, and that paths reach the model through
 * prompt variables DSH's own renderer substitutes verbatim.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_SYSTEM_PROMPT = resolve(
  HERE,
  '../../node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
);

/** 12:00 in Shanghai. */
const NOON = new Date('2026-10-09T04:00:00Z');

function windows(overrides: Partial<EnvironmentFacts> = {}): EnvironmentFacts {
  return {
    platform: 'win32',
    release: '10.0.26100',
    version: 'Windows 11 Pro',
    arch: 'x64',
    homedir: 'C:\\Users\\tester',
    now: () => NOON,
    timeZone: () => 'Asia/Shanghai',
    ...overrides,
  };
}

function linux(overrides: Partial<EnvironmentFacts> = {}): EnvironmentFacts {
  return windows({
    platform: 'linux',
    release: '6.8.0-45-generic',
    version: '#45-Ubuntu SMP PREEMPT_DYNAMIC',
    homedir: '/home/tester',
    ...overrides,
  });
}

const session = agent('aiclient-root', { cwd: 'E:\\code\\proj' });

describe('the aiclient:environment text', () => {
  it('states the Windows facts, the conflict rule and the unknown-tool rule', () => {
    const text = environmentPromptText(windows(), session);
    expect(text).toContain('Operating system: Windows 11 Pro (10.0.26100, win32, x64).');
    expect(text).toContain('drive letter');
    expect(text).toContain('a POSIX path such as /Users/...');
    expect(text).toContain('Shell tool: `pwsh`');
    expect(text).toContain('There is no bash tool in this session.');
    expect(text).toContain('{{aiclient_cwd}}');
    expect(text).toContain('Home directory: {{aiclient_home}}');
    expect(text).toContain("Today's date: 2026-10-09 (time zone Asia/Shanghai, UTC+08:00)");
    expect(text).toContain('it does not apply to this session: rely on the facts above');
    expect(text).toContain('If a tool call fails with "unknown tool", that tool does not exist');
    // Paths only through the variables, never spliced into the text.
    expect(text).not.toContain('E:\\code\\proj');
    expect(text).not.toContain('C:\\Users\\tester');
    // Tool names are not claimed lowercase, nor are Read / Edit / Write denied (pi-ai OAuth casing).
    expect(text).not.toMatch(/lowercase|\bRead\b|\bWrite\b|\bEdit\b/);
  });

  it('states bash and POSIX paths on Linux, and no pwsh', () => {
    const text = environmentPromptText(
      linux(),
      agent('aiclient-root', { cwd: '/home/tester/proj' })
    );
    expect(text).toContain('Operating system: Linux 6.8.0-45-generic (linux, x64).');
    expect(text).toContain('POSIX paths');
    expect(text).toContain('Shell tool: `bash`.');
    expect(text).not.toMatch(/pwsh|PowerShell/);
    expect(text).not.toContain('#45-Ubuntu');
  });

  it('names macOS on darwin', () => {
    expect(
      environmentPromptText(windows({ platform: 'darwin', release: '25.0.0' }), session)
    ).toContain('Operating system: macOS (Darwin 25.0.0, darwin, x64).');
  });

  it('is the same all day in the zone and changes past its midnight', () => {
    const at = (iso: string) =>
      environmentPromptText(windows({ now: () => new Date(iso) }), session);
    // 00:30 and 23:30 in Shanghai, the same local day.
    expect(at('2026-10-08T16:30:00Z')).toBe(at('2026-10-09T15:30:00Z'));
    // 00:30 the next day there.
    expect(at('2026-10-09T16:30:00Z')).not.toBe(at('2026-10-09T15:30:00Z'));
    expect(at('2026-10-09T16:30:00Z')).toContain("Today's date: 2026-10-10 ");
  });

  it('says nothing without an agent', () => {
    expect(environmentPromptText(windows(), undefined)).toBe('');
  });

  it('drops the working directory line without a header cwd, and the home line without a home', () => {
    const noCwd = environmentPromptText(windows(), agent('aiclient-root'));
    expect(noCwd).not.toContain('Working directory');
    expect(noCwd).not.toContain('{{aiclient_cwd}}');
    expect(noCwd).toContain('{{aiclient_home}}');
    const noHome = environmentPromptText(windows({ homedir: '' }), session);
    expect(noHome).not.toContain('Home directory');
    expect(noHome).not.toContain('{{aiclient_home}}');
  });

  it('keeps braces of OS-reported text out of the template', () => {
    const text = environmentPromptText(windows({ version: 'Windows {{x}}' }), session);
    expect(text).toContain('Windows x (10.0.26100');
    expect(text.match(/\{\{/g)).toHaveLength(2);
  });
});

describe('the local date', () => {
  it('gives the zone and its offset', () => {
    expect(localDateText(NOON, 'Asia/Shanghai')).toBe(
      '2026-10-09 (time zone Asia/Shanghai, UTC+08:00)'
    );
    expect(localDateText(NOON, 'UTC')).toBe('2026-10-09 (time zone UTC, UTC+00:00)');
    expect(localDateText(new Date('2026-10-09T02:00:00Z'), 'America/New_York')).toBe(
      '2026-10-08 (time zone America/New_York, UTC-04:00)'
    );
  });

  it('falls back to the offset alone without a usable zone name', () => {
    expect(localDateText(NOON, undefined)).toMatch(/^\d{4}-\d{2}-\d{2} \(UTC[+-]\d{2}:\d{2}\)$/);
    expect(localDateText(NOON, 'Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2} \(UTC[+-]\d{2}:\d{2}\)$/);
  });
});

interface RenderAssembly {
  sections: never[];
  contexts: Array<{ name: string; text: string }>;
  tools: never[];
  variables: Record<string, string | undefined>;
}

/**
 * dsh-system-prompt's own renderer: interpolation is DSH's, not re-implemented
 * here. Only where src/dsh-host is installed.
 */
describe.skipIf(!existsSync(DSH_SYSTEM_PROMPT))(
  "the text through dsh-system-prompt's renderer",
  () => {
    async function renderer() {
      return (await import(pathToFileURL(DSH_SYSTEM_PROMPT).href)) as {
        renderContextSections(assembly: RenderAssembly): Array<{ name: string; text: string }>;
      };
    }

    it('substitutes a path verbatim, braces included, and scans it no further', async () => {
      const { renderContextSections } = await renderer();
      const [section] = renderContextSections({
        sections: [],
        contexts: [
          { name: ENVIRONMENT_PROMPT_CONTEXT, text: environmentPromptText(windows(), session) },
        ],
        tools: [],
        variables: { aiclient_cwd: 'E:\\code\\{{x}}', aiclient_home: 'C:\\Users\\tester' },
      });
      expect(section?.text).toContain('resolve against it): E:\\code\\{{x}}\n');
      expect(section?.text).toContain('- Home directory: C:\\Users\\tester\n');
    });

    it('renders what the row registered, for agents with and without a cwd', async () => {
      const { renderContextSections } = await renderer();
      const fake = createFakeDsh();
      apply(fake.ctx);
      const render = (view: DshAgentView | undefined) => {
        const assembly = { ...(view ? { agent: view } : {}) };
        const variables: Record<string, string | undefined> = {};
        for (const [name, provider] of fake.variables) variables[name] = provider(assembly);
        return renderContextSections({
          sections: [],
          contexts: [...fake.contexts]
            .sort((a, b) => a.order - b.order)
            .map((context) => ({ name: context.name, text: context.text(assembly) })),
          tools: [],
          variables,
        });
      };
      const withCwd = render(agent('aiclient-root', { cwd: '/home/tester/{{proj}}' }));
      expect(withCwd[0]?.name).toBe(ENVIRONMENT_PROMPT_CONTEXT);
      expect(withCwd[0]?.text).toContain('resolve against it): /home/tester/{{proj}}\n');
      expect(withCwd[0]?.text).not.toContain('{{aiclient_');
      const withoutCwd = render(agent('aiclient-root'));
      expect(withoutCwd[0]?.text).not.toContain('Working directory');
      expect(render(undefined)).toEqual([]);
    });
  }
);
