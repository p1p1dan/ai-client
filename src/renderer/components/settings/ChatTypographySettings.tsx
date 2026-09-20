import {
  CHAT_BODY_FONT_SIZE_MAX,
  CHAT_BODY_FONT_SIZE_MIN,
  CHAT_PROCESS_FONT_SIZE_MAX,
  CHAT_PROCESS_FONT_SIZE_MIN,
} from '@shared/types/chatTypography';
import * as React from 'react';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

/**
 * T104: the chat area's typeface and its two size tiers, in the Appearance
 * page rather than a new category of its own.
 *
 * A new settings category costs four files and a hard-coded eleven-item
 * assertion in `settingsCategories.test.ts`; this is three controls that
 * describe the same surface the "Reading column" block above already does, so
 * it belongs in the same block list.
 *
 * The controls are the local/global pair `TerminalAppearanceSettings` uses:
 * `local*` is what the input shows while it is being typed into, `global*` is
 * the store. Typing is therefore never clamped mid-keystroke (the field would
 * fight the user on the way to `18`), and the clamp lands on blur/Enter. The
 * store clamps again on its own side — this is the UI half of that contract,
 * not the only half.
 */
function ChatTypographyPreview({
  fontFamily,
  bodySize,
  processSize,
  t,
}: {
  fontFamily: string;
  bodySize: number;
  processSize: number;
  t: (key: string) => string;
}) {
  // Deliberately the same three tiers the transcript uses: the reader's own
  // body text, the downgraded process tier, and a mono code block, which must
  // NOT pick up the family override (a utility's font-family beats
  // inheritance) — showing that here is cheaper than finding out later.
  //
  // The sizes are applied as inline `font-size` rather than through the
  // `text-chat-body` / `text-chat-process` utilities, because those resolve
  // `var(--text-chat-body)` and this preview sits OUTSIDE the chat column's
  // root node — the node that owns those overrides. Inline here, custom
  // properties there: same numbers, two homes, and the preview is the one that
  // has to say so.
  const familyStyle = fontFamily ? { fontFamily } : {};
  return (
    <div className="rounded-lg border bg-card p-3">
      <p
        className="leading-relaxed text-foreground"
        style={{ fontSize: `${bodySize}px`, ...familyStyle }}
      >
        {t('For example: this paragraph is the message text, and it changes with the setting.')}
      </p>
      <p
        className="mt-2 leading-normal text-muted-foreground"
        style={{ fontSize: `${processSize}px`, ...familyStyle }}
      >
        {t('Process information (thinking, tool calls) reads at this size.')}
      </p>
      <p className="mt-2 font-mono text-code leading-normal text-muted-foreground">
        const answer = 42;
      </p>
    </div>
  );
}

