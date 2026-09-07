import { Keyboard, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { codeToKey } from '@/lib/keybinding';
import { cn } from '@/lib/utils';
import { type TerminalKeybinding, useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

export function KeybindingInput({
  value,
  onChange,
  label,
}: {
  value: TerminalKeybinding;
  onChange: (binding: TerminalKeybinding) => void;
  label: string;
}) {
  const { t } = useI18n();
  const [isRecording, setIsRecording] = React.useState(false);

  const formatKeybinding = (binding: TerminalKeybinding): string => {
    const parts: string[] = [];
    if (binding.ctrl) parts.push('Ctrl');
    if (binding.alt) parts.push('Alt');
    if (binding.shift) parts.push('Shift');
    if (binding.meta) parts.push('Cmd');
    parts.push(binding.key.toUpperCase());
    return parts.join(' + ');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isRecording) return;

    e.preventDefault();
    e.stopPropagation();

    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

    const key = codeToKey(e.code) || e.key.toLowerCase();

    const newBinding: TerminalKeybinding = {
      key,
    };

    if (e.ctrlKey && !e.metaKey) newBinding.ctrl = true;
    if (e.altKey) newBinding.alt = true;
    if (e.shiftKey) newBinding.shift = true;
    if (e.metaKey) newBinding.meta = true;

    onChange(newBinding);
    setIsRecording(false);
  };

  return (
    <div className="flex items-center gap-2">
      <div
        className={cn(
          'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
          'focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
          isRecording && 'ring-2 ring-ring ring-offset-2'
        )}
        onClick={() => setIsRecording(true)}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="button"
        aria-label={label}
        data-keybinding-recording={isRecording ? '' : undefined}
      >
        {isRecording ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Keyboard className="h-4 w-4" />
            {t('Press a shortcut...')}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            {formatKeybinding(value)}
          </span>
        )}
      </div>
      {isRecording && (
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            setIsRecording(false);
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function ShortcutSection<K extends string>({
  title,
  bindings,
  labels,
  onChange,
}: {
  title: string;
  bindings: Record<K, TerminalKeybinding>;
  labels: readonly (readonly [K, string])[];
  onChange: (bindings: Record<K, TerminalKeybinding>) => void;
}) {
  return (
    <SettingsSectionBlock title={title}>
      {labels.map(([key, label]) => (
        <SettingsRow key={key}>
          <span className="text-sm">{label}</span>
          <KeybindingInput
            label={label}
            value={bindings[key]}
            onChange={(binding) => onChange({ ...bindings, [key]: binding })}
          />
        </SettingsRow>
      ))}
    </SettingsSectionBlock>
  );
}

export function KeybindingsSettings() {
  const { t } = useI18n();
  const {
    xtermKeybindings,
    setXtermKeybindings,
    editorKeybindings,
    setEditorKeybindings,
    sourceControlKeybindings,
    setSourceControlKeybindings,
    searchKeybindings,
    setSearchKeybindings,
  } = useSettingsStore();

  return (
    <div className="space-y-6">
      <ShortcutSection
        title={t('Terminal')}
        bindings={xtermKeybindings}
        onChange={setXtermKeybindings}
        labels={[
          ['newTab', t('New Tab')],
          ['closeTab', t('Close Tab')],
          ['nextTab', t('Next Tab')],
          ['prevTab', t('Previous Tab')],
          ['split', t('Split pane')],
          ['merge', t('Merge pane')],
          ['clear', t('Clear terminal')],
        ]}
      />
      <ShortcutSection
        title={t('Editor')}
        bindings={editorKeybindings}
        onChange={setEditorKeybindings}
        labels={[['gotoSymbol', t('Show Symbols')]]}
      />
      <ShortcutSection
        title={t('Version Control')}
        bindings={sourceControlKeybindings}
        onChange={setSourceControlKeybindings}
        labels={[
          ['prevDiff', t('Previous change')],
          ['nextDiff', t('Next change')],
        ]}
      />
      <ShortcutSection
        title={t('Search')}
        bindings={searchKeybindings}
        onChange={setSearchKeybindings}
        labels={[
          ['searchFiles', t('Search files')],
          ['searchContent', t('Search content')],
        ]}
      />
    </div>
  );
}
