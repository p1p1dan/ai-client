import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentDefaultPermission,
  type ChatAgentDefaults,
  EMPTY_CHAT_AGENT_DEFAULTS,
  withAgentPreference,
} from '@shared/models/chatAgentDefaults';
import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import {
  isDangerousPermissionPreference,
  type SessionPermissionPreference,
} from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
// The repo-wide parser-backed strip: these scans have to ban names that this
// module's own doc comments must spell in order to explain the ban.
import { stripComments } from '../../chat/__tests__/stripComments';
import {
  CHAT_PERMISSION_SCOPE_NOTE,
  CLAUDE_PERMISSION_OPTIONS,
  CODEX_APPROVAL_OPTIONS,
  CODEX_NETWORK_ROW,
  CODEX_SANDBOX_OPTIONS,
  claudeTemplateSelection,
  codexTemplateSelection,
  DANGEROUS_TIER_WARNING,
  decidePermissionTemplateAction,
  isDangerousTemplate,
  NON_USER_CHOSEN_TEMPLATE_ARMS,
  nextClaudeTemplate,
  nextCodexTemplate,
  RUNTIME_DEFAULT_OPTION,
} from '../chatPermissionDefaults';

/**
 * D48 S3 §5.7 — the write side's template layer: C8 (view-model half), C12,
 * C13 and C16.
 *
 * The whole panel is one decision — "where does a NEW chat start" — and every
 * assertion here is about a way that decision could leak somewhere it does not
 * belong: onto a running session (C12), onto a dimension nothing can configure
 * (C8), or onto a user who never asked for it (C13/C16).
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MODEL_FILE = path.join(SRC_DIR, 'renderer/components/settings/chatPermissionDefaults.ts');
const SECTION_FILE = path.join(
  SRC_DIR,
  'renderer/components/settings/ChatAgentDefaultsSection.tsx'
);
const AGENT_SETTINGS_FILE = path.join(SRC_DIR, 'renderer/components/settings/AgentSettings.tsx');

function code(file: string): string {
  // The real filename matters: `.ts` and `.tsx` are different grammars.
  return stripComments(readFileSync(file, 'utf8'), file);
}

/** The store write the component performs, replayed without React. */
function applyToStore(
  defaults: ChatAgentDefaults,
  agent: typeof CLAUDE_CODE_AGENT,
  preference: SessionPermissionPreference | undefined
): ChatAgentDefaults {
  return withAgentPreference(defaults, agent, { permission: preference });
}

