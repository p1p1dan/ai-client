import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * T3 wiring. The decision (`modelLacksImageInput`) is truth-tabled in
 * `attachmentLimits.test.ts`; this pins how `ChatComposer` feeds and shows it.
 * No test mounts the composer (it needs the whole session store graph), so the
 * three properties that matter are read off the source.
 */
const COMPOSER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ChatComposer.tsx');
const source = stripComments(readFileSync(COMPOSER, 'utf8'), COMPOSER);

function count(needle: string): number {
  return source.split(needle).length - 1;
}

describe('composer image-input hint (T3)', () => {
  it('asks about the model the next send will actually carry', () => {
    // Same resolution `runSend` uses for the wire model, and the global
    // template before the chat exists.
    expect(source).toContain(
      'resolveResumeModel(getSessionModel, activeSessionId, agentDefaultModel(chatAgentDefaults))'
    );
    expect(source).toMatch(
      /modelLacksImageInput\(\{\s*drafts: attachments\.drafts,\s*model: nextSendModel,\s*catalog: catalogModels\(modelCatalog\),\s*\}\)/
    );
  });

  it('renders in both composer layouts as a non-blocking warning', () => {
    expect(count('{imageInputHintBlock}')).toBe(2);
    expect(source).toMatch(/imageInputHintBlock \|\|/);
    expect(source).toMatch(/<Alert\s+variant="warning"\s+role="status"/);
  });

  it('never gates sending', () => {
    // Declared once, read only for rendering: no send guard mentions it.
    expect(count('modelLacksImageInput(')).toBe(1);
    const start = source.indexOf('const canSend = ');
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, source.indexOf(');', start))).not.toContain('image');
  });
});
