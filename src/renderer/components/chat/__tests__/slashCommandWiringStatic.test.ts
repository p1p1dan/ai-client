import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * R02-c — claims about JSX and ordering that no pure test can reach, pinned
 * against source the way `deadControlsStatic` pins its own.
 *
 * Every one of these fails silently when broken: the menu simply does not
 * appear, or a command quietly becomes a message to the model.
 */
const read = (relative: string) => {
  const file = path.join(process.cwd(), relative);
  return stripComments(readFileSync(file, 'utf8'), file);
};

const COMPOSER = read('src/renderer/components/chat/ChatComposer.tsx');
const APP = read('src/renderer/App.tsx');

describe('R02-c the slash menu works without a workspace', () => {
  it('tracks the command prefix before the cwd guard, not after', () => {
    // The @ popup needs a directory to search. Slash commands come from the
    // agent's own configuration, and the start screen — no cwd yet — is exactly
    // where someone reaches for `/new`. Ordering here is the whole feature.
    const change = COMPOSER.slice(COMPOSER.indexOf('const handleContentChange'));
    const body = change.slice(0, change.indexOf('const insertSlash'));
    const syncAt = body.indexOf('syncSlashQuery(next)');
    const guardAt = body.indexOf('!effectiveCwd');
    expect(syncAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(syncAt).toBeLessThan(guardAt);
  });

  it('does the same on IME composition end', () => {
    const handler = COMPOSER.slice(COMPOSER.indexOf('onCompositionEnd={'));
    const body = handler.slice(0, handler.indexOf('onPaste='));
    expect(body.indexOf('syncSlashQuery(')).toBeLessThan(body.indexOf('!effectiveCwd'));
  });

  it('asks for the catalog without requiring a session', () => {
    // `sessionId` is a hint that sharpens the answer in local mode, never a
    // precondition.
    expect(COMPOSER).toContain(
      '.getSlashCommands(activeSessionId ? { sessionId: activeSessionId } : {})'
    );
  });
});

describe('R02-c a builtin never shadows a plugin', () => {
  it('resolves through the catalog’s source, not the bare name', () => {
    const run = COMPOSER.slice(COMPOSER.indexOf('const runBuiltinSlash'));
    const body = run.slice(0, run.indexOf('const handleSend'));
    expect(body).toContain('buildSlashCatalog(slashCatalog, t)');
    expect(body).toContain('resolveSlashAction(parsed.name, parsed.args, source)');
    // A runtime command must fall through untouched — pi already dispatches it.
    expect(body).toContain("if (action.type === 'runtime') return false;");
  });
});

describe('R02-c interception happens before the send decision', () => {
  it('runs builtins ahead of decideSendAction', () => {
    // These are actions in this window, not turns: they must not be queued
    // behind a running one either.
    const send = COMPOSER.slice(COMPOSER.indexOf('const handleSend = async'));
    const body = send.slice(0, send.indexOf('if (action === '));
    expect(body.indexOf('runBuiltinSlash(trimmed)')).toBeLessThan(
      body.indexOf('decideSendAction({')
    );
  });

  it('leaves a message with attachments alone', () => {
    // `/compact` plus three files is not a command, it is a message the user
    // half-typed over.
    const run = COMPOSER.slice(COMPOSER.indexOf('const runBuiltinSlash'));
    expect(run.slice(0, run.indexOf('const handleSend'))).toContain(
      'if (!parsed || attachments.drafts.length > 0) return false;'
    );
  });
});

describe('R02-c the menu keyboard comes before the @ popup’s', () => {
  it('checks slashOpen first', () => {
    const keydown = COMPOSER.slice(COMPOSER.indexOf('onKeyDown={(event) => {'));
    const body = keydown.slice(0, keydown.indexOf('void handleSend();'));
    expect(body.indexOf('if (slashOpen) {')).toBeLessThan(body.indexOf('if (mentionOpen) {'));
  });
});

describe('R02-c the menu says where each command came from', () => {
  it('renders the source on every row', () => {
    // Three kinds share one list; a skill, a template and a plugin command look
    // identical without it.
    expect(COMPOSER).toContain(
      '<span className="shrink-0 text-meta text-muted-foreground">{item.source}</span>'
    );
  });
});

describe('R02-c /settings crosses the layers through a pending request', () => {
  it('the composer records an intent and App consumes it once', () => {
    expect(COMPOSER).toContain('useSettingsIntentStore.getState().requestSettings()');
    // Cleared BEFORE opening, so a re-render during open cannot fire it twice.
    const effect = APP.slice(APP.indexOf('if (!pendingSettingsOpen) return;'));
    const body = effect.slice(0, effect.indexOf('}, ['));
    expect(body.indexOf('clearSettingsRequest()')).toBeLessThan(
      body.indexOf('openSettingsFromSlash()')
    );
  });
});
