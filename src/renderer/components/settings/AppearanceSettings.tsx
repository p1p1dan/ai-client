import {
  ChevronDown,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
  Terminal,
} from 'lucide-react';
import * as React from 'react';
import { dispatchBackgroundRefresh } from '@/components/layout/BackgroundLayer';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
import { cn } from '@/lib/utils';
import { type Theme, useSettingsStore } from '@/stores/settings';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { SettingsSectionBlock } from './SettingsPrimitives';

export function AppearanceSettings() {
  const readingWidthMode = useShellLayoutStore((state) => state.readingWidthMode);
  const toggleReadingWidthMode = useShellLayoutStore((state) => state.toggleReadingWidthMode);
  const {
    theme,
    setTheme,

    backgroundImageEnabled,
    setBackgroundImageEnabled,
    backgroundImagePath,
    setBackgroundImagePath,
    backgroundUrlPath,
    setBackgroundUrlPath,
    backgroundFolderPath,
    setBackgroundFolderPath,
    backgroundSourceType,
    setBackgroundSourceType,
    backgroundRandomEnabled,
    setBackgroundRandomEnabled,
    backgroundRandomInterval,
    setBackgroundRandomInterval,
    backgroundOpacity,
    setBackgroundOpacity,
    backgroundBlur,
    setBackgroundBlur,
    backgroundBrightness,
    setBackgroundBrightness,
    backgroundSaturation,
    setBackgroundSaturation,
    backgroundSizeMode,
    setBackgroundSizeMode,
  } = useSettingsStore();
  const { t } = useI18n();
  const themeModeOptions: {
    value: Theme;
    icon: React.ElementType;
    label: string;
    description: string;
  }[] = [
    {
      value: 'light',
      icon: Sun,
      label: t('Light'),
      description: t('Bright theme'),
    },
    {
      value: 'dark',
      icon: Moon,
      label: t('Dark'),
      description: t('Eye-friendly dark theme'),
    },
    {
      value: 'system',
      icon: Monitor,
      label: t('System'),
      description: t('Follow system theme'),
    },
    {
      value: 'sync-terminal',
      icon: Terminal,
      label: t('Sync terminal theme'),
      description: t('Match terminal color scheme'),
    },
  ];

  const [bgSettingsOpen, setBgSettingsOpen] = React.useState(false);

  const handleSelectFile = async () => {
    const path = await window.electronAPI.dialog.openFile({
      filters: [
        {
          name: t('Media'),
          extensions: [
            'png',
            'jpg',
            'jpeg',
            'gif',
            'webp',
            'bmp',
            'svg',
            'mp4',
            'webm',
            'ogg',
            'mov',
          ],
        },
      ],
    });
    if (path) {
      setBackgroundImagePath(path);
      setBackgroundSourceType('file');
    }
  };
  const handleSelectFolder = async () => {
    const path = await window.electronAPI.dialog.openDirectory();
    if (path) {
      setBackgroundFolderPath(path);
      setBackgroundSourceType('folder');
    }
  };
  const activePath =
    backgroundSourceType === 'folder'
      ? backgroundFolderPath
      : backgroundSourceType === 'url'
        ? backgroundUrlPath
        : backgroundImagePath;
  const setActivePath =
    backgroundSourceType === 'folder'
      ? setBackgroundFolderPath
      : backgroundSourceType === 'url'
        ? setBackgroundUrlPath
        : setBackgroundImagePath;
  return (
    <div className="space-y-6">
      <SettingsSectionBlock title={t('Theme mode')} description={t('Choose interface theme')}>
        <div className="grid grid-cols-4 gap-3">
          {themeModeOptions.map((option) => (
            <button
              type="button"
              key={option.value}
              onClick={() => setTheme(option.value)}
              className={cn(
                'flex flex-col items-center gap-2 rounded-lg border-2 p-3 transition-colors',
                theme === option.value
                  ? 'border-primary bg-accent text-accent-foreground'
                  : 'border-transparent bg-muted/50 hover:bg-muted'
              )}
            >
              <div
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-full',
                  theme === option.value
                    ? 'bg-accent-foreground/20 text-accent-foreground'
                    : 'bg-muted'
                )}
              >
                <option.icon className="h-5 w-5" />
              </div>
              <span className="text-sm font-medium">{option.label}</span>
            </button>
          ))}
        </div>
      </SettingsSectionBlock>
      <SettingsSectionBlock
        title={t('Reading column')}
        description={t('How wide conversation text is allowed to run')}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
              <LayoutGrid className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">{t('Wide reading column')}</p>
              <p className="text-xs text-muted-foreground">
                {t('Let messages use the full column instead of a fixed reading width')}
              </p>
            </div>
          </div>
          <Switch
            checked={readingWidthMode === 'wide'}
            onCheckedChange={toggleReadingWidthMode}
            aria-label={t('Wide reading column')}
          />
        </div>
      </SettingsSectionBlock>
      <SettingsSectionBlock title={t('Beta Features')} description={t('Experimental features')}>
        <Collapsible open={bgSettingsOpen} onOpenChange={setBgSettingsOpen} className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/20 to-purple-500/20">
                <ImageIcon className="h-4 w-4 text-blue-500" />
              </div>
              <div>
                <p className="text-sm font-medium">{t('Background Image')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('Custom background image for the workspace')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Switch
                checked={backgroundImageEnabled}
                onCheckedChange={setBackgroundImageEnabled}
              />
              <CollapsibleTrigger
                className={cn(
                  'inline-flex items-center justify-center h-8 w-8 rounded-md',
                  'hover:bg-accent hover:text-accent-foreground transition-colors'
                )}
              >
                <ChevronDown
                  className={cn(
                    'h-4 w-4 transition-transform duration-150',
                    bgSettingsOpen ? 'rotate-180' : ''
                  )}
                />
              </CollapsibleTrigger>
            </div>
          </div>

          <CollapsibleContent className="space-y-4 pl-12">
            {/* Source Type */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('Source Type')}</label>
              <Select
                value={backgroundSourceType}
                onValueChange={(v) => setBackgroundSourceType(v as 'file' | 'folder' | 'url')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="file">{t('Image / Video File')}</SelectItem>
                  <SelectItem value="folder">{t('Folder (Random)')}</SelectItem>
                  <SelectItem value="url">{t('URL (Auto Refresh)')}</SelectItem>
                </SelectPopup>
              </Select>
            </div>

            {/* Source Path */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('Source Path')}</label>
              <div className="flex gap-2">
                <Input
                  value={activePath}
                  onChange={(e) => setActivePath(e.target.value)}
                  placeholder={
                    backgroundSourceType === 'folder'
                      ? t('Select a folder containing images or videos')
                      : backgroundSourceType === 'url'
                        ? t('Paste remote image URL (http/https)')
                        : t('Local file path or URL')
                  }
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  disabled={backgroundSourceType === 'url'}
                  onClick={
                    backgroundSourceType === 'folder' ? handleSelectFolder : handleSelectFile
                  }
                >
                  {backgroundSourceType === 'folder' ? (
                    <>
                      <FolderOpen className="h-4 w-4 mr-1.5" />
                      {t('Select Folder')}
                    </>
                  ) : backgroundSourceType === 'url' ? (
                    t('URL Mode')
                  ) : (
                    t('Select File')
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={dispatchBackgroundRefresh}
                  title={t('Refresh')}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Auto Random - available when source type is folder or URL */}
            {(() => {
              const canAutoRandom =
                backgroundSourceType === 'folder' || backgroundSourceType === 'url';
              return (
                <Collapsible className="space-y-3">
                  <CollapsibleTrigger
                    disabled={!canAutoRandom}
                    className={cn(
                      'flex items-center gap-1 text-sm transition-colors',
                      canAutoRandom
                        ? 'text-muted-foreground hover:text-foreground cursor-pointer'
                        : 'text-muted-foreground/40 cursor-not-allowed'
                    )}
                  >
                    <ChevronDown className="h-3.5 w-3.5 transition-transform duration-150 [[data-state=open]>&]:rotate-180" />
                    {t('Auto Random')}
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-3 pl-5">
                    {/* Enable toggle */}
                    <div className="flex items-center justify-between">
                      <label className="text-sm">{t('Enable')}</label>
                      <Switch
                        checked={backgroundRandomEnabled}
                        onCheckedChange={setBackgroundRandomEnabled}
                      />
                    </div>

                    {/* Interval */}
                    <div className="flex items-center justify-between gap-4">
                      <label className="text-sm shrink-0">{t('Interval (seconds)')}</label>
                      <Input
                        type="number"
                        min={5}
                        max={86400}
                        value={backgroundRandomInterval}
                        onChange={(e) => setBackgroundRandomInterval(Number(e.target.value))}
                        className="w-24"
                      />
                    </div>

                    {/* Source Directory */}
                    {backgroundSourceType === 'folder' && (
                      <div className="space-y-1.5">
                        <label className="text-sm">{t('Source Directory')}</label>
                        <div className="flex gap-2">
                          <Input
                            value={backgroundFolderPath}
                            onChange={(e) => setBackgroundFolderPath(e.target.value)}
                            placeholder={t('Select a folder')}
                            className="flex-1"
                          />
                          <Button
                            variant="outline"
                            size="icon"
                            className="shrink-0"
                            onClick={handleSelectFolder}
                          >
                            <FolderOpen className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Manual Refresh */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={dispatchBackgroundRefresh}
                      className="w-full"
                    >
                      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                      {t('Refresh')}
                    </Button>
                  </CollapsibleContent>
                </Collapsible>
              );
            })()}

            {/* Opacity */}
            <div className="space-y-2">
              <div className="flex justify-between">
                <label className="text-sm font-medium">{t('Opacity')}</label>
                <span className="text-sm text-muted-foreground">
                  {Math.round(backgroundOpacity * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(backgroundOpacity * 100)}
                onChange={(e) => setBackgroundOpacity(Number(e.target.value) / 100)}
                className="w-full h-1 rounded-full appearance-none cursor-pointer bg-input accent-primary"
              />
            </div>

            {/* Blur */}
            <div className="space-y-2">
              <div className="flex justify-between">
                <label className="text-sm font-medium">{t('Blur')}</label>
                <span className="text-sm text-muted-foreground">{backgroundBlur}px</span>
              </div>
              <input
                type="range"
                min={0}
                max={20}
                step={1}
                value={backgroundBlur}
                onChange={(e) => setBackgroundBlur(Number(e.target.value))}
                className="w-full h-1 rounded-full appearance-none cursor-pointer bg-input accent-primary"
              />
            </div>

            {/* More - Brightness & Saturation */}
            <Collapsible className="space-y-3">
              <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
                <ChevronDown className="h-3.5 w-3.5 transition-transform duration-150 [[data-state=open]>&]:rotate-180" />
                {t('More Options')}
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4">
                {/* Brightness */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className="text-sm font-medium">{t('Brightness')}</label>
                    <span className="text-sm text-muted-foreground">
                      {Math.round(backgroundBrightness * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={Math.round(backgroundBrightness * 100)}
                    onChange={(e) => setBackgroundBrightness(Number(e.target.value) / 100)}
                    className="w-full h-1 rounded-full appearance-none cursor-pointer bg-input accent-primary"
                  />
                </div>

                {/* Saturation */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <label className="text-sm font-medium">{t('Saturation')}</label>
                    <span className="text-sm text-muted-foreground">
                      {Math.round(backgroundSaturation * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={Math.round(backgroundSaturation * 100)}
                    onChange={(e) => setBackgroundSaturation(Number(e.target.value) / 100)}
                    className="w-full h-1 rounded-full appearance-none cursor-pointer bg-input accent-primary"
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Size Mode */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('Size Mode')}</label>
              <Select
                value={backgroundSizeMode}
                onValueChange={(v) =>
                  setBackgroundSizeMode(v as 'cover' | 'contain' | 'repeat' | 'center')
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="cover">{t('Cover')}</SelectItem>
                  <SelectItem value="contain">{t('Contain')}</SelectItem>
                  <SelectItem value="repeat">{t('Repeat')}</SelectItem>
                  <SelectItem value="center">{t('Center')}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </SettingsSectionBlock>
    </div>
  );
}
