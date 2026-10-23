import {
  CLAUDE_SDK_AUTO_COMPACT_PERCENT_MAX,
  CLAUDE_SDK_AUTO_COMPACT_PERCENT_MIN,
} from '@shared/claudeSdkEngine';
import { useEffect, useState } from 'react';
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from '@/components/ui/number-field';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

/**
 * Route B, S-1 (docs/plantree/plans/claude-sdk-engine/topics/s1-engine-selection.md
 * decision 10, §5): whether new chats whose model is on the Anthropic
 * protocol run on the official Claude Agent SDK.
 * On by default; off sends them to the built-in engine like every other model.
 * Main reads it when it creates a chat, so it never moves a chat that exists.
 */
export function ClaudeSdkEngineSection() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.claudeSdkEngineEnabled);
  const setEnabled = useSettingsStore((state) => state.setClaudeSdkEngineEnabled);
  const dropEmptySystem = useSettingsStore((state) => state.claudeSdkDropEmptySystemMessages);
  const setDropEmptySystem = useSettingsStore((state) => state.setClaudeSdkDropEmptySystemMessages);
  const compactPercent = useSettingsStore((state) => state.claudeSdkAutoCompactPercent);
  const setCompactPercent = useSettingsStore((state) => state.setClaudeSdkAutoCompactPercent);
  // A local draft while typing; only a committed value reaches the store.
  const [compactDraft, setCompactDraft] = useState<number | null>(compactPercent);
  useEffect(() => setCompactDraft(compactPercent), [compactPercent]);

  return (
    <SettingsSectionBlock
      title={t('Agent SDK engine')}
      description={t(
        'When on, new chats whose model uses the Anthropic protocol (Claude, or another model behind an Anthropic-compatible endpoint) run on the official Claude Agent SDK, and on the built-in engine if that one cannot start. When off, they run on the built-in engine like other models. Applies to new chats; existing chats keep the engine they started on.'
      )}
    >
      {/* The same row layout as the neighbouring switches: a short label in the
          label column, the full sentence as the switch's accessible name. */}
      <SettingsRow>
        <span className="text-ui">{t('Use Agent SDK')}</span>
        <div className="min-w-0">
          <Switch
            aria-label={t('Run Anthropic-protocol models on the official Agent SDK')}
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>
      </SettingsRow>
      {/* User 2026-10-23: the CLI compacts at this share of the model's window
          (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`); committed on blur, Enter or a step. */}
      <SettingsRow>
        <div className="min-w-0">
          <p className="text-ui">{t('Automatic compaction at')}</p>
          <p className="text-small text-muted-foreground">
            {t(
              'Percentage of the context window at which Agent SDK chats summarize earlier turns. 100 keeps the CLI default. Applies when a chat engine starts next.'
            )}
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <NumberField
            className="w-32"
            size="sm"
            min={CLAUDE_SDK_AUTO_COMPACT_PERCENT_MIN}
            max={CLAUDE_SDK_AUTO_COMPACT_PERCENT_MAX}
            step={1}
            value={compactDraft}
            onValueChange={setCompactDraft}
            onValueCommitted={(value) => {
              if (value === null) setCompactDraft(compactPercent);
              else setCompactPercent(Math.round(value));
            }}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement />
              <NumberFieldInput aria-label={t('Automatic compaction at')} />
              <NumberFieldIncrement />
            </NumberFieldGroup>
          </NumberField>
          <span className="shrink-0 text-ui text-muted-foreground">%</span>
        </div>
      </SettingsRow>
      {/* User 2026-10-23: the auth proxy's fix for the CLI's empty system message. */}
      <SettingsRow>
        <div className="min-w-0">
          <p className="text-ui">{t('Drop empty system messages')}</p>
          <p className="text-small text-muted-foreground">
            {t(
              'After a compaction the CLI can send an empty system message that the gateway refuses, and every later turn of that chat fails. When on, PiLab removes it before the request goes out. Applies when a chat engine starts next.'
            )}
          </p>
        </div>
        <div className="min-w-0">
          <Switch
            aria-label={t('Drop empty system messages')}
            checked={dropEmptySystem}
            onCheckedChange={setDropEmptySystem}
          />
        </div>
      </SettingsRow>
    </SettingsSectionBlock>
  );
}
