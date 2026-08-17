import { readdirSync, readFileSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * D48 S3 — the wiring the pure models cannot see: which values the send path
 * actually hands to `chat.createSession`, and which store the Context surface
 * actually reads the posture from.
 *
 * BRITTLE BY DESIGN, same as `composerModelWiring.test.ts` next door and for
 * the same reason: `vitest.config.ts` runs `environment: 'node'`, so no
 * component renders and nothing here can be asserted by calling it. Presence
 * and relative position in executable syntax is what is available; every
 * DECISION lives in `chatAgentDefaults.ts` / `contextSurfaceModel.ts` /
 * `chatPermissionDefaults.ts`, truth-tabled next door.
 *
 * What this suite is really pinning is a pair of omissions that would be
 * invisible in review and silent at runtime: a create payload that forgot the
 * posture (the session runs under the constant while Settings says otherwise),
 * and a Context row that forgot the policy (a Codex session's row disappears,
 * which is exactly today's bug).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_DIR = path.resolve(__dirname, '..');
const COMPOSER_PATH = join(CHAT_DIR, 'ChatComposer.tsx');
const CONTEXT_VIEW_PATH = path.resolve(
  CHAT_DIR,
  '../workspace-shell/surfaces/ContextSurfaceView.tsx'
);

function readStripped(file: string): string {
  return stripComments(readFileSync(file, 'utf8'), path.basename(file));
}

const composer = readStripped(COMPOSER_PATH);
const contextView = readStripped(CONTEXT_VIEW_PATH);

/** Every renderer `.ts`/`.tsx`, for the "nobody calls this" negative control. */
function rendererFiles(dir: string = path.resolve(CHAT_DIR, '../..')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...rendererFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('ChatComposer — the posture is materialised once, at the commit point', () => {
  it('resolves it through the hydration-gated helper, not off the store directly (C15)', () => {
    expect(composer).toMatch(/resolveDraftPermissionPreference\(\{/);
    expect(composer).toMatch(/settingsHydrated,/);
    // The gate lives in the helper; reading `chatAgentDefaults` here without it
    // is how a cold-start send pins a factory value forever.
    expect(composer).toMatch(/const settingsHydrated = useSettingsHydrated\(\);/);
  });

  it('resolves it against the SAME agent the model and effort used', () => {
    // The call, not the import line above it.
    const resolve = composer.indexOf('resolveDraftPermissionPreference({');
    expect(resolve).toBeGreaterThan(-1);
    const call = composer.slice(resolve, composer.indexOf('});', resolve));
    expect(call).toMatch(/agent: turnAgent/);
    expect(call).toMatch(/defaults: chatAgentDefaults/);
  });

  it('is resolved BEFORE the create dispatch, and reaches it (B11 spread form)', () => {
    const resolve = composer.indexOf(
      'const permissionPreference = resolveDraftPermissionPreference'
    );
    const create = composer.indexOf('chat.createSession({');
    expect(resolve).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    expect(resolve).toBeLessThan(create);
    const payload = composer.slice(create, composer.indexOf('});', create));
    // Absent, never `undefined` — "no template" has to be indistinguishable
    // from "field not supported" for the runtime default to apply.
    expect(payload).toMatch(/\.\.\.\(permissionPreference \? \{ permissionPreference \} : \{\}\)/);
  });

  it('the resume dispatch does NOT carry one — resume replays the snapshot Main holds (C9)', () => {
    const resume = composer.indexOf('.resumeSession({');
    expect(resume).toBeGreaterThan(-1);
    const payload = composer.slice(resume, composer.indexOf('});', resume));
    expect(payload).not.toMatch(/permissionPreference/);
  });

  it('exactly one dispatch in ChatComposer.tsx carries a posture', () => {
    expect(composer.match(/permissionPreference/g) ?? []).toHaveLength(3);
  });

  it('the store’s own dormant create path carries no posture, and no live UI reaches it', () => {
    // Scope note, asserted rather than promised. `chatSessions.ts` holds a
    // SECOND `chat.createSession` dispatch inside its `sendMessage` action, and
    // it carries no posture — nor `model`, nor `effort`, since S2. That is
    // correct only because the action is dormant: the send path every rendered
    // Composer uses is ChatComposer's own. If a caller ever appears, it needs
    // all three, and this assertion goes red the moment one does.
    const store = readStripped(path.resolve(CHAT_DIR, '../../stores/chatSessions.ts'));
    const create = store.indexOf('chat.createSession({');
    expect(create).toBeGreaterThan(-1);
    const payload = store.slice(create, store.indexOf('});', create));
    expect(payload).not.toMatch(/permissionPreference/);
    expect(payload).not.toMatch(/\bmodel\b/);
    expect(payload).not.toMatch(/\beffort\b/);

    // "Dormant" = no non-test caller anywhere in the renderer. `useChatStore`
    // exposes it, so the search is for a call site rather than for the name.
    const callers = rendererFiles().filter(
      (file) => !file.includes('__tests__') && /\.sendMessage\s*\(/.test(readFileSync(file, 'utf8'))
    );
    expect(callers).toEqual([]);
  });
});

describe('ContextSurfaceView — the policy is read, and the surface stays read-only', () => {
  it('selects permissionPolicy off the adjacent facts store, per session', () => {
    expect(contextView).toMatch(
      /state\.factsBySession\[activeSessionId\]\?\.permissionPolicy \?\? null/
    );
  });

  it('feeds it into the runtime facts AND into the memo dependency list', () => {
    const derive = contextView.indexOf('deriveContextGroups({');
    expect(derive).toBeGreaterThan(-1);
    const factsBlock = contextView.slice(derive, contextView.indexOf('  }, [', derive));
    expect(factsBlock).toMatch(/permissionPolicy,/);
    // A missing dependency would freeze the row at whatever it showed when the
    // session was opened — a stale posture is worse than no posture. Four
    // occurrences in total: the binding, the selector's own read, the facts and
    // the dependency.
    const depsBlock = contextView.slice(contextView.indexOf('  }, [', derive));
    expect(depsBlock).toMatch(/permissionPolicy,/);
    expect(contextView.match(/permissionPolicy/g) ?? []).toHaveLength(4);
  });

  it('never writes: no template helper, no settings mutation, no preference type', () => {
    // The panel mirrors Host echoes. A control here would make one row both a
    // request and a report, which is the shape §5.4 rules out.
    expect(contextView).not.toMatch(/setChatAgentDefaults/);
    expect(contextView).not.toMatch(/permissionPreference/);
    expect(contextView).not.toMatch(/withAgentPreference/);
  });
});
