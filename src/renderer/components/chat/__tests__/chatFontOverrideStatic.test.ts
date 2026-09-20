import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * T104: guards for the chat area's runtime typography override.
 *
 * `ChatWorkspace.tsx` cannot be rendered in this suite (`vitest.config.ts`
 * includes `*.test.ts` only, and the component reaches the runtime stores,
 * the host-status poll and the whole timeline). The facts that matter here are
 * about a SOURCE SHAPE, so they are scanned over the source with comments
 * blanked — the posture `composerFormStatic` / `composerStopStatic` take for
 * their own untestable facts.
 *
 * The two propositions:
 *
 *  1. The override lives on the chat column's own root node. It must NOT be
 *     written to `documentElement` — that is the deleted `applyTerminalFont()`
 *     bug, which scaled the whole interface by `terminalFontSize / 16` and
 *     polluted every `font-mono` in the app.
 *  2. The family is a direct declaration, and it is omitted (not defaulted)
 *     when the setting is empty. Overriding `--font-sans` instead is the same
 *     hazard `globals.css` documents for its own domain attribute (a theme
 *     custom property can be inlined at build time), and a fallback literal is
 *     the dead `fontFamily: 'Inter'` field coming back through the side door.
 */

const WORKSPACE_PATH = path.resolve(__dirname, '../ChatWorkspace.tsx');
const SOURCE = stripComments(readFileSync(WORKSPACE_PATH, 'utf8'), 'ChatWorkspace.tsx');

/** The override object literal, from its first key to the family spread. */
function overrideLiteral(): string {
  const start = SOURCE.indexOf("'--text-chat-body':");
  expect(start, 'the override literal must exist').toBeGreaterThan(-1);
  const end = SOURCE.indexOf('}) as React.CSSProperties', start);
  expect(end, 'the override literal must stay a plain object cast').toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('T104: chat typography override is scoped to the chat column', () => {
  it('sets both size tiers as inline custom properties', () => {
    const literal = overrideLiteral();
    expect(literal).toContain("'--text-chat-body': `${chatBodyFontSize}px`");
    expect(literal).toContain("'--text-chat-process': `${chatProcessFontSize}px`");
  });

  it('[R3] never writes the override to documentElement', () => {
    // The whole point of scoping: `documentElement` would reach the sidebar,
    // the editor chrome and every other `text-*` consumer in the app.
    expect(SOURCE).not.toMatch(/documentElement\.style\.setProperty\(\s*'--text-chat/);
    expect(SOURCE).not.toMatch(/documentElement\.style\.setProperty\(\s*'--font-sans/);
    expect(SOURCE).not.toMatch(/documentElement\.style\.fontFamily/);
    // And the family must not be routed through the theme variable either —
    // that is what a build-time inline would silently defeat.
    expect(overrideLiteral()).not.toContain("'--font-sans'");
    expect(overrideLiteral()).toContain('fontFamily: chatFontFamily');
  });

  it('omits the fontFamily key entirely when the setting is empty', () => {
    // `...(chatFontFamily ? { fontFamily: chatFontFamily } : {})` — empty means
    // "inherit the app font", and an unconditional key with a literal fallback
    // would freeze the chat area on some font the rest of the UI does not use.
    const literal = overrideLiteral();
    expect(literal).toContain('...(chatFontFamily ?');
    expect(literal).toMatch(/\{\s*fontFamily: chatFontFamily\s*\}/);
    expect(literal).toMatch(/:\s*\{\s*\}/);
  });

  it('is applied to the column root <section>, which is what wraps timeline and composer alike', () => {
    const section = SOURCE.indexOf("cn('relative flex min-h-0 flex-col', className)");
    expect(section, 'the root section class must still be there').toBeGreaterThan(-1);
    expect(SOURCE.slice(section, section + 120)).toContain('style={chatSurfaceStyle}');
  });

  it('reads the three settings through scalar selectors', () => {
    expect(SOURCE).toContain('useSettingsStore((state) => state.chatFontFamily)');
    expect(SOURCE).toContain('useSettingsStore((state) => state.chatBodyFontSize)');
    expect(SOURCE).toContain('useSettingsStore((state) => state.chatProcessFontSize)');
  });

  /**
   * The override node also wraps the TUI branch's `AgentTerminal`, so "does the
   * terminal follow the chat font" has to be answered rather than assumed.
   *
   * It does not, and not by luck: xterm is configured entirely through JS
   * options (`new Terminal({ fontSize, fontFamily })`), which no CSS
   * inheritance can reach — `design-system.md`'s separation contract lists
   * "xterm: JS option, reads no CSS variable" as the second row of its table.
   * This asserts the mechanism that makes that true, on the source of the hook
   * that builds the terminal, so a future edit that "simplifies" the terminal
   * onto CSS would fail here instead of silently coupling the two fonts.
   */
  it('[R3] the TUI terminal takes its font from JS options, so the section override cannot reach it', () => {
    const xtermPath = path.resolve(__dirname, '../../../hooks/useXterm.ts');
    const xterm = stripComments(readFileSync(xtermPath, 'utf8'), 'useXterm.ts');
    expect(xterm).toContain('fontSize: settings.fontSize');
    expect(xterm).toContain('fontFamily: settings.fontFamily');
    // And the settings it reads are the terminal's own, never the chat fields.
    expect(xterm).toContain('terminalFontFamily');
    expect(xterm).not.toContain('chatFontFamily');
    expect(xterm).not.toContain('chatBodyFontSize');
    // No CSS route into the terminal either.
    expect(xterm).not.toMatch(/style\.setProperty\(\s*'--/);
  });
});
