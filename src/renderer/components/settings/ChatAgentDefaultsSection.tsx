import { withAgentPreference } from '@shared/models/chatAgentDefaults';
import { type AgentWireName, CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import type { SessionPermissionPreference } from '@shared/types/runtimeEvents';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { useSettingsHydrated, useSettingsStore } from '@/stores/settings';
import {
  CHAT_PERMISSION_SCOPE_NOTE,
  CLAUDE_PERMISSION_OPTIONS,
  CODEX_APPROVAL_OPTIONS,
  CODEX_NETWORK_ROW,
  CODEX_SANDBOX_OPTIONS,
  claudeTemplateSelection,
  codexTemplateSelection,
  DANGEROUS_CONFIRM_BODY,
  DANGEROUS_CONFIRM_TITLE,
  DANGEROUS_TIER_WARNING,
  decidePermissionTemplateAction,
  isDangerousTemplate,
  nextClaudeTemplate,
  nextCodexTemplate,
  type PermissionOption,
  RUNTIME_DEFAULT_OPTION,
} from './chatPermissionDefaults';

/**
 * D48 S3 §5.4 — Settings' "Chat agent defaults" permission cards.
 *
 * This is the TEMPLATE layer and the only write side S3 ships: it decides where
 * a NEW chat starts, never what a running one does. Two consequences are worth
 * stating where the JSX is, because both are easy to "fix" back into bugs:
 *
 *  1. **Nothing here talks to a session.** No `electronAPI` import, no active
 *     session id in scope. A settings edit that optimistically retuned the
 *     current chat would make the Context surface report a posture the runtime
 *     was never told about (C12).
 *  2. **Every Select's value is derived from the store, not from local state.**
 *     That is what makes "cancel the confirmation" return the control to the
 *     previous tier for free — there is no local copy left sitting on the
 *     dangerous value, so no "unsaved dangerous state" can exist (C16).
 *
 * The live per-session control is S4's and lives in the Composer; this panel
 * stays global on purpose (a pill that sometimes means "this chat" and
 * sometimes "all new chats" is a pill nobody can read).
 */
export function ChatAgentDefaultsSection() {
  const { t } = useI18n();
  const chatAgentDefaults = useSettingsStore((state) => state.chatAgentDefaults);
  const setChatAgentDefaults = useSettingsStore((state) => state.setChatAgentDefaults);
  // Same gate as the agent picker's own persistence: app settings rehydrate
  // over an async IPC round trip, and writing during that window would push
  // `defaults.ts` factory values over the user's real file.
  const settingsHydrated = useSettingsHydrated();
  // The dangerous tier that is waiting for its second confirmation. Held here
  // and NOWHERE else — in particular not in the Select, whose value keeps
  // showing the stored tier until this is committed.
  const [pending, setPending] = useState<{
    agent: AgentWireName;
    preference: SessionPermissionPreference;
  } | null>(null);

  const commit = (agent: AgentWireName, preference: SessionPermissionPreference | undefined) => {
    setChatAgentDefaults(withAgentPreference(chatAgentDefaults, agent, { permission: preference }));
  };

  const request = (agent: AgentWireName, preference: SessionPermissionPreference | undefined) => {
    if (!settingsHydrated) return;
    const action = decidePermissionTemplateAction(preference);
    if (action.kind === 'confirm') {
      setPending({ agent, preference: action.preference });
      return;
    }
    commit(agent, action.preference);
  };

  const claudeSelection = claudeTemplateSelection(chatAgentDefaults);
  const codexSelection = codexTemplateSelection(chatAgentDefaults);

  return (
    <div className="border-t pt-6">
      <div>
        <h4 className="text-base font-medium">{t('Chat agent defaults')}</h4>
        <p className="text-sm text-muted-foreground">{t(CHAT_PERMISSION_SCOPE_NOTE)}</p>
      </div>

      {/* Permanent, not a tooltip: the risk has to be readable before anything
          is picked, and it deliberately promises no way back for sessions that
          already captured the tier. */}
      <p className="mt-3 flex items-start gap-2 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{t(DANGEROUS_TIER_WARNING)}</span>
      </p>

      <div className="mt-4 space-y-4">
        <PermissionCard
          title="Claude Code"
          dangerous={isDangerousTemplate(chatAgentDefaults, CLAUDE_CODE_AGENT)}
        >
          <PermissionRow label={t('Permission mode')}>
            <PermissionSelect
              ariaLabel={t('Default permission mode for new Claude Code sessions')}
              disabled={!settingsHydrated}
              options={CLAUDE_PERMISSION_OPTIONS}
              value={claudeSelection}
              onValueChange={(value) => request(CLAUDE_CODE_AGENT, nextClaudeTemplate(value))}
            />
          </PermissionRow>
        </PermissionCard>

        <PermissionCard
          title="Codex"
          dangerous={isDangerousTemplate(chatAgentDefaults, CODEX_AGENT)}
        >
          <PermissionRow label={t('Approval policy')}>
            <PermissionSelect
              ariaLabel={t('Default approval policy for new Codex sessions')}
              disabled={!settingsHydrated}
              options={CODEX_APPROVAL_OPTIONS}
              value={codexSelection.approvalPolicy}
              onValueChange={(value) =>
                request(
                  CODEX_AGENT,
                  nextCodexTemplate(chatAgentDefaults, { approvalPolicy: value })
                )
              }
            />
          </PermissionRow>
          <PermissionRow label={t('Sandbox mode')}>
            <PermissionSelect
              ariaLabel={t('Default sandbox mode for new Codex sessions')}
              disabled={!settingsHydrated}
              options={CODEX_SANDBOX_OPTIONS}
              value={codexSelection.sandboxMode}
              onValueChange={(value) =>
                request(CODEX_AGENT, nextCodexTemplate(chatAgentDefaults, { sandboxMode: value }))
              }
            />
          </PermissionRow>
          {/* Read-only by construction: network access is not a `thread/start`
              request field, only an echo, so a control here would claim to
              configure something nothing configures. */}
          <PermissionRow label={t(CODEX_NETWORK_ROW.label)}>
            <p className="text-xs text-muted-foreground">{t(CODEX_NETWORK_ROW.value)}</p>
          </PermissionRow>
        </PermissionCard>
      </div>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(nextOpen) => {
          // Any dismissal — Escape, backdrop, Cancel — is a cancel, and a
          // cancel writes nothing. The Select re-reads the store and snaps
          // back to the previous tier on its own.
          if (!nextOpen) setPending(null);
        }}
      >
        <AlertDialogPopup className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <span className="min-w-0 flex-1">{t(DANGEROUS_CONFIRM_TITLE)}</span>
            </AlertDialogTitle>
            <AlertDialogDescription>{t(DANGEROUS_CONFIRM_BODY)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="destructive"
              onClick={() => {
                if (pending) commit(pending.agent, pending.preference);
                setPending(null);
              }}
            >
              {t('Use this tier')}
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('Cancel')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function PermissionCard({
  title,
  dangerous,
  children,
}: {
  title: string;
  dangerous: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{title}</span>
        {dangerous && (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {t('Dangerous tier is the current default')}
          </span>
        )}
      </div>
      <div className="mt-3 space-y-3">{children}</div>
    </div>
  );
}

function PermissionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-4">
      <span className="text-sm font-medium">{label}</span>
      <div className="min-w-0 space-y-1.5">{children}</div>
    </div>
  );
}

function PermissionSelect<T extends string>({
  ariaLabel,
  disabled,
  options,
  value,
  onValueChange,
}: {
  ariaLabel: string;
  disabled: boolean;
  options: ReadonlyArray<PermissionOption<T>>;
  value: T | typeof RUNTIME_DEFAULT_OPTION;
  onValueChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const selected = options.find((option) => option.value === value);
  const runtimeDefaultLabel = t('Runtime default');
  return (
    <>
      <Select
        // Widened to `string` on purpose: the Select's own value type would
        // otherwise be inferred from the sentinel literal alone.
        value={value as string}
        disabled={disabled}
        onValueChange={(next) => next && onValueChange(String(next))}
      >
        <SelectTrigger className="w-56" aria-label={ariaLabel}>
          <SelectValue>
            {selected ? (
              <span className={selected.dangerous ? 'text-destructive' : undefined}>
                {t(selected.label)}
              </span>
            ) : (
              runtimeDefaultLabel
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={RUNTIME_DEFAULT_OPTION}>{runtimeDefaultLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <span className={option.dangerous ? 'text-destructive' : undefined}>
                {t(option.label)}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <p className="text-xs text-muted-foreground">
        {selected ? t(selected.description) : t('Whatever the runtime itself defaults to.')}
      </p>
    </>
  );
}