describe('the option tables (C13 input)', () => {
  it('names exactly the two dangerous tiers, and only those', () => {
    expect(CLAUDE_PERMISSION_OPTIONS.filter((o) => o.dangerous).map((o) => o.value)).toEqual([
      'bypassPermissions',
    ]);
    expect(CODEX_SANDBOX_OPTIONS.filter((o) => o.dangerous).map((o) => o.value)).toEqual([
      'danger-full-access',
    ]);
    // Approval policy has no dangerous tier: `never` removes the prompts but
    // the sandbox still holds, which is a different thing from no sandbox.
    expect(CODEX_APPROVAL_OPTIONS.some((o) => o.dangerous)).toBe(false);
  });

  it('the `dangerous` flags agree with the shared predicate, rather than being a second opinion', () => {
    for (const option of CLAUDE_PERMISSION_OPTIONS) {
      expect(isDangerousPermissionPreference(nextClaudeTemplate(option.value))).toBe(
        option.dangerous
      );
    }
    for (const option of CODEX_SANDBOX_OPTIONS) {
      expect(
        isDangerousPermissionPreference(nextCodexTemplate(undefined, { sandboxMode: option.value }))
      ).toBe(option.dangerous);
    }
  });

  it('every option carries a description — the risk is never left to a tooltip', () => {
    for (const option of [
      ...CLAUDE_PERMISSION_OPTIONS,
      ...CODEX_APPROVAL_OPTIONS,
      ...CODEX_SANDBOX_OPTIONS,
    ]) {
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  it('the scope note states the rule §5.4 requires, and the warning promises no way back', () => {
    expect(CHAT_PERMISSION_SCOPE_NOTE).toBe(
      'Applies to new chat sessions. Existing and active sessions keep the permission posture captured when they were first sent.'
    );
    expect(DANGEROUS_TIER_WARNING).toMatch(/danger-full-access/);
    expect(DANGEROUS_TIER_WARNING).toMatch(/Bypass permissions/);
    // "You can always turn it back" would be a lie: a session that captured the
    // tier keeps it forever.
    expect(DANGEROUS_TIER_WARNING).not.toMatch(/revert|undo|any time|anytime/i);
  });
});

describe('C13 — no default, fallback or placeholder is ever a dangerous tier', () => {
  it('the factory value carries no template at all', () => {
    expect(EMPTY_CHAT_AGENT_DEFAULTS.byAgent).toBeUndefined();
    expect(agentDefaultPermission(EMPTY_CHAT_AGENT_DEFAULTS, CLAUDE_CODE_AGENT)).toBeUndefined();
    expect(agentDefaultPermission(EMPTY_CHAT_AGENT_DEFAULTS, CODEX_AGENT)).toBeUndefined();
  });

  it('every non-user-chosen arm is enumerated by name, and none of them is dangerous', () => {
    // The enumeration is the assertion: a new fallback arm that nobody adds
    // here is a fallback nobody checked, so the list is required to be
    // non-trivial as well as clean.
    expect(NON_USER_CHOSEN_TEMPLATE_ARMS.length).toBeGreaterThanOrEqual(7);
    for (const { arm, preference } of NON_USER_CHOSEN_TEMPLATE_ARMS) {
      expect(isDangerousPermissionPreference(preference), arm).toBe(false);
    }
  });

  it('the Codex companion dimension fills in the most restrictive value, not the most convenient', () => {
    expect(nextCodexTemplate(undefined, { approvalPolicy: 'never' })).toEqual({
      agent: CODEX_AGENT,
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
    });
    expect(nextCodexTemplate(undefined, { sandboxMode: 'workspace-write' })).toEqual({
      agent: CODEX_AGENT,
      approvalPolicy: 'untrusted',
      sandboxMode: 'workspace-write',
    });
  });

  it('the sentinel and any unrecognized value clear the template rather than picking one', () => {
    expect(nextClaudeTemplate(RUNTIME_DEFAULT_OPTION)).toBeUndefined();
    expect(nextClaudeTemplate('bypass')).toBeUndefined();
    const stored = applyToStore(EMPTY_CHAT_AGENT_DEFAULTS, CLAUDE_CODE_AGENT, {
      agent: CLAUDE_CODE_AGENT,
      permissionMode: 'plan',
    } as SessionPermissionPreference);
    expect(nextCodexTemplate(stored, { approvalPolicy: RUNTIME_DEFAULT_OPTION })).toBeUndefined();
    expect(nextCodexTemplate(stored, { sandboxMode: 'nope' })).toBeUndefined();
  });

  it('chat permission never lands on the terminal axis (axis isolation, static)', () => {
    // `AgentSettings.tsx` manages `BuiltinAgentId` terminal agents. A chat
    // session's posture landing there would key a security decision by a
    // loose terminal id — a different table with different values.
    expect(code(AGENT_SETTINGS_FILE)).not.toMatch(
      /permissionPreference|bypassPermissions|danger-full-access/
    );
    for (const file of [MODEL_FILE, SECTION_FILE]) {
      expect(code(file)).not.toMatch(/agentSettings|AgentSettings|BuiltinAgentId/);
    }
  });
});

describe('C16 — the second confirmation, both directions', () => {
  it('a safe tier is applied straight away', () => {
    const action = decidePermissionTemplateAction(nextClaudeTemplate('plan'));
    expect(action).toEqual({
      kind: 'apply',
      preference: { agent: CLAUDE_CODE_AGENT, permissionMode: 'plan' },
    });
  });

  it('clearing back to the runtime default is applied straight away too', () => {
    expect(decidePermissionTemplateAction(undefined)).toEqual({
      kind: 'apply',
      preference: undefined,
    });
  });

  it('a dangerous tier is held, not written', () => {
    for (const preference of [
      nextClaudeTemplate('bypassPermissions'),
      nextCodexTemplate(undefined, { sandboxMode: 'danger-full-access' }),
    ]) {
      const action = decidePermissionTemplateAction(preference);
      expect(action.kind).toBe('confirm');
      expect(action.preference).toEqual(preference);
    }
  });

  it('the CANCEL arm leaves app settings untouched, so the control shows the previous tier again', () => {
    const stored = applyToStore(EMPTY_CHAT_AGENT_DEFAULTS, CLAUDE_CODE_AGENT, {
      agent: CLAUDE_CODE_AGENT,
      permissionMode: 'plan',
    } as SessionPermissionPreference);
    const action = decidePermissionTemplateAction(nextClaudeTemplate('bypassPermissions'));
    expect(action.kind).toBe('confirm');
    // Cancel = nothing is applied. There is no third state to clean up: the
    // Select reads `stored`, which never moved.
    expect(claudeTemplateSelection(stored)).toBe('plan');
    expect(isDangerousTemplate(stored, CLAUDE_CODE_AGENT)).toBe(false);
  });

  it('the CONFIRM arm writes exactly the held tier, and the control then shows it', () => {
    const action = decidePermissionTemplateAction(nextClaudeTemplate('bypassPermissions'));
    if (action.kind !== 'confirm') throw new Error('expected a confirmation gate');
    const stored = applyToStore(EMPTY_CHAT_AGENT_DEFAULTS, CLAUDE_CODE_AGENT, action.preference);
    expect(claudeTemplateSelection(stored)).toBe('bypassPermissions');
    expect(isDangerousTemplate(stored, CLAUDE_CODE_AGENT)).toBe(true);
    // The other agent is untouched: two cards, two decisions.
    expect(isDangerousTemplate(stored, CODEX_AGENT)).toBe(false);
    expect(codexTemplateSelection(stored)).toEqual({
      approvalPolicy: RUNTIME_DEFAULT_OPTION,
      sandboxMode: RUNTIME_DEFAULT_OPTION,
    });
  });

  it('the component routes EVERY selection through the gate — there is no direct write path', () => {
    const section = code(SECTION_FILE);
    // Exactly one writer to app settings, and it is `commit`. A Select wired
    // straight to the store — mutation ⑫ — adds a second one here.
    expect(section.match(/setChatAgentDefaults\(/g) ?? []).toHaveLength(1);
    // Two callers of it: the `apply` arm inside `request`, and the confirm
    // button. Nothing may reach the store around the gate.
    expect(section.match(/\bcommit\(/g) ?? []).toHaveLength(2);
    expect(section).toMatch(/decidePermissionTemplateAction/);
    // Three writable controls (Claude mode, Codex approval, Codex sandbox),
    // three trips through `request`. The network row is not one of them.
    expect(section.match(/\brequest\(/g) ?? []).toHaveLength(3);
  });
});

describe('C8 / C12 — negative controls', () => {
  it('C8 — the panel shows network access as a fact and marks it unwritable', () => {
    expect(CODEX_NETWORK_ROW.writable).toBe(false);
    expect(CODEX_NETWORK_ROW.value).toBe('Reported by runtime');
    // No option table offers it, and no builder can produce it.
    const produced = [
      nextCodexTemplate(undefined, { approvalPolicy: 'never' }),
      nextCodexTemplate(undefined, { sandboxMode: 'danger-full-access' }),
    ];
    for (const preference of produced) {
      expect(preference && 'networkAccess' in preference).toBe(false);
    }
  });

  it('C8 — no control in this panel is wired to networkAccess', () => {
    // The read-only row goes through `CODEX_NETWORK_ROW`, which never spells
    // the key; what must not exist anywhere in the code is a handler for it.
    expect(code(SECTION_FILE)).not.toMatch(/networkAccess/);
    expect(code(MODEL_FILE)).not.toMatch(/networkAccess/);
  });

  it('C12 — the write side cannot reach a session: no IPC surface is imported at all', () => {
    for (const file of [MODEL_FILE, SECTION_FILE]) {
      const source = code(file);
      expect(source).not.toMatch(/electronAPI/);
      expect(source).not.toMatch(/chatSessions|useChatSessionsStore/);
      expect(source).not.toMatch(/activeSessionId/);
      expect(source).not.toMatch(/sessionRuntimeFacts/);
    }
  });

  it('C12 — the only store this panel writes is app settings', () => {
    const section = code(SECTION_FILE);
    const setters = section.match(/\bset[A-Z]\w*\(/g) ?? [];
    for (const setter of setters) {
      expect(['setChatAgentDefaults(', 'setPending(']).toContain(setter);
    }
  });
});
