import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.resolve(__dirname, '../../..');
const COMPONENTS_DIR = path.join(RENDERER_DIR, 'components');

/**
 * D25 font-domain assertion suite (spec §6.3, A1..A6; A4 lives in
 * shellLayoutModel.test.ts). Pure static scans — the domain mapping is
 * enforced at the source level because vitest has no DOM here.
 */

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
}

const rel = (file: string) => path.relative(RENDERER_DIR, file).replaceAll(path.sep, '/');

// A1 whitelist: files allowed to carry a literal `font-mono` utility.
// Everything else must go through the <Ident>/<CodeInline> primitives
// (D25 §2.5 "no scattering font-mono"). Legacy panes stay listed until the
// S5 sweep re-verifies each; removing an entry tightens the guard.
const FONT_MONO_WHITELIST = new Set([
  // primitives — the sanctioned carriers
  'components/ui/ident.tsx',
  'components/ui/code-block.tsx',
  'components/ui/mermaid-renderer.tsx',
  // chat: kbd shortcut chips + slash-command labels (D25 M7/M8)
  'components/chat/ChatComposer.tsx',
  'components/chat/EnhancedInput.tsx',
  // chat: tool-row pre bodies + ident-kind args (D25 M3a/M3b/M4)
  'components/chat/ToolRows.tsx',
  'components/chat/toolCard.ts',
  // legacy panes (S5 sweep re-verifies; diff/hash/path surfaces)
  'components/settings/HapiSettings.tsx',
  'components/settings/prompts/PromptEditorDialog.tsx',
  'components/settings/mcp/McpServerDialog.tsx',
  'components/settings/GeneralSettings.tsx',
  'components/git/FileChanges.tsx',
  'components/git/AddRepositoryDialog.tsx',
  'components/source-control/ChangesTree.tsx',
  'components/source-control/CodeReviewModal.tsx',
  'components/source-control/ChangesList.tsx',
  'components/source-control/CommitHistoryList.tsx',
  'components/files/MarkdownPreview.tsx',
  'components/files/editorDefinitionProvider.ts',
  'components/sessions/SessionItem.tsx',
  'components/sessions/SessionManagerView.tsx',
  'components/ErrorBoundary.tsx',
  'components/repository/RepositorySettingsDialog.tsx',
  'components/onboarding/OnboardingView.tsx',
  'components/onboarding/ClaudeVsCodeOnlyShell.tsx',
]);

describe('A1 · font-mono stays inside the whitelist', () => {
  it('no file outside the whitelist mentions font-mono', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(RENDERER_DIR)) {
      if (!stripComments(readFileSync(file, 'utf8')).includes('font-mono')) continue;
      if (!FONT_MONO_WHITELIST.has(rel(file))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });
});

describe('A2 · tool-row arg font follows argKind (verb sans / ident-arg mono / prose-arg sans)', () => {
  it('toolArgClass switches the family by kind and never applies mono to prose', async () => {
    const mod = await import('../toolCard');
    const toolArgClass = (
      mod as unknown as { toolArgClass?: (kind: 'ident' | 'prose', failed: boolean) => string }
    ).toolArgClass;
    expect(typeof toolArgClass).toBe('function');
    const ident = toolArgClass?.('ident', false) ?? '';
    const prose = toolArgClass?.('prose', false) ?? '';
    expect(ident).toContain('font-mono');
    expect(ident).toContain('text-code');
    expect(prose).not.toContain('font-mono');
    expect(prose).not.toContain('text-code');
  });
});

describe('A3 · stack heads cannot swap back', () => {
  it('--font-sans leads with a proportional family, --font-mono with ui-monospace', () => {
    const css = readFileSync(path.join(RENDERER_DIR, 'styles/globals.css'), 'utf8');
    const sans = css.match(/--font-sans:\s*([^;]+);/)?.[1]?.trim() ?? '';
    const mono = css.match(/--font-mono:\s*([^;]+);/)?.[1]?.trim() ?? '';
    expect(sans.startsWith('ui-monospace')).toBe(false);
    expect(sans.length).toBeGreaterThan(0);
    expect(mono.startsWith('ui-monospace')).toBe(true);
  });

  it('neither stack contains system-ui (locale-dependent Latin resolution on zh-CN Windows)', () => {
    const css = readFileSync(path.join(RENDERER_DIR, 'styles/globals.css'), 'utf8');
    const theme = css.match(/--font-sans:[^;]+;|--font-mono:[^;]+;/g)?.join('\n') ?? '';
    expect(theme).not.toMatch(/(?<![-\w])system-ui/);
  });
});

describe('A5 · font-mono never combines with a non-zero tracking (column alignment breaks)', () => {
  // Sole exemption: the onboarding OTP field's deliberate 0.5em character
  // separation (D25 M9).
  it('no line carries both font-mono and a tracking-* utility outside the OTP exemption', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(COMPONENTS_DIR)) {
      const relative = rel(file);
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('font-mono')) return;
        if (!/tracking-(?!normal)/.test(line)) return;
        if (relative === 'components/onboarding/OnboardingView.tsx') return;
        offenders.push(`${relative}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('A6 · banned size utilities are gone from chat/ and workspace-shell/', () => {
  // D25 §3.1: text-xs(12) migrates to --text-meta(13)/--text-ui(14);
  // text-[10px]/text-[11px] arbitrary sizes collapse into the token ladder
  // (10px survives only as --text-2xs on Latin-only mono chips); text-base
  // (16px) was a stray odd size.
  const BANNED = /(?:^|[\s'"`{])text-(?:xs|base|\[10px\]|\[11px\])(?=$|[\s'"`}])/;

  it('chat/ and workspace-shell/ carry none of: text-xs, text-base, text-[10px], text-[11px]', () => {
    const offenders: string[] = [];
    for (const dir of ['chat', 'workspace-shell']) {
      for (const file of collectSourceFiles(path.join(COMPONENTS_DIR, dir))) {
        const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
        lines.forEach((line, index) => {
          if (BANNED.test(line)) offenders.push(`${rel(file)}:${index + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
