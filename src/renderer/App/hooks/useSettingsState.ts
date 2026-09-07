import { useCallback, useEffect, useState } from 'react';
import { restoreSettingsCategory, type SettingsCategory } from '@/components/settings/constants';

export function useSettingsState() {
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(() => {
    try {
      return restoreSettingsCategory(localStorage.getItem('aiclient-settings-active-category'));
    } catch {
      return 'general';
    }
  });
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem('aiclient-settings-active-category', settingsCategory);
    } catch (error) {
      console.warn('Failed to save settings category:', error);
    }
  }, [settingsCategory]);
  const openSettings = useCallback(() => setSettingsDialogOpen(true), []);
  const toggleSettings = useCallback(() => setSettingsDialogOpen((open) => !open), []);
  return {
    settingsCategory,
    settingsDialogOpen,
    setSettingsDialogOpen,
    openSettings,
    toggleSettings,
    handleSettingsCategoryChange: setSettingsCategory,
  };
}
