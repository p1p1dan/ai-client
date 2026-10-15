import type { Context } from '@deepseek-ai/cordis';
import {
  GLOB_MAX_RESULTS,
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_GRACE_MS,
  SEARCH_META_MAX_BYTES,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
} from '@deepseek-ai/dsh-tool-fs-search';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeToolSwitches, RICH_GREP_ENV, WEB_FETCH_ENV } from '../../lib/toolSwitches.ts';
import { apply, inject, name, resolveFsSearchSettings } from '../plugin.ts';

/**
 * dsh-rebase decision 190 — the aiclient-fs-search row: dsh-tool-fs-search's
 * config, DSH's glob as it is, and the grep its switch picks.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Tool {
  name: string;
  parameters: { properties: Record<string, unknown> };
}

/** The slice of a Cordis context both DSH's apply functions and ours touch. */
function fakeContext() {
  const tools: Tool[] = [];
  const sections: string[] = [];
  const listeners: string[] = [];
  const ctx = {
    tools: {
      register: (tool: Tool) => tools.push(tool),
      get: (toolName: string) => tools.find((tool) => tool.name === toolName),
    },
    systemPrompt: {
      section: (section: { name: string }) => sections.push(section.name),
      getSectionOrder: () => 0,
    },
    on: (event: string) => listeners.push(event),
    subprocess: { spawn: () => ({}) },
  };
  return { ctx: ctx as unknown as Context, tools, sections, listeners };
}

describe('aiclient-fs-search', () => {
  it("is a row of its own that injects dsh-tool-fs-search's three services", () => {
    expect(name).toBe('aiclient-fs-search');
    expect(inject).toEqual(['tools', 'systemPrompt', 'subprocess']);
  });

  it("defaults every limit to dsh-tool-fs-search's own", () => {
    const settings = resolveFsSearchSettings({ sampleOverCapGlobResults: false }, {});
    expect(settings).toEqual({
      richGrep: true,
      glob: {
        sampleOverCapGlobResults: false,
        maxResults: GLOB_MAX_RESULTS,
        maxMetaBytes: SEARCH_META_MAX_BYTES,
        rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES,
        graceMs: SEARCH_GRACE_MS,
        stderrMaxBytes: SEARCH_STDERR_MAX_BYTES,
        timeoutMs: SEARCH_TIMEOUT_MS,
      },
      dshGrep: {
        maxMatches: GREP_MAX_MATCHES,
        maxLineBytes: GREP_MAX_LINE_BYTES,
        maxMetaBytes: SEARCH_META_MAX_BYTES,
        rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES,
        graceMs: SEARCH_GRACE_MS,
        stderrMaxBytes: SEARCH_STDERR_MAX_BYTES,
        timeoutMs: SEARCH_TIMEOUT_MS,
      },
      grep: {
        maxLineBytes: GREP_MAX_LINE_BYTES,
        rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES,
        graceMs: SEARCH_GRACE_MS,
        stderrMaxBytes: SEARCH_STDERR_MAX_BYTES,
        timeoutMs: SEARCH_TIMEOUT_MS,
      },
    });
    const tuned = resolveFsSearchSettings(
      { sampleOverCapGlobResults: true, globMaxResults: 50, timeoutMs: 5000 },
      {}
    );
    expect(tuned.glob).toMatchObject({ sampleOverCapGlobResults: true, maxResults: 50 });
    expect(tuned.grep.timeoutMs).toBe(5000);
  });

  it('refuses the config dsh-tool-fs-search refuses', () => {
    expect(() => resolveFsSearchSettings({}, {})).toThrow('sampleOverCapGlobResults');
    expect(() => resolveFsSearchSettings(undefined, {})).toThrow('sampleOverCapGlobResults');
    for (const bad of [0, -1, 1.5, '10']) {
      expect(() =>
        resolveFsSearchSettings({ sampleOverCapGlobResults: false, grepMaxLineBytes: bad }, {})
      ).toThrow('grepMaxLineBytes must be a positive integer');
    }
  });

  it('reads its switch: only 0 picks DSH’s grep', () => {
    for (const value of [undefined, '', '1', 'off']) {
      expect(
        resolveFsSearchSettings({ sampleOverCapGlobResults: false }, { [RICH_GREP_ENV]: value })
          .richGrep
      ).toBe(true);
    }
    expect(
      resolveFsSearchSettings({ sampleOverCapGlobResults: false }, { [RICH_GREP_ENV]: '0' })
        .richGrep
    ).toBe(false);
  });

  it('registers DSH’s glob and our grep', () => {
    const { ctx, tools, sections, listeners } = fakeContext();
    apply(ctx, { sampleOverCapGlobResults: false });
    expect(tools.map((tool) => tool.name)).toEqual(['glob', 'grep']);
    expect(Object.keys(tools[0]?.parameters.properties ?? {})).toEqual(['pattern', 'path']);
    expect(Object.keys(tools[1]?.parameters.properties ?? {})).toContain('output_mode');
    expect(sections).toEqual(['tool:glob', 'tool:grep']);
    // DSH's glob keeps its own spill of a capped list; our grep pages instead.
    expect(listeners).toEqual(['tools/post-execute']);
  });

  it('registers DSH’s own grep when switched off, as tool-fs-search did', () => {
    vi.stubEnv(RICH_GREP_ENV, '0');
    const { ctx, tools, sections, listeners } = fakeContext();
    apply(ctx, { sampleOverCapGlobResults: false });
    expect(tools.map((tool) => tool.name)).toEqual(['glob', 'grep']);
    expect(Object.keys(tools[1]?.parameters.properties ?? {})).toEqual([
      'pattern',
      'path',
      'include',
    ]);
    expect(sections).toEqual(['tool:glob', 'tool:grep']);
    expect(listeners).toEqual(['tools/post-execute', 'tools/post-execute']);
  });
});

describe('the start line of the switches', () => {
  it('says which gaps this start closes, and names the switch of each one open', () => {
    expect(describeToolSwitches({})).toBe('tool switches: web_fetch on, grep rich');
    expect(describeToolSwitches({ [WEB_FETCH_ENV]: '0', [RICH_GREP_ENV]: '0' })).toBe(
      'tool switches: web_fetch off (AICLIENT_RUNTIME_WEB_FETCH=0), grep dsh (AICLIENT_RUNTIME_RICH_GREP=0)'
    );
  });
});
