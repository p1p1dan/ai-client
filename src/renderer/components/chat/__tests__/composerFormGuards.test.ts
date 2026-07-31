import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_DIR = path.resolve(__dirname, '..');

function collectChatSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectChatSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Doc comments may narrate the SelectTrigger ban itself — only code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
}

/**
 * F-A20 (supersedes F-A8, unconditional after 拍板 ①): the merged
 * ComposerModelTrigger replaced the two Select-based dropdowns. Their
 * resurrection — or any new SelectTrigger in the chat tree — reintroduces
 * the bordered/shadowed full-pill form that was the #1 "AI 化" source.
 */
describe('F-A20 · merged model control deletion evidence', () => {
  it('ModelSelect.tsx and EffortSelect.tsx no longer exist under components/chat', () => {
    expect(existsSync(path.join(CHAT_DIR, 'ModelSelect.tsx'))).toBe(false);
    expect(existsSync(path.join(CHAT_DIR, 'EffortSelect.tsx'))).toBe(false);
  });

  it('SelectTrigger never appears under components/chat (toolbar dropdowns are ghost chips, not form controls)', () => {
    const offenders: string[] = [];
    for (const file of collectChatSourceFiles(CHAT_DIR)) {
      const content = stripComments(readFileSync(file, 'utf8'));
      if (content.includes('SelectTrigger')) {
        offenders.push(path.relative(CHAT_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
