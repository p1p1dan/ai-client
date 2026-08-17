import { readdirSync, readFileSync, statSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './stripComments';

/**
 * D48 S2 · B11 / B13 / B17 wiring — source-scan guards for the three `.tsx`
 * files this slice rewired, plus the asset-deletion scan the spec asks for.
 *
 * BRITTLE BY DESIGN, and for the same reason `composerAgentPickerWiring.test.ts`
 * exists: `vitest.config.ts` runs `environment: 'node'` with `include: *.test.ts`,
 * so no component ever renders and nothing below can be asserted by calling it.
 * What IS asserted here is presence and relative position in executable syntax,
 * with comments blanked by the shared parser-backed strip.
 *
 * What this does NOT claim: reachability. A guard inside `if (false)` satisfies
 * every assertion here. That residual blind spot is why every DECISION lives in
 * `models.ts` / `agentModelCatalog.ts` / `chatAgentDefaults.ts`, truth-tabled
 * next door, and only the wiring is checked here.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_DIR = path.resolve(__dirname, '..');
const TRIGGER_PATH = join(CHAT_DIR, 'ComposerModelTrigger.tsx');
const COMPOSER_PATH = join(CHAT_DIR, 'ChatComposer.tsx');
const PICKER_PATH = join(CHAT_DIR, 'ComposerAgentPicker.tsx');
const CATALOG_HOOK_PATH = join(CHAT_DIR, 'useAgentModelCatalog.ts');
const CONTEXT_VIEW_PATH = path.resolve(
  CHAT_DIR,
  '../workspace-shell/surfaces/ContextSurfaceView.tsx'
);

function readStripped(file: string): string {
  return stripComments(readFileSync(file, 'utf8'), path.basename(file));
}

const trigger = readStripped(TRIGGER_PATH);
const composer = readStripped(COMPOSER_PATH);
const picker = readStripped(PICKER_PATH);
const catalogHook = readStripped(CATALOG_HOOK_PATH);
const contextView = readStripped(CONTEXT_VIEW_PATH);

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** All start offsets of `needle` in `source`. */
function offsets(source: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

/**
 * The `{...}` literal starting at `open`, brace-matched.
 *
 * Not `indexOf('})')`: the payloads being checked CONTAIN `})` inside their own
 * conditional spreads, so a naive scan truncates the block before the thing it
 * is looking for and the assertion fails on correct code.
 */
function braceBlock(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced braces from offset ${open}`);
}

/**
 * All whitespace removed, for the handful of checks that name a CALL rather
 * than a position.
 *
 * The formatter owns line breaks: adding one binding to a destructure pushed
 * `useAgentModelCatalog(agent, hostState)` past `lineWidth: 100` and biome
 * wrapped it across four lines, turning a correct rewire into a red test. Any
 * assertion whose subject can be re-wrapped by `biome check --write` is written
 * against this form instead of the raw source.
 */
function compact(source: string): string {
  return source.replace(/\s+/g, '');
}

/** Sole start offset of `needle` — fails loudly if absent or duplicated. */
function only(source: string, needle: string): number {
  const found = offsets(source, needle);
  expect(found, `expected exactly one occurrence of ${JSON.stringify(needle)}`).toHaveLength(1);
  return found[0];
}

describe('B13: the static catalog is deleted, not merely unused', () => {
  // The three short names were the product surface for two years, and a stray
  // re-import would restore a catalog the gateway rejects outright [实测 调查 04
  // 探测 B] while looking like an ordinary constant. A file-system scan is the
  // only check that survives someone re-adding the table under a new name in a
  // different file — the identifier is what is banned.
  it('no `CHAT_MODELS` identifier survives under components/chat', () => {
    const offenders = collectFiles(CHAT_DIR).filter(
      (file) => !file.includes('__tests__') && /\bCHAT_MODELS\b/.test(readStripped(file))
    );
    expect(offenders).toEqual([]);
  });

  it('no `ensureModelOptions` / `defaultModelId` / `DEFAULT_CHAT_MODEL_ID` survives anywhere in the renderer', () => {
    const rendererDir = path.resolve(CHAT_DIR, '../..');
    const banned = /\b(ensureModelOptions|defaultModelId|DEFAULT_CHAT_MODEL_ID)\b/;
    const offenders = collectFiles(rendererDir).filter(
      (file) => !file.includes('__tests__') && banned.test(readStripped(file))
    );
    expect(offenders).toEqual([]);
  });
});

describe('B11 wiring: Automatic omits the key rather than sending undefined', () => {
  // `model: undefined` is NOT the same thing: it still names the key, and the
  // whole point of `Automatic` is that the runtime cannot tell the field apart
  // from one this build never supported.
  it('every model-carrying dispatch site spreads the key conditionally', () => {
    // Enumerated by CALL SITE rather than by a count: `runSend` reaches the
    // Host through three of them (create, send, resume-then-send), and a test
    // pinned to a literal 2 would have missed the third — which is how the
    // resume path kept naming `model: undefined` after the other two were fixed.
    const sites = ['chat.createSession({', 'chat.send({', '.resumeSession({'];
    for (const site of sites) {
      const at = only(composer, site);
      const payload = braceBlock(composer, at + site.length - 1);
      expect(payload, `${site} must spread the model conditionally`).toContain(
        '...(model ? { model } : {})'
      );
      expect(payload, `${site} must not name a bare model key`).not.toMatch(/\bmodel,\s/);
    }
  });

  it('the effort key was already conditional and stays that way', () => {
    expect(offsets(composer, '...(effort ? { effort } : {})').length).toBeGreaterThanOrEqual(1);
  });

  // D40's Codex half rides this key: an override on `turn/start` is STICKY
  // [实测 06-probes P1], so a model the user did not pick would silently
  // re-default the whole thread rather than one turn.
  it('the send payload resolves its model from the turn agent, not from a session-wide read', () => {
    const resolveAt = only(composer, 'const model = resolveResumeModel(');
    const turnAgentAt = only(composer, 'const turnAgent = agentAtEntry;');
    expect(turnAgentAt).toBeLessThan(resolveAt);
    expect(composer).toContain('agentDefaultModel(chatAgentDefaults, turnAgent)');
    expect(composer).toContain('getSessionEffort(sessionId, turnAgent)');
  });

  it('the model trigger is handed the same agent the picker shows', () => {
    expect(composer).toContain('const composerAgent = sessionAgent(activeSession ?? {});');
    expect(composer).toContain('agent={composerAgent}');
  });
});

describe('B17 wiring: the trigger reconciles instead of re-deriving', () => {
  it('reads the catalog through the hook rather than a static import', () => {
    expect(compact(trigger)).toContain('useAgentModelCatalog(agent,hostState)');
  });

  // The rewrite rule is `reconcileModelSelection`'s, and it is handed the
  // loaded flag: a trigger that passed a constant `true` would wipe a stored
  // selection during the pre-catalog window on every launch.
  it('the reconciliation effect calls reconcileModelSelection with the loaded flag', () => {
    const at = only(trigger, 'reconcileModelSelection({');
    expect(trigger.slice(at, at + 400)).toContain('catalogLoaded: loaded');
    expect(trigger.slice(at, at + 400)).toContain('current,');
  });

  // §4.3-6's OTHER trigger. The pure half is truth-tabled in `models.test.ts`;
  // what can only be checked here is that the effect actually TELLS the pure
  // function the pair moved. Without this the component computes `pairChanged`
  // nowhere, the reconcile takes a keep-arm on every session switch, and the
  // trigger displays the previous session's model while the send path resolves
  // the new session's — a display≠send split (R11/A11) with no red test.
  it('the reconcile is told when the (session, agent) pair moved, off a ref', () => {
    const at = only(trigger, 'reconcileModelSelection({');
    expect(trigger.slice(at, at + 400)).toContain('pairChanged,');
    // The ref is the mechanism: this component is never remounted per session,
    // so a pair change is otherwise indistinguishable from a re-render.
    const refAt = only(trigger, 'const resolvedPairRef = useRef<string>(');
    const computedAt = only(trigger, 'const pairChanged = resolvedPairRef.current !== pair;');
    expect(refAt).toBeLessThan(computedAt);
    expect(computedAt).toBeLessThan(at);
    // …and it is updated in the same effect, otherwise every later render would
    // re-resolve and overwrite what the user just picked.
    expect(trigger).toContain('resolvedPairRef.current = pair;');
  });

  // §4.1 刷新 row: "opening the menu re-checks the 10-minute TTL". The hook's
  // request effect only re-runs when its `request` identity changes (agent /
  // hostState) and the trigger is never remounted, so without this a catalog
  // fetched at minute 0 is frozen for the life of the renderer process — and
  // the Retry control cannot substitute, because a healthy `source:'proxy'`
  // answer produces `message:null` and renders no status row at all.
  it('opening the menu re-checks the TTL through the non-forced request', () => {
    const at = only(trigger, 'onOpenChange={(open) => {');
    expect(trigger.slice(at, at + 120)).toContain('refresh()');
    expect(trigger).toContain('refresh,');
    // `refresh` must be the TTL-respecting arm; `retry` is the forced one.
    // Wiring the menu to the forced arm would put a network call behind every
    // menu open.
    expect(catalogHook).toContain('refresh: useCallback(() => request(false), [request])');
    expect(catalogHook).toContain('retry: useCallback(() => request(true), [request])');
  });

  // §4.6 防线 ① 连带口径: the two axes do not share one sentence. Asserted at the
  // wiring layer as well as in `models.test.ts` because the failure mode is a
  // literal being typed back into the tooltip, not the helper changing.
  it('the trigger copy names the axis-dependent scope', () => {
    expect(trigger).toContain('modelScopeHint(agent)');
    const spokenAt = only(trigger, 'const spokenLabel =');
    const titleAt = only(trigger, 'const title =');
    expect(trigger.slice(spokenAt, spokenAt + 200)).toContain('scopeHint');
    expect(trigger.slice(titleAt, titleAt + 200)).toContain('scopeHint');
  });

  it('the effect re-runs on session, agent and catalog — the three things that change the answer', () => {
    // Read off the dependency array that follows the reconcile call, not off a
    // whitespace-exact literal: the formatter owns the line breaks, and a test
    // that pinned them would go red for a plain `biome check --write`.
    const at = only(trigger, 'reconcileModelSelection({');
    const deps = trigger.slice(trigger.indexOf('}, [', at), trigger.indexOf(']);', at));
    for (const dependency of ['sessionId', 'agent', 'catalogOptions', 'loaded']) {
      expect(deps, `reconcile effect must re-run on ${dependency}`).toContain(dependency);
    }
  });

  // §4.3-5: provenance is a status row, never a radio item. A `source:'seed'`
  // list rendered as ordinary entries is the one failure the discriminant exists
  // to stop, so the copy has to be reachable from the menu.
  it('the seed/stale/empty status row is rendered outside the two radio sections', () => {
    const sectionsAt = only(trigger, 'menu.sections.map(');
    const statusAt = only(trigger, '{status.message && (');
    expect(statusAt).toBeGreaterThan(sectionsAt);
    expect(trigger).toContain('status.retryable');
    expect(trigger).toContain('onClick={retry}');
  });

  // `Automatic` is an absence at every layer; a persisted sentinel would freeze
  // the session against a later agent template.
  it('picking Automatic clears storage instead of writing a sentinel', () => {
    const at = only(trigger, 'if (itemId === AUTOMATIC_MODEL_ID) {');
    expect(trigger.slice(at, at + 200)).toContain('clearSessionModel(sessionId, agent)');
    expect(trigger).toContain('setSessionModel(sessionId, agent, itemId)');
  });

  it('every per-session read and write names the agent', () => {
    expect(offsets(trigger, 'getSessionModel(sessionId)')).toHaveLength(0);
    expect(offsets(trigger, 'getSessionEffort(sessionId)')).toHaveLength(0);
    expect(offsets(trigger, 'getSessionModel(sessionId, agent)').length).toBeGreaterThanOrEqual(1);
    expect(offsets(trigger, 'setSessionEffort(sessionId, agent, itemId)')).toHaveLength(1);
  });
});

describe('B15 wiring: lastAgent is remembered, intersected and gated', () => {
  it('the initial draft agent goes through the intersection helper, not through the raw setting', () => {
    const at = only(picker, 'resolveInitialDraftAgent({');
    expect(picker.slice(at, at + 220)).toContain('capabilitiesAgents: agents');
    expect(picker.slice(at, at + 220)).toContain('settingsHydrated');
    expect(picker).not.toContain('lastAgent ??');
  });

  // The write half is separately gated, because a build that only gated the
  // read would persist the empty default over the user's real value on the
  // first pick of every launch.
  it('the lastAgent write is gated on hydration at its only call site', () => {
    const at = only(picker, 'if (canPersistLastAgent(settingsHydrated)) {');
    expect(picker.slice(at, at + 200)).toContain('lastAgent: option.agent');
    expect(offsets(picker, 'lastAgent: option.agent')).toHaveLength(1);
  });

  // Display-only adoption is the A11 failure reached from the other side: the
  // picker would show Codex while the create payload still said Claude Code.
  it('the remembered agent is written back, not only displayed', () => {
    const at = only(picker, 'if (draftAgent !== undefined) return;');
    expect(picker.slice(at, at + 300)).toContain(
      'setDraftSessionAgent(sessionId, rememberedAgent, { sendAttempted })'
    );
    // …and skipped when it would only re-state the legacy default, so an
    // untouched draft on a machine with no memory stays exactly as S1 left it.
    expect(picker.slice(at, at + 300)).toContain('rememberedAgent === sessionAgent({})');
  });
});

/**
 * §4.3 priority chain, mirror side.
 *
 * The Context panel is a MIRROR of what the runtime was told, so every rung the
 * send path walks it has to walk too. It previously read only the session's own
 * storage, so a session running on its agent template's `high` reported "no
 * effort configured" on the panel while `effort:'high'` was on the wire — the
 * same mirror≠wire split A06 pins for the model row, one field over.
 *
 * Asserted as wiring rather than by rendering because the decision itself is
 * `resolveEffortSelection`'s (truth-tabled in `efforts.test.ts`); what can only
 * be checked here is that this surface calls it with BOTH rungs instead of
 * re-deriving one.
 */
describe('§4.3 wiring: the Context panel resolves effort the way the send path does', () => {
  it('reads the session rung and the agent-template rung through the shared helper', () => {
    const at = only(contextView, 'resolveEffortSelection(');
    const call = contextView.slice(at, at + 260);
    expect(call).toContain('getSessionEffort(');
    expect(call).toContain('agentDefaultEffort(');
  });

  it('keys both rungs by the session agent, never by a hard-coded axis', () => {
    const at = only(contextView, 'resolveEffortSelection(');
    const call = contextView.slice(at, at + 260);
    // `sessionAgent(session)` once per rung: a mirror that read the template
    // for the wrong agent would report the other runtime's level.
    expect(offsets(call, 'sessionAgent(session)')).toHaveLength(2);
    expect(contextView).not.toContain("agentDefaultEffort(chatAgentDefaults, 'claude-code')");
  });

  // `undefined` (no session) and `null` (session, nothing configured) decide
  // between "row omitted" and "row says none" downstream, so the ternary that
  // produces `undefined` must stay outside the helper call.
  it('keeps no-session distinct from nothing-configured', () => {
    const at = only(contextView, 'const effortSelection =');
    expect(contextView.slice(at, at + 120)).toContain('activeSessionId && session');
    expect(contextView.slice(at, at + 320)).toContain(': undefined');
  });
});
