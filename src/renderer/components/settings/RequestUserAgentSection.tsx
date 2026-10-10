import type { Translate } from '@shared/i18n';
import {
  checkRequestUserAgent,
  defaultRequestUserAgent,
  isRequestUserAgentMode,
  REQUEST_USER_AGENT_MAX_LENGTH,
  type RequestUserAgentProblem,
  resolveRequestUserAgent,
} from '@shared/types/requestUserAgent';
import { useEffect, useState } from 'react';
import { Field, FieldError } from '@/components/ui/field';
import { Ident } from '@/components/ui/ident';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

/**
 * dsh-rebase decision 171 (GitHub issue #7): the User-Agent of every request to
 * a model service — the company gateway's and the user's own AI services alike
 * — and of a service's model list. One global choice: the default
 * `claude-cli-pilab/<app version>` (what 1.0.x sent), the engine's own
 * (`deepseek-harness/…`), or a custom value.
 *
 * The custom text is a local draft until it is committed (Enter or leaving the
 * field), and only a value that passes the shared check is committed: every
 * commit that changes the User-Agent rebuilds the model plan and restarts the
 * host once it is idle, which must not happen per keystroke.
 *
 * Exported so a mount test can render THIS section without stubbing the
 * model-catalog IPC the rest of the page loads on start.
 */
export function RequestUserAgentSection() {
  const { t } = useI18n();
  const mode = useSettingsStore((state) => state.requestUserAgentMode);
  const custom = useSettingsStore((state) => state.requestUserAgentCustom);
  const setMode = useSettingsStore((state) => state.setRequestUserAgentMode);
  const setCustom = useSettingsStore((state) => state.setRequestUserAgentCustom);

  // The same version Main builds the plan's default from (`app.getVersion()`).
  const appVersion = window.electronAPI?.env.appVersion ?? '';
  const resolved = resolveRequestUserAgent({ mode, custom }, appVersion);

  const [draft, setDraft] = useState(custom);
  useEffect(() => setDraft(custom), [custom]);
  const checked = checkRequestUserAgent(draft);
  // An empty field is allowed: it clears the value, and the default is sent.
  const problem = checked.ok || draft.trim() === '' ? undefined : checked.problem;
  const commit = () => {
    if (problem === undefined) setCustom(draft);
  };

  return (
    <SettingsSectionBlock
      title={t('Request identity (User-Agent)')}
      description={t(
        'The User-Agent sent with every request to a model service, including the company gateway and your own AI services, and when fetching a service model list. Some services only accept specific values.'
      )}
    >
      <SettingsRow>
        <span className="text-ui">{t('User-Agent')}</span>
        <div className="min-w-0 space-y-2">
          <ToggleGroup
            aria-label={t('User-Agent')}
            value={[mode]}
            onValueChange={(value) => {
              const next = (value as string[])[0];
              if (isRequestUserAgentMode(next)) setMode(next);
            }}
          >
            <ToggleGroupItem value="default">{t('Default')}</ToggleGroupItem>
            <ToggleGroupItem value="engine">{t('Engine default')}</ToggleGroupItem>
            <ToggleGroupItem value="custom">{t('Custom')}</ToggleGroupItem>
          </ToggleGroup>

          {mode === 'custom' && (
            <Field invalid={problem !== undefined} className="w-full max-w-md gap-1.5">
              <Input
                aria-label={t('Custom User-Agent')}
                value={draft}
                placeholder={defaultRequestUserAgent(appVersion)}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit();
                }}
              />
              {problem && (
                <FieldError match className="text-destructive text-meta">
                  {problemText(problem, t)}
                </FieldError>
              )}
            </Field>
          )}

          {resolved.userAgent === undefined ? (
            <p className="text-meta text-muted-foreground">
              {t(
                'The engine sends its own User-Agent (deepseek-harness/…). Fetching a service model list uses the system default.'
              )}
            </p>
          ) : (
            <p className="min-w-0 break-all text-meta text-muted-foreground">
              {mode === 'custom' && resolved.problem
                ? t('Until a value is entered, the default is sent:')
                : t('Sent as:')}{' '}
              <Ident className="text-foreground">{resolved.userAgent}</Ident>
            </p>
          )}
          <p className="text-meta text-muted-foreground">
            {t('Takes effect from the next turn; no restart needed.')}
          </p>
        </div>
      </SettingsRow>
    </SettingsSectionBlock>
  );
}

function problemText(problem: RequestUserAgentProblem, t: Translate): string {
  if (problem === 'too_long') {
    return t('At most {{count}} characters.', { count: REQUEST_USER_AGENT_MAX_LENGTH });
  }
  return t('Use letters, digits, spaces and common symbols only (visible ASCII).');
}
