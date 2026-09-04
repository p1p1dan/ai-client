import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

const chatDir = path.join(__dirname, '..');
const composer = stripComments(
  readFileSync(path.join(chatDir, 'ChatComposer.tsx'), 'utf8'),
  'ChatComposer.tsx'
);
const trigger = stripComments(
  readFileSync(path.join(chatDir, 'ComposerModelTrigger.tsx'), 'utf8'),
  'ComposerModelTrigger.tsx'
);
const hook = stripComments(
  readFileSync(path.join(chatDir, 'usePiModelCatalog.ts'), 'utf8'),
  'usePiModelCatalog.ts'
);
const preload = stripComments(
  readFileSync(path.join(__dirname, '..', '..', '..', '..', 'preload', 'index.ts'), 'utf8'),
  'preload/index.ts'
);

function compact(value: string): string {
  return value.replace(/\s+/g, '');
}

describe('Pi-only model wiring', () => {
  it('has no Composer agent picker or legacy permission control', () => {
    expect(composer).not.toContain('ComposerAgentPicker');
    // U12 revived the NAME `ComposerPermissionTrigger` for a Pi-native
    // control — the session tier chip, which talks to `chat:setPermissionTier`.
    // What this gate is about is the Claude/Codex-era permission surface, so it
    // pins that surface's channels rather than a filename the product now uses
    // for something else. (Asserting the name's absence made this gate red the
    // moment U12 landed, while proving nothing about the legacy runtime.)
    for (const legacy of ['chat:respondPermission', 'chat:updatePermission', 'permissionMode']) {
      expect(composer, legacy).not.toContain(legacy);
    }
    // The narrowing went past pinning the agent to a Pi constant: the Composer
    // carries no runtime variable at all now. Pin the absence, not the constant.
    expect(composer).not.toContain('composerAgent');
  });

  it('loads the single Pi catalog through the Pi-only preload method', () => {
    expect(compact(trigger)).toContain('usePiModelCatalog(hostState)');
    expect(hook).toContain('.listPiModels(');
    expect(preload).toContain('listPiModels:');
    expect(preload).toContain('CHAT_LIST_PI_MODELS');
    expect(preload).not.toContain('listAgentModels:');
  });

  it('sends model and effort but no runtime or legacy permission discriminant', () => {
    const createAt = composer.indexOf('window.electronAPI.chat.createSession({');
    const createEnd = composer.indexOf('});', createAt);
    const createPayload = composer.slice(createAt, createEnd);
    expect(createPayload).toContain('...(model ? { model } : {})');
    expect(createPayload).toContain('...(effort ? { effort } : {})');
    expect(createPayload).not.toContain('permissionPreference');
    expect(createPayload).not.toMatch(/\bagent\s*,/);
  });
});
