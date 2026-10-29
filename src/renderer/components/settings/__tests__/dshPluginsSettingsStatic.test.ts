import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';

/**
 * dsh-rebase P1-10c (topic §4.4, decisions 090, 104, 117) — what the plugins
 * section claims and offers, pinned to the source.
 *
 * Replaces `piPluginsPermissionNoticeStatic.test.ts` (decision 117): that one
 * pinned the approval wording of the pi extension page, which P1-16e took off
 * the Extensions page (decision 116 rule 19) and P1-12 deletes. The lasting
 * half of it — the plugins page must tell the truth about who approves a
 * plugin's tool calls — is carried over here, for the page users now see.
 */
const pagePath = join(__dirname, '..', 'DshPluginsSettings.tsx');
const page = stripComments(readFileSync(pagePath, 'utf8'), pagePath);
/** Whitespace flattened, so a formatter re-wrap cannot fail a claim about the words. */
const flat = page.replace(/\s+/g, ' ');
const contentPath = join(__dirname, '..', 'SettingsContent.tsx');
const settingsContent = stripComments(readFileSync(contentPath, 'utf8'), contentPath);
const allowlistPath = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'dsh-host',
  'plugins',
  'allowlist.json'
);
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8')) as {
  plugins: Array<{ name: string }>;
};

describe('DSH plugins section (Settings → Extensions)', () => {
  it('says plugin tools go through approval, that they serve Pi chats only, and where Claude chats get theirs', () => {
    expect(flat).toContain(
      'Installed with this app and reviewed by it, for Pi chats only. Tools a plugin adds go through approval like the built-in tools.'
    );
    expect(flat).toContain(
      'Claude chats load the plugins a repository declares in its .claude settings; they are not managed here.'
    );
    // Claude chats do fetch the plugins a repository declares, so the page no longer says nothing is downloaded.
    expect(flat).not.toContain('Nothing is downloaded');
  });

  it('offers a switch and nothing to install or remove (decisions 058, 059)', () => {
    expect(page).toContain('<Switch');
    expect(page).not.toContain('<Input');
    expect(page).not.toMatch(/\b(install|remove|uninstall)\s*\(/i);
    expect(page).not.toContain('Trash2');
    expect(page).not.toContain('Download');
  });

  it('talks to Main only through the plugin channels', () => {
    const calls = [...page.matchAll(/window\.electronAPI\.(\w+)\.(\w+)/g)].map(
      (match) => `${match[1]}.${match[2]}`
    );
    // P1-7e e5 (decision 143): `onChanged` is Main's push after an engine
    // start; it reads, and never writes or restarts anything.
    expect(new Set(calls)).toEqual(
      new Set(['dshPlugins.list', 'dshPlugins.setEnabled', 'dshPlugins.onChanged'])
    );
  });

  it('never says the change is live: it waits for the next engine start (decision 108 rule 7)', () => {
    expect(flat).toContain(
      'Plugin changes take effect the next time the Pi engine starts. If it is running, it restarts on its own once no chat has work in progress.'
    );
    expect(flat).not.toMatch(/take[s]? effect (immediately|now|right away)/i);
  });

  it('carries no pi extension wording at all (decision 090)', () => {
    expect(page).not.toMatch(/\bpi\s+extensions?\b/i);
    expect(page).not.toContain('chat engine');
    expect(page).not.toContain('piPlugins');
  });

  it('has its own summary for every allowlisted plugin', () => {
    expect(allowlist.plugins.length).toBeGreaterThan(0);
    for (const { name } of allowlist.plugins) {
      expect(page, `a summary case for ${name}`).toContain(`case '${name}':`);
    }
  });

  it('sits on the Extensions page between skills and the legacy-asset entry', () => {
    expect(settingsContent).toMatch(
      /<PiResourcesSettings repoPath=\{repoPath\} \/>\s*<DshPluginsSettings \/>\s*<LegacyAssetsSettings repoPath=\{repoPath\} \/>/
    );
  });
});
