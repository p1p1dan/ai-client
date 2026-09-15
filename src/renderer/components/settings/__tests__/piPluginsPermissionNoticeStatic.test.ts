import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * cutover-02 / cutover-03 — what the plugins page claims, pinned to the source.
 *
 * The page used to render, whenever the agent directory declared a permission
 * extension: "Tool approval is handled by the permission system you installed
 * yourself. This app steps aside, and its approval settings do not apply."
 * Since P6-5 that is the opposite of what happens — every chat is approved by
 * `src/runtime/plugins/permissions/` — and a user reading it believed their own
 * deny rules were in force when not one of them ran.
 *
 * Rendering the page needs Electron's bridge, so the claims are pinned against
 * the source the way `piResourcesSettingsStatic` pins its own.
 */
const pagePath = join(__dirname, '..', 'PiPluginsSettings.tsx');
const page = stripComments(readFileSync(pagePath, 'utf8'), pagePath);
/** Same source with runs of whitespace flattened, so a re-wrap by the formatter
 * cannot turn a claim about the page's words into a failing assertion. */
const flat = page.replace(/\s+/g, ' ');

describe('plugins page permission notice', () => {
  it('states unconditionally that this app approves tool calls', () => {
    expect(page).toContain(
      "t('This app approves tool calls with its own permission system in every chat.')"
    );
  });

  it('carries none of the retired "this app steps aside" wording', () => {
    expect(page).not.toContain('steps aside');
    expect(page).not.toContain('approval settings do not apply');
    expect(flat).not.toContain('Tool approval is handled by the permission system');
  });

  it('sends an installed permission system to the built-in terminal, not to chats', () => {
    expect(flat).toContain(
      "t( 'The pi permission system you installed applies to the built-in terminal only, not to chats in this app.' )"
    );
  });

  it('says in the section description where installed extensions are loaded', () => {
    // cutover-03's other half: the sidebar panel never names a user's
    // extensions, so the page that installs them has to say why.
    expect(page).toContain(
      "'Extensions installed for your account. Only the built-in Pi terminal loads them; chats in this app do not.'"
    );
  });

  it('reads the field that is about the terminal, not the retired app-wide one', () => {
    expect(page).toContain('state?.terminalPermissionSystem');
    expect(page).not.toContain('state.permissionSystem');
    // `bundled` was removed from the union: the copy this app ships is payload
    // for the policy panel, and the CLI never loads it.
    expect(page).not.toContain("'bundled'");
  });
});