/** The chat area's font family + the two tier sizes. Rendered by `AppearanceSettings`. */
export function ChatTypographySection() {
  const {
    chatFontFamily: globalFontFamily,
    setChatFontFamily,
    chatBodyFontSize: globalBodySize,
    setChatBodyFontSize,
    chatProcessFontSize: globalProcessSize,
    setChatProcessFontSize,
  } = useSettingsStore();
  const { t } = useI18n();

  const [localFontFamily, setLocalFontFamily] = React.useState(globalFontFamily);
  const [localBodySize, setLocalBodySize] = React.useState(globalBodySize);
  const [localProcessSize, setLocalProcessSize] = React.useState(globalProcessSize);

  React.useEffect(() => {
    setLocalFontFamily(globalFontFamily);
  }, [globalFontFamily]);
  React.useEffect(() => {
    setLocalBodySize(globalBodySize);
  }, [globalBodySize]);
  React.useEffect(() => {
    setLocalProcessSize(globalProcessSize);
  }, [globalProcessSize]);

  // Empty is a real value here ("follow the app"), unlike the terminal's
  // `applyFontFamilyChange`, which falls back to the previous value because an
  // empty terminal family is unrenderable. Clearing this field is how the
  // reader gets back to the app font.
  const applyFontFamilyChange = React.useCallback(() => {
    const next = localFontFamily.trim();
    if (next !== localFontFamily) {
      setLocalFontFamily(next);
    }
    if (next !== globalFontFamily) {
      setChatFontFamily(next);
    }
  }, [localFontFamily, globalFontFamily, setChatFontFamily]);

  const applyBodySizeChange = React.useCallback(() => {
    const next = Math.min(
      CHAT_BODY_FONT_SIZE_MAX,
      Math.max(CHAT_BODY_FONT_SIZE_MIN, Math.round(localBodySize) || CHAT_BODY_FONT_SIZE_MIN)
    );
    if (next !== localBodySize) {
      setLocalBodySize(next);
    }
    setChatBodyFontSize(next);
    // The store may have pulled the process tier down with it (process ≤ body);
    // re-read so the two fields never show a pair the store does not hold.
    setLocalProcessSize(useSettingsStore.getState().chatProcessFontSize);
  }, [localBodySize, setChatBodyFontSize]);

  const applyProcessSizeChange = React.useCallback(() => {
    const next = Math.min(
      CHAT_PROCESS_FONT_SIZE_MAX,
      Math.max(
        CHAT_PROCESS_FONT_SIZE_MIN,
        Math.round(localProcessSize) || CHAT_PROCESS_FONT_SIZE_MIN
      )
    );
    if (next !== localProcessSize) {
      setLocalProcessSize(next);
    }
    setChatProcessFontSize(next);
    setLocalBodySize(useSettingsStore.getState().chatBodyFontSize);
  }, [localProcessSize, setChatProcessFontSize]);

  return (
    <SettingsSectionBlock
      title={t('Chat area')}
      description={t('Font and text size for messages and process information')}
    >
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('Preview')}</p>
        <ChatTypographyPreview
          fontFamily={localFontFamily}
          bodySize={localBodySize}
          processSize={localProcessSize}
          t={t}
        />
      </div>
      <SettingsRow>
        <span className="text-sm font-medium">{t('Font family')}</span>
        <Input
          value={localFontFamily}
          onChange={(e) => setLocalFontFamily(e.target.value)}
          onBlur={applyFontFamilyChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              applyFontFamilyChange();
              e.currentTarget.blur();
            }
          }}
          placeholder={t('Empty follows the app font')}
          aria-label={t('Chat font family')}
        />
      </SettingsRow>
      <SettingsRow>
        <span className="text-sm font-medium">{t('Message text size')}</span>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={localBodySize}
            onChange={(e) => setLocalBodySize(Number(e.target.value))}
            onBlur={applyBodySizeChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                applyBodySizeChange();
                e.currentTarget.blur();
              }
            }}
            min={CHAT_BODY_FONT_SIZE_MIN}
            max={CHAT_BODY_FONT_SIZE_MAX}
            className="w-20"
            aria-label={t('Message text size')}
          />
          <span className="text-sm text-muted-foreground">px</span>
        </div>
      </SettingsRow>
      <SettingsRow>
        <span className="text-sm font-medium">{t('Process text size')}</span>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={localProcessSize}
            onChange={(e) => setLocalProcessSize(Number(e.target.value))}
            onBlur={applyProcessSizeChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                applyProcessSizeChange();
                e.currentTarget.blur();
              }
            }}
            min={CHAT_PROCESS_FONT_SIZE_MIN}
            // The body size is this control's ceiling: "process larger than the
            // answer" is not a preference to offer, and the store enforces the
            // same rule for callers that bypass the control.
            max={Math.min(CHAT_PROCESS_FONT_SIZE_MAX, localBodySize)}
            className="w-20"
            aria-label={t('Process text size')}
          />
          <span className="text-sm text-muted-foreground">px</span>
        </div>
      </SettingsRow>
    </SettingsSectionBlock>
  );
}
