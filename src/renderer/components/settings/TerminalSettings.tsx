import type { ShellInfo } from '@shared/types';
import * as React from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { type TerminalRenderer, useSettingsStore } from '@/stores/settings';
import { SettingsRow, SettingsSectionBlock } from './SettingsPrimitives';

// Parse shell arguments string, supporting single/double quotes for paths with spaces
function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoteChar = '';
  for (const ch of input) {
    if (!quoteChar && (ch === '"' || ch === "'")) {
      quoteChar = ch;
    } else if (ch === quoteChar) {
      quoteChar = '';
    } else if (ch === ' ' && !quoteChar) {
      if (current) args.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

function stringifyShellArgs(args: string[]): string {
  return args
    .map((a) => {
      if (a.includes(' ') || a.includes('"') || a.includes("'")) {
        return `"${a.replace(/"/g, '\\"')}"`;
      }
      return a;
    })
    .join(' ');
}

export function TerminalSettings() {
  const {
    terminalOptionIsMeta,
    setTerminalOptionIsMeta,
    terminalRenderer,
    setTerminalRenderer,
    terminalScrollback,
    setTerminalScrollback,
    shellConfig,
    setShellConfig,

    copyOnSelection,
    setCopyOnSelection,
  } = useSettingsStore();
  const { t, locale } = useI18n();

  const numberFormatter = React.useMemo(
    () => new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US'),
    [locale]
  );
  const rendererOptions = React.useMemo(
    () => [
      { value: 'dom', label: 'DOM', description: t('Best compatibility (recommended)') },
      { value: 'webgl', label: 'WebGL', description: t('Higher performance, may have issues') },
    ],
    [t]
  );
  const scrollbackOptions = React.useMemo(
    () =>
      [1000, 5000, 10000, 20000, 50000].map((value) => ({
        value,
        label: t('{{count}} lines', { count: numberFormatter.format(value) }),
      })),
    [t, numberFormatter]
  );
  const [shells, setShells] = React.useState<ShellInfo[]>([]);
  const [loadingShells, setLoadingShells] = React.useState(true);

  React.useEffect(() => {
    window.electronAPI.shell.detect().then((detected) => {
      setShells(detected);
      setLoadingShells(false);
    });
  }, []);

  const availableShells = shells.filter((s) => s.available);
  const currentShell = shells.find((s) => s.id === shellConfig.shellType);
  const isCustomShell = shellConfig.shellType === 'custom';
  const [customArgsText, setCustomArgsText] = React.useState(() =>
    stringifyShellArgs(shellConfig.customShellArgs || [])
  );
  React.useEffect(() => {
    setCustomArgsText(stringifyShellArgs(shellConfig.customShellArgs || []));
  }, [shellConfig.customShellArgs]);
  const commitCustomArgs = React.useCallback(() => {
    setShellConfig({
      ...shellConfig,
      customShellArgs: parseShellArgs(customArgsText),
    });
  }, [customArgsText, shellConfig, setShellConfig]);
  const executionPlatform = window.electronAPI?.env.platform;
  const isWindows = executionPlatform === 'win32';
  const shellPathPlaceholder = isWindows ? 'cmd.exe' : '/bin/bash';
  const shellArgsPlaceholder = isWindows
    ? '/k "C:\\Program Files\\init.bat"'
    : "-l -c '/usr/local/bin/app'";
  return (
    <div className="space-y-6">
      {window.electronAPI?.env?.platform === 'darwin' && (
        <SettingsRow>
          <span className="text-sm">{t('Option as Meta')}</span>
          <div className="flex items-center gap-3">
            <Switch checked={terminalOptionIsMeta} onCheckedChange={setTerminalOptionIsMeta} />
            <span className="text-xs text-muted-foreground">
              {t('Use Option key as Meta instead of composing special characters')}
            </span>
          </div>
        </SettingsRow>
      )}
      <SettingsSectionBlock
        title={t('Terminal')}
        description={t('Terminal renderer and performance settings')}
      >
        <SettingsRow>
          <span className="text-sm font-medium mt-2">{t('Shell')}</span>
          <div className="space-y-1.5">
            {loadingShells ? (
              <div className="flex h-10 items-center">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
              </div>
            ) : (
              <Select
                value={shellConfig.shellType}
                onValueChange={(v) => setShellConfig({ ...shellConfig, shellType: v as never })}
              >
                <SelectTrigger className="w-64" aria-label={t('Shell')}>
                  <SelectValue>
                    {isCustomShell ? t('Custom') : currentShell?.name || shellConfig.shellType}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {availableShells.map((shell) => (
                    <SelectItem key={shell.id} value={shell.id}>
                      <div className="flex items-center gap-2">
                        <span>{shell.name}</span>
                        {shell.isWsl && (
                          <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-xs text-blue-600 dark:text-blue-400">
                            WSL
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">
                    <span>{t('Custom')}</span>
                  </SelectItem>
                </SelectPopup>
              </Select>
            )}
            {isCustomShell && (
              <div className="space-y-2 mt-2">
                <Input
                  className="w-64"
                  placeholder={t('Shell path (e.g. {{example}})', {
                    example: shellPathPlaceholder,
                  })}
                  value={shellConfig.customShellPath || ''}
                  onChange={(e) =>
                    setShellConfig({ ...shellConfig, customShellPath: e.target.value })
                  }
                />
                <Input
                  className="w-64"
                  placeholder={t('Arguments (e.g. {{example}})', { example: shellArgsPlaceholder })}
                  value={customArgsText}
                  onChange={(e) => setCustomArgsText(e.target.value)}
                  onBlur={commitCustomArgs}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCustomArgs();
                  }}
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('Apply on new terminals')}</p>
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium mt-2">{t('Renderer')}</span>
          <div className="space-y-1.5">
            <Select
              value={terminalRenderer}
              onValueChange={(v) => setTerminalRenderer(v as TerminalRenderer)}
            >
              <SelectTrigger className="w-48" aria-label={t('Renderer')}>
                <SelectValue>
                  {rendererOptions.find((o) => o.value === terminalRenderer)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {rendererOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              {rendererOptions.find((o) => o.value === terminalRenderer)?.description}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('Apply on new terminals or restart')}
            </p>
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium mt-2">{t('Terminal scrollback')}</span>
          <div className="space-y-1.5">
            <Select
              value={String(terminalScrollback)}
              onValueChange={(v) => setTerminalScrollback(Number(v))}
            >
              <SelectTrigger className="w-48" aria-label={t('Terminal scrollback')}>
                <SelectValue>
                  {scrollbackOptions.find((o) => o.value === terminalScrollback)?.label ??
                    t('{{count}} lines', { count: numberFormatter.format(terminalScrollback) })}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {scrollbackOptions.map((opt) => (
                  <SelectItem key={opt.value} value={String(opt.value)}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('History lines in the terminal. Higher values use more memory.')}
            </p>
            <p className="text-xs text-muted-foreground">{t('Apply on new terminals only')}</p>
          </div>
        </SettingsRow>
        <SettingsRow>
          <span className="text-sm font-medium">{t('Copy on Selection')}</span>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('Automatically copy selected text in the terminal to the clipboard')}
            </p>
            <Switch checked={copyOnSelection} onCheckedChange={setCopyOnSelection} />
          </div>
        </SettingsRow>
      </SettingsSectionBlock>
    </div>
  );
}
